// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { assertRepoSlug, ghApi, pickBaseRelease, type GhRelease } from "./sources/github.ts";
import {
  fetchForgeReleasePage,
  fetchForgeReleases,
  parseRepoUrl,
  type ForgeListing,
} from "./sources/forge.ts";
import { assertCloneUrl } from "./sources/local.ts";
import { resolveEngines, type EngineOptions } from "./judge.ts";
import { judgeCallStats, resetJudgeStats } from "./cache.ts";
import { runNotify, writeJsonAtomic } from "./util.ts";
import { toWatchAtomFeed, toWatchIndexHtml } from "./watch-index.ts";
import {
  analyzeRelease,
  loadForgeRelease,
  loadGithubReleaseData,
  prepareForgeTarget,
  type CheckSettings,
  type ForgeTarget,
  type RepoLink,
} from "./check.ts";
import { githubHistory } from "./history.ts";
import { toMarkdown, exitCode } from "./report.ts";
import { toHtml } from "./html.ts";
import { reportDirOf, reportNavFor, toRepoDetailHtml } from "./watch-detail.ts";
import { safeSegment } from "./paths.ts";
import {
  DEFAULT_HISTORY_LIMIT,
  BASELINE_MIN_CHECKS,
  MAX_AUTHOR_LEDGER,
  MAX_CHECK_ATTEMPTS,
  MAX_PROMISE_LEDGER,
  baselineLevel,
  capLedger,
  carriedFromLedger,
  countSkipped,
  entryKey,
  hasDrifted,
  isFlagged,
  pickBackfillReleases,
  pickNewReleases,
  recordCheckFailure,
  recordChecked,
  recordSkip,
  releaseWebUrl,
  updateAuthorLedger,
  worstExit,
  type CheckedRelease,
  type ReleaseInfo,
  type RepoState,
  type WatchConfig,
  type WatchRepoConfig,
  type WatchState,
  type WatchedEntry,
} from "./watch-state.ts";

import type { PromiseCheck } from "./types.ts";
import type { CarriedPromise } from "./promises.ts";


function defaultStatePath(): string {
  const stateHome =
    process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(stateHome, "comparereleaseii", "watch-state.json");
}

async function loadState(path: string): Promise<WatchState> {
  try {
    const state = JSON.parse(await readFile(path, "utf8")) as WatchState;
    if (state.version !== 1 || typeof state.repos !== "object") {
      throw new Error("unrecognized shape");
    }
    return state;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(
        `State file ${path} is unreadable (${(err as Error).message}) — delete it to start fresh or pass --state <file>.`,
      );
    }
    return { version: 1, repos: {} };
  }
}

const saveState = (path: string, state: WatchState): Promise<void> =>
  writeJsonAtomic(path, state);

export function sanitizeTag(tag: string): string {
  const base = tag.replace(/[^\w.@-]+/g, "_");
  // "index" is the one basename the dashboard owns inside every report
  // directory — the history page. A release tagged `index` would have its
  // report overwritten by that page on the next write, taking the evidence
  // with it; the tag is attacker-chosen, the filename must not be. APFS
  // and NTFS are case-insensitive, so INDEX collides just the same.
  return /^index$/i.test(base) ? `${base}_` : base;
}

function validateWatchConfig(config: WatchConfig): void {
  if (!Array.isArray(config.repos) || !config.repos.length) {
    throw new Error('Watch config needs a non-empty "repos" array — see docs/watchdog.md.');
  }
  // A repository name in defaults would merge into EVERY entry — the
  // per-entry validation below could then never see a clean entry again,
  // and `{...defaults, ...entry}` would silently give repo-entries a
  // repoUrl too (two different state keys for one entry).
  if (config.defaults?.repo || config.defaults?.repoUrl) {
    throw new Error(
      'Watch config: "defaults" cannot name a repository — "repo"/"repoUrl" belong on the entries.',
    );
  }
  if (
    config.historyLimit !== undefined &&
    (!Number.isInteger(config.historyLimit) || config.historyLimit < BASELINE_MIN_CHECKS)
  ) {
    throw new Error(
      `Watch config: "historyLimit" must be an integer ≥ ${BASELINE_MIN_CHECKS} (got ${JSON.stringify(config.historyLimit)}).`,
    );
  }
  for (const r of config.repos) {
    if (r.repo && r.repoUrl) {
      throw new Error(
        `Watch config: "repo" and "repoUrl" name the same thing — pass one per entry (got both for ${JSON.stringify(r.repo)}).`,
      );
    }
    if (r.repoUrl) {
      assertCloneUrl(r.repoUrl);
      if (!parseRepoUrl(r.repoUrl)) {
        throw new Error(
          `Watch config: cannot read owner/repo from "repoUrl": ${JSON.stringify(r.repoUrl)} — ` +
            "use the forge's https URL (https://forge.example.com/owner/repo) or the " +
            "git@host:owner/repo form; an ssh:// clone URL carries no web origin for the release API.",
        );
      }
    } else if (!r.repo?.includes("/")) {
      throw new Error(
        `Watch config: every repos[] entry needs "repo": "owner/name" (GitHub) or "repoUrl": "https://forge.example.com/owner/repo" (got ${JSON.stringify(r.repo)}).`,
      );
    }
  }
}

/** CLI overrides resolve against the working directory, config-file paths
 * against the config file's own directory (stable under cron). */
function resolveWatchPaths(
  config: WatchConfig,
  opts: { configPath: string; stateFile?: string; reportsDir?: string },
): { configDir: string; reportsDir: string; statePath: string } {
  const configDir = dirname(resolve(opts.configPath));
  const reportsDir = opts.reportsDir
    ? resolve(opts.reportsDir)
    : resolve(configDir, config.reportsDir ?? "reports");
  const statePath = opts.stateFile
    ? resolve(opts.stateFile)
    : config.stateFile
      ? resolve(configDir, config.stateFile)
      : defaultStatePath();
  return { configDir, reportsDir, statePath };
}

function configuredEntries(config: WatchConfig): WatchedEntry[] {
  return config.repos.map((entry) => {
    const rc: WatchRepoConfig = { ...config.defaults, ...entry };
    if (rc.repoUrl) {
      const parsed = parseRepoUrl(rc.repoUrl);
      return {
        key: entryKey(rc),
        repo: parsed ? `${parsed.owner}/${parsed.repo}` : rc.repoUrl,
        ...(parsed ? { url: `${parsed.origin}/${parsed.owner}/${parsed.repo}` } : {}),
      };
    }
    return { key: entryKey(rc), repo: rc.repo! };
  });
}

type EngineResolver = (eo: EngineOptions) => ReturnType<typeof resolveEngines>;

function makeEngineResolver(): EngineResolver {
  const engineCache = new Map<string, ReturnType<typeof resolveEngines>>();
  return (eo: EngineOptions) => {
    const key = JSON.stringify(eo);
    let p = engineCache.get(key);
    if (!p) {
      p = resolveEngines(eo);
      engineCache.set(key, p);
    }
    return p;
  };
}

/** Regenerated after every check, not just at the end — a long run over
 * many repos should have a live dashboard, not a blank page. The per-repo
 * history pages ride along: they render from the same state, so
 * regenerating them here is what keeps every page's numbers in step. */
async function writeIndexFiles(
  reportsDir: string,
  state: WatchState,
  configured: WatchedEntry[],
): Promise<void> {
  await mkdir(reportsDir, { recursive: true });
  const now = new Date().toISOString();
  await writeFile(join(reportsDir, "index.html"), toWatchIndexHtml(state, now, configured));
  await writeFile(join(reportsDir, "feed.xml"), toWatchAtomFeed(state, now, configured));
  for (const e of configured) {
    const rs = state.repos[e.key];
    if (!rs?.latest) continue;
    // Same derivation as the index's history link — the page must land
    // where the link points, whatever layout the state was written under.
    const dir = join(reportsDir, reportDirOf(rs, e.key));
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "index.html"),
      toRepoDetailHtml(e, rs, baselineLevel(rs.history), now),
    );
  }
}

/** Cap and persist the promise ledger after a check — announced, never silent. */
function storePromiseLedger(
  key: string,
  repoState: RepoState,
  promises: PromiseCheck[] | undefined,
): void {
  if (!promises?.length && !repoState.promises?.length) return;
  const ledger = promises ?? [];
  if (ledger.length > MAX_PROMISE_LEDGER) {
    console.error(
      `${key}: promise ledger capped at ${MAX_PROMISE_LEDGER} entries ` +
        `(${ledger.length} tracked) — dropping the oldest carried promises.`,
    );
  }
  repoState.promises = capLedger(ledger);
}

interface CheckOutcome {
  checked: CheckedRelease;
  /** The full promise ledger this check produced — the caller decides
   * whether it becomes the state's (backfill only stores the thread that
   * reached the present). */
  promises: PromiseCheck[] | undefined;
  ec: number;
  flagged: boolean;
  drifted: boolean;
  jsonPath: string;
}

/**
 * Check one release and fold the result into the repo's state — the one
 * code path both the watch loop and backfill run. Report files land in the
 * reports directory; state persistence and the index rewrite stay with the
 * caller (they decide when to flush).
 */
async function checkAndRecord(args: {
  key: string;
  rc: WatchRepoConfig;
  rel: ReleaseInfo;
  repoState: RepoState;
  target: ForgeTarget | undefined;
  /** Explicit base for GitHub entries — backfill picks it from its deep
   * listing, since the loader's own list only reaches the newest 100. */
  base?: string;
  carried: CarriedPromise[];
  configDir: string;
  reportsDir: string;
  engines: EngineResolver;
  cache: boolean;
  historyLimit: number;
  /** Marks the CheckedRelease as a backfill result (recorded, never alerted). */
  backfilled?: boolean;
}): Promise<CheckOutcome> {
  const { key, rc, rel, repoState, target } = args;
  const { engine, escalate } = await args.engines({
    judgeMode: rc.judge ?? "auto",
    engine: rc.engine ?? "claude-cli",
    model: rc.model,
    openaiUrl: rc.openaiUrl,
    escalate: rc.escalate ?? "auto",
    escalateModel: rc.escalateModel,
    cache: args.cache,
  });
  const settings: CheckSettings = {
    judgeMode: rc.judge ?? "auto",
    engine,
    escalateEngine: escalate,
    concurrency: rc.concurrency ?? 4,
    reverse: true,
    baseline: rc.baseline ?? 5,
    history: target ? target.history : githubHistory(rc.repo!),
    // Promises older than the base release live only here: the caller
    // carries every still-open one until a later diff resolves it — or
    // until it ages out as stale (checkPromises counts the carries).
    carriedPromises: args.carried,
    components: rc.components,
  };
  const notesFile = rc.notesFile ? resolve(args.configDir, rc.notesFile) : undefined;
  let data;
  let context;
  let link: RepoLink | null;
  if (target) {
    ({ data, context } = await loadForgeRelease(target, {
      head: rel.tag,
      base: args.base,
      notesFile,
    }));
    link = target.link;
  } else {
    ({ data, context } = await loadGithubReleaseData(rc.repo!, {
      tag: rel.tag,
      base: args.base,
      notesFile,
    }));
    link = { base: `https://github.com/${rc.repo}`, style: "github" };
  }
  const report = await analyzeRelease(data, context, link, settings);
  // A labeled entry is not the repo's own release (e.g. a fabricated
  // negative control, or draft notes) — say so in the report header
  // instead of pinning the result on the innocent upstream repo.
  if (rc.label) report.repoLabel = `${rc.repo ?? target?.slug ?? rc.repoUrl} (${rc.label})`;

  // The tag went through a sanitizer and the key did not — a config
  // with `label: "../.."` wrote outside the reports directory.
  const dirKey = safeSegment(key);
  const dir = join(args.reportsDir, dirKey);
  await mkdir(dir, { recursive: true });
  const base = sanitizeTag(rel.tag);
  const jsonPath = join(dir, `${base}.json`);
  await writeFile(jsonPath, JSON.stringify(report, null, 2));
  await writeFile(join(dir, `${base}.md`), toMarkdown(report));
  await writeFile(
    join(dir, `${base}.html`),
    toHtml(report, reportNavFor(args.reportsDir, dir, repoState, key)),
  );

  // Watch default is lenient: honest releases often carry unprovable
  // claims (private advisories) — alerting on every one is fatigue.
  // Critical flags and the score threshold still catch attack shapes.
  const ec = exitCode(report, rc.failOn ?? "contradicted");
  const critical = report.metrics.flags.filter((f) => f.severity === "critical").length;
  // The repo's level comes from the checks BEFORE this release — in release
  // order, not check order: a backfilled past release must be measured
  // against its own past, not against checks of releases that came after it.
  // Including the current score would let a slow slide redefine "normal".
  const past = repoState.history.filter(
    (h) => (h.publishedAt ?? h.checkedAt) < (rel.publishedAt ?? "￿"),
  );
  const scoreLevel = baselineLevel(past);
  const drifted = hasDrifted([...past, { score: report.metrics.scores.overall }]);
  const flagged =
    isFlagged(report.metrics.scores.overall, ec, critical, rc.notifyBelow, scoreLevel) || drifted;
  const verdicts = {
    verified: report.results.filter((r) => r.verdict === "verified").length,
    partial: report.results.filter((r) => r.verdict === "partial").length,
    noEvidence: report.results.filter((r) => r.verdict === "no-evidence").length,
    contradicted: report.results.filter((r) => r.verdict === "contradicted").length,
  };
  const releaseUrl = releaseWebUrl(link, rel.tag);
  // The ledger update precedes the CheckedRelease so "new" means "new
  // to everything this watcher has seen", not "new to this run".
  const authorUpdate = updateAuthorLedger(repoState.authors, report.authors, rel.tag);
  if (authorUpdate.dropped > 0) {
    repoState.authorsEvicted = true;
    console.error(
      `${key}: author ledger capped at ${MAX_AUTHOR_LEDGER} identities ` +
        `(${authorUpdate.dropped} least-active dropped — later "new author" counts may overcount).`,
    );
  }
  repoState.authors = authorUpdate.ledger;
  const totalCommits = (report.authors ?? []).reduce((s, a) => s + a.commits, 0);
  const checkedRelease: CheckedRelease = {
    tag: rel.tag,
    publishedAt: rel.publishedAt,
    checkedAt: new Date().toISOString(),
    score: report.metrics.scores.overall,
    scoreLabel: report.metrics.scores.label,
    components: {
      correctness: report.metrics.scores.correctness,
      completeness: report.metrics.scores.completeness,
      risk: report.metrics.scores.risk,
    },
    exitCode: ec,
    criticalFlags: critical,
    flagCount: report.metrics.flags.length,
    flagged,
    ...(report.warnings.length ? { warnings: report.warnings } : {}),
    ...(report.promises?.some((p) => p.status === "broken")
      ? { brokenPromises: report.promises.filter((p) => p.status === "broken").length }
      : {}),
    engine: report.engine,
    verdicts,
    ...(report.authors?.length
      ? {
          authors: {
            total: report.authors.length,
            new: authorUpdate.newAuthors,
            top1Share:
              Math.round(((report.authors[0]?.commits ?? 0) / (totalCommits || 1)) * 100) / 100,
            ...(report.authors[0] ? { top1Name: report.authors[0].name } : {}),
          },
        }
      : {}),
    unverifiable: report.metrics.unverifiable?.kind,
    scoreLevel,
    report: `${dirKey}/${base}.html`,
    ...(releaseUrl ? { releaseUrl } : {}),
    ...(args.backfilled ? { backfilled: true } : {}),
  };
  recordChecked(repoState, checkedRelease, args.historyLimit);
  return { checked: checkedRelease, promises: report.promises, ec, flagged, drifted, jsonPath };
}

export async function runWatch(
  config: WatchConfig,
  opts: {
    configPath: string;
    notify?: string;
    stateFile?: string;
    reportsDir?: string;
    cache: boolean;
  },
): Promise<number> {
  validateWatchConfig(config);
  resetJudgeStats();
  const { configDir, reportsDir, statePath } = resolveWatchPaths(config, opts);
  const notifyCmd = opts.notify ?? config.notify;
  const historyLimit = config.historyLimit ?? DEFAULT_HISTORY_LIMIT;
  const state = await loadState(statePath);
  const engines = makeEngineResolver();

  const codes: number[] = [];
  let checked = 0;
  let flaggedTotal = 0;

  const configured = configuredEntries(config);
  const writeIndex = () => writeIndexFiles(reportsDir, state, configured);

  for (const entry of config.repos) {
    const rc: WatchRepoConfig = { ...config.defaults, ...entry };
    const key = entryKey(rc);
    const repoState: RepoState = state.repos[key] ?? {
      lastPublishedAt: null,
      lastTag: null,
      history: [],
    };
    // The poll stays one API call per repo either way; a repoUrl entry's
    // clone happens only once a new release is actually there to check.
    let releases: ReleaseInfo[];
    let forge: ForgeListing | null = null;
    try {
      if (rc.repoUrl) {
        forge = await fetchForgeReleases(parseRepoUrl(rc.repoUrl)!);
        if (!forge) {
          throw new Error(
            `no Forgejo/Gitea or GitLab release API answered for ${rc.repoUrl} — watch polls the ` +
              "release list, so it needs one. A private repo needs FORGEJO_TOKEN/GITEA_TOKEN or " +
              `GITLAB_TOKEN exported; a host without the API can still be checked one-off with --repo-url.`,
          );
        }
        releases = forge.releases.map((r) => ({
          tag: r.tag_name,
          publishedAt: r.published_at ?? null,
          prerelease: r.prerelease,
          draft: r.draft,
        }));
      } else {
        const raw = await ghApi<
          Array<{ tag_name: string; published_at: string | null; prerelease: boolean; draft: boolean }>
        >(`repos/${assertRepoSlug(rc.repo!)}/releases?per_page=30`);
        releases = raw.map((r) => ({
          tag: r.tag_name,
          publishedAt: r.published_at,
          prerelease: r.prerelease,
          draft: r.draft,
        }));
      }
    } catch (err) {
      console.error(`${key}: listing releases failed — ${(err as Error).message}`);
      codes.push(2);
      continue;
    }
    const cap = config.maxPerRun ?? 3;
    const fresh = pickNewReleases(releases, repoState.lastPublishedAt, {
      includePrerelease: rc.includePrerelease,
      cap,
    });
    if (!fresh.length) {
      console.error(`${key}: up to date (${repoState.lastTag ?? "no releases"})`);
      state.repos[key] = repoState;
      continue;
    }
    const skipped = countSkipped(releases, repoState.lastPublishedAt, {
      includePrerelease: rc.includePrerelease,
      cap,
    });
    if (skipped > 0) {
      console.error(
        `${key}: ${skipped} older new release(s) skipped (maxPerRun ${cap} — raise it to backfill).`,
      );
    }

    let target: ForgeTarget | undefined;
    for (const rel of fresh) {
      console.error(`${key}: checking ${rel.tag}…`);
      try {
        // The clone is per repo, not per release — the first fresh release
        // pays it, later ones in the same batch reuse it.
        if (rc.repoUrl && !target) target = await prepareForgeTarget(rc.repoUrl, { forge });
        const outcome = await checkAndRecord({
          key,
          rc,
          rel,
          repoState,
          target,
          carried: carriedFromLedger(repoState.promises),
          configDir,
          reportsDir,
          engines,
          cache: opts.cache,
          historyLimit,
        });
        // The ledger is replaced wholesale: carried promises were all
        // re-checked this run, resolved ones keep their final status here and
        // only still-open entries ride along to the next release. The cap
        // bounds it — the dedupe key is normalized text, so notes that reword
        // a promise every release would otherwise multiply entries without
        // limit. Report order puts this release's own promises first, so the
        // oldest carried entries (nearest to stale anyway) are what drops.
        storePromiseLedger(key, repoState, outcome.promises);
        state.repos[key] = repoState;
        codes.push(outcome.ec);
        checked++;
        console.error(
          `${key}: ${rel.tag} → score ${outcome.checked.score} (${outcome.checked.scoreLabel})` +
            (outcome.flagged ? " — FLAGGED" : "") +
            (outcome.drifted ? " (this repo's own level has been sliding)" : ""),
        );
        if (outcome.flagged) {
          flaggedTotal++;
          if (notifyCmd) await runNotify(notifyCmd, outcome.jsonPath);
        }
        // Persist after every successful check so a crash never re-alerts.
        await saveState(statePath, state);
        await writeIndex();
      } catch (err) {
        const msg = (err as Error).message;
        codes.push(2);
        const move = recordCheckFailure(repoState, rel, msg, new Date().toISOString());
        state.repos[key] = repoState;
        if (move === "retry") {
          console.error(
            `${key}: checking ${rel.tag} failed (attempt ${repoState.failing!.attempts}/${MAX_CHECK_ATTEMPTS}) — ${msg}`,
          );
          break; // transient until proven otherwise; state stays put, retried next run
        }
        console.error(
          `${key}: giving up on ${rel.tag} after ${MAX_CHECK_ATTEMPTS} failed runs — ${msg}. ` +
            `Skipping past it so newer releases get checked; it stays listed as unchecked on the history page.`,
        );
        await saveState(statePath, state);
        await writeIndex();
        continue; // newer releases in this batch still get their check
      }
    }
  }

  await writeIndex();
  await saveState(statePath, state);
  const exit = worstExit(codes);
  console.error(
    `watch: ${config.repos.length} repos · ${checked} new release(s) checked · ${flaggedTotal} flagged · ${judgeBalance()}index ${join(reportsDir, "index.html")} · exit ${exit}`,
  );
  return exit;
}

/** The run's judge bill, for the summary line — the cost question every
 * long run gets asked. Empty when no judge ran (deterministic-only). */
function judgeBalance(): string {
  const { fresh, cached } = judgeCallStats();
  return fresh || cached ? `judge calls: ${fresh} fresh · ${cached} from cache · ` : "";
}

/** One listing page — GitHub and the forges both speak 100 per page. */
const LISTING_PAGE = 100;
/** Hard bound on the deep listing: 2000 releases is far beyond any scope a
 * backfill can afford to judge; announced when it bites, never silent. */
const MAX_LISTING_PAGES = 20;

/**
 * The deep release listing backfill selects from — paginated until the
 * scope is covered plus one older release (the base pick needs the
 * predecessor of the oldest release in scope). The watch poll's single
 * newest-30 page is exactly what backfill exists to see past.
 */
async function listReleasesDeep(
  rc: WatchRepoConfig,
  scope: { releases?: number; since?: string; includePrerelease?: boolean },
): Promise<{ releases: ReleaseInfo[]; gh: GhRelease[] | null; forge: ForgeListing | null }> {
  const eligibleCount = (rels: ReleaseInfo[]) =>
    rels.filter((r) => !r.draft && r.publishedAt && (scope.includePrerelease || !r.prerelease));
  // More pages are needed while the scope is not covered: for --releases N
  // until N+1 eligible ones are loaded, for --since until one eligible
  // release predates the date (then everything since it is on the list).
  const needMore = (rels: ReleaseInfo[]): boolean => {
    const eligible = eligibleCount(rels);
    if (scope.since !== undefined) return !eligible.some((r) => r.publishedAt! < scope.since!);
    return eligible.length <= (scope.releases ?? 0);
  };
  const toInfo = (r: GhRelease): ReleaseInfo => ({
    tag: r.tag_name,
    publishedAt: r.published_at ?? null,
    prerelease: r.prerelease,
    draft: r.draft,
  });

  if (rc.repoUrl) {
    const target = parseRepoUrl(rc.repoUrl)!;
    const first = await fetchForgeReleases(target, { limit: LISTING_PAGE });
    if (!first) {
      throw new Error(
        `no Forgejo/Gitea or GitLab release API answered for ${rc.repoUrl} — backfill lists past ` +
          "releases over that API. A private repo needs FORGEJO_TOKEN/GITEA_TOKEN or GITLAB_TOKEN exported.",
      );
    }
    const all = [...first.releases];
    let page = 1;
    while (
      all.length === page * LISTING_PAGE &&
      needMore(all.map(toInfo)) &&
      page < MAX_LISTING_PAGES
    ) {
      page++;
      const next = await fetchForgeReleasePage(target, first.kind, {
        limit: LISTING_PAGE,
        page,
      });
      if (!next?.length) break;
      all.push(...next);
    }
    if (page >= MAX_LISTING_PAGES && needMore(all.map(toInfo))) {
      console.error(
        `${rc.repoUrl}: release listing stopped at ${all.length} releases (${MAX_LISTING_PAGES} pages) — the scope may not be fully covered.`,
      );
    }
    return { releases: all.map(toInfo), gh: null, forge: { kind: first.kind, releases: all } };
  }

  const slug = assertRepoSlug(rc.repo!);
  const all: GhRelease[] = [];
  for (let page = 1; page <= MAX_LISTING_PAGES; page++) {
    const batch = await ghApi<GhRelease[]>(
      `repos/${slug}/releases?per_page=${LISTING_PAGE}&page=${page}`,
    );
    all.push(...batch);
    if (batch.length < LISTING_PAGE || !needMore(all.map(toInfo))) break;
    if (page === MAX_LISTING_PAGES) {
      console.error(
        `${slug}: release listing stopped at ${all.length} releases (${MAX_LISTING_PAGES} pages) — the scope may not be fully covered.`,
      );
    }
  }
  return { releases: all.map(toInfo), gh: all, forge: null };
}

async function promptYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    throw new Error(
      "backfill wants a confirmation before spending judge time, and there is no terminal to ask on — re-run with --yes.",
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

export interface BackfillOptions {
  configPath: string;
  stateFile?: string;
  reportsDir?: string;
  cache: boolean;
  /** Exactly one of `releases` and `since`. */
  releases?: number;
  since?: string;
  /** Skip the cost confirmation — for scripts. */
  yes: boolean;
  /** Restrict to these entries (state key, owner/repo or repoUrl); empty = all. */
  only: string[];
  /** Injection seam for tests — production asks on the terminal. */
  confirm?: (question: string) => Promise<boolean>;
}

/**
 * `watch backfill` — solve the cold start honestly: check the PAST releases
 * the state never saw, gap-free and oldest-first, so a fresh watch entry has
 * a median, drift detection and a filled author ledger after one command
 * instead of after most of a year. Deliberately its own mode: the catch-up
 * (`pickNewReleases`) prioritizes the newest releases when behind, which is
 * right for alerting and the exact opposite of backfill. No sampling — each
 * check verifies notes against its own diff, so skipped releases would leave
 * commits no checked diff covers and holes in promise resolution and the
 * author ledger; display resolution is the long view's concern, not the
 * record's. Resumable by construction (state saves after every check, checked
 * releases are never re-checked) and silent toward `--notify`: historical
 * alerts are noise, `flagged` stays in the record.
 */
export async function runBackfill(config: WatchConfig, opts: BackfillOptions): Promise<number> {
  validateWatchConfig(config);
  if ((opts.releases === undefined) === (opts.since === undefined)) {
    throw new Error(
      "backfill needs exactly one scope: --releases <n> (the newest n releases) or --since <date>.",
    );
  }
  if (opts.since !== undefined && !/^\d{4}-\d{2}-\d{2}/.test(opts.since)) {
    throw new Error(`--since must be a date like 2024-01-01 (got "${opts.since}").`);
  }
  resetJudgeStats();
  const { configDir, reportsDir, statePath } = resolveWatchPaths(config, opts);
  const historyLimit = config.historyLimit ?? DEFAULT_HISTORY_LIMIT;
  const state = await loadState(statePath);
  const engines = makeEngineResolver();
  const configured = configuredEntries(config);
  const writeIndex = () => writeIndexFiles(reportsDir, state, configured);

  const matches = (rc: WatchRepoConfig, sel: string) =>
    sel === entryKey(rc) || sel === rc.repo || sel === rc.repoUrl;
  const entries = config.repos
    .map((entry) => ({ ...config.defaults, ...entry }) as WatchRepoConfig)
    .filter((rc) => !opts.only.length || opts.only.some((sel) => matches(rc, sel)));
  for (const sel of opts.only) {
    if (!config.repos.some((entry) => matches({ ...config.defaults, ...entry }, sel))) {
      throw new Error(
        `backfill: "${sel}" is not in the watch config — watched entries: ${config.repos
          .map((entry) => entryKey({ ...config.defaults, ...entry }))
          .join(", ")}.`,
      );
    }
  }

  const codes: number[] = [];
  const scope = (rc: WatchRepoConfig) => ({
    releases: opts.releases,
    since: opts.since,
    includePrerelease: rc.includePrerelease,
  });

  // Plan first — the cost statement must precede the first paid check.
  const plans: Array<{
    rc: WatchRepoConfig;
    key: string;
    plan: ReleaseInfo[];
    gh: GhRelease[] | null;
    forge: ForgeListing | null;
  }> = [];
  for (const rc of entries) {
    const key = entryKey(rc);
    try {
      const listing = await listReleasesDeep(rc, scope(rc));
      const repoState = state.repos[key] ?? { lastPublishedAt: null, lastTag: null, history: [] };
      const plan = pickBackfillReleases(listing.releases, repoState, scope(rc));
      plans.push({ rc, key, plan, gh: listing.gh, forge: listing.forge });
    } catch (err) {
      console.error(`${key}: listing releases failed — ${(err as Error).message}`);
      codes.push(2);
    }
  }
  const total = plans.reduce((s, p) => s + p.plan.length, 0);
  if (!total) {
    console.error(
      "backfill: nothing to do — every release in scope is already checked or on the skipped record.",
    );
    return worstExit(codes);
  }
  for (const { key, plan } of plans) {
    if (!plan.length) continue;
    console.error(
      `${key}: ${plan.length} release(s) to check — ${plan[0].tag} … ${plan[plan.length - 1].tag}`,
    );
    const kept = (state.repos[key]?.history.length ?? 0) + plan.length;
    if (kept > historyLimit) {
      console.error(
        `${key}: note — historyLimit ${historyLimit} keeps only the newest ${historyLimit} of ${kept} checks; raise "historyLimit" in the config to keep the full series.`,
      );
    }
  }
  const judged = entries.some((rc) => (rc.judge ?? "auto") !== "off");
  console.error(
    `backfill: ${total} release(s) total — est. ${
      judged
        ? `~${Math.max(1, total * 2)} min judge time (rough 2 min per release)`
        : "deterministic only (judge off), seconds per release"
    }. Checked releases never re-check; state saves after every one, so an interrupted run resumes.`,
  );
  if (!opts.yes) {
    const ok = await (opts.confirm ?? promptYesNo)(`Check ${total} release(s) now?`);
    if (!ok) {
      console.error("backfill cancelled — nothing checked.");
      return 1;
    }
  }

  let checked = 0;
  let flaggedTotal = 0;
  let gaveUp = 0;
  for (const { rc, key, plan, gh, forge } of plans) {
    if (!plan.length) continue;
    const repoState: RepoState = state.repos[key] ?? {
      lastPublishedAt: null,
      lastTag: null,
      history: [],
    };
    state.repos[key] = repoState;
    let target: ForgeTarget | undefined;
    try {
      // The paginated listing rides into the target: notes, base picks and
      // baseline snapshots then reach as far back as the scope does, not
      // just the newest page.
      if (rc.repoUrl) target = await prepareForgeTarget(rc.repoUrl, { forge });
    } catch (err) {
      console.error(`${key}: preparing the clone failed — ${(err as Error).message}`);
      codes.push(2);
      continue;
    }
    // The promise thread starts empty and runs chronologically through this
    // backfill; it becomes the state's ledger only when it reaches the
    // present (the check that ends up as `latest`). An existing ledger
    // belongs to the newest checks and stays untouched by pure-past runs.
    let carried: CarriedPromise[] = [];
    let consecutiveFailures = 0;
    for (const rel of plan) {
      let base: string | undefined;
      let deterministicFailure: string | null = null;
      if (gh) {
        try {
          base = pickBaseRelease(gh, rel.tag) ?? undefined;
        } catch (err) {
          deterministicFailure = (err as Error).message;
        }
      }
      let outcome: CheckOutcome | null = null;
      let lastError = deterministicFailure ?? "";
      let attempts = deterministicFailure ? 1 : 0;
      if (!deterministicFailure) {
        for (attempts = 1; attempts <= MAX_CHECK_ATTEMPTS; attempts++) {
          console.error(`${key}: checking ${rel.tag}…`);
          try {
            outcome = await checkAndRecord({
              key,
              rc,
              rel,
              repoState,
              target,
              base,
              carried,
              configDir,
              reportsDir,
              engines,
              cache: opts.cache,
              historyLimit,
              backfilled: true,
            });
            break;
          } catch (err) {
            lastError = (err as Error).message;
            console.error(
              `${key}: checking ${rel.tag} failed (attempt ${attempts}/${MAX_CHECK_ATTEMPTS}) — ${lastError}`,
            );
          }
        }
      }
      if (outcome) {
        consecutiveFailures = 0;
        carried = carriedFromLedger(outcome.promises);
        if (repoState.latest === outcome.checked) {
          storePromiseLedger(key, repoState, outcome.promises);
        }
        codes.push(outcome.ec);
        checked++;
        if (outcome.flagged) flaggedTotal++;
        console.error(
          `${key}: ${rel.tag} → score ${outcome.checked.score} (${outcome.checked.scoreLabel})` +
            (outcome.flagged ? " — flagged (recorded; backfill never notifies)" : ""),
        );
        await saveState(statePath, state);
        await writeIndex();
        continue;
      }
      // Give up on this release: recorded as unchecked, never retried — the
      // wedge guard for broken old releases.
      recordSkip(repoState, rel, Math.min(attempts, MAX_CHECK_ATTEMPTS), lastError, new Date().toISOString());
      gaveUp++;
      consecutiveFailures++;
      codes.push(1);
      console.error(
        `${key}: giving up on ${rel.tag} — ${lastError}. It stays listed as unchecked on the history page.`,
      );
      await saveState(statePath, state);
      await writeIndex();
      if (consecutiveFailures >= 3) {
        console.error(
          `${key}: ${consecutiveFailures} releases in a row failed every attempt — that looks systemic (network, rate limit, auth), not like broken releases. Aborting; state is saved, re-run to resume.`,
        );
        return worstExit([...codes, 1]);
      }
    }
  }

  await writeIndex();
  await saveState(statePath, state);
  const exit = worstExit(codes);
  console.error(
    `backfill: ${checked} release(s) checked · ${flaggedTotal} flagged (recorded, never notified) · ${gaveUp} given up · ${judgeBalance()}index ${join(reportsDir, "index.html")} · exit ${exit}`,
  );
  return exit;
}
