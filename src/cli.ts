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
import { addGoldenCase } from "./golden.ts";
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
import { cacheBytes, pruneVerdictCache, verdictCacheStats } from "./cache.ts";
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
  ${PROG} cache [stats|gc] [--all]

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
  --add-golden <report.json> <claim-id> <verdict> [why]
                      Lift a claim out of a stored --json report into the
                      golden set with the verdict it SHOULD have had, so a
                      misjudgement you noticed becomes a regression test the
                      next --calibrate answers. The release is reloaded and
                      the evidence rebuilt through the same selection the
                      check makes. verdict: verified | partial | no-evidence
                      | contradicted. The case lands in the "field" category:
                      --calibrate runs it and names it when a judge gets it
                      wrong, but it never moves the fitness verdict — that
                      gate is frozen, and promoting a case into it is a
                      deliberate hand-edit (--category <c> does it at lift
                      time). --golden-file <path> picks the target set, and
                      --local <path> names the clone for a report that was
                      checked locally
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
                      was not measured (--no-reverse) or that scored
                      unverified never fails this gate
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

Verdict cache (the tool version is part of every key — an upgrade orphans the
entries it wrote, and a check sweeps them once per build on its own):
  ${PROG} cache stats    entries and bytes per build that wrote them
  ${PROG} cache gc       remove what this build can no longer read
      --all    remove this build's entries too — the next run re-judges
               everything, which is what a changed parser wants to measure

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

/** Parse a one-of-these flag or fail loudly — parseArgs only proves it is a
 * string, and an unrecognised word used to pass straight through as a mode
 * nobody implements. The error names the flag, the choices and what arrived. */
function enumFlag<T extends string>(name: string, raw: string, allowed: readonly T[]): T {
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new Error(
      `--${name} must be ${allowed.slice(0, -1).join(", ")} or ${allowed[allowed.length - 1]} (got "${raw}")`,
    );
  }
  return raw as T;
}

/** `--component <pin name>=<repo>`, the form the sub-check needs it in. */
function parseComponents(specs: string[]): Record<string, string> {
  const components: Record<string, string> = {};
  for (const spec of specs) {
    const eq = spec.indexOf("=");
    if (eq < 1 || eq === spec.length - 1) {
      throw new Error(
        `--component expects <pin name>=<owner/repo or URL> (got "${spec}") — e.g. WEB_ASSETS_VERSION=opencloud-eu/web.`,
      );
    }
    components[spec.slice(0, eq)] = spec.slice(eq + 1);
  }
  return components;
}

/** The report in every format the run asked for. Each path is announced on
 * stderr, so a piped stdout carries the report and nothing else. */
async function writeReports(
  report: Report,
  paths: { md?: string; json?: string; html?: string },
): Promise<void> {
  if (paths.md) {
    await writeFile(paths.md, toMarkdown(report));
    console.error(`\nMarkdown report written to ${paths.md}`);
  }
  if (paths.json) {
    await writeFile(paths.json, JSON.stringify(report, null, 2));
    console.error(`JSON report written to ${paths.json}`);
  }
  if (paths.html) {
    await writeFile(paths.html, toHtml(report));
    console.error(`HTML report written to ${paths.html}`);
  }
}

async function main(): Promise<number> {
  if (process.argv[2] === "watch") {
    return runWatchCli(process.argv.slice(3));
  }
  if (process.argv[2] === "guidelines") {
    return runGuidelinesCli(process.argv.slice(3));
  }
  if (process.argv[2] === "cache") {
    return runCacheCli(process.argv.slice(3));
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
      "add-golden": { type: "string" },
      category: { type: "string" },
      "golden-file": { type: "string" },
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
    (!positionals.length &&
      !values.local &&
      !values["repo-url"] &&
      !values.calibrate &&
      !values["add-golden"])
  ) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }

  // Before every source and engine decision below: this reads a report that
  // already exists and asks no judge anything. It takes over main() the way
  // --calibrate does.
  if (values["add-golden"]) {
    return runAddGolden(values["add-golden"], positionals, {
      category: values.category,
      goldenFile: values["golden-file"],
      local: values.local,
    });
  }
  if (values.local && values["repo-url"]) {
    throw new Error("--local and --repo-url both name the repository — pass one.");
  }

  const judgeMode = enumFlag("judge", values.judge, ["auto", "all", "off"] as const);
  const engineName = enumFlag("engine", values.engine, ["claude-cli", "api", "openai", "off"] as const);
  const failOn = enumFlag("fail-on", values["fail-on"], ["none", "contradicted", "no-evidence"] as const);
  const escalateOpt = enumFlag("escalate", values.escalate, ["auto", "off", "claude-cli", "api", "openai"] as const);
  const lensOpt =
    values.lens === undefined
      ? undefined
      : enumFlag("lens", values.lens, ["operator", "integrator", "user", "all"] as const);

  const minCoverage =
    values["min-coverage"] === undefined
      ? undefined
      : intFlag("min-coverage", values["min-coverage"], 0);
  if (minCoverage !== undefined && minCoverage > 100) {
    throw new Error(`--min-coverage is a percentage 0–100 (got "${values["min-coverage"]}")`);
  }
  const concurrency = intFlag("concurrency", values.concurrency, 1);
  const baseline = intFlag("baseline", values.baseline, 0);
  const suggestLimit = intFlag("suggest-limit", values["suggest-limit"], 0);
  const findingsBudget =
    values["findings-budget"] === undefined
      ? undefined
      : intFlag("findings-budget", values["findings-budget"], 1000);
  const historyCount = values.history === undefined ? null : intFlag("history", values.history, 1);

  const components = parseComponents(values.component ?? []);

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
  await writeReports(report, values);
  return exitCode(report, failOn, minCoverage);
}

/**
 * `--add-golden <report.json> <claim-id> <verdict> [why]`. The three
 * positionals are the human's judgement, and the command exists to record
 * exactly that: what the tool answered is in the report, what it should have
 * answered is what only a person can supply.
 */
async function runAddGolden(
  reportPath: string,
  positionals: string[],
  opts: { category?: string; goldenFile?: string; local?: string },
): Promise<number> {
  const [rawId, verdict, ...rest] = positionals;
  if (rawId === undefined || verdict === undefined) {
    throw new Error(
      `--add-golden needs the claim and the verdict it should have had: ` +
        `${PROG} --add-golden <report.json> <claim-id> <verdict> [why]. ` +
        `The claim id is the "id" field of the entry in the report's results array.`,
    );
  }
  const claimId = intFlag("add-golden claim id", rawId, 0);
  const added = await addGoldenCase({
    reportPath,
    claimId,
    verdict,
    why: rest.length ? rest.join(" ") : undefined,
    category: opts.category,
    goldenFile: opts.goldenFile,
    local: opts.local,
  });
  const gc = added.case;
  console.error(
    `Added ${gc.name} to ${added.path} (${added.total} cases).\n` +
      `  claim:     ${gc.claim.slice(0, 100)}\n` +
      `  it said:   ${gc.lifted!.got}\n` +
      `  you say:   ${gc.expected.join(" | ")}\n` +
      `  category:  ${gc.category}\n` +
      `  evidence:  ${gc.hunks.length} hunk(s) from ${new Set(gc.hunks.map((h) => h.path)).size} file(s)\n` +
      (gc.category === "field"
        ? `--calibrate now runs this case and names it when a judge gets it wrong, but a field case never\n` +
          `moves the fitness verdict: the gate is frozen, and one case lifted this morning must not be able\n` +
          `to reclassify a judge that has been fine for months. Once you are sure the case is right AND\n` +
          `general, move its "category" to core or security by hand — then it gates.\n` +
          (added.securityLooking
            ? `This one reads like security material, which is the one category the gate treats as disqualifying.\n`
            : "")
        : `Category ${gc.category} gates: from now on a judge that gets this wrong is downgraded.\n`) +
      `Run ${PROG} --calibrate to see whether your judge gets it right now.`,
  );
  return 0;
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

/**
 * The verdict cache from the outside: what it holds, and removing what this
 * build can no longer read. A check sweeps once per build on its own, so this
 * exists for the two things automation cannot do — showing the histogram
 * before deciding, and `--all` when a re-judge from scratch is the point.
 */
async function runCacheCli(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      all: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const cmd = positionals[0] ?? "stats";
  if (cmd !== "stats" && cmd !== "gc") {
    console.error(`error: unknown cache subcommand "${cmd}" — expected stats or gc.`);
    return 2;
  }
  if (cmd === "gc") {
    const result = await pruneVerdictCache({ all: values.all });
    if (!result.scanned) {
      console.error("error: no usable cache directory — nothing to collect.");
      return 1;
    }
    console.log(
      `Removed ${result.removed} entr${result.removed === 1 ? "y" : "ies"} (${cacheBytes(result.freed)}); ` +
        `${result.kept} kept for this build (${VERSION}).`,
    );
    return 0;
  }
  const stats = await verdictCacheStats();
  if (!stats.dir) {
    console.error("error: no usable cache directory.");
    return 1;
  }
  console.log(`verdict cache — ${stats.dir}`);
  console.log(`  ${stats.entries} entries · ${cacheBytes(stats.bytes)}\n`);
  for (const row of stats.byVersion) {
    const label = row.version === null ? "unreadable" : row.version;
    console.log(
      `  ${label.padEnd(14)}${String(row.entries).padStart(7)}  ${cacheBytes(row.bytes).padStart(9)}` +
        (row.version === VERSION ? "  ← this build" : ""),
    );
  }
  const dead = stats.entries - (stats.byVersion.find((r) => r.version === VERSION)?.entries ?? 0);
  if (dead) {
    const pct = ((dead / stats.entries) * 100).toFixed(1);
    console.log(
      `\n  ${dead} entries (${pct} %) were written by other builds. The version is part of` +
        `\n  every key, so nothing will read them again — \`${PROG} cache gc\` removes them.`,
    );
  }
  return 0;
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
