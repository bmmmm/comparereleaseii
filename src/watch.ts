// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { assertRepoSlug, ghApi } from "./sources/github.ts";
import { fetchForgeReleases, parseRepoUrl, type ForgeListing } from "./sources/forge.ts";
import { assertCloneUrl } from "./sources/local.ts";
import { resolveEngines, type EngineOptions } from "./judge.ts";
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
import { safeSegment } from "./paths.ts";

import type { PromiseCheck, UnverifiableKind } from "./types.ts";
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
  /** HTML report path relative to the reports directory. */
  report: string;
  /**
   * The release's own web page. States written before forges joined lack it;
   * the index then derives the GitHub URL, which is all those states watched.
   */
  releaseUrl?: string;
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

interface RepoState {
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

/**
 * Has the repo's own level slid? The relative alert measures a release
 * against the median of that repo's past checks — a number the publisher
 * produces. Six releases losing eight points each never trip it while the
 * level they define moves forty, and the absolute floor that would have
 * caught it was given up when alerting went relative. So watch the level
 * itself: older half of the history against the newer one.
 */
export function hasDrifted(history: Array<{ score: number }>): boolean {
  if (history.length < DRIFT_MIN_CHECKS) return false;
  const half = Math.floor(history.length / 2);
  const older = scoreBaseline(history.slice(0, half));
  const newer = scoreBaseline(history.slice(-half));
  if (older === null || newer === null) return false;
  return newer <= older - SCORE_DROP;
}

/** Worst exit code of the batch: 2 (errors) > 1 (failed gate) > 0. */
export function worstExit(codes: number[]): number {
  return codes.reduce((worst, c) => Math.max(worst, c), 0);
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
  // A forge entry carries its own web URL; only plain owner/repo entries mean
  // GitHub. A URL-shaped `repo` (unparseable repoUrl) must not be pinned on
  // github.com just because it contains a slash. The cell shows owner/repo —
  // an unlabeled forge entry's key is its whole URL, which belongs in the
  // title, not across the table.
  const repoCell = (key: string, repo: string, url?: string) => {
    const shown = key.includes("://") ? repo : key;
    const title = shown === repo ? (url ?? "") : (url ?? repo);
    const href =
      url ?? (repo.includes("/") && !repo.includes("://") ? `https://github.com/${repo}` : null);
    return href
      ? `<a class="repo" href="${esc(href)}" target="_blank" rel="noopener"${title ? ` title="${esc(title)}"` : ""}>${esc(shown)}</a>`
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
      return `<tr class="${l.flagged ? "flagged" : ""}" data-href="${esc(l.report)}">
<td>${l.flagged ? "&#9888;" : "&#10003;"}</td>
<td>${repoCell(key, repo, url)}</td>
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
<td>${repoCell(key, repo, url)}</td>
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
table{border-collapse:collapse;width:100%;margin-top:1rem}
th,td{text-align:left;padding:.45rem .6rem;border-bottom:1px solid #d1d9e0}
th{font-size:.8rem;text-transform:uppercase;letter-spacing:.04em;color:#59636e}
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
@media (prefers-color-scheme:dark){body{background:#0d1117;color:#e6edf3}th{color:#8d96a0}th,td{border-color:#30363d}tr.flagged{background:#3c1618}tr[data-href]:hover{background:#161b22}tr.flagged[data-href]:hover{background:#4a1c1f}tr.pending td{color:#8d96a0}.comp{color:#8d96a0}.incomplete{border-color:#d29922;color:#d29922}}
</style></head><body>
<h1>Release watch</h1>
<p class="sub">${entries.length} repos watched · ${flaggedCount} flagged · generated ${esc(generatedAt)} by comparereleaseii</p>
<table>
<thead><tr><th></th><th>repo</th><th>release</th><th>released</th><th>trust score</th><th>c &middot; c &middot; r</th><th>verdicts</th><th>flags</th><th>trend</th><th>checked</th></tr></thead>
<tbody>
${rows}
${pendingRows}
</tbody></table>
<p class="sub">rows: &#10003; passed &middot; &#9888; flagged &middot; &#8943; waiting &mdash;
verdicts: &#10004; verified &middot; &#9680; partial &middot; ? no evidence &middot; &#10008; contradicted &mdash;
c &middot; c &middot; r = correctness &middot; completeness &middot; risk</p>
<p class="sub">click a row for the current report &middot; trend dots (last 6 checks) open past reports &middot; &#8599; opens the release on its forge</p>
<script>
for (const tr of document.querySelectorAll("tr[data-href]")) {
  tr.addEventListener("click", (e) => {
    if (e.target.closest("a")) return;
    location.href = tr.dataset.href;
  });
}
</script>
</body></html>
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

function sanitizeTag(tag: string): string {
  return tag.replace(/[^\w.@-]+/g, "_");
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
  // CLI overrides resolve against the working directory, config-file paths
  // against the config file's own directory (stable under cron).
  const configDir = dirname(resolve(opts.configPath));
  const reportsDir = opts.reportsDir
    ? resolve(opts.reportsDir)
    : resolve(configDir, config.reportsDir ?? "reports");
  const statePath = opts.stateFile
    ? resolve(opts.stateFile)
    : config.stateFile
      ? resolve(configDir, config.stateFile)
      : defaultStatePath();
  const notifyCmd = opts.notify ?? config.notify;
  const state = await loadState(statePath);

  const engineCache = new Map<string, ReturnType<typeof resolveEngines>>();
  const engines = (eo: EngineOptions) => {
    const key = JSON.stringify(eo);
    let p = engineCache.get(key);
    if (!p) {
      p = resolveEngines(eo);
      engineCache.set(key, p);
    }
    return p;
  };

  const codes: number[] = [];
  let checked = 0;
  let flaggedTotal = 0;

  const configured: WatchedEntry[] = config.repos.map((entry) => {
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
  // Regenerated after every check, not just at the end — a long first run
  // over many repos should have a live dashboard, not a blank page.
  const writeIndex = async () => {
    await mkdir(reportsDir, { recursive: true });
    await writeFile(
      join(reportsDir, "index.html"),
      toWatchIndexHtml(state, new Date().toISOString(), configured),
    );
  };

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
        const { engine, escalate } = await engines({
          judgeMode: rc.judge ?? "auto",
          engine: rc.engine ?? "claude-cli",
          model: rc.model,
          openaiUrl: rc.openaiUrl,
          escalate: rc.escalate ?? "auto",
          escalateModel: rc.escalateModel,
          cache: opts.cache,
        });
        const settings: CheckSettings = {
          judgeMode: rc.judge ?? "auto",
          engine,
          escalateEngine: escalate,
          concurrency: rc.concurrency ?? 4,
          reverse: true,
          baseline: rc.baseline ?? 5,
          history: target ? target.history : githubHistory(rc.repo!),
          // Promises older than the base release live only here: the state
          // carries every still-open one until a later diff resolves it — or
          // until it ages out as stale (checkPromises counts the carries).
          carriedPromises: carriedFromLedger(repoState.promises),
        };
        const notesFile = rc.notesFile ? resolve(configDir, rc.notesFile) : undefined;
        let data;
        let context;
        let link: RepoLink | null;
        if (target) {
          ({ data, context } = await loadForgeRelease(target, { head: rel.tag, notesFile }));
          link = target.link;
        } else {
          ({ data, context } = await loadGithubReleaseData(rc.repo!, { tag: rel.tag, notesFile }));
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
        const dir = join(reportsDir, dirKey);
        await mkdir(dir, { recursive: true });
        const base = sanitizeTag(rel.tag);
        const jsonPath = join(dir, `${base}.json`);
        await writeFile(jsonPath, JSON.stringify(report, null, 2));
        await writeFile(join(dir, `${base}.md`), toMarkdown(report));
        await writeFile(join(dir, `${base}.html`), toHtml(report));

        // Watch default is lenient: honest releases often carry unprovable
        // claims (private advisories) — alerting on every one is fatigue.
        // Critical flags and the score threshold still catch attack shapes.
        const ec = exitCode(report, rc.failOn ?? "contradicted");
        const critical = report.metrics.flags.filter((f) => f.severity === "critical").length;
        // The repo's level comes from the checks BEFORE this one — including
        // the current score would let a slow slide redefine "normal".
        const scoreLevel = scoreBaseline(repoState.history);
        const drifted = hasDrifted([
          ...repoState.history,
          { score: report.metrics.scores.overall },
        ]);
        const flagged =
          isFlagged(report.metrics.scores.overall, ec, critical, rc.notifyBelow, scoreLevel) ||
          drifted;
        const verdicts = {
          verified: report.results.filter((r) => r.verdict === "verified").length,
          partial: report.results.filter((r) => r.verdict === "partial").length,
          noEvidence: report.results.filter((r) => r.verdict === "no-evidence").length,
          contradicted: report.results.filter((r) => r.verdict === "contradicted").length,
        };
        const releaseUrl = releaseWebUrl(link, rel.tag);
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
          unverifiable: report.metrics.unverifiable?.kind,
          scoreLevel,
          report: `${dirKey}/${base}.html`,
          ...(releaseUrl ? { releaseUrl } : {}),
        };
        repoState.lastPublishedAt = rel.publishedAt;
        repoState.lastTag = rel.tag;
        repoState.latest = checkedRelease;
        repoState.history = [...repoState.history, checkedRelease].slice(-20);
        // The ledger is replaced wholesale: carried promises were all
        // re-checked this run, resolved ones keep their final status here and
        // only still-open entries ride along to the next release. The cap
        // bounds it — the dedupe key is normalized text, so notes that reword
        // a promise every release would otherwise multiply entries without
        // limit. Report order puts this release's own promises first, so the
        // oldest carried entries (nearest to stale anyway) are what drops.
        if (report.promises?.length || repoState.promises?.length) {
          const ledger = report.promises ?? [];
          if (ledger.length > MAX_PROMISE_LEDGER) {
            console.error(
              `${key}: promise ledger capped at ${MAX_PROMISE_LEDGER} entries ` +
                `(${ledger.length} tracked) — dropping the oldest carried promises.`,
            );
          }
          repoState.promises = capLedger(ledger);
        }
        state.repos[key] = repoState;
        codes.push(ec);
        checked++;
        console.error(
          `${key}: ${rel.tag} → score ${checkedRelease.score} (${checkedRelease.scoreLabel})` +
            (flagged ? " — FLAGGED" : "") +
            (drifted ? " (this repo's own level has been sliding)" : ""),
        );
        if (flagged) {
          flaggedTotal++;
          if (notifyCmd) await runNotify(notifyCmd, jsonPath);
        }
        // Persist after every successful check so a crash never re-alerts.
        await saveState(statePath, state);
        await writeIndex();
      } catch (err) {
        // FIXME: `break` assumes the failure is transient. A permanently
        // failing release (e.g. a tag-only forge release with an empty body
        // -> "No claims found") wedges the repo: state never advances past
        // it, so newer releases are never checked. Distinguish permanent
        // shapes and skip them with a warning instead.
        console.error(`${key}: checking ${rel.tag} failed — ${(err as Error).message}`);
        codes.push(2);
        break; // keep state before the failed release; retried next run
      }
    }
  }

  await writeIndex();
  await saveState(statePath, state);
  const exit = worstExit(codes);
  console.error(
    `watch: ${config.repos.length} repos · ${checked} new release(s) checked · ${flaggedTotal} flagged · index ${join(reportsDir, "index.html")} · exit ${exit}`,
  );
  return exit;
}
