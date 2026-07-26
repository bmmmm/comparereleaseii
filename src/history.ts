// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pooled, c } from "./util.ts";
import { parseClaims } from "./claims.ts";
import { anchorMatch, lexicalMatch } from "./match.ts";
import { newDependencies, opacityIssue, sensitiveCategory } from "./metrics.ts";
import { ghApi, fetchCompare } from "./sources/github.ts";

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
  authors: string[];
}

export interface Baseline {
  snapshots: ReleaseSnapshot[];
  medianChurn: number;
  /** Median of the snapshots' lexicalCoverage — the repo's normal shape. */
  medianLexicalCoverage: number;
  knownAuthors: string[];
  everBinary: boolean;
  /** Fraction of past releases touching each sensitive category. */
  categoryFreq: Record<string, number>;
}

interface GhRelease {
  tag_name: string;
  body: string | null;
  published_at: string | null;
  prerelease: boolean;
  draft: boolean;
}

const CACHE_DIR = join(tmpdir(), "comparereleaseii-cache");

async function snapshotFor(
  repo: string,
  release: GhRelease,
  baseTag: string,
): Promise<ReleaseSnapshot> {
  const cacheFile = join(
    CACHE_DIR,
    `${repo.replace(/\//g, "_")}-${baseTag}...${release.tag_name}.json`,
  );
  try {
    const cached = JSON.parse(await readFile(cacheFile, "utf8")) as ReleaseSnapshot;
    // Snapshots written before a field existed would silently read as
    // undefined and skew every median built from them — rebuild instead.
    if (typeof cached.lexicalCoverage === "number") return cached;
  } catch {
    // cache miss — build below
  }

  const cmp = await fetchCompare(repo, baseTag, release.tag_name);
  const claims = parseClaims(release.body ?? "");
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
    tag: release.tag_name,
    base: baseTag,
    date: release.published_at?.slice(0, 10) ?? null,
    commits: cmp.commits.length,
    files: cmp.files.length,
    additions: cmp.files.reduce((s, f) => s + f.additions, 0),
    deletions: cmp.files.reduce((s, f) => s + f.deletions, 0),
    claims: claims.length,
    anchoredCoverage: cmp.commits.length ? covered.size / cmp.commits.length : 1,
    lexicalCoverage: changeClaims.length ? lexicalHits / changeClaims.length : 1,
    sensitiveTouched: [...categories],
    binaries: cmp.files.filter((f) => opacityIssue(f) === "binary file").length,
    newDeps: [...new Set(cmp.files.flatMap((f) => newDependencies(f, repo)))],
    authors: [...new Set(cmp.commits.map((commit) => commit.author))],
  };
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(cacheFile, JSON.stringify(snapshot));
  } catch {
    // cache is best-effort
  }
  return snapshot;
}

/**
 * Snapshots of consecutive stable releases, newest first.
 * `before` restricts to releases strictly older than that tag (baseline use).
 */
export async function buildSnapshots(
  repo: string,
  opts: { count: number; before?: string },
): Promise<ReleaseSnapshot[]> {
  const releases = (await ghApi<GhRelease[]>(`repos/${repo}/releases?per_page=100`)).filter(
    (r) => !r.draft && !r.prerelease,
  );
  let start = 0;
  if (opts.before) {
    const i = releases.findIndex((r) => r.tag_name === opts.before);
    if (i !== -1) start = i + 1;
  }
  const pairs: Array<{ release: GhRelease; base: string }> = [];
  for (let i = start; i < releases.length - 1 && pairs.length < opts.count; i++) {
    pairs.push({ release: releases[i], base: releases[i + 1].tag_name });
  }
  return pooled(pairs, 4, (p) => snapshotFor(repo, p.release, p.base));
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function summarizeBaseline(snapshots: ReleaseSnapshot[]): Baseline {
  const categoryFreq: Record<string, number> = {};
  for (const s of snapshots) {
    for (const cat of s.sensitiveTouched) {
      categoryFreq[cat] = (categoryFreq[cat] ?? 0) + 1 / (snapshots.length || 1);
    }
  }
  return {
    snapshots,
    medianChurn: median(snapshots.map((s) => s.additions + s.deletions)),
    medianLexicalCoverage: median(snapshots.map((s) => s.lexicalCoverage)),
    knownAuthors: [...new Set(snapshots.flatMap((s) => s.authors))],
    everBinary: snapshots.some((s) => s.binaries > 0),
    categoryFreq,
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
