// SPDX-License-Identifier: GPL-3.0-or-later
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { run } from "../util.ts";
import { extractPrNumbers } from "./github.ts";
import type { Commit, DiffFile, ReleaseData, RepoContext } from "../types.ts";

function git(repo: string, args: string[]): Promise<string> {
  return run("git", ["-C", repo, ...args]).then((r) => r.stdout);
}

/** Parse `git diff --patch` output into per-file entries. */
export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  const chunks = diff.split(/^(?=diff --git )/m).filter((c) => c.trim());
  for (const chunk of chunks) {
    const header = chunk.split("\n", 1)[0];
    const pathMatch = header.match(/^diff --git a\/(.*) b\/(.*)$/);
    if (!pathMatch) continue;
    const path = pathMatch[2];
    let status = "modified";
    if (/^new file mode/m.test(chunk)) status = "added";
    else if (/^deleted file mode/m.test(chunk)) status = "removed";
    else if (/^rename from /m.test(chunk)) status = "renamed";
    let additions = 0;
    let deletions = 0;
    for (const line of chunk.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions++;
      else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
    }
    const hunkStart = chunk.indexOf("\n@@");
    files.push({
      path,
      status,
      additions,
      deletions,
      patch: hunkStart === -1 ? undefined : chunk.slice(hunkStart + 1),
    });
  }
  return files;
}

async function loadCommits(repo: string, base: string, head: string): Promise<Commit[]> {
  const out = await git(repo, [
    "log",
    "--format=%H%x1f%an%x1f%s%x1f%b%x1e",
    `${base}..${head}`,
  ]);
  return out
    .split("\x1e")
    .map((e) => e.trim())
    .filter(Boolean)
    .map((entry) => {
      const [sha, author, subject, body = ""] = entry.split("\x1f");
      return {
        sha,
        subject,
        body: body.trim(),
        author,
        prNumbers: extractPrNumbers(subject + "\n" + body),
      };
    });
}

/** Extract the section for `tag` from a Keep-a-Changelog-style file. */
export function extractChangelogSection(changelog: string, tag: string): string | null {
  const lines = changelog.split("\n");
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headingRe = new RegExp(`^(#{1,4})\\s+.*(?:^|[^\\w.])${escaped}(?:[^\\w.]|$)`);
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(headingRe);
    if (m) {
      start = i;
      level = m[1].length;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,4})\s/);
    if (m && m[1].length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n").trim();
}

const EXT_LANG: Record<string, string> = {
  rs: "Rust", ts: "TypeScript", tsx: "TypeScript", js: "JavaScript", jsx: "JavaScript",
  mjs: "JavaScript", py: "Python", go: "Go", rb: "Ruby", java: "Java", kt: "Kotlin",
  c: "C", h: "C", cpp: "C++", cc: "C++", hpp: "C++", cs: "C#", php: "PHP",
  swift: "Swift", sh: "Shell", bash: "Shell", sql: "SQL", html: "HTML", css: "CSS",
  scss: "SCSS", vue: "Vue", svelte: "Svelte", hbs: "Handlebars", lua: "Lua", zig: "Zig",
};

/** Repo calibration data from the local checkout — best effort, never throws. */
export async function localRepoContext(repo: string, head: string): Promise<RepoContext> {
  try {
    const tree = await git(repo, ["ls-tree", "-r", "-l", head]);
    const languages: Record<string, number> = {};
    let codeBytes = 0;
    for (const line of tree.split("\n")) {
      const m = line.match(/^\d+ blob \S+\s+(\d+)\t(.*)$/);
      if (!m) continue;
      const size = Number(m[1]);
      const ext = m[2].split(".").pop() ?? "";
      const lang = EXT_LANG[ext];
      if (lang) {
        languages[lang] = (languages[lang] ?? 0) + size;
        codeBytes += size;
      }
    }
    const tagDates = (
      await git(repo, [
        "for-each-ref", "--sort=-creatordate", "--count=20",
        "--format=%(creatordate:unix)", "refs/tags",
      ])
    )
      .split("\n")
      .filter(Boolean)
      .map(Number);
    const releaseCadenceDays =
      tagDates.length >= 2
        ? Math.round((tagDates[0] - tagDates[tagDates.length - 1]) / (tagDates.length - 1) / 86_400)
        : null;
    return { languages, codeBytes, releaseCadenceDays };
  } catch {
    return { languages: null, codeBytes: null, releaseCadenceDays: null };
  }
}

/** Commits, diff and per-commit patches for a ref range of a local checkout. */
export async function loadLocalRange(
  repo: string,
  base: string,
  head: string,
): Promise<Pick<ReleaseData, "commits" | "files" | "commitFiles">> {
  const [commits, diff] = await Promise.all([
    loadCommits(repo, base, head),
    git(repo, ["diff", "--patch", "--no-color", `${base}...${head}`]),
  ]);
  const commitCache = new Map<string, Promise<DiffFile[]>>();
  const commitFiles = (sha: string): Promise<DiffFile[]> => {
    let p = commitCache.get(sha);
    if (!p) {
      p = git(repo, ["show", "--patch", "--no-color", "--format=", sha]).then(
        parseUnifiedDiff,
      );
      commitCache.set(sha, p);
    }
    return p;
  };
  return { commits, files: parseUnifiedDiff(diff), commitFiles };
}

/** Clone (or update) a partial mirror for API-truncation fallback. */
export async function ensureClone(url: string, dir: string): Promise<void> {
  try {
    await git(dir, ["rev-parse", "--git-dir"]);
    await git(dir, ["fetch", "--tags", "--force", "--quiet"]);
  } catch {
    await run("git", ["clone", "--quiet", "--filter=blob:none", url, dir]);
  }
}

export async function loadLocalRelease(opts: {
  repo: string;
  head?: string;
  base?: string;
  notesFile?: string;
}): Promise<ReleaseData> {
  const warnings: string[] = [];
  const head =
    opts.head ?? (await git(opts.repo, ["describe", "--tags", "--abbrev=0"])).trim();
  const base =
    opts.base ??
    (await git(opts.repo, ["describe", "--tags", "--abbrev=0", `${head}^`])).trim();

  let notes: string;
  if (opts.notesFile) {
    notes = await readFile(opts.notesFile, "utf8");
  } else {
    let changelog: string;
    try {
      changelog = await readFile(join(opts.repo, "CHANGELOG.md"), "utf8");
    } catch {
      throw new Error(
        `No release notes: pass --notes-file <file> or add a CHANGELOG.md with a "${head}" section to the repo.`,
      );
    }
    const section =
      extractChangelogSection(changelog, head) ??
      extractChangelogSection(changelog, head.replace(/^v/, ""));
    if (!section) {
      throw new Error(
        `CHANGELOG.md has no section for "${head}". Pass --notes-file <file> instead.`,
      );
    }
    notes = section;
  }

  const range = await loadLocalRange(opts.repo, base, head);
  return {
    repoLabel: basename(opts.repo),
    baseRef: base,
    headRef: head,
    notes,
    ...range,
    warnings,
  };
}
