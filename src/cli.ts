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
import { selectEngine, type JudgeEngine } from "./judge.ts";
import { withVerdictCache } from "./cache.ts";
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
  --engine <engine>   claude-cli | api | off (default: claude-cli)
  --model <model>     Judge model (default: haiku)
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
  comparerelease dani-garcia/vaultwarden --tag 1.37.0
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

  if (values.help || (!positionals.length && !values.local)) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }

  const judgeMode = values.judge as "auto" | "all" | "off";
  const engineName = values.engine as "claude-cli" | "api" | "off";
  if (!["auto", "all", "off"].includes(judgeMode)) {
    throw new Error(`--judge must be auto, all or off (got "${values.judge}")`);
  }
  if (!["claude-cli", "api", "off"].includes(engineName)) {
    throw new Error(`--engine must be claude-cli, api or off (got "${values.engine}")`);
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

  let effectiveEngine = engineName;
  if (judgeMode !== "off" && engineName === "claude-cli" && !(await commandExists("claude"))) {
    if (process.env.ANTHROPIC_API_KEY) {
      console.error("claude CLI not found — using the Anthropic API engine instead.");
      effectiveEngine = "api";
    } else {
      console.error(
        "claude CLI not found and ANTHROPIC_API_KEY is unset — running deterministic-only.\n" +
          "For LLM-judged verdicts install Claude Code (https://code.claude.com) or export ANTHROPIC_API_KEY.",
      );
      effectiveEngine = "off";
    }
  }
  let engine =
    judgeMode === "off" ? null : selectEngine({ engine: effectiveEngine, model: values.model });
  if (engine && !values["no-cache"]) engine = withVerdictCache(engine);
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
