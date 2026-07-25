// SPDX-License-Identifier: GPL-3.0-or-later
import { run, pooled } from "../util.ts";
import type { Commit, DiffFile, ReleaseData } from "../types.ts";

async function ghJson<T>(path: string): Promise<T> {
  const { stdout } = await run("gh", ["api", path]);
  return JSON.parse(stdout) as T;
}

interface GhRelease {
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

async function findBaseTag(repo: string, tag: string): Promise<string> {
  const releases = await ghJson<GhRelease[]>(`repos/${repo}/releases?per_page=100`);
  const idx = releases.findIndex((r) => r.tag_name === tag);
  if (idx === -1) {
    throw new Error(
      `Release ${tag} not found among the latest 100 releases of ${repo}. Pass --base <tag> explicitly.`,
    );
  }
  const target = releases[idx];
  for (let i = idx + 1; i < releases.length; i++) {
    const r = releases[i];
    if (r.draft) continue;
    // For a stable release, compare against the previous stable one.
    if (!target.prerelease && r.prerelease) continue;
    return r.tag_name;
  }
  throw new Error(
    `No previous release found before ${tag} in ${repo}. Pass --base <tag> explicitly.`,
  );
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
  const baseRef = opts.base ?? (await findBaseTag(opts.repo, headRef));

  const cmp = await ghJson<{
    total_commits: number;
    commits: GhCompareCommit[];
    files: GhFile[];
  }>(`repos/${opts.repo}/compare/${baseRef}...${headRef}`);

  if (cmp.commits.length < cmp.total_commits) {
    warnings.push(
      `Compare API returned ${cmp.commits.length}/${cmp.total_commits} commits — use a local clone (--local) for full coverage.`,
    );
  }
  if (cmp.files.length >= 300) {
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

  return {
    repoLabel: opts.repo,
    baseRef,
    headRef,
    notes: release.body ?? "",
    commits: cmp.commits.map(toCommit),
    files: cmp.files.map(toDiffFile),
    commitFiles,
    warnings,
  };
}

/** Prefetch per-commit diffs with limited concurrency (used by the reverse check). */
export async function prefetchCommitFiles(
  data: ReleaseData,
  concurrency = 6,
): Promise<void> {
  await pooled(data.commits, concurrency, (c) => data.commitFiles(c.sha));
}
