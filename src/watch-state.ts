// SPDX-License-Identifier: GPL-3.0-or-later
// The watch state and the rules that move it: what a check records, when a
// score counts as flagged, how the author and promise ledgers age. Pure —
// no I/O, no network, no rendering — which is what makes every rule here
// unit-testable and lets both the renderers and the orchestrator depend on
// this module without depending on each other.
import type { RepoLink } from "./check.ts";
import type { CarriedPromise } from "./promises.ts";
import type { Audience, AuthorActivity, PromiseCheck, UnverifiableKind } from "./types.ts";

type FailOn = "none" | "contradicted" | "no-evidence";

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
  /** Flag the release (exit-code path) when the completeness score falls
   * below this percentage — same semantics as the CLI's --min-coverage. */
  minCoverage?: number;
  baseline?: number;
  concurrency?: number;
  includePrerelease?: boolean;
  /** Trust score below which a release is flagged (default 65). */
  notifyBelow?: number;
  /**
   * First-party components behind version pins that cannot name their own
   * repo: pin name → owner/repo (or repository URL), e.g.
   * `{ "WEB_ASSETS_VERSION": "opencloud-eu/web" }`. Pins that name a repo
   * themselves (go.mod paths, download URLs) are classified without this.
   */
  components?: Record<string, string>;
  /**
   * `false` disables the depth-1 sub-check of first-party pin bumps. On by
   * default: when a watched release bumps a first-party component, the
   * component's own (from, to) range is checked and folded into the report
   * — and the verdict cache makes the sub-check free when the component
   * repo is watched too.
   */
  expand?: boolean;
  /**
   * The repo's default lens: who decides updates here — `operator` (hosts
   * it), `integrator` (builds against it) or `user` (runs it themselves).
   * Findings for other audiences fold behind a count; security findings
   * render under every lens. Unset renders unfiltered. Pure config by
   * design: a heuristic reading changed files misclassifies exactly the
   * hybrid repos, and a silently wrong lens hides the findings its real
   * audience needed (S4a).
   */
  audience?: Audience;
  /** `false` disables the LLM findings pass for this repo. */
  findings?: boolean;
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
export const BASELINE_MIN_CHECKS = 3;
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
