#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
import { parseArgs } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { assertCloneUrl, ensureClone, loadLocalRelease, localRepoContext } from "./sources/local.ts";
import { fetchForgeReleases, parseRepoUrl } from "./sources/forge.ts";
import { pickBaseRelease } from "./sources/github.ts";
import { cloneDirFor, VERSION } from "./paths.ts";
import { parseClaims } from "./claims.ts";
import { resolveEngines, discoverLocalModels, type JudgeEngine } from "./judge.ts";
import {
  runCalibration,
  printCalibration,
  calibrateModels,
  printModelRanking,
  rankCalibrations,
  gateCalibration,
  loadReference,
} from "./calibrate.ts";
import { commandExists } from "./util.ts";
import { verifyClaims, computeCoverage } from "./verify.ts";
import { suggestNotes } from "./suggest.ts";
import { printTerminal, toMarkdown, exitCode } from "./report.ts";
import { toHtml } from "./html.ts";
import {
  buildSnapshots,
  cloneHistory,
  githubHistory,
  printTimeline,
  type HistoryRelease,
  type HistorySource,
} from "./history.ts";
import { analyzeRelease, loadGithubReleaseData, type CheckSettings } from "./check.ts";
import { runWatch } from "./watch.ts";
import { runWatchInit, runWatchAdd, runWatchRemove, runWatchList } from "./watchlist.ts";
import { loadGuidelines } from "./guidelines.ts";
import type { Report } from "./types.ts";

// Wrappers (e.g. the gh extension) set this so help and errors show the
// command the user actually typed instead of the bare bin name.
const PROG = process.env.COMPARERELEASE_PROG ?? "comparerelease";
const USAGE = `${PROG} — fact-check release notes against the actual code diff

Usage:
  ${PROG} <owner/repo> [--tag <tag>] [--base <tag>]
  ${PROG} --repo-url <url> [--tag <ref>] [--base <ref>] [--notes-file <file>]
  ${PROG} --local <path> [--head <ref>] [--base <ref>] [--notes-file <file>]
  ${PROG} watch --config <file> [--notify <cmd>]
  ${PROG} watch init|add|remove|list [--config <file>]
  ${PROG} guidelines [--full]

Options:
  --tag <tag>         Release tag to check (default: latest release)
  --base <ref>        Base tag/ref to diff against (default: previous release/tag)
  --local <path>      Use a local git repo instead of the GitHub API
  --repo-url <url>    Any forge: clone the URL (cached) and check it like
                      --local. Works with Forgejo, GitLab, private and
                      air-gapped repos — no forge API, so the notes come from
                      --notes-file or the CHANGELOG section
  --head <ref>        Head ref for --local/--repo-url (default: latest tag;
                      --tag means the same thing there)
  --notes-file <file> Check this notes file instead of the published notes
                      (for --local/--repo-url the default is the CHANGELOG
                      section)
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
                      no-evidence never fails a release whose diff contains no
                      source-code changes — nothing could be checked there
  --no-reverse        Skip the completeness check (undocumented commits)
  --baseline <n>      Compare against the n previous releases for anomaly
                      detection (default: 5; 0 disables). Past releases come
                      from the forge API, or from the tags the CHANGELOG
                      documents when the host has none
  --suggest           Draft a release-note line for the highest-churn
                      undocumented commits (needs a judge engine)
  --suggest-limit <n> Max commits to draft for, highest churn first
                      (default: 15 — bounds the extra LLM calls)
  --history <n>       Print a release-history timeline instead of a check
  --estimate          Print a cost/effort estimate instead of judging
  --no-cache          Bypass the on-disk verdict cache
  --version           Print the version and exit
  -h, --help          Show this help

Watch mode (continuous release monitoring):
  ${PROG} watch --config watch.json
      --config <file>   JSON config: repos to watch + per-repo options
      --notify <cmd>    Run <cmd> <json-report-path> for each flagged release
      --state <file>    Override the state-file path from the config
      --reports <dir>   Override the reports directory from the config
      --no-cache        Bypass the on-disk verdict cache
  A run only checks releases newer than the last run (state file) and
  regenerates <reports>/index.html; exit code is the worst of the batch.

  Building the repo list (--config defaults to ./watch.json here):
  ${PROG} watch init [--from watched,starred,notifications]
      Pick repos interactively from what YOUR GitHub account already follows:
      watched repos, stars, and repos whose release notifications you got.
  ${PROG} watch add <owner/repo>     add one repo (scripts/CI-friendly)
  ${PROG} watch remove <owner/repo>  drop a repo from the config
  ${PROG} watch list                 show the watched repos

Guidelines (hand release-note writing rules to an LLM coding agent):
  ${PROG} guidelines >> AGENTS.md
      --full   print the full writing-release-notes guide instead of the
               condensed agent checklist

Examples:
  ${PROG} restic/restic --tag v0.19.1
  ${PROG} juanfont/headscale --estimate
  ${PROG} --repo-url https://git.example.com/team/app.git --tag v1.3.0
  ${PROG} --local ~/src/myrepo --base v1.2.0 --head v1.3.0 --notes-file notes.md
  ${PROG} watch init
  ${PROG} watch --config watch.json --notify 'ntfy publish releases'
  ${PROG} guidelines >> AGENTS.md
`;

/** Parse a numeric flag or fail loudly — NaN silently disables features
 * downstream (pooled() with a NaN limit runs zero workers and "completes"). */
function intFlag(name: string, raw: string, min: number): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`--${name} must be an integer ≥ ${min} (got "${raw}")`);
  }
  return n;
}

async function main(): Promise<number> {
  if (process.argv[2] === "watch") {
    return runWatchCli(process.argv.slice(3));
  }
  if (process.argv[2] === "guidelines") {
    return runGuidelinesCli(process.argv.slice(3));
  }
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      tag: { type: "string" },
      base: { type: "string" },
      local: { type: "string" },
      "repo-url": { type: "string" },
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
      suggest: { type: "boolean", default: false },
      "suggest-limit": { type: "string", default: "15" },
      history: { type: "string" },
      estimate: { type: "boolean", default: false },
      "no-cache": { type: "boolean", default: false },
      version: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  // Before the usage check below: `--version` carries no repo argument, and
  // that check treats a missing one as a usage error (exit 2).
  if (values.version) {
    console.log(`comparereleaseii ${VERSION}`);
    return 0;
  }

  if (
    values.help ||
    (!positionals.length && !values.local && !values["repo-url"] && !values.calibrate)
  ) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }
  if (values.local && values["repo-url"]) {
    throw new Error("--local and --repo-url both name the repository — pass one.");
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
  const escalateOpt = values.escalate as "auto" | "off" | "claude-cli" | "api" | "openai";
  if (!["auto", "off", "claude-cli", "api", "openai"].includes(escalateOpt)) {
    throw new Error(`--escalate must be auto, off, claude-cli, api or openai (got "${values.escalate}")`);
  }
  const concurrency = intFlag("concurrency", values.concurrency, 1);
  const baseline = intFlag("baseline", values.baseline, 0);
  const suggestLimit = intFlag("suggest-limit", values["suggest-limit"], 0);
  const historyCount = values.history === undefined ? null : intFlag("history", values.history, 1);

  // Every forge speaks git, so a clone answers almost everything the check
  // asks: diff, commits, subjects, authors, tags. Only the published notes and
  // which tags are releases live on the forge, and one flat endpoint on
  // Forgejo/Gitea and GitLab covers both. Without it — a plain git host, an
  // air-gapped mirror, a token nobody exported — the CHANGELOG section is the
  // fallback, which is what --local has always used.
  let localPath = values.local;
  let cloneUrl: string | undefined;
  let forgeNotes: string | undefined;
  let forgeBase: string | undefined;
  let forgeLabel: string | undefined;
  let forgeReleases: HistoryRelease[] | undefined;
  if (values["repo-url"]) {
    const url = assertCloneUrl(values["repo-url"]);
    const dir = await cloneDirFor(url);
    if (!dir) {
      throw new Error(
        "--repo-url needs a private directory to clone into — set XDG_CACHE_HOME to a writable path.",
      );
    }
    cloneUrl = url;
    localPath = dir;
    console.error(`Cloning ${url} (cached at ${localPath})…`);
    await ensureClone(url, localPath);

    const target = parseRepoUrl(url);
    const forge = target && (await fetchForgeReleases(target));
    if (target) forgeLabel = `${target.owner}/${target.repo}`;
    if (forge) {
      const wanted = values.tag ?? values.head;
      const release = wanted
        ? forge.releases.find((r) => r.tag_name === wanted)
        : forge.releases.find((r) => !r.draft && !r.prerelease);
      forgeReleases = forge.releases
        .filter((r) => !r.draft && !r.prerelease)
        .map((r) => ({
          tag: r.tag_name,
          notes: r.body,
          date: r.published_at?.slice(0, 10) ?? null,
        }));
      if (release) {
        forgeNotes = release.body;
        forgeBase = pickBaseRelease(forge.releases, release.tag_name) ?? undefined;
        values.head ??= release.tag_name;
        console.error(
          `Published notes for ${release.tag_name} from the ${forge.kind} API at ${target!.origin}.`,
        );
      } else if (wanted) {
        console.error(
          `${wanted} is not a published release on ${target!.origin} — falling back to the CHANGELOG section.`,
        );
      }
    } else if (target) {
      console.error(
        `No Forgejo/Gitea or GitLab release API at ${target.origin} — using the CHANGELOG section for the notes.`,
      );
    }
  }

  // Where the baseline reads the repo's past releases. The clone answers the
  // diffs either way; the notes come from the forge when it has an API and
  // from the CHANGELOG when it does not.
  const history: HistorySource | null = localPath
    ? cloneHistory({
        dir: localPath,
        slug: forgeLabel ?? basename(localPath),
        cacheKey: cloneUrl ?? `local:${localPath}`,
        releases: forgeReleases,
      })
    : positionals[0]
      ? githubHistory(positionals[0])
      : null;

  if (historyCount !== null) {
    if (!history) {
      throw new Error(
        "--history needs a repository: pass owner/repo, --repo-url <url>, or --local <path>.",
      );
    }
    const snapshots = await buildSnapshots(history, { count: historyCount, concurrency });
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
        concurrency,
      });
      printModelRanking(cals);
      const best = rankCalibrations(cals)[0];
      return best && gateCalibration(best).verdict === "sole-judge" ? 0 : 1;
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

  const { engine, escalate } = await resolveEngines({
    judgeMode,
    engine: engineName,
    model: values.model,
    openaiUrl: values["openai-url"],
    escalate: escalateOpt,
    escalateModel: values["escalate-model"],
    cache: !values["no-cache"],
  });

  if (values.calibrate) {
    if (!engine) {
      throw new Error(
        "--calibrate needs a judge engine (claude CLI, ANTHROPIC_API_KEY, or a local OpenAI-compatible server).",
      );
    }
    const cal = await runCalibration(engine, concurrency);
    printCalibration(cal, await loadReference());
    if (values.json) {
      await writeFile(values.json, JSON.stringify(cal, null, 2));
      console.error(`JSON calibration written to ${values.json}`);
    }
    return gateCalibration(cal).verdict === "sole-judge" ? 0 : 1;
  }

  if (!localPath && !(await commandExists("gh"))) {
    throw new Error(
      "The GitHub CLI (gh) is required for GitHub sources — install it from https://cli.github.com and run `gh auth login`. Alternatively check any forge with --repo-url <url>, or a local clone with --local <path>.",
    );
  }

  console.error(`Loading release data${localPath ? ` from ${localPath}` : ` for ${positionals[0]}`}…`);
  let data;
  let context;
  if (localPath) {
    data = await loadLocalRelease({
      repo: localPath,
      // --tag is what a reader types for "this release"; for a clone that is
      // the head ref, and there is no separate release object to name.
      head: values.head ?? values.tag,
      // An explicit --base always wins; otherwise the forge's own release
      // order beats "the tag before this one", which is what a clone can see.
      base: values.base ?? forgeBase,
      notesFile: values["notes-file"],
      notes: forgeNotes,
      repoLabel: forgeLabel,
    });
    context = await localRepoContext(localPath, data.headRef);
  } else {
    ({ data, context } = await loadGithubReleaseData(positionals[0], {
      tag: values.tag,
      base: values.base,
      notesFile: values["notes-file"],
    }));
  }

  if (values.estimate) {
    const claims = parseClaims(data.notes);
    if (!claims.length) {
      throw new Error("No claims found in the release notes — nothing to check.");
    }
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

    let suggestTargets = 0;
    if (values.suggest && !values["no-reverse"]) {
      // Reuse the same stub engine so its draft calls land in est.calls/chars —
      // the printed cost already covers --suggest, not just claim verification.
      const coverage = await computeCoverage(data, claims, results);
      suggestTargets = Math.min(coverage.uncovered.length, suggestLimit);
      await suggestNotes(data, coverage.uncovered, {
        engine: stub,
        concurrency: 8,
        limit: suggestLimit,
        maxEvidenceChars: 20000,
      });
    }

    const inTokens = Math.round(est.chars / 4);
    const reserve = Math.ceil(est.calls * 0.5);
    const timeMin = ((est.calls + reserve / 2) * 10) / concurrency / 60;
    const apiCost = (inTokens / 1e6) * 1.0 + ((est.calls * 300) / 1e6) * 5.0;
    console.log(`\nCost estimate — ${data.repoLabel} ${data.baseRef} → ${data.headRef}`);
    console.log(`  Diff: ${data.commits.length} commits, ${data.files.length} files, ±${data.files.reduce((s, f) => s + f.additions + f.deletions, 0)} lines`);
    console.log(`  Claims: ${results.length} total — ${change.length} checkable (${generated} generated), ${results.length - change.length} informational`);
    if (values.suggest) {
      console.log(
        values["no-reverse"]
          ? `  --suggest: no-op (--no-reverse disables the completeness check it drafts for)`
          : `  --suggest: up to ${suggestTargets} undocumented commit(s) drafted (--suggest-limit ${values["suggest-limit"]}), included below`,
      );
    }
    console.log(`  LLM judge calls (auto): ${est.calls}, plus up to ${reserve} for retrieval rounds / second opinions`);
    console.log(`  Est. input ~${(inTokens / 1000).toFixed(0)}k tokens · wall clock ~${timeMin < 1 ? "<1" : timeMin.toFixed(0)} min via claude-cli · API cost ≈ $${apiCost.toFixed(2)} (haiku)`);
    if (localPath) {
      console.log(
        `  Baseline: ${values.baseline} past release(s) diffed out of the clone — no API, but a blobless clone fetches their file contents on demand, so budget roughly one head-sized diff each.`,
      );
    } else {
      console.log(`  GitHub API calls: ~${3 + data.commits.length + 2 * baseline} (compare, per-commit diffs, baseline)`);
    }
    console.log(`  Verdict cache: repeated runs on unchanged data are free and deterministic.`);
    return 0;
  }

  const settings: CheckSettings = {
    judgeMode,
    engine,
    escalateEngine: escalate,
    concurrency,
    reverse: !values["no-reverse"],
    baseline,
    history,
    suggest: values.suggest,
    suggestLimit,
  };
  const report: Report = await analyzeRelease(
    data,
    context,
    localPath ? null : positionals[0],
    settings,
  );

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

async function runWatchCli(argv: string[]): Promise<number> {
  if (["init", "add", "remove", "list"].includes(argv[0])) {
    return runWatchListCli(argv[0] as "init" | "add" | "remove" | "list", argv.slice(1));
  }
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: "string" },
      notify: { type: "string" },
      state: { type: "string" },
      reports: { type: "string" },
      "no-cache": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help || !values.config) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }
  const raw = await readFile(values.config, "utf8").catch((err) => {
    throw new Error(
      `Cannot read watch config ${values.config} (${(err as Error).message}) — see docs/watchdog.md for the format.`,
    );
  });
  let config;
  try {
    config = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Watch config ${values.config} is not valid JSON: ${(err as Error).message}`,
    );
  }
  return runWatch(config, {
    configPath: values.config,
    notify: values.notify,
    stateFile: values.state,
    reportsDir: values.reports,
    cache: !values["no-cache"],
  });
}

async function runWatchListCli(
  cmd: "init" | "add" | "remove" | "list",
  argv: string[],
): Promise<number> {
  const options: Record<string, { type: "string" | "boolean"; short?: string; default?: string | boolean }> = {
    config: { type: "string", default: "watch.json" },
    help: { type: "boolean", short: "h", default: false },
  };
  if (cmd === "init") {
    options.from = { type: "string", default: "watched,starred,notifications" };
  }
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (!(await commandExists("gh"))) {
    throw new Error(
      "The GitHub CLI (gh) is required — install it from https://cli.github.com and run `gh auth login`.",
    );
  }
  const configPath = values.config as string;
  if (cmd === "init" || cmd === "list") {
    if (positionals.length) {
      throw new Error(`watch ${cmd} takes no arguments (got "${positionals.join(" ")}").`);
    }
    return cmd === "init"
      ? runWatchInit({ configPath, from: values.from as string })
      : runWatchList({ configPath });
  }
  if (positionals.length !== 1) {
    throw new Error(`watch ${cmd} needs exactly one repo: ${PROG} watch ${cmd} owner/repo`);
  }
  return cmd === "add"
    ? runWatchAdd({ configPath, repo: positionals[0] })
    : runWatchRemove({ configPath, repo: positionals[0] });
}

async function runGuidelinesCli(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      full: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  console.log(await loadGuidelines({ full: values.full }));
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`error: ${(err as Error).message}`);
    process.exit(2);
  });
