// SPDX-License-Identifier: GPL-3.0-or-later
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { run } from "../util.ts";
import { extractPrNumbers } from "./github.ts";
import type { Commit, DiffFile, ReleaseData, RepoContext } from "../types.ts";

function git(repo: string, args: string[]): Promise<string> {
  return run("git", ["-C", repo, ...args]).then(
    (r) => r.stdout,
    (err: Error) => {
      // A `--filter=blob:none` clone downloads file contents on demand, so
      // the first diff reaches back to the server and a hiccup surfaces as
      // "could not fetch <sha> from promisor remote" — true, and useless to
      // whoever typed --repo-url.
      if (/promisor remote|filtered.*missing object/i.test(err.message)) {
        throw new Error(
          `The cached clone at ${repo} stores file contents on demand and the server did not ` +
            "answer for some of them. Re-run (it is usually transient); if it persists, delete " +
            `${repo} to clone again.`,
        );
      }
      throw err;
    },
  );
}

/** git's well-known empty tree — the diff base for a repo's first release. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

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
    base ? `${base}..${head}` : head,
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
  // The version may follow the heading marker directly ("## 0.1.0 — date")
  // or after a prefix ending in a separator ("## [1.2.0] - date").
  const headingRe = new RegExp(`^(#{1,4})\\s+(?:.*[^\\w.])?${escaped}(?:[^\\w.]|$)`);
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
  // The empty tree is not a commit: list every commit up to head and diff
  // two-dot (three-dot needs a merge base, which a tree cannot have).
  const [commits, diff] = await Promise.all([
    loadCommits(repo, base === EMPTY_TREE ? "" : base, head),
    git(repo, [
      "diff",
      "--patch",
      "--no-color",
      ...(base === EMPTY_TREE ? [EMPTY_TREE, head] : [`${base}...${head}`]),
    ]),
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

const CLONE_URL = /^(https?|ssh|git|file):\/\/[^\s]+$/i;
/** `git@host:owner/repo.git` — the scp-like form every forge prints. */
const SCP_LIKE = /^[\w.-]+@[\w.-]+:[^\s]+$/;

/**
 * A repository URL is an argument to `git clone`, and `git clone` takes more
 * than repositories.
 *
 * `ext::sh -c <cmd>` is a transport helper: git runs the command. A leading
 * `-` makes the whole thing an option instead of a URL (`--upload-pack=…` runs
 * a command too). Neither needs a shell to go wrong, so passing argv rather
 * than a shell string is not the defence — refusing the shapes is. Anything
 * that is not an ordinary scheme URL or the scp-like form is rejected by name.
 */
export function assertCloneUrl(url: string): string {
  if (url.startsWith("-")) {
    throw new Error(`Repository URL may not start with "-" (git would read it as an option): ${url}`);
  }
  if (url.includes("::")) {
    throw new Error(
      `Repository URL may not use a git transport helper ("::"), which runs a command: ${url}`,
    );
  }
  if (!CLONE_URL.test(url) && !SCP_LIKE.test(url)) {
    throw new Error(
      `Not a repository URL: ${url} — expected https://, ssh://, git://, file:// or git@host:owner/repo.`,
    );
  }
  return url;
}

/**
 * Clone, or update what is already cached.
 *
 * Whether to clone is decided by "is this a git repository", never by whether
 * the update worked. Those were one `try` before, so any failing fetch — an
 * expired token, an offline laptop, a credential helper that cannot write —
 * sent it to `git clone` against a directory full of files, and it died with
 * "destination path already exists" while a perfectly usable clone sat right
 * there. A fetch that fails costs freshness, and freshness is worth a warning,
 * not the run.
 */
export async function ensureClone(url: string, dir: string): Promise<void> {
  assertCloneUrl(url);
  let cloned = true;
  try {
    await git(dir, ["rev-parse", "--git-dir"]);
  } catch {
    cloned = false;
  }
  if (!cloned) {
    await run("git", ["clone", "--quiet", "--filter=blob:none", url, dir]);
    return;
  }
  try {
    await git(dir, ["fetch", "--tags", "--force", "--quiet"]);
  } catch (err) {
    console.error(
      `warning: could not update the cached clone at ${dir} ` +
        `(${(err as Error).message.split("\n")[0].slice(0, 120)}) — checking against what is ` +
        "already there. A release published since the last successful fetch will not be found.",
    );
  }
}

export async function loadLocalRelease(opts: {
  repo: string;
  head?: string;
  base?: string;
  notesFile?: string;
  /** Published notes from a forge API — outrank the CHANGELOG, not a file. */
  notes?: string;
  /** Label for the report; defaults to the clone's directory name. */
  repoLabel?: string;
}): Promise<ReleaseData> {
  const warnings: string[] = [];
  const head =
    opts.head ?? (await git(opts.repo, ["describe", "--tags", "--abbrev=0"])).trim();
  let base = opts.base;
  if (!base) {
    try {
      base = (await git(opts.repo, ["describe", "--tags", "--abbrev=0", `${head}^`])).trim();
    } catch {
      warnings.push(
        `No tag before ${head} — treating it as the first release and checking against the full history.`,
      );
      base = EMPTY_TREE;
    }
  }

  let notes: string;
  if (opts.notesFile) {
    notes = await readFile(opts.notesFile, "utf8");
  } else if (opts.notes !== undefined) {
    notes = opts.notes;
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
    repoLabel: opts.repoLabel ?? basename(opts.repo),
    baseRef: base,
    headRef: head,
    notes,
    ...range,
    warnings,
  };
}
