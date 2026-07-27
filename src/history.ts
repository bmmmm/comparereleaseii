// SPDX-License-Identifier: GPL-3.0-or-later
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cacheDir, safeSegment, VERSION } from "./paths.ts";
import { pooled, c } from "./util.ts";
import { parseClaims } from "./claims.ts";
import { anchorMatch, lexicalMatch } from "./match.ts";
import { newDependencies, opacityIssue, sensitiveCategory } from "./metrics.ts";
import { assertRepoSlug, ghApi, fetchCompare, type GhRelease } from "./sources/github.ts";
import { changelogReleases, loadLocalRange } from "./sources/local.ts";
import type { Commit, DiffFile } from "./types.ts";

export interface ReleaseSnapshot {
  tag: string;
  base: string;
  date: string | null;
  commits: number;
  files: number;
  additions: number;
  deletions: number;
  claims: number;
  /** Share of commits referenced by note anchors (0..1). */
  anchoredCoverage: number;
  /**
   * Share of `change` claims whose identifiers appear anywhere in the diff
   * (0..1), deterministic — no judge. Near zero across a whole history means
   * the notes habitually describe code that is not in this repo.
   */
  lexicalCoverage: number;
  sensitiveTouched: string[];
  binaries: number;
  newDeps: string[];
  /** Identity keys (see authorKey) — emails where the source carries them. */
  authors: string[];
  /**
   * Forge logins, when the range came from an API (a clone has none). What
   * makes them worth a second list: the email above is attacker-chosen, the
   * forge account is not.
   */
  logins?: string[];
}

/**
 * Cross-source author identity: the git-header email when present
 * (lowercased — the compare API and a clone both carry it), the display
 * name/login otherwise. Snapshots cached before emails existed hold names;
 * the version stamp retires them at the next release bump.
 */
export function authorKey(commit: { author: string; email?: string }): string {
  const email = commit.email?.trim().toLowerCase();
  return email || commit.author;
}

export interface Baseline {
  snapshots: ReleaseSnapshot[];
  medianChurn: number;
  /** Median of the snapshots' lexicalCoverage — the repo's normal shape. */
  medianLexicalCoverage: number;
  knownAuthors: string[];
  /** Forge logins seen in API-built snapshots; empty when history came from a clone. */
  knownLogins: string[];
  everBinary: boolean;
}

/** One past release, in the only shape a snapshot needs. */
export interface HistoryRelease {
  tag: string;
  notes: string;
  /** YYYY-MM-DD, or null when the source does not date its releases. */
  date: string | null;
}

/**
 * Where the baseline gets its history.
 *
 * A snapshot needs two things, and they do not come from the same place: which
 * tags are releases and what their notes say, and the diff of each release
 * against the one before it. GitHub answers both over its API, which is why
 * this used to be one hardcoded pair of calls. Every other forge answers the
 * first over its own API — or does not, and then the CHANGELOG in the clone
 * does — while the diff comes out of the clone the check already made. The
 * split is what lets --baseline leave GitHub.
 */
export interface HistorySource {
  /**
   * Namespaces the snapshot cache. Carries the host for anything but GitHub:
   * two forges can each have an `owner/repo`, and those are not the same repo.
   */
  cacheKey: string;
  /** owner/repo — the dependency heuristics use it to spot a repo's own packages. */
  slug: string;
  listReleases(): Promise<HistoryRelease[]>;
  loadRange(base: string, head: string): Promise<{ commits: Commit[]; files: DiffFile[] }>;
}

/** History over the GitHub API: releases and compare, as before. */
export function githubHistory(repo: string): HistorySource {
  const slug = assertRepoSlug(repo);
  return {
    cacheKey: slug,
    slug,
    async listReleases() {
      const releases = await ghApi<GhRelease[]>(`repos/${slug}/releases?per_page=100`);
      return releases
        .filter((r) => !r.draft && !r.prerelease)
        .map((r) => ({
          tag: r.tag_name,
          notes: r.body ?? "",
          date: r.published_at?.slice(0, 10) ?? null,
        }));
    },
    loadRange: (base, head) => fetchCompare(slug, base, head),
  };
}

/**
 * History out of a git clone. `releases` is what a forge API answered, when one
 * did; without it the clone's own tags and CHANGELOG are the release list.
 */
export function cloneHistory(opts: {
  dir: string;
  slug: string;
  cacheKey: string;
  releases?: HistoryRelease[];
}): HistorySource {
  return {
    cacheKey: opts.cacheKey,
    slug: opts.slug,
    listReleases: async () => opts.releases ?? (await changelogReleases(opts.dir)),
    loadRange: (base, head) => loadLocalRange(opts.dir, base, head),
  };
}

async function snapshotFor(
  source: HistorySource,
  release: HistoryRelease,
  baseTag: string,
): Promise<ReleaseSnapshot> {
  const dir = await cacheDir("snapshots");
  // Tag names may contain slashes and dots — one path component, always.
  const cacheFile = dir
    ? join(
        dir,
        `${safeSegment(source.cacheKey)}-${safeSegment(baseTag)}..${safeSegment(release.tag)}.json`,
      )
    : null;
  if (cacheFile) {
    try {
      const { version, ...cached } = JSON.parse(await readFile(cacheFile, "utf8")) as
        ReleaseSnapshot & { version?: string };
      // A snapshot is a bundle of formula outputs (coverage rules, lexical
      // scoring, dependency heuristics) — all of which change across
      // releases of this tool. The verdict cache learned in 0.1.2 that only
      // a version stamp catches a changed formula; the field-presence check
      // alone only catches an *added* field.
      if (version === VERSION && typeof cached.lexicalCoverage === "number") return cached;
    } catch {
      // cache miss — build below
    }
  }

  const cmp = await source.loadRange(baseTag, release.tag);
  const claims = parseClaims(release.notes);
  const covered = new Set<string>();
  for (const claim of claims) {
    for (const commit of anchorMatch(claim, cmp.commits).commits) covered.add(commit.sha);
  }
  const categories = new Set<string>();
  for (const f of cmp.files) {
    const cat = sensitiveCategory(f.path);
    if (cat) categories.add(cat);
  }
  const changeClaims = claims.filter((claim) => claim.kind === "change");
  const lexicalHits = changeClaims.filter(
    (claim) => lexicalMatch(claim, cmp.files).score > 0,
  ).length;
  const snapshot: ReleaseSnapshot = {
    tag: release.tag,
    base: baseTag,
    date: release.date,
    commits: cmp.commits.length,
    files: cmp.files.length,
    additions: cmp.files.reduce((s, f) => s + f.additions, 0),
    deletions: cmp.files.reduce((s, f) => s + f.deletions, 0),
    claims: claims.length,
    anchoredCoverage: cmp.commits.length ? covered.size / cmp.commits.length : 1,
    lexicalCoverage: changeClaims.length ? lexicalHits / changeClaims.length : 1,
    sensitiveTouched: [...categories],
    binaries: cmp.files.filter((f) => opacityIssue(f) === "binary file").length,
    newDeps: [...new Set(cmp.files.flatMap((f) => newDependencies(f, source.slug)))],
    authors: [...new Set(cmp.commits.map((commit) => authorKey(commit)))],
  };
  // Only when the source attributes commits at all — an empty list from an
  // API range is a statement ("no known account touched this"), an absent
  // one from a clone is not.
  if (cmp.commits.some((commit) => commit.login !== undefined)) {
    snapshot.logins = [
      ...new Set(cmp.commits.flatMap((commit) => (commit.login ? [commit.login] : []))),
    ];
  }
  if (cacheFile) {
    try {
      await writeFile(cacheFile, JSON.stringify({ version: VERSION, ...snapshot }), {
        mode: 0o600,
      });
    } catch {
      // cache is best-effort
    }
  }
  return snapshot;
}

/**
 * Snapshots of consecutive stable releases, newest first.
 * `before` restricts to releases strictly older than that tag (baseline use).
 */
export async function buildSnapshots(
  source: HistorySource,
  opts: { count: number; before?: string; concurrency?: number },
): Promise<ReleaseSnapshot[]> {
  const releases = await source.listReleases();
  let start = 0;
  if (opts.before) {
    const i = releases.findIndex((r) => r.tag === opts.before);
    if (i !== -1) start = i + 1;
  }
  const pairs: Array<{ release: HistoryRelease; base: string }> = [];
  for (let i = start; i < releases.length - 1 && pairs.length < opts.count; i++) {
    pairs.push({ release: releases[i], base: releases[i + 1].tag });
  }
  const built = await pooled(pairs, opts.concurrency ?? 4, (p) =>
    // One release the source cannot answer for used to cost the whole
    // baseline: this threw all the way up into a `.catch(() => null)` at the
    // call site, and the run continued with no baseline and nothing said. A
    // clone makes that ordinary — a tag the fetch never got, a range whose
    // blobs the promisor remote would not hand over.
    snapshotFor(source, p.release, p.base).catch((err: Error) => {
      console.error(
        `warning: no baseline snapshot for ${p.release.tag} ` +
          `(${err.message.split("\n")[0].slice(0, 120)}) — continuing without it.`,
      );
      return null;
    }),
  );
  return built.filter((s): s is ReleaseSnapshot => s !== null);
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function summarizeBaseline(snapshots: ReleaseSnapshot[]): Baseline {
  return {
    snapshots,
    medianChurn: median(snapshots.map((s) => s.additions + s.deletions)),
    medianLexicalCoverage: median(snapshots.map((s) => s.lexicalCoverage)),
    knownAuthors: [...new Set(snapshots.flatMap((s) => s.authors))],
    knownLogins: [...new Set(snapshots.flatMap((s) => s.logins ?? []))],
    everBinary: snapshots.some((s) => s.binaries > 0),
  };
}

export function printTimeline(snapshots: ReleaseSnapshot[]): void {
  console.log(c.bold("\nRelease history") + c.dim(` — ${snapshots.length} release(s), newest first\n`));
  const header = ["tag", "date", "commits", "files", "±churn", "claims", "anchored", "lexical", "sensitive", "deps+", "bin"];
  const rows = snapshots.map((s) => [
    s.tag,
    s.date ?? "?",
    String(s.commits),
    String(s.files),
    `${s.additions + s.deletions}`,
    String(s.claims),
    `${Math.round(s.anchoredCoverage * 100)}%`,
    `${Math.round(s.lexicalCoverage * 100)}%`,
    s.sensitiveTouched.map((t) => t.split("/")[0]).join(",") || "-",
    String(s.newDeps.length),
    String(s.binaries),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  console.log(c.dim(header.map((h, i) => h.padEnd(widths[i])).join("  ")));
  for (const r of rows) console.log(r.map((v, i) => v.padEnd(widths[i])).join("  "));
  const base = summarizeBaseline(snapshots);
  console.log(
    c.dim(
      `\nmedian churn ±${base.medianChurn} · ${base.knownAuthors.length} distinct authors · binaries in history: ${base.everBinary ? "yes" : "no"}`,
    ),
  );
}
