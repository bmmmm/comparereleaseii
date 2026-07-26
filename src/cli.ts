#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
import { parseArgs } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGithubRelease, fetchGithubContext } from "./sources/github.ts";
import {
  loadLocalRelease,
  loadLocalRange,
  ensureClone,
  localRepoContext,
} from "./sources/local.ts";
import { parseClaims } from "./claims.ts";
import { selectEngine, discoverLocalModels, type JudgeEngine } from "./judge.ts";
import { withVerdictCache } from "./cache.ts";
import {
  runCalibration,
  printCalibration,
  calibrateModels,
  printModelRanking,
  rankCalibrations,
} from "./calibrate.ts";
import { commandExists } from "./util.ts";
import { verifyClaims, computeCoverage } from "./verify.ts";
import { computeMetrics } from "./metrics.ts";
import { printTerminal, toMarkdown, exitCode } from "./report.ts";
import { toHtml } from "./html.ts";
import { buildSnapshots, summarizeBaseline, printTimeline } from "./history.ts";
import type { Report } from "./types.ts";

const USAGE = `comparerelease — fact-check release notes against the actual code diff

Usage:
  comparerelease <owner/repo> [--tag <tag>] [--base <tag>]
  comparerelease --local <path> [--head <ref>] [--base <ref>] [--notes-file <file>]

Options:
  --tag <tag>         Release tag to check (default: latest release)
  --base <ref>        Base tag/ref to diff against (default: previous release/tag)
  --local <path>      Use a local git repo instead of the GitHub API
  --head <ref>        Head ref for --local (default: latest tag)
  --notes-file <file> Check this notes file instead of the published notes
                      (for --local the default is the CHANGELOG.md section)
  --judge <mode>      auto | all | off (default: auto — LLM only for unclear claims)
  --engine <engine>   claude-cli | api | openai | off (default: claude-cli;
                      openai = any OpenAI-compatible server: Ollama, MLX, vLLM)
  --model <model>     Judge model (default: haiku; required for --engine openai)
  --openai-url <url>  Base URL for --engine openai
                      (default: $OPENAI_BASE_URL or http://127.0.0.1:11434/v1)
  --escalate <what>   auto | off | claude-cli | api | openai — second, stronger
                      engine that reviews release-critical verdicts when the
                      primary judge is a local model (default: auto)
  --escalate-model <m> Model for the escalation engine
  --calibrate         Run the golden set against the configured judge and
                      report whether YOUR model is good enough (no repo needed).
                      With --engine openai and no --model, ALL models on the
                      server are calibrated and ranked to find the best judge;
                      --model "a,b,c" ranks an explicit shortlist (required on
                      aggregators like OpenRouter)
  --md <file>         Write a markdown report
  --json <file>       Write the full JSON report
  --html <file>       Write a self-contained visual HTML report
  --concurrency <n>   Parallel judge calls (default: 4)
  --fail-on <what>    none | contradicted | no-evidence (default: no-evidence)
  --no-reverse        Skip the completeness check (undocumented commits)
  --baseline <n>      Compare against the n previous releases for anomaly
                      detection (default: 5, GitHub source only; 0 disables)
  --history <n>       Print a release-history timeline instead of a check
  --estimate          Print a cost/effort estimate instead of judging
  --no-cache          Bypass the on-disk verdict cache
  -h, --help          Show this help

Examples:
  comparerelease restic/restic --tag v0.19.1
  comparerelease juanfont/headscale --estimate
  comparerelease --local ~/src/myrepo --base v1.2.0 --head v1.3.0 --notes-file notes.md
`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      tag: { type: "string" },
      base: { type: "string" },
      local: { type: "string" },
      head: { type: "string" },
      "notes-file": { type: "string" },
      judge: { type: "string", default: "auto" },
      engine: { type: "string", default: "claude-cli" },
      model: { type: "string" },
      "openai-url": { type: "string" },
      escalate: { type: "string", default: "auto" },
      "escalate-model": { type: "string" },
      calibrate: { type: "boolean", default: false },
      md: { type: "string" },
      json: { type: "string" },
      html: { type: "string" },
      concurrency: { type: "string", default: "4" },
      "fail-on": { type: "string", default: "no-evidence" },
      "no-reverse": { type: "boolean", default: false },
      baseline: { type: "string", default: "5" },
      history: { type: "string" },
      estimate: { type: "boolean", default: false },
      "no-cache": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help || (!positionals.length && !values.local && !values.calibrate)) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }

  const judgeMode = values.judge as "auto" | "all" | "off";
  const engineName = values.engine as "claude-cli" | "api" | "openai" | "off";
  if (!["auto", "all", "off"].includes(judgeMode)) {
    throw new Error(`--judge must be auto, all or off (got "${values.judge}")`);
  }
  if (!["claude-cli", "api", "openai", "off"].includes(engineName)) {
    throw new Error(`--engine must be claude-cli, api, openai or off (got "${values.engine}")`);
  }
  const failOn = values["fail-on"] as "none" | "contradicted" | "no-evidence";
  if (!["none", "contradicted", "no-evidence"].includes(failOn)) {
    throw new Error(`--fail-on must be none, contradicted or no-evidence (got "${values["fail-on"]}")`);
  }

  if (values.history) {
    if (values.local) throw new Error("--history works with the GitHub source only.");
    const snapshots = await buildSnapshots(positionals[0], { count: Number(values.history) });
    printTimeline(snapshots);
    if (values.json) {
      await writeFile(values.json, JSON.stringify(snapshots, null, 2));
      console.error(`\nJSON timeline written to ${values.json}`);
    }
    return 0;
  }

  const openaiBase =
    values["openai-url"] ?? process.env.OPENAI_BASE_URL ?? "http://127.0.0.1:11434/v1";

  if (values.calibrate && engineName === "openai") {
    // "Which model is the best judge?" — rank an explicit shortlist, or
    // everything a (small) local server offers.
    const rankAndExit = async (models: string[]): Promise<number> => {
      const cals = await calibrateModels(models, {
        baseUrl: openaiBase,
        apiKey: process.env.OPENAI_API_KEY,
        cache: !values["no-cache"],
      });
      printModelRanking(cals);
      const best = rankCalibrations(cals)[0];
      return best && best.passed === best.outcomes.length ? 0 : 1;
    };
    const shortlist = (values.model ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (shortlist.length > 1) {
      return rankAndExit(shortlist);
    }
    if (!values.model) {
      const found = await discoverLocalModels(openaiBase);
      if (found && !found.authRequired && found.models.length > 20) {
        // Aggregators (OpenRouter & co.) list hundreds of models — calibrating
        // them all would be absurdly expensive and mostly paid.
        throw new Error(
          `${openaiBase} offers ${found.models.length} models — that looks like an aggregator. Rank a shortlist instead: --model "vendor/a,vendor/b,vendor/c".`,
        );
      }
      if (found && !found.authRequired && found.models.length > 1) {
        console.error(
          `Found ${found.models.length} models on ${openaiBase} — calibrating all to find the best judge (sequential, one model at a time).`,
        );
        return rankAndExit(found.models);
      }
    }
  }

  const { engine, escalate } = await buildEngines();
  async function buildEngines(): Promise<{ engine: JudgeEngine | null; escalate: JudgeEngine | null }> {
    if (judgeMode === "off") return { engine: null, escalate: null };
    let effective = engineName;
    let model = values.model;

    if (effective === "claude-cli" && !(await commandExists("claude"))) {
      if (process.env.ANTHROPIC_API_KEY) {
        console.error("claude CLI not found — using the Anthropic API engine instead.");
        effective = "api";
      } else {
        const found = await discoverLocalModels(openaiBase);
        if (found && !found.authRequired && found.models.length) {
          model ??= found.models[0];
          console.error(
            `claude CLI not found — using the local model server at ${openaiBase} (model ${model}).`,
          );
          effective = "openai";
        } else {
          console.error(
            "claude CLI not found and ANTHROPIC_API_KEY is unset — running deterministic-only.\n" +
              (found?.authRequired
                ? `(A local server at ${openaiBase} responded but needs OPENAI_API_KEY.)\n`
                : "") +
              "For LLM-judged verdicts install Claude Code (https://code.claude.com), export ANTHROPIC_API_KEY, or start a local OpenAI-compatible server (Ollama/MLX).",
          );
          return { engine: null, escalate: null };
        }
      }
    }

    if (model?.includes(",")) {
      throw new Error(
        'Comma-separated model lists are only for --calibrate ranking — pick ONE model for a check run.',
      );
    }
    if (effective === "openai" && !model) {
      const found = await discoverLocalModels(openaiBase);
      if (found?.authRequired) {
        throw new Error(`${openaiBase} requires an API key — export OPENAI_API_KEY.`);
      }
      if (!found?.models.length) {
        throw new Error(
          `No model server reachable at ${openaiBase} — start one (Ollama/MLX/vLLM) or pass --openai-url / --model.`,
        );
      }
      if (found.models.length > 20) {
        throw new Error(
          `${openaiBase} offers ${found.models.length} models — that looks like an aggregator (OpenRouter?). Auto-picking would be arbitrary and possibly expensive; pass --model explicitly.`,
        );
      }
      model = found.models[0];
      console.error(
        `Local server: using model ${model}` +
          (found.models.length > 1
            ? ` (override with --model; also available: ${found.models.slice(1, 6).join(", ")})`
            : "") +
          ".",
      );
    }

    let primary = selectEngine({ engine: effective, model, openaiUrl: values["openai-url"] });
    if (primary && !values["no-cache"]) primary = withVerdictCache(primary);

    const escOpt = values.escalate as "auto" | "off" | "claude-cli" | "api" | "openai";
    if (!["auto", "off", "claude-cli", "api", "openai"].includes(escOpt)) {
      throw new Error(`--escalate must be auto, off, claude-cli, api or openai (got "${values.escalate}")`);
    }
    let second: JudgeEngine | null = null;
    if (primary && escOpt !== "off") {
      if (escOpt === "auto") {
        // Only local primaries need a stronger reviewer by default.
        if (effective === "openai") {
          if (await commandExists("claude")) {
            second = selectEngine({ engine: "claude-cli", model: values["escalate-model"] });
          } else if (process.env.ANTHROPIC_API_KEY) {
            second = selectEngine({ engine: "api", model: values["escalate-model"] });
          }
          if (second) {
            console.error(
              `Escalation engine for release-critical verdicts: ${second.name} (disable with --escalate off).`,
            );
          }
        }
      } else {
        second = selectEngine({
          engine: escOpt,
          model: values["escalate-model"],
          openaiUrl: values["openai-url"],
        });
      }
      if (second && !values["no-cache"]) second = withVerdictCache(second);
    }
    return { engine: primary, escalate: second };
  }

  if (values.calibrate) {
    if (!engine) {
      throw new Error(
        "--calibrate needs a judge engine (claude CLI, ANTHROPIC_API_KEY, or a local OpenAI-compatible server).",
      );
    }
    const cal = await runCalibration(engine);
    printCalibration(cal);
    return cal.passed === cal.outcomes.length ? 0 : 1;
  }

  if (!values.local && !(await commandExists("gh"))) {
    throw new Error(
      "The GitHub CLI (gh) is required for GitHub sources — install it from https://cli.github.com and run `gh auth login`. Alternatively check a local clone with --local <path>.",
    );
  }

  console.error(`Loading release data${values.local ? ` from ${values.local}` : ` for ${positionals[0]}`}…`);
  let data;
  let context;
  if (values.local) {
    data = await loadLocalRelease({
      repo: values.local,
      head: values.head,
      base: values.base,
      notesFile: values["notes-file"],
    });
    context = await localRepoContext(values.local, data.headRef);
  } else {
    [data, context] = await Promise.all([
      loadGithubRelease({ repo: positionals[0], tag: values.tag, base: values.base }),
      fetchGithubContext(positionals[0]),
    ]);
  }

  if (values["notes-file"] && !values.local) {
    data.notes = await readFile(values["notes-file"], "utf8");
  }

  if (!values.local) {
    const truncated = data.warnings.some((w) => w.includes("full coverage"));
    if (truncated) {
      console.error("Compare API truncated the diff — falling back to a partial clone…");
      try {
        const dir = join(tmpdir(), "comparereleaseii-cache", "clones", positionals[0].replace("/", "_"));
        await ensureClone(`https://github.com/${positionals[0]}.git`, dir);
        const range = await loadLocalRange(dir, data.baseRef, data.headRef);
        data = {
          ...data,
          ...range,
          warnings: data.warnings
            .filter((w) => !w.includes("full coverage"))
            .concat("Diff loaded from a local partial clone (compare API truncated)."),
        };
      } catch (err) {
        data.warnings.push(
          `Partial-clone fallback failed: ${(err as Error).message.slice(0, 120)}`,
        );
      }
    }
  }

  const claims = parseClaims(data.notes);
  if (!claims.length) {
    throw new Error("No claims found in the release notes — nothing to check.");
  }
  console.error(
    `${claims.length} claims parsed from the notes of ${data.headRef}; verifying against ${data.commits.length} commits…`,
  );

  if (values.estimate) {
    const est = { calls: 0, chars: 0 };
    const stub: JudgeEngine = {
      name: "estimate",
      judge: async (p: string) => {
        est.calls++;
        est.chars += p.length;
        return '{"verdict":"partial","confidence":0.5,"files":[],"reasoning":"(estimate)"}';
      },
    };
    const results = await verifyClaims(data, claims, {
      judgeMode: judgeMode === "off" ? "auto" : judgeMode,
      engine: stub,
      concurrency: 8,
      maxHunks: 6,
      maxEvidenceChars: 20000,
    });
    const change = results.filter((r) => r.claim.kind === "change");
    const generated = results.filter((r) => r.generated).length;
    const inTokens = Math.round(est.chars / 4);
    const reserve = Math.ceil(est.calls * 0.5);
    const timeMin = ((est.calls + reserve / 2) * 10) / Number(values.concurrency) / 60;
    const apiCost = (inTokens / 1e6) * 1.0 + ((est.calls * 300) / 1e6) * 5.0;
    console.log(`\nCost estimate — ${data.repoLabel} ${data.baseRef} → ${data.headRef}`);
    console.log(`  Diff: ${data.commits.length} commits, ${data.files.length} files, ±${data.files.reduce((s, f) => s + f.additions + f.deletions, 0)} lines`);
    console.log(`  Claims: ${results.length} total — ${change.length} checkable (${generated} generated), ${results.length - change.length} informational`);
    console.log(`  LLM judge calls (auto): ${est.calls}, plus up to ${reserve} for retrieval rounds / second opinions`);
    console.log(`  Est. input ~${(inTokens / 1000).toFixed(0)}k tokens · wall clock ~${timeMin < 1 ? "<1" : timeMin.toFixed(0)} min via claude-cli · API cost ≈ $${apiCost.toFixed(2)} (haiku)`);
    console.log(`  GitHub API calls: ~${3 + data.commits.length + 2 * Number(values.baseline)} (compare, per-commit diffs, baseline)`);
    console.log(`  Verdict cache: repeated runs on unchanged data are free and deterministic.`);
    return 0;
  }

  const baselineCount = Number(values.baseline);
  const baselinePromise =
    !values.local && baselineCount > 0
      ? buildSnapshots(positionals[0], { count: baselineCount, before: data.headRef }).catch(
          () => null,
        )
      : Promise.resolve(null);
  const [results, baselineSnapshots] = await Promise.all([
    verifyClaims(data, claims, {
      judgeMode,
      engine,
      escalateEngine: escalate,
      concurrency: Number(values.concurrency),
      maxHunks: 6,
      maxEvidenceChars: 20000,
    }),
    baselinePromise,
  ]);
  const baseline = baselineSnapshots?.length ? summarizeBaseline(baselineSnapshots) : null;

  const coverage = values["no-reverse"] ? null : await computeCoverage(data, claims, results);
  const metrics = computeMetrics({ data, results, coverage, context, baseline });

  const report: Report = {
    repoLabel: data.repoLabel,
    baseRef: data.baseRef,
    headRef: data.headRef,
    stats: {
      commits: data.commits.length,
      files: data.files.length,
      additions: data.files.reduce((s, f) => s + f.additions, 0),
      deletions: data.files.reduce((s, f) => s + f.deletions, 0),
    },
    results,
    uncovered: coverage?.uncovered ?? [],
    reverseChecked: !values["no-reverse"],
    metrics,
    warnings: data.warnings,
    engine: engine ? engine.name : "off (deterministic only)",
    linkBase: values.local ? undefined : `https://github.com/${positionals[0]}`,
  };

  printTerminal(report);
  if (values.md) {
    await writeFile(values.md, toMarkdown(report));
    console.error(`\nMarkdown report written to ${values.md}`);
  }
  if (values.json) {
    await writeFile(values.json, JSON.stringify(report, null, 2));
    console.error(`JSON report written to ${values.json}`);
  }
  if (values.html) {
    await writeFile(values.html, toHtml(report));
    console.error(`HTML report written to ${values.html}`);
  }
  return exitCode(report, failOn);
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`error: ${(err as Error).message}`);
    process.exit(2);
  });
