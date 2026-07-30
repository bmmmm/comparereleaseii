// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
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
import { esc } from "./util.ts";
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

import type { AuthorActivity, PromiseCheck, UnverifiableKind } from "./types.ts";
import type { CarriedPromise } from "./promises.ts";

type FailOn = "none" | "contradicted" | "no-evidence";

/** Short enough for a table cell; the title carries the explanation. */
const UNVERIFIABLE_TAG: Record<UnverifiableKind, string> = {
  sourceless: "no source",
  "out-of-repo": "out of repo",
};
const UNVERIFIABLE_TITLE: Record<UnverifiableKind, string> = {
  sourceless: "This release's diff contains no source-code changes — its claims could not be checked against code.",
  "out-of-repo": "These notes describe code that is not in this repo's own diff (fork, build or distribution repo).",
};

export interface WatchRepoConfig {
  /** owner/repo on GitHub. Exactly one of `repo` and `repoUrl` per entry. */
  repo?: string;
  /**
   * Any forge with a release API instead: a Forgejo/Gitea or GitLab
   * repository URL. Polled over that API, checked through a cached clone —
   * the same path the CLI's --repo-url takes. A plain git host without a
   * release API cannot be watched (nothing answers "is there a new
   * release?"); it can still be checked one-off with --repo-url.
   */
  repoUrl?: string;
  /** State key and report directory — defaults to `repo`. Needed when the
   * same repo appears twice (e.g. once with a notesFile override). */
  label?: string;
  /** Check this notes file instead of the published release notes. */
  notesFile?: string;
  judge?: "auto" | "all" | "off";
  engine?: "claude-cli" | "api" | "openai" | "off";
  model?: string;
  openaiUrl?: string;
  escalate?: "auto" | "off" | "claude-cli" | "api" | "openai";
  escalateModel?: string;
  failOn?: FailOn;
  baseline?: number;
  concurrency?: number;
  includePrerelease?: boolean;
  /** Trust score below which a release is flagged (default 65). */
  notifyBelow?: number;
}

export interface WatchConfig {
  repos: WatchRepoConfig[];
  /** Options applied to every repo unless overridden per repo. */
  defaults?: Partial<WatchRepoConfig>;
  /** Default: "reports" next to the config file. */
  reportsDir?: string;
  /** Default: $XDG_STATE_HOME/comparereleaseii/watch-state.json. */
  stateFile?: string;
  /** Max new releases checked per repo per run (default 3). */
  maxPerRun?: number;
  /**
   * Checks kept per repo in the state (default 20). Raise it before a deep
   * `watch backfill` — the long-view history can only render what the state
   * keeps. The baseline median and drift detection deliberately do NOT widen
   * with it: they read fixed windows of the newest checks, so years of old
   * note culture cannot dilute what "normal" means now.
   */
  historyLimit?: number;
  /** Command run as `<cmd> <json-report-path>` for each flagged release. */
  notify?: string;
}

export interface ReleaseInfo {
  tag: string;
  publishedAt: string | null;
  prerelease: boolean;
  draft: boolean;
}

export interface CheckedRelease {
  tag: string;
  publishedAt: string | null;
  checkedAt: string;
  score: number;
  scoreLabel: string;
  /** Absent in state files written before the field existed. */
  components?: { correctness: number; completeness: number | null; risk: number };
  /**
   * Set when the release's claims could not be checked against this repo's
   * own diff. Without it the index cannot tell a fork/docs-only release from
   * a repo whose notes genuinely stopped matching its code.
   */
  unverifiable?: UnverifiableKind;
  /** The repo's median score before this check — null until enough history. */
  scoreLevel?: number | null;
  exitCode: number;
  criticalFlags: number;
  flagCount: number;
  flagged: boolean;
  /**
   * Whatever the check could not see. A score computed on a diff the compare
   * API truncated and the clone fallback then failed to complete is not a
   * score, and the index is the one place where that is invisible: measured
   * on bitwarden/clients cli-v2026.7.0, 18 % of the diff scored 45 where the
   * full diff scores 85.
   */
  warnings?: string[];
  /** Promises from earlier releases this release was due to keep and did not. */
  brokenPromises?: number;
  engine: string;
  verdicts: { verified: number; partial: number; noEvidence: number; contradicted: number };
  /**
   * Author facts of this release: identities total, identities the ledger
   * had never seen, and the top identity's share of commits (0–1) — a
   * single-maintainer release is a supply-chain fact worth showing.
   * `top1Name` names the top identity (display name, not the key) so the
   * long view can detect top-identity regime changes; absent in states
   * written before it existed.
   */
  authors?: { total: number; new: number; top1Share: number; top1Name?: string };
  /** HTML report path relative to the reports directory. */
  report: string;
  /**
   * The release's own web page. States written before forges joined lack it;
   * the index then derives the GitHub URL, which is all those states watched.
   */
  releaseUrl?: string;
  /**
   * Checked after the fact by `watch backfill`, not by the live loop. A
   * flagged backfilled check never fired a notification and never will — the
   * pages say so, and the Atom feed (the pull counterpart to --notify)
   * skips these entries entirely: historical alerts are noise there too.
   */
  backfilled?: boolean;
}

/** One configured watch entry, for rendering the index: key = label ?? repo. */
export interface WatchedEntry {
  key: string;
  /** owner/repo — display, and the GitHub link when `url` is absent. */
  repo: string;
  /** The repo's web page on its forge — set for repoUrl entries. */
  url?: string;
}

/** One entry's state key and report directory — the single derivation both
 * the index and the run loop use, so a row can never wait for a check that
 * is accumulating state under another key. */
export function entryKey(rc: WatchRepoConfig): string {
  return rc.label ?? rc.repo ?? rc.repoUrl!;
}


/** Where a release lives on the web — GitLab spells the route differently. */
export function releaseWebUrl(link: RepoLink | null, tag: string): string | undefined {
  if (!link) return undefined;
  const t = encodeURIComponent(tag);
  return link.style === "gitlab"
    ? `${link.base}/-/releases/${t}`
    : `${link.base}/releases/tag/${t}`;
}

export interface RepoState {
  lastPublishedAt: string | null;
  lastTag: string | null;
  latest?: CheckedRelease;
  history: CheckedRelease[];
  /**
   * Promise ledger from the last check: still-open entries are re-checked
   * against every later release until they resolve to kept or broken — or
   * age out as `stale` after STALE_AFTER carries, which is the third exit
   * and the reason target-less promises cannot ride forever.
   */
  promises?: PromiseCheck[];
  /** Author ledger — per-identity facts accumulated across checked releases. */
  authors?: AuthorRecord[];
  /**
   * The ledger cap has evicted identities at least once. Sticky: from then
   * on a returning evicted identity recounts as "new", so the display must
   * qualify first-appearance counts instead of stating them as fact.
   */
  authorsEvicted?: boolean;
  /** The release the run loop is currently stuck on — retried next run. */
  failing?: { tag: string; attempts: number; lastError: string };
  /** Releases the loop gave up on after MAX_CHECK_ATTEMPTS failed runs. */
  skipped?: SkippedRelease[];
}

/** A release that was seen but never checked: every attempt failed, and the
 * state advanced past it so newer releases could get their turn. */
export interface SkippedRelease {
  tag: string;
  publishedAt: string | null;
  attempts: number;
  lastError: string;
  skippedAt: string;
}

/**
 * One identity's record across every release this watcher checked — the
 * promise-ledger pattern applied to authors. Facts only, accumulated, never
 * scored; the settled framing is behaviors per release, no person-level
 * trust labels in either direction.
 */
export interface AuthorRecord {
  key: string;
  /** Latest display name seen for this identity. */
  name: string;
  /** Distinct forge attributions across releases; `null` = explicitly none. */
  logins?: Array<string | null>;
  /** Tag of the first checked release this identity appeared in. */
  firstSeen: string;
  lastSeen: string;
  /** Checked releases this identity had commits in. */
  releases: number;
  commits: number;
  sensitiveCommits: number;
  binaryCommits: number;
}

/** Hard bound on the per-repo author ledger — same reasoning as the promise
 * cap: state must not grow without limit, and the drop is announced. */
export const MAX_AUTHOR_LEDGER = 100;

/**
 * Fold one release's author activity into the ledger. `firstSeen` is
 * immutable once recorded — it is the one fact the ledger exists to answer
 * ("since when has this identity been here?"). When the cap bites, this
 * release's active identities always survive (they are what the next
 * check's "new" count is measured against), then the busiest.
 */
export function updateAuthorLedger(
  ledger: AuthorRecord[] | undefined,
  activity: AuthorActivity[] | undefined,
  tag: string,
): { ledger: AuthorRecord[]; newAuthors: number; dropped: number } {
  const byKey = new Map((ledger ?? []).map((a) => [a.key, { ...a }]));
  let newAuthors = 0;
  for (const act of activity ?? []) {
    let rec = byKey.get(act.key);
    if (!rec) {
      newAuthors++;
      rec = {
        key: act.key,
        name: act.name,
        firstSeen: tag,
        lastSeen: tag,
        releases: 0,
        commits: 0,
        sensitiveCommits: 0,
        binaryCommits: 0,
      };
      byKey.set(act.key, rec);
    }
    rec.name = act.name;
    rec.lastSeen = tag;
    rec.releases++;
    rec.commits += act.commits;
    rec.sensitiveCommits += act.sensitiveCommits;
    rec.binaryCommits += act.binaryCommits;
    for (const login of act.logins ?? []) {
      if (!(rec.logins ?? []).includes(login)) rec.logins = [...(rec.logins ?? []), login];
    }
  }
  const all = [...byKey.values()];
  if (all.length <= MAX_AUTHOR_LEDGER) return { ledger: all, newAuthors, dropped: 0 };
  const active = new Set((activity ?? []).map((a) => a.key));
  const keep = all.filter((a) => active.has(a.key));
  const rest = all.filter((a) => !active.has(a.key)).sort((x, y) => y.commits - x.commits);
  // The whole active set survives even when it alone exceeds the cap — a
  // 150-author release must not have 50 of its own identities forgotten,
  // or they would recount as "new" on every later release forever. The
  // ledger runs wide for that one release and shrinks back to the cap on
  // the next narrower one; only inactive records are ever evicted. An
  // evicted identity returning later still recounts as new — that is the
  // bounded-memory limit, and the caller sticky-flags it for display.
  const room = Math.max(0, MAX_AUTHOR_LEDGER - keep.length);
  return {
    ledger: [...keep, ...rest.slice(0, room)],
    newAuthors,
    dropped: rest.length - room,
  };
}

export interface WatchState {
  version: 1;
  repos: Record<string, RepoState>;
}

/** Releases to check: newer than the last checked one, oldest first. On the
 * first run only the latest release is checked (no backfill surprise). */
export function pickNewReleases(
  releases: ReleaseInfo[],
  lastPublishedAt: string | null,
  opts: { includePrerelease?: boolean; cap?: number } = {},
): ReleaseInfo[] {
  const cap = opts.cap ?? 3;
  const eligible = releases
    .filter((r) => !r.draft && r.publishedAt && (opts.includePrerelease || !r.prerelease))
    .sort((a, b) => a.publishedAt!.localeCompare(b.publishedAt!));
  if (!eligible.length) return [];
  if (!lastPublishedAt) return [eligible[eligible.length - 1]];
  return eligible.filter((r) => r.publishedAt! > lastPublishedAt).slice(-cap);
}

/**
 * New-but-unchecked releases the maxPerRun cap left behind. Counts only
 * releases that WOULD have been checked (same eligibility as
 * pickNewReleases) — counting prereleases here told the operator to raise
 * maxPerRun to backfill releases that would never be checked anyway.
 */
export function countSkipped(
  releases: ReleaseInfo[],
  lastPublishedAt: string | null,
  opts: { includePrerelease?: boolean; cap?: number } = {},
): number {
  if (lastPublishedAt === null) return 0;
  const eligible = releases.filter(
    (r) =>
      !r.draft &&
      r.publishedAt &&
      (opts.includePrerelease || !r.prerelease) &&
      r.publishedAt! > lastPublishedAt,
  );
  return Math.max(0, eligible.length - (opts.cap ?? 3));
}

/** Checks kept per repo when the config does not say otherwise. */
export const DEFAULT_HISTORY_LIMIT = 20;

/**
 * Fold one checked release into the repo's state. The watch loop always
 * appends the newest release, but backfill checks the past — so the insert
 * is chronological (history stays readable as a series), and `latest` and
 * the poll cursor only ever move FORWARD: a backfilled old release must not
 * become "the latest check", and a cursor moving backward would make the
 * next watch run re-check — and re-alert — everything published since.
 */
export function recordChecked(
  repoState: RepoState,
  checked: CheckedRelease,
  historyLimit = DEFAULT_HISTORY_LIMIT,
): void {
  const at = (h: CheckedRelease) => h.publishedAt ?? h.checkedAt;
  const history = repoState.history.filter((h) => h.tag !== checked.tag);
  history.push(checked);
  history.sort((a, b) => at(a).localeCompare(at(b)));
  repoState.history = history.slice(-historyLimit);
  if (!repoState.latest || at(checked) >= at(repoState.latest)) repoState.latest = checked;
  if (
    checked.publishedAt &&
    (repoState.lastPublishedAt === null || checked.publishedAt > repoState.lastPublishedAt)
  ) {
    repoState.lastPublishedAt = checked.publishedAt;
    repoState.lastTag = checked.tag;
  }
  // A success proves the loop is not stuck — whatever tag the counter was
  // tracking, it either just passed or is gone from the window.
  delete repoState.failing;
}

/**
 * The past the state never saw: eligible releases inside the requested
 * scope that were never checked and never given up on, oldest first.
 * Releases newer than the poll cursor are deliberately NOT backfill's job —
 * they belong to the ordinary watch run (which also owns the promise-ledger
 * thread from the cursor forward). This is a separate mode on purpose:
 * `pickNewReleases` prioritizes the NEWEST when behind (right for alerting),
 * so a reset state plus hourly runs would never reach the old releases.
 */
export function pickBackfillReleases(
  releases: ReleaseInfo[],
  repoState: RepoState,
  scope: { releases?: number; since?: string; includePrerelease?: boolean },
): ReleaseInfo[] {
  const eligible = releases
    .filter((r) => !r.draft && r.publishedAt && (scope.includePrerelease || !r.prerelease))
    .sort((a, b) => a.publishedAt!.localeCompare(b.publishedAt!));
  const inScope =
    scope.since !== undefined
      ? eligible.filter((r) => r.publishedAt! >= scope.since!)
      : eligible.slice(-(scope.releases ?? 0));
  const done = new Set([
    ...repoState.history.map((h) => h.tag),
    ...(repoState.skipped ?? []).map((s) => s.tag),
  ]);
  return inScope.filter(
    (r) =>
      !done.has(r.tag) &&
      (repoState.lastPublishedAt === null || r.publishedAt! <= repoState.lastPublishedAt),
  );
}

/** After this many failed runs on the same release, watch skips past it. */
export const MAX_CHECK_ATTEMPTS = 3;
/** Skipped releases kept on record — bounded like every other ledger. */
const MAX_SKIPPED = 10;

/**
 * Give up on a release: record it as seen-but-unchecked and move the poll
 * cursor past it — forward only. Skipping a backfilled OLD release must not
 * pull the cursor back, or the next watch run would re-check (and re-alert)
 * everything published since.
 */
export function recordSkip(
  repoState: RepoState,
  rel: { tag: string; publishedAt: string | null },
  attempts: number,
  error: string,
  now: string,
): void {
  repoState.skipped = [
    ...(repoState.skipped ?? []),
    { tag: rel.tag, publishedAt: rel.publishedAt, attempts, lastError: error, skippedAt: now },
  ].slice(-MAX_SKIPPED);
  if (
    rel.publishedAt &&
    (repoState.lastPublishedAt === null || rel.publishedAt > repoState.lastPublishedAt)
  ) {
    repoState.lastPublishedAt = rel.publishedAt;
    repoState.lastTag = rel.tag;
  }
}

/**
 * Record one failed check and decide the loop's move. Retrying next run is
 * right for transient failures — network, rate limits — but a permanently
 * failing release (a tag-only forge release whose empty notes parse to no
 * claims, a diff the source cannot serve) would wedge the repo: the state
 * never advances past it, so newer releases are never checked. The attempt
 * count therefore rides in the state, and once MAX_CHECK_ATTEMPTS runs have
 * failed on the same tag the state moves past it as seen-but-unchecked —
 * announced in the log and listed on the history page, never silent. A
 * success wipes the counter; a different failing tag restarts it.
 */
export function recordCheckFailure(
  repoState: RepoState,
  rel: { tag: string; publishedAt: string | null },
  error: string,
  now: string,
): "retry" | "skip" {
  const attempts = (repoState.failing?.tag === rel.tag ? repoState.failing.attempts : 0) + 1;
  if (attempts < MAX_CHECK_ATTEMPTS) {
    repoState.failing = { tag: rel.tag, attempts, lastError: error };
    return "retry";
  }
  delete repoState.failing;
  recordSkip(repoState, rel, attempts, error, now);
  return "skip";
}

/** Fewer than this many past checks is an accident, not a repo's normal level. */
const BASELINE_MIN_CHECKS = 3;
/** A drop this far below the repo's own median is the alarm. */
const SCORE_DROP = 20;
/**
 * Hard bound on the per-repo promise ledger. Promises dedupe on normalized
 * text, so notes that reword the same commitment every release would grow the
 * state without limit; aging (STALE_AFTER carries) is the ordinary exit, this
 * cap is the backstop — and it is announced, never silent.
 */
export const MAX_PROMISE_LEDGER = 50;

/**
 * Still-open entries ride to the next check with their carry count; kept,
 * broken and stale entries stay behind — stale IS the exit, re-carrying it
 * would undo the aging.
 */
export function carriedFromLedger(promises: PromiseCheck[] | undefined): CarriedPromise[] {
  return (promises ?? [])
    .filter((p) => p.status === "still-open")
    .map((p) => ({
      text: p.text,
      from: p.from,
      kind: p.kind,
      target: p.target,
      carriedFor: p.carriedFor,
    }));
}

/**
 * Bound the persisted ledger, still-open entries first: they are the only
 * ones the ledger exists to carry. A plain head-slice would let this
 * release's kept/broken entries (display-only, discarded next run anyway)
 * evict the oldest carried promises.
 */
export function capLedger(promises: PromiseCheck[]): PromiseCheck[] {
  if (promises.length <= MAX_PROMISE_LEDGER) return promises;
  const open = promises.filter((p) => p.status === "still-open");
  const resolved = promises.filter((p) => p.status !== "still-open");
  return [...open, ...resolved].slice(0, MAX_PROMISE_LEDGER);
}

/**
 * The repo's own normal score — median of its past checks, or null while
 * there are too few to call it a level.
 */
export function scoreBaseline(history: Array<{ score: number }>): number | null {
  if (history.length < BASELINE_MIN_CHECKS) return null;
  const sorted = history.map((h) => h.score).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** How many of the newest checks feed the baseline median. */
export const BASELINE_WINDOW = 10;

/**
 * The repo's CURRENT level: the median over a fixed window of the newest
 * checks, not the whole recorded history. Decoupled from `historyLimit` on
 * purpose — a deep backfill keeps hundreds of checks for the long view, but
 * "normal" must mean what the repo does now; a median over years of old
 * note culture would dilute exactly the level the relative alert compares
 * against.
 */
export function baselineLevel(history: Array<{ score: number }>): number | null {
  return scoreBaseline(history.slice(-BASELINE_WINDOW));
}

/**
 * Alert-worthy? Exit code and critical flags always are. The score, though,
 * is only meaningful against the repo's own level: traefik sits near 25 on
 * every release because 9% churn coverage is its culture, and an absolute
 * threshold turns that into a permanent alarm nobody reads. Once enough
 * checks exist, the question becomes "did this release drop below what this
 * repo normally does?" — until then the absolute `notifyBelow` stands in.
 */
export function isFlagged(
  score: number,
  exit: number,
  criticalFlags: number,
  notifyBelow = 65,
  baseline: number | null = null,
): boolean {
  if (exit > 0 || criticalFlags > 0) return true;
  // Once it exists, the repo's own level replaces the absolute bar rather
  // than joining it: a repo normally at 25 stops crying wolf, and one
  // normally at 95 now alerts at 70 — which no absolute default would catch.
  // The comparison is inclusive: a drop of exactly SCORE_DROP is the case
  // the constant names, and `<` let it through.
  if (baseline !== null) return score <= baseline - SCORE_DROP;
  return score < notifyBelow;
}

/** Below this many checks there is no trend to read, only noise. */
const DRIFT_MIN_CHECKS = 6;
/** The newest checks the drift detector reads — a fixed window, like the
 * baseline's: with a deep backfilled history, "is the level sliding" must
 * compare recent halves, not this year against three years ago (that
 * question belongs to the long view, which shows it instead of alerting). */
export const DRIFT_WINDOW = 12;

/**
 * Has the repo's own level slid? The relative alert measures a release
 * against the median of that repo's past checks — a number the publisher
 * produces. Six releases losing eight points each never trip it while the
 * level they define moves forty, and the absolute floor that would have
 * caught it was given up when alerting went relative. So watch the level
 * itself: older half of the window against the newer one.
 */
export function hasDrifted(history: Array<{ score: number }>): boolean {
  const window = history.slice(-DRIFT_WINDOW);
  if (window.length < DRIFT_MIN_CHECKS) return false;
  const half = Math.floor(window.length / 2);
  const older = scoreBaseline(window.slice(0, half));
  const newer = scoreBaseline(window.slice(-half));
  if (older === null || newer === null) return false;
  return newer <= older - SCORE_DROP;
}

/** Worst exit code of the batch: 2 (errors) > 1 (failed gate) > 0. */
export function worstExit(codes: number[]): number {
  return codes.reduce((worst, c) => Math.max(worst, c), 0);
}

/** Self-contained watch overview: one row per watched repo, red rows first,
 * whole rows link to the report; repos awaiting their first check are listed
 * too so a fresh `watch add` is visible immediately. */
export function toWatchIndexHtml(
  state: WatchState,
  generatedAt: string,
  configured?: WatchedEntry[],
): string {
  const entries: Array<{ key: string; repo: string; url?: string; rs: RepoState | undefined }> =
    configured
      ? configured.map((e) => ({ ...e, rs: state.repos[e.key] }))
      : Object.entries(state.repos).map(([key, rs]) => ({ key, repo: key, rs }));
  const withData = entries
    .filter((e) => e.rs?.latest)
    .sort((a, b) => {
      const fa = a.rs!.latest!.flagged ? 0 : 1;
      const fb = b.rs!.latest!.flagged ? 0 : 1;
      if (fa !== fb) return fa - fb;
      return (b.rs!.latest!.checkedAt ?? "").localeCompare(a.rs!.latest!.checkedAt ?? "");
    });
  const pending = entries.filter((e) => !e.rs?.latest);
  const flaggedCount = withData.filter((e) => e.rs!.latest!.flagged).length;
  // Unverified gets its own bucket, not folded into "mid" — a capped 65 for
  // "could not be checked" must not look like a genuinely scored 65-84.
  const scoreClass = (h: { score: number; scoreLabel: string }) =>
    h.scoreLabel === "unverified" ? "unverified" : h.score >= 85 ? "good" : h.score >= 65 ? "mid" : "bad";
  const latest = withData.map((e) => e.rs!.latest!);
  const brokenTotal = latest.reduce((s, l) => s + (l.brokenPromises ?? 0), 0);
  // Score distribution across the CURRENT state of every repo — the shape of
  // the whole watchlist at a glance, in the same buckets the rows use.
  const dist = { good: 0, mid: 0, bad: 0, unverified: 0 };
  for (const l of latest) dist[scoreClass(l) as keyof typeof dist]++;
  const DIST_LABEL = { good: "85+", mid: "65–84", bad: "&lt;65", unverified: "unverified" };
  const distBar = latest.length
    ? `<div class="dist" role="img" aria-label="score distribution">${(
        Object.keys(dist) as Array<keyof typeof dist>
      )
        .filter((k) => dist[k] > 0)
        .map(
          (k) =>
            `<div class="seg ${k}" style="width:${((dist[k] / latest.length) * 100).toFixed(1)}%" title="${dist[k]} repo(s) at ${DIST_LABEL[k]}"></div>`,
        )
        .join("")}</div><div class="legend">${(Object.keys(dist) as Array<keyof typeof dist>)
        .map((k) => `<span class="lg"><span class="dot ${k}"></span>${DIST_LABEL[k]} ${dist[k]}</span>`)
        .join("")}</div>`
    : "";
  const cards = `<div class="cards">
<div><div class="n">${entries.length}</div><div class="t">repos watched</div></div>
<div><div class="n">${flaggedCount}</div><div class="t">flagged</div></div>
<div><div class="n">${brokenTotal}</div><div class="t">broken promise${brokenTotal === 1 ? "" : "s"}</div></div>
<div class="distcard"><div class="t">latest scores</div>${distBar}</div>
</div>`;
  // The feed reads along the releases' own axis, not the table's per-repo
  // one: what came out across the whole watchlist, newest first.
  const FEED_MAX = 30;
  const allChecks = withData
    .flatMap(({ key, rs }) => rs!.history.map((h) => ({ key, h })))
    .sort((a, b) =>
      (b.h.publishedAt ?? b.h.checkedAt).localeCompare(a.h.publishedAt ?? a.h.checkedAt),
    );
  const feedRows = allChecks
    .slice(0, FEED_MAX)
    .map(
      ({ key, h }) =>
        `<li><span class="when">${h.publishedAt ? esc(h.publishedAt.slice(0, 10)) : esc(h.checkedAt.slice(0, 10))}</span> <span${
          h.backfilled ? ` title="backfilled — checked after the fact${h.flagged ? "; flagged on record, never alerted" : ""}"` : ""
        }>${
          h.flagged ? "&#9888;" : "&#10003;"
        }</span> <b>${esc(key.includes("://") ? key.replace(/^\w+:\/\//, "") : key)}</b> <a href="${esc(h.report)}">${esc(h.tag)}</a> <span class="score ${scoreClass(h)}">${h.score}</span> ${esc(h.scoreLabel)}${
          h.brokenPromises ? ` <span class="incomplete">${h.brokenPromises} broken promise${h.brokenPromises > 1 ? "s" : ""}</span>` : ""
        }</li>`,
    )
    .join("\n");
  const feedSection = allChecks.length
    ? `<h2>Release feed <span class="note">— every checked release across the watchlist, newest first${
        allChecks.length > FEED_MAX ? ` (last ${FEED_MAX} of ${allChecks.length})` : ""
      } · <a href="feed.xml">atom</a></span></h2>
<ol class="feed">
${feedRows}
</ol>`
    : "";
  // A forge entry carries its own web URL; only plain owner/repo entries mean
  // GitHub. A URL-shaped `repo` (unparseable repoUrl) must not be pinned on
  // github.com just because it contains a slash. The cell shows owner/repo —
  // an unlabeled forge entry's key is its whole URL, which belongs in the
  // title, not across the table.
  const forgeHref = (repo: string, url?: string) =>
    url ?? (repo.includes("/") && !repo.includes("://") ? `https://github.com/${repo}` : null);
  const shownName = (key: string, repo: string) => (key.includes("://") ? repo : key);
  // The most prominent click in a row is the repo name, and the most valuable
  // drilldown is the repo's own history page — so the name opens it (the
  // common dashboard idiom: name = internal detail), and the forge moves to
  // a small ↗ right behind it, the same pattern the release column uses.
  const repoCell = (key: string, repo: string, url: string | undefined, rs: RepoState) => {
    const fh = forgeHref(repo, url);
    return (
      `<a class="repo" href="${esc(reportDirOf(rs, key))}/index.html" title="this repo's full history: score series, verdicts, promise ledger">${esc(shownName(key, repo))}</a>` +
      (fh
        ? ` <a class="ext" href="${esc(fh)}" target="_blank" rel="noopener" title="${esc(fh)}">&#8599;</a>`
        : "")
    );
  };
  // A waiting row has no history page yet — its name keeps the forge link.
  const pendingCell = (key: string, repo: string, url?: string) => {
    const fh = forgeHref(repo, url);
    const shown = shownName(key, repo);
    return fh
      ? `<a class="repo" href="${esc(fh)}" target="_blank" rel="noopener"${url ? ` title="${esc(url)}"` : ""}>${esc(shown)}</a>`
      : esc(shown);
  };
  const rows = withData
    .map(({ key, repo, url, rs }) => {
      const l = rs!.latest!;
      const v = l.verdicts;
      // A single dot would just repeat the score column — the trend earns
      // its place only once there is history, and then each dot links to
      // that release's report.
      const trend =
        rs!.history.length >= 2
          ? rs!.history
              .slice(-6)
              .map(
                (h) =>
                  `<a href="${esc(h.report)}" title="${esc(h.tag)}: ${h.score}"><span class="dot ${scoreClass(h)}"></span></a>`,
              )
              .join("")
          : "";
      const comp = l.components
        ? `${l.components.correctness} · ${l.components.completeness ?? "–"} · ${l.components.risk}`
        : "";
      const releaseHref =
        l.releaseUrl ??
        (repo.includes("/") && !url && !repo.includes("://")
          ? `https://github.com/${repo}/releases/tag/${encodeURIComponent(l.tag)}`
          : null);
      const releaseUrl = releaseHref
        ? ` <a class="ext" href="${esc(releaseHref)}" target="_blank" rel="noopener" title="release on its forge">&#8599;</a>`
        : "";
      return `<tr class="${l.flagged ? "flagged" : ""}" data-href="${esc(l.report)}" data-repo="${esc(key.toLowerCase())}" data-released="${l.publishedAt ? esc(l.publishedAt) : ""}" data-score="${l.score}" data-flags="${l.criticalFlags * 1000 + l.flagCount}" data-checked="${esc(l.checkedAt)}">
<td${l.backfilled ? ` title="backfilled — checked after the fact${l.flagged ? "; flagged on record, never alerted" : ""}"` : ""}>${l.flagged ? "&#9888;" : "&#10003;"}</td>
<td>${repoCell(key, repo, url, rs!)}</td>
<td><a href="${esc(l.report)}">${esc(l.tag)}</a>${releaseUrl}</td>
<td>${l.publishedAt ? esc(l.publishedAt.slice(0, 10)) : ""}</td>
<td><span class="score ${scoreClass(l)}" title="judge: ${esc(l.engine)}${
        typeof l.scoreLevel === "number" ? ` · this repo's median: ${l.scoreLevel}` : ""
      }">${l.score}</span> ${esc(l.scoreLabel)}${
        typeof l.scoreLevel === "number" && l.score < l.scoreLevel - 20
          ? ` <span class="drop" title="down from this repo's median of ${l.scoreLevel}">&#8595;${l.scoreLevel - l.score}</span>`
          : typeof l.scoreLevel === "number"
            ? ` <span class="level" title="this repo's median is ${l.scoreLevel}">~median</span>`
            : ""
      }${
        l.unverifiable
          ? ` <span class="tag" title="${esc(UNVERIFIABLE_TITLE[l.unverifiable])}">${esc(UNVERIFIABLE_TAG[l.unverifiable])}</span>`
          : ""
      }${
        l.warnings?.length
          ? ` <span class="incomplete" title="${esc(l.warnings.join(" · "))}">&#9888; partial data</span>`
          : ""
      }${
        l.brokenPromises
          ? ` <span class="incomplete" title="an earlier release promised a change this release was due to ship">&#9888; ${l.brokenPromises} broken promise${l.brokenPromises > 1 ? "s" : ""}</span>`
          : ""
      }</td>
<td class="comp">${comp}</td>
<td>${v.verified}&#10004; ${v.partial}&#9680; ${v.noEvidence}? ${v.contradicted}&#10008;</td>
<td>${l.criticalFlags ? `<b>${l.criticalFlags} critical</b>` : l.flagCount || ""}</td>
<td>${trend}</td>
<td title="${esc(l.checkedAt)}">${esc(l.checkedAt.slice(0, 10))}</td>
</tr>`;
    })
    .join("\n");
  const pendingRows = pending
    .map(
      ({ key, repo, url }) => `<tr class="pending">
<td>&#8943;</td>
<td>${pendingCell(key, repo, url)}</td>
<td colspan="8">waiting for the first release check</td>
</tr>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>comparereleaseii watch</title>
<style>
body{font:14px/1.5 system-ui,sans-serif;margin:2rem auto;max-width:75rem;padding:0 1rem;color:#1f2328;background:#fff}
h1{font-size:1.3rem} .sub{color:#59636e}
h2{font-size:1rem;margin-top:1.6rem}
.note{color:#59636e;font-size:.85em;font-weight:400}
.cards{display:flex;gap:26px;flex-wrap:wrap;align-items:center;background:#f6f8fa;border:1px solid #d1d9e0;border-radius:10px;padding:10px 16px;margin:12px 0}
.cards>div{text-align:center}.cards .n{font-size:20px;font-weight:700}.cards .t{color:#59636e;font-size:12px}
.distcard{min-width:180px;flex:1;text-align:left!important}
.dist{display:flex;height:10px;border-radius:5px;overflow:hidden;margin:4px 0 2px}
.dist .seg{height:100%;border-right:2px solid #f6f8fa}.dist .seg:last-child{border-right:0}
.seg.good,.dot.good{background:#1a7f37}.seg.mid,.dot.mid{background:#d4a72c}.seg.bad,.dot.bad{background:#cf222e}.seg.unverified,.dot.unverified{background:#8250df}
.legend{color:#59636e;font-size:11px}.lg{margin-right:10px}
button{background:#f6f8fa;color:#1f2328;border:1px solid #d1d9e0;border-radius:6px;padding:3px 10px;cursor:pointer;font-size:12px}
button.active{background:#cf222e;border-color:#cf222e;color:#fff}
body.only-flagged tr[data-href]:not(.flagged),body.only-flagged tr.pending{display:none}
table{border-collapse:collapse;width:100%;margin-top:1rem}
th,td{text-align:left;padding:.45rem .6rem;border-bottom:1px solid #d1d9e0}
th{font-size:.8rem;text-transform:uppercase;letter-spacing:.04em;color:#59636e}
th[data-sort]{cursor:pointer;white-space:nowrap}
th[data-sort]::after{content:" \\2195";color:#818b98}
th[data-sort].sorted[data-dir="asc"]::after{content:" \\2191";color:#1f2328}
th[data-sort].sorted[data-dir="desc"]::after{content:" \\2193";color:#1f2328}
.feed{list-style:none;padding:0;margin:.5rem 0}
.feed li{padding:.28rem 0;border-bottom:1px solid #d1d9e0}
.feed .when{color:#59636e;font-variant-numeric:tabular-nums;margin-right:.3rem}
tr.flagged{background:#fff1f0}
tr[data-href]{cursor:pointer}
tr[data-href]:hover{background:#f6f8fa}
tr.flagged[data-href]:hover{background:#ffe3e0}
tr.pending td{color:#59636e}
.score{display:inline-block;min-width:2.2em;text-align:center;border-radius:.6em;padding:0 .35em;font-weight:600;color:#fff}
.tag{display:inline-block;border:1px solid #58a6ff;color:#58a6ff;border-radius:.6em;padding:0 .4em;font-size:.8em;white-space:nowrap}
.drop{display:inline-block;border:1px solid #cf222e;color:#cf222e;border-radius:.6em;padding:0 .4em;font-size:.8em}
.incomplete{display:inline-block;border:1px solid #9a6700;color:#9a6700;border-radius:.6em;padding:0 .4em;font-size:.8em;white-space:nowrap}
.level{color:#8b949e;font-size:.8em}
.score.good{background:#1a7f37}.score.mid{background:#9a6700}.score.bad{background:#cf222e}.score.unverified{background:#8250df}
.comp{color:#59636e;white-space:nowrap}
.dot{display:inline-block;width:.55em;height:.55em;border-radius:50%;margin-right:2px}
.dot.good{background:#1a7f37}.dot.mid{background:#d4a72c}.dot.bad{background:#cf222e}.dot.unverified{background:#8250df}
a{color:#0969da;text-decoration:none}a:hover{text-decoration:underline}
a.repo{color:inherit}a.ext{font-size:.85em}
@media (prefers-color-scheme:dark){body{background:#0d1117;color:#e6edf3}th{color:#8d96a0}th,td{border-color:#30363d}tr.flagged{background:#3c1618}tr[data-href]:hover{background:#161b22}tr.flagged[data-href]:hover{background:#4a1c1f}tr.pending td{color:#8d96a0}.comp{color:#8d96a0}.incomplete{border-color:#d29922;color:#d29922}
.cards{background:#161b22;border-color:#30363d}.cards .t,.sub,.note,.legend,.feed .when{color:#8d96a0}
.dist .seg{border-color:#161b22}
button{background:#161b22;color:#e6edf3;border-color:#30363d}button.active{background:#cf222e;border-color:#cf222e;color:#fff}
th[data-sort]::after{color:#484f58}
th[data-sort].sorted[data-dir="asc"]::after,th[data-sort].sorted[data-dir="desc"]::after{color:#e6edf3}
.feed li{border-color:#30363d}}
</style></head><body>
<h1>Release watch</h1>
<p class="sub">generated ${esc(generatedAt)} by comparereleaseii · <a href="feed.xml">atom feed</a></p>
${cards}
<p class="sub"><button id="flagged-only" type="button">&#9888; flagged only</button> <span class="note">columns with &#8597; sort on click</span></p>
<table>
<thead><tr><th></th><th data-sort="repo">repo</th><th>release</th><th data-sort="released">released</th><th data-sort="score">trust score</th><th>c &middot; c &middot; r</th><th>verdicts</th><th data-sort="flags">flags</th><th>trend</th><th data-sort="checked">checked</th></tr></thead>
<tbody>
${rows}
${pendingRows}
</tbody></table>
${feedSection}
<p class="sub">rows: &#10003; passed &middot; &#9888; flagged &middot; &#8943; waiting &mdash;
verdicts: &#10004; verified &middot; &#9680; partial &middot; ? no evidence &middot; &#10008; contradicted &mdash;
c &middot; c &middot; r = correctness &middot; completeness &middot; risk</p>
<p class="sub">repo names open that repo&#39;s full record &middot; click anywhere else in a row for the current report &middot; trend dots (last 6 checks) open past reports &middot; &#8599; opens the repo or release on its forge</p>
<p class="sub">scores measure how well the release notes match the shipped diff &mdash; not project quality, and never people; every number links to the full evidence behind it</p>
<script>
for (const tr of document.querySelectorAll("tr[data-href]")) {
  tr.addEventListener("click", (e) => {
    if (e.target.closest("a")) return;
    location.href = tr.dataset.href;
  });
}
const tbody = document.querySelector("tbody");
const pendingRows = [...tbody.querySelectorAll("tr.pending")];
let sortKey = null;
let dir = 1;
for (const th of document.querySelectorAll("th[data-sort]")) {
  th.addEventListener("click", () => {
    const key = th.dataset.sort;
    // Repo names read naturally ascending; numbers and dates start with the
    // biggest/newest on top. A second click flips.
    dir = key === sortKey ? -dir : key === "repo" ? 1 : -1;
    sortKey = key;
    const numeric = key === "score" || key === "flags";
    const rows = [...tbody.querySelectorAll("tr[data-href]")].sort((a, b) => {
      const va = a.dataset[key] ?? "";
      const vb = b.dataset[key] ?? "";
      return dir * (numeric ? Number(va) - Number(vb) : va.localeCompare(vb));
    });
    for (const r of rows) tbody.appendChild(r);
    for (const r of pendingRows) tbody.appendChild(r);
    for (const o of document.querySelectorAll("th[data-sort]")) {
      o.classList.toggle("sorted", o === th);
      if (o === th) o.dataset.dir = dir > 0 ? "asc" : "desc";
      else delete o.dataset.dir;
    }
  });
}
document.getElementById("flagged-only").addEventListener("click", (e) => {
  document.body.classList.toggle("only-flagged");
  e.currentTarget.classList.toggle("active");
});
</script>
</body></html>
`;
}

/**
 * Static Atom feed next to the index — the pull counterpart to --notify's
 * push. Links are relative and resolve against the feed's own URL, so the
 * reports directory stays scp-able as a whole. Entry ids derive from state
 * key + tag and `updated` is the stored checkedAt, so re-rendering the feed
 * never re-publishes an old check as new.
 */
export function toWatchAtomFeed(
  state: WatchState,
  generatedAt: string,
  configured?: WatchedEntry[],
): string {
  const entries: Array<{ key: string; rs: RepoState | undefined }> = configured
    ? configured.map((e) => ({ key: e.key, rs: state.repos[e.key] }))
    : Object.entries(state.repos).map(([key, rs]) => ({ key, rs }));
  const checks = entries
    .filter((e) => e.rs)
    .flatMap(({ key, rs }) => rs!.history.map((h) => ({ key, h })))
    // A feed reader treats every entry as news. Backfilled checks are the
    // past — 40 of them arriving at once, several flagged, is exactly the
    // historical alert noise --notify refuses to make; the pull channel
    // refuses it too. They stay on the index's own feed section and pages.
    .filter(({ h }) => !h.backfilled)
    .sort((a, b) => b.h.checkedAt.localeCompare(a.h.checkedAt))
    .slice(0, 50);
  const items = checks.map(({ key, h }) => {
    const id = `urn:comparereleaseii:${encodeURIComponent(key)}:${encodeURIComponent(h.tag)}`;
    const v = h.verdicts;
    const summary =
      `score ${h.score}/100 (${h.scoreLabel})${h.flagged ? " — FLAGGED" : ""} · ` +
      `verdicts: ${v.verified} verified, ${v.partial} partial, ${v.noEvidence} no-evidence, ${v.contradicted} contradicted · ` +
      `flags: ${h.flagCount}${h.criticalFlags ? ` (${h.criticalFlags} critical)` : ""}` +
      (h.brokenPromises ? ` · ${h.brokenPromises} broken promise(s)` : "") +
      (h.warnings?.length ? ` · ${h.warnings.join(" · ")}` : "");
    return `<entry>
<id>${esc(id)}</id>
<title>${esc(`${key} ${h.tag} — ${h.score}/100 ${h.scoreLabel}${h.flagged ? " ⚠" : ""}`)}</title>
<updated>${esc(h.checkedAt)}</updated>
<link rel="alternate" type="text/html" href="${esc(h.report)}"/>
<summary>${esc(summary)}</summary>
</entry>`;
  });
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<id>urn:comparereleaseii:watch-feed</id>
<title>Release watch — comparereleaseii</title>
<updated>${esc(generatedAt)}</updated>
<author><name>comparereleaseii</name></author>
<link rel="alternate" type="text/html" href="index.html"/>
${items.join("\n")}
</feed>
`;
}

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

async function saveState(path: string, state: WatchState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2));
  await rename(tmp, path);
}

/**
 * `cmd` is the operator's own shell string — running it is the feature. The
 * report path is not: it carries a repo key and a tag, both from the config
 * and the forge. It is therefore passed as a positional argument and read back
 * as `"$1"`, never interpolated — the shell parses the operator's command and
 * nothing else. Writing `${cmd} ${jsonPath}` here would hand a crafted tag a
 * shell; the two sanitizers upstream (`safeSegment`, `sanitizeTag`) would then
 * be the only thing left, and defence in depth is the point.
 */
export function runNotify(cmd: string, jsonPath: string): Promise<boolean> {
  return new Promise((done) => {
    const child = spawn("sh", ["-c", `${cmd} "$1"`, "sh", jsonPath], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("close", (code) => {
      if (code !== 0) console.error(`warning: notify command exited with ${code}`);
      done(code === 0);
    });
    child.on("error", (err) => {
      console.error(`warning: notify command failed to start: ${err.message}`);
      done(false);
    });
  });
}

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
