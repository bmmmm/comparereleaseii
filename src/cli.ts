#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
import { parseArgs } from "node:util";
import { writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { loadLocalRelease, localRepoContext } from "./sources/local.ts";
import { VERSION } from "./paths.ts";
import { resolveEngines, discoverLocalModels } from "./judge.ts";
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
import { printEstimate } from "./estimate.ts";
import { printTerminal, toMarkdown, exitCode } from "./report.ts";
import { toHtml } from "./html.ts";
import {
  buildSnapshots,
  cloneHistory,
  githubHistory,
  printTimeline,
  type HistorySource,
} from "./history.ts";
import {
  analyzeRelease,
  componentLoader,
  loadForgeRelease,
  loadGithubReleaseData,
  prepareForgeTarget,
  type CheckSettings,
  type ForgeTarget,
  type RepoLink,
} from "./check.ts";
import { runWatch, runBackfill } from "./watch.ts";
import {
  requireConfig,
  runWatchInit,
  runWatchAdd,
  runWatchRemove,
  runWatchList,
} from "./watchlist.ts";
import { runWatchSetup } from "./setup.ts";
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
  ${PROG} watch backfill [repo…] --config <file> --releases <n> | --since <date>
  ${PROG} watch init|add|remove|list [--config <file>]
  ${PROG} watch setup
  ${PROG} guidelines [--full]

Options:
  --tag <tag>         Release tag to check (default: latest release)
  --base <ref>        Base tag/ref to diff against (default: previous release/tag)
  --local <path>      Use a local git repo instead of the GitHub API
  --repo-url <url>    Any forge: clone the URL (cached) and check it. Notes
                      and past releases come from the forge's release API
                      (Forgejo/Gitea, GitLab); a host without one falls back
                      to --notes-file or the CHANGELOG section
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
  --min-coverage <n>  Also fail (exit 1) when the completeness score — the
                      percentage of changed lines the notes cover — is below
                      n. Independent of --fail-on; a release whose coverage
                      could not be measured (--no-reverse, unverified) never
                      fails this gate
  --no-reverse        Skip the completeness check (undocumented commits)
  --baseline <n>      Compare against the n previous releases for anomaly
                      detection (default: 5; 0 disables). Past releases come
                      from the forge API, or from the tags the CHANGELOG
                      documents when the host has none
  --component <k=v>   Declare a first-party component behind a version pin
                      that cannot name its own repo: pin name = owner/repo
                      (or repo URL), e.g. WEB_ASSETS_VERSION=opencloud-eu/web.
                      Repeatable. Pins that name a repo themselves (go.mod
                      paths, download URLs) are classified without this
  --no-expand         Do not sub-check first-party pin bumps. By default a
                      first-party bump whose repo is loadable gets a depth-1
                      check of its own (from, to) range — same pipeline,
                      same caches — folded into the report
  --lens <who>        operator | integrator | user | all — which audience's
                      findings the report shows; the rest folds behind a
                      count (default: all; security findings show under
                      every lens)
  --no-findings       Skip the LLM findings pass — the typed, audience-
                      tagged "what shipped" summary that runs whenever a
                      judge engine is active
  --findings-budget <chars>  Hard evidence budget for the findings pass;
                      subsystems beyond it are declared unread
                      (default: 120000)
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

  Backfill (solve the cold start — check the past the state never saw):
  ${PROG} watch backfill --config watch.json --releases 10
  ${PROG} watch backfill owner/repo --config watch.json --since 2024-01-01
      Checks past releases gap-free, oldest first: a fresh entry gets a
      median, drift detection and a filled author ledger from one command.
      States the cost and asks before checking (--yes for scripts); never
      fires --notify (flagged stays in the record); resumes after an
      interruption without re-checking. Positional repos restrict the run
      (state key, owner/repo or URL). Raise "historyLimit" in the config
      before a deep backfill — it decides how many checks the state keeps.

  Building the repo list (--config defaults to ./watch.json here):
  ${PROG} watch init [--from watched,starred,notifications]
      Pick repos interactively from what YOUR GitHub account already follows:
      watched repos, stars, and repos whose release notifications you got.
  ${PROG} watch add <owner/repo>     add one GitHub repo (scripts/CI-friendly)
  ${PROG} watch add --repo-url <url> add a Forgejo/Gitea/GitLab repo by URL
                                     (needs that forge's release API to poll)
  ${PROG} watch remove <owner/repo|url>  drop a repo from the config
  ${PROG} watch list                 show the watched repos

  From a bare machine to a scheduled routine (interactive):
  ${PROG} watch setup
      Picks a home directory (config, state, reports, log in one place),
      detects the judges this machine offers — with the calibration gate one
      answer away for a local model — writes the launchd plist or crontab
      line, and test-fires the optional notify hook. Only writes files and
      PRINTS the command that activates the schedule; installs nothing.

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
      "min-coverage": { type: "string" },
      "no-reverse": { type: "boolean", default: false },
      baseline: { type: "string", default: "5" },
      lens: { type: "string" },
      "no-findings": { type: "boolean", default: false },
      "findings-budget": { type: "string" },
      suggest: { type: "boolean", default: false },
      "suggest-limit": { type: "string", default: "15" },
      component: { type: "string", multiple: true },
      "no-expand": { type: "boolean", default: false },
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
  const minCoverage =
    values["min-coverage"] === undefined
      ? undefined
      : intFlag("min-coverage", values["min-coverage"], 0);
  if (minCoverage !== undefined && minCoverage > 100) {
    throw new Error(`--min-coverage is a percentage 0–100 (got "${values["min-coverage"]}")`);
  }
  const escalateOpt = values.escalate as "auto" | "off" | "claude-cli" | "api" | "openai";
  if (!["auto", "off", "claude-cli", "api", "openai"].includes(escalateOpt)) {
    throw new Error(`--escalate must be auto, off, claude-cli, api or openai (got "${values.escalate}")`);
  }
  const lensOpt = values.lens as "operator" | "integrator" | "user" | "all" | undefined;
  if (lensOpt !== undefined && !["operator", "integrator", "user", "all"].includes(lensOpt)) {
    throw new Error(`--lens must be operator, integrator, user or all (got "${values.lens}")`);
  }
  const concurrency = intFlag("concurrency", values.concurrency, 1);
  const baseline = intFlag("baseline", values.baseline, 0);
  const suggestLimit = intFlag("suggest-limit", values["suggest-limit"], 0);
  const findingsBudget =
    values["findings-budget"] === undefined
      ? undefined
      : intFlag("findings-budget", values["findings-budget"], 1000);
  const historyCount = values.history === undefined ? null : intFlag("history", values.history, 1);

  const components: Record<string, string> = {};
  for (const spec of values.component ?? []) {
    const eq = spec.indexOf("=");
    if (eq < 1 || eq === spec.length - 1) {
      throw new Error(
        `--component expects <pin name>=<owner/repo or URL> (got "${spec}") — e.g. WEB_ASSETS_VERSION=opencloud-eu/web.`,
      );
    }
    components[spec.slice(0, eq)] = spec.slice(eq + 1);
  }

  // Every forge speaks git, so a clone answers almost everything the check
  // asks: diff, commits, subjects, authors, tags. Only the published notes and
  // which tags are releases live on the forge, and one flat endpoint on
  // Forgejo/Gitea and GitLab covers both. Without it — a plain git host, an
  // air-gapped mirror, a token nobody exported — the CHANGELOG section is the
  // fallback, which is what --local has always used.
  let localPath = values.local;
  let forgeTarget: ForgeTarget | undefined;
  let repoLink: RepoLink | null = null;
  if (values["repo-url"]) {
    forgeTarget = await prepareForgeTarget(values["repo-url"]);
    localPath = forgeTarget.dir;
    repoLink = forgeTarget.link;
  }

  // Where the baseline reads the repo's past releases. The clone answers the
  // diffs either way; the notes come from the forge when it has an API and
  // from the CHANGELOG when it does not.
  const history: HistorySource | null = forgeTarget
    ? forgeTarget.history
    : localPath
      ? cloneHistory({
          dir: localPath,
          slug: basename(localPath),
          cacheKey: `local:${localPath}`,
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
  if (forgeTarget) {
    // --tag is what a reader types for "this release"; for a clone that is
    // the head ref, and there is no separate release object to name.
    ({ data, context } = await loadForgeRelease(forgeTarget, {
      head: values.head ?? values.tag,
      base: values.base,
      notesFile: values["notes-file"],
    }));
  } else if (localPath) {
    data = await loadLocalRelease({
      repo: localPath,
      head: values.head ?? values.tag,
      base: values.base,
      notesFile: values["notes-file"],
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
    return printEstimate(data, {
      judgeMode: judgeMode === "off" ? "auto" : judgeMode,
      concurrency,
      baseline,
      localPath: Boolean(localPath),
      suggest: Boolean(values.suggest),
      noReverse: Boolean(values["no-reverse"]),
      suggestLimit,
      findings: !values["no-findings"],
      findingsBudget,
    });
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
    components: Object.keys(components).length ? components : undefined,
    expand: values["no-expand"] ? undefined : componentLoader,
    findings: values["no-findings"] ? false : undefined,
    findingsBudget,
    audience: lensOpt === "all" ? undefined : lensOpt,
  };
  const report: Report = await analyzeRelease(
    data,
    context,
    localPath
      ? repoLink
      : positionals[0]
        ? { base: `https://github.com/${positionals[0]}`, style: "github" }
        : null,
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
  return exitCode(report, failOn, minCoverage);
}

async function runWatchCli(argv: string[]): Promise<number> {
  if (argv[0] === "setup") {
    if (argv.slice(1).some((a) => a !== "-h" && a !== "--help")) {
      throw new Error(`watch setup takes no arguments (got "${argv.slice(1).join(" ")}") — it asks everything interactively.`);
    }
    if (argv.includes("-h") || argv.includes("--help")) {
      console.log(USAGE);
      return 0;
    }
    return runWatchSetup();
  }
  if (argv[0] === "backfill") {
    return runWatchBackfillCli(argv.slice(1));
  }
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
  const config = await requireConfig(values.config);
  return runWatch(config, {
    configPath: values.config,
    notify: values.notify,
    stateFile: values.state,
    reportsDir: values.reports,
    cache: !values["no-cache"],
  });
}

async function runWatchBackfillCli(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      releases: { type: "string" },
      since: { type: "string" },
      yes: { type: "boolean", default: false },
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
  const releases =
    values.releases === undefined ? undefined : intFlag("releases", values.releases, 1);
  const config = await requireConfig(values.config);
  return runBackfill(config, {
    configPath: values.config,
    stateFile: values.state,
    reportsDir: values.reports,
    cache: !values["no-cache"],
    releases,
    since: values.since,
    yes: values.yes,
    only: positionals,
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
  if (cmd === "add") {
    options["repo-url"] = { type: "string" };
  }
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const repoUrl = values["repo-url"] as string | undefined;
  // Only the GitHub-backed commands need gh — a forge URL is polled over its
  // own API, and remove/list never leave the config file.
  const needsGh = cmd === "init" || (cmd === "add" && repoUrl === undefined);
  if (needsGh && !(await commandExists("gh"))) {
    throw new Error(
      "The GitHub CLI (gh) is required — install it from https://cli.github.com and run `gh auth login`. Forge repos can be added without it: watch add --repo-url <url>.",
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
  if (cmd === "add" && repoUrl !== undefined) {
    if (positionals.length) {
      throw new Error(
        `watch add takes owner/repo OR --repo-url <url>, not both (got "${positionals.join(" ")}").`,
      );
    }
    return runWatchAdd({ configPath, repoUrl });
  }
  if (positionals.length !== 1) {
    throw new Error(
      `watch ${cmd} needs exactly one repo: ${PROG} watch ${cmd} owner/repo` +
        (cmd === "add" ? ` — or ${PROG} watch add --repo-url <url>` : ""),
    );
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
