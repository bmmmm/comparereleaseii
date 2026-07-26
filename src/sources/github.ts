// SPDX-License-Identifier: GPL-3.0-or-later
import { run, pooled } from "../util.ts";
import type { Commit, DiffFile, ReleaseData, RepoContext } from "../types.ts";

export async function ghApi<T>(path: string): Promise<T> {
  const { stdout } = await run("gh", ["api", path]);
  return JSON.parse(stdout) as T;
}
const ghJson = ghApi;

export interface GhRelease {
  tag_name: string;
  name: string;
  body: string;
  prerelease: boolean;
  draft: boolean;
}

interface GhCompareCommit {
  sha: string;
  commit: { message: string; author: { name: string } };
  author: { login: string } | null;
}

interface GhFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export function extractPrNumbers(message: string): number[] {
  const prs = new Set<number>();
  for (const m of message.matchAll(/\(#(\d+)\)/g)) prs.add(Number(m[1]));
  for (const m of message.matchAll(/Merge pull request #(\d+)/g)) prs.add(Number(m[1]));
  return [...prs];
}

function toCommit(gc: GhCompareCommit): Commit {
  const [subject, ...rest] = gc.commit.message.split("\n");
  return {
    sha: gc.sha,
    subject,
    body: rest.join("\n").trim(),
    author: gc.author?.login ?? gc.commit.author.name,
    prNumbers: extractPrNumbers(gc.commit.message),
  };
}

function toDiffFile(f: GhFile): DiffFile {
  return {
    path: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    patch: f.patch,
  };
}

export async function fetchCompare(
  repo: string,
  base: string,
  head: string,
): Promise<{ commits: Commit[]; files: DiffFile[]; totalCommits: number }> {
  const cmp = await ghJson<{
    total_commits: number;
    commits: GhCompareCommit[];
    files: GhFile[];
  }>(`repos/${repo}/compare/${base}...${head}`);
  return {
    commits: cmp.commits.map(toCommit),
    files: cmp.files.map(toDiffFile),
    totalCommits: cmp.total_commits,
  };
}

/**
 * Pick the base release from a (newest-first) release list, or null when the
 * target is effectively the repo's first release: no earlier entry at all,
 * only drafts (never published), or a stable following only prereleases
 * (its notes describe everything since the last stable — which is nothing).
 * Throws when the page is full — earlier releases may exist beyond it, so
 * "first release" cannot be asserted.
 */
/** Tag text before the first digit: "cli-v2026.7.0" → "cli-v", "1.2b" → "". */
function tagPrefix(tag: string): string {
  const i = tag.search(/\d/);
  return i === -1 ? tag : tag.slice(0, i);
}

/** First number in the tag — the release line's major version. */
function tagMajor(tag: string): string | null {
  return tag.match(/\d+/)?.[0] ?? null;
}

export function pickBaseRelease(releases: GhRelease[], tag: string): string | null {
  const idx = releases.findIndex((r) => r.tag_name === tag);
  if (idx === -1) {
    throw new Error(
      `Release ${tag} not found among the latest 100 releases. Pass --base <tag> explicitly.`,
    );
  }
  const target = releases[idx];
  // Monorepos tag per product (cli-v…, browser-v…) and projects maintain
  // parallel lines (v3.7.x alongside v2.11.x) — "the release right before
  // this one" is then a different product or line, and the diff is garbage
  // (seen live: 328 claims against a 1-commit diff). The base must share
  // the tag prefix, and within that, prefer the same major line.
  const prefix = tagPrefix(tag);
  const major = tagMajor(tag);
  let prefixFallback: string | null = null;
  for (let i = idx + 1; i < releases.length; i++) {
    const r = releases[i];
    if (r.draft) continue;
    // For a stable release, compare against the previous stable one.
    if (!target.prerelease && r.prerelease) continue;
    if (tagPrefix(r.tag_name) !== prefix) continue;
    if (tagMajor(r.tag_name) === major) return r.tag_name;
    // Nearest same-prefix release of another line — right when this is the
    // line's first release (v3.0.0 follows v2.x).
    prefixFallback ??= r.tag_name;
  }
  if (prefixFallback) return prefixFallback;
  if (releases.length >= 100) {
    throw new Error(
      `No usable base among the latest 100 releases before ${tag} — earlier ones may exist beyond the page. Pass --base <tag> explicitly.`,
    );
  }
  return null;
}

/** Previous release tag, or null when this is the repo's first release. */
async function findBaseTag(
  repo: string,
  tag: string,
): Promise<{ tag: string; notes: string } | null> {
  const releases = await ghJson<GhRelease[]>(`repos/${repo}/releases?per_page=100`);
  const base = pickBaseRelease(releases, tag);
  if (!base) return null;
  // The list already carries every release's body — the carry-over check
  // costs no extra request here.
  return { tag: base, notes: releases.find((r) => r.tag_name === base)?.body ?? "" };
}

/**
 * Root commit of the tag's history — the full-history base for a repo's
 * first release (the compare API cannot diff against git's empty tree).
 * Walks parents in 100-commit pages; the compare API caps at 250 commits
 * anyway, so beyond ~300 the answer is "use --local".
 */
async function findRootCommit(repo: string, ref: string): Promise<string | null> {
  let sha = ref;
  for (let page = 0; page < 3; page++) {
    const commits = await ghJson<Array<{ sha: string; parents: Array<{ sha: string }> }>>(
      `repos/${repo}/commits?sha=${sha}&per_page=100`,
    );
    if (!commits.length) return null;
    const oldest = commits[commits.length - 1];
    if (!oldest.parents.length) {
      // Root == the checked ref means a single-commit history — the compare
      // API cannot diff a commit against nothing (no empty-tree endpoint).
      if (page === 0 && commits.length === 1) return null;
      return oldest.sha;
    }
    sha = oldest.parents[0].sha;
  }
  return null;
}

export async function loadGithubRelease(opts: {
  repo: string;
  tag?: string;
  base?: string;
}): Promise<ReleaseData> {
  const warnings: string[] = [];
  const release = opts.tag
    ? await ghJson<GhRelease>(`repos/${opts.repo}/releases/tags/${opts.tag}`)
    : await ghJson<GhRelease>(`repos/${opts.repo}/releases/latest`);
  const headRef = release.tag_name;
  let baseRef: string;
  let baseNotes: string | undefined;
  if (opts.base) {
    baseRef = opts.base;
    // Explicit --base: fetch its notes on their own, best-effort (the ref may
    // be a plain commit or a tag without a release).
    baseNotes = await ghJson<GhRelease>(`repos/${opts.repo}/releases/tags/${opts.base}`)
      .then((r) => r.body ?? "")
      .catch(() => undefined);
  } else {
    const base = await findBaseTag(opts.repo, headRef);
    if (base) {
      baseRef = base.tag;
      baseNotes = base.notes;
    } else {
      const root = await findRootCommit(opts.repo, headRef).catch(() => null);
      if (!root) {
        throw new Error(
          `${headRef} is ${opts.repo}'s first release, but no usable full-history base was found (single-commit history, unusual history shape, or a root deeper than ~300 commits). Pass --base <ref> explicitly or use a local clone (--local <path>).`,
        );
      }
      warnings.push(
        `No previous release before ${headRef} — treating it as the first release and checking against the full history (root ${root.slice(0, 10)}; the root commit itself is outside the compare range, use --local for full coverage).`,
      );
      baseRef = root;
    }
  }

  const cmp = await fetchCompare(opts.repo, baseRef, headRef);

  let truncated = false;
  if (cmp.commits.length < cmp.totalCommits) {
    truncated = true;
    warnings.push(
      `Compare API returned ${cmp.commits.length}/${cmp.totalCommits} commits — use a local clone (--local) for full coverage.`,
    );
  }
  if (cmp.files.length >= 300) {
    truncated = true;
    warnings.push(
      `Compare API caps file lists at 300 — diff may be incomplete, use a local clone (--local) for full coverage.`,
    );
  }

  const commitCache = new Map<string, Promise<DiffFile[]>>();
  const commitFiles = (sha: string): Promise<DiffFile[]> => {
    let p = commitCache.get(sha);
    if (!p) {
      p = ghJson<{ files: GhFile[] }>(`repos/${opts.repo}/commits/${sha}`).then((r) =>
        r.files.map(toDiffFile),
      );
      commitCache.set(sha, p);
    }
    return p;
  };

  const prCache = new Map<number, Promise<string | null>>();
  const resolvePr = (n: number): Promise<string | null> => {
    let p = prCache.get(n);
    if (!p) {
      p = ghJson<{ merge_commit_sha: string | null; merged_at: string | null }>(
        `repos/${opts.repo}/pulls/${n}`,
      )
        .then((pr) => (pr.merged_at ? pr.merge_commit_sha : null))
        .catch(() => null);
      prCache.set(n, p);
    }
    return p;
  };

  return {
    repoLabel: opts.repo,
    baseRef,
    headRef,
    notes: release.body ?? "",
    baseNotes,
    commits: cmp.commits,
    files: cmp.files,
    commitFiles,
    resolvePr,
    warnings,
    truncated,
  };
}

/** Prefetch per-commit diffs with limited concurrency (used by the reverse check). */
export async function prefetchCommitFiles(
  data: ReleaseData,
  concurrency = 6,
): Promise<void> {
  await pooled(data.commits, concurrency, (c) => data.commitFiles(c.sha));
}

/** Repo calibration data — best effort, never fails the run. */
export async function fetchGithubContext(repo: string): Promise<RepoContext> {
  try {
    const [languages, releases] = await Promise.all([
      ghJson<Record<string, number>>(`repos/${repo}/languages`),
      ghJson<Array<{ published_at: string | null }>>(`repos/${repo}/releases?per_page=20`),
    ]);
    const codeBytes = Object.values(languages).reduce((s, b) => s + b, 0);
    const dates = releases
      .map((r) => (r.published_at ? Date.parse(r.published_at) : NaN))
      .filter((d) => !Number.isNaN(d))
      .sort((a, b) => b - a);
    const releaseCadenceDays =
      dates.length >= 2
        ? Math.round((dates[0] - dates[dates.length - 1]) / (dates.length - 1) / 86_400_000)
        : null;
    return { languages, codeBytes, releaseCadenceDays };
  } catch {
    return { languages: null, codeBytes: null, releaseCadenceDays: null };
  }
}
