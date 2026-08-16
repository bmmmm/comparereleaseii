// SPDX-License-Identifier: GPL-3.0-or-later
// Run `pnpm release:publish` after committing what `pnpm release:prepare`
// staged. Tags the version already in package.json, pushes the branch and
// tag to every configured remote, and opens the GitHub release from the
// matching CHANGELOG section. Never touches version numbers or notes —
// those are already on disk and committed by this point.
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { extractChangelogSection } from "../src/sources/local.ts";

function git(...args: string[]): string {
  const res = spawnSync("git", args, { encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  }
  return res.stdout.trim();
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const dirty = git("status", "--porcelain");
if (dirty) fail(`Working tree is not clean — commit the release first:\n${dirty}`);

const pkg = JSON.parse(await readFile("package.json", "utf8")) as { version: string };
const version = pkg.version;
const tag = `v${version}`;

if (spawnSync("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`], { stdio: "ignore" }).status === 0) {
  fail(`${tag} already exists locally — has this version already been released?`);
}

const changelog = await readFile("CHANGELOG.md", "utf8");
const section = extractChangelogSection(changelog, version);
if (!section) fail(`CHANGELOG.md has no section for ${version} — did pnpm release:prepare run?`);

const subject = git("log", "-1", "--format=%s");
const prefix = `Release ${tag}: `;
const title = subject.startsWith(prefix) ? subject.slice(prefix.length) : tag;

// Releases land on the default branch, whatever HEAD is called locally. A
// worktree on a topic branch (or a detached HEAD) whose tip IS the release
// used to push that topic branch to every remote — the 0.2.2 release needed
// two manual HEAD:main pushes because of exactly this. A push that is not a
// fast-forward of the remote's main still fails loudly, so releasing from a
// stray branch cannot overwrite anything.
const branch = git("branch", "--show-current");
let defaultBranch = "main";
try {
  defaultBranch = git("symbolic-ref", "--short", "refs/remotes/origin/HEAD").replace(/^origin\//, "");
} catch {
  // remote HEAD not recorded locally — "main" is this repo's default
}
const pushRef = branch === defaultBranch ? branch : `HEAD:${defaultBranch}`;
if (pushRef !== branch) {
  console.error(
    `Releasing from ${branch || "a detached HEAD"} — pushing HEAD:${defaultBranch} instead of a topic branch.`,
  );
}
const remotes = git("remote").split("\n").filter(Boolean);
if (remotes.length === 0) fail("No git remotes configured — nothing to push to.");

/** Same line = one is an ancestor of the other (or they are equal). */
function onOneLine(a: string, b: string): boolean {
  if (spawnSync("git", ["merge-base", "--is-ancestor", a, b]).status === 0) return true;
  return spawnSync("git", ["merge-base", "--is-ancestor", b, a]).status === 0;
}

// The forges must sit on ONE line before anything is pushed to all of them.
// Lag is fine — the public mirror trailing the private forge between releases
// is the intended state — but DIVERGENCE means the release push would update
// one forge and be refused by the other, leaving the release half-published.
// Lived through 2026-07-27: two variants of the same commit on origin/main
// vs github/main, and the github push died at the leak gate. Divergence
// needs a history decision no script should make; checked BEFORE the tag
// exists, so an aborted release leaves nothing behind.
if (remotes.length > 1) {
  const tips: Array<{ remote: string; sha: string }> = [];
  for (const remote of remotes) {
    if (spawnSync("git", ["fetch", "--quiet", remote, defaultBranch], { stdio: "inherit" }).status !== 0) {
      fail(`git fetch ${remote} ${defaultBranch} failed — cannot verify the forges agree before releasing.`);
    }
    try {
      tips.push({ remote, sha: git("rev-parse", `refs/remotes/${remote}/${defaultBranch}`) });
    } catch {
      // remote has no default branch yet (fresh mirror) — nothing to disagree with
    }
  }
  for (let i = 1; i < tips.length; i++) {
    if (!onOneLine(tips[0].sha, tips[i].sha)) {
      fail(
        `${tips[0].remote}/${defaultBranch} (${tips[0].sha.slice(0, 7)}) and ${tips[i].remote}/${defaultBranch} ` +
          `(${tips[i].sha.slice(0, 7)}) have DIVERGED — a release would land on one forge and be refused by ` +
          `the other. Decide which line wins, bring both remotes onto it, then re-run. Nothing was tagged or pushed.`,
      );
    }
  }
}

console.error(`Tagging ${tag}...`);
git("tag", "-a", tag, "-m", `${tag} — ${title}`);

let githubRepo: string | null = null;
for (const remote of remotes) {
  const url = git("remote", "get-url", remote);
  const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
  if (m) githubRepo = `${m[1]}/${m[2]}`;

  console.error(`Pushing ${pushRef} and ${tag} to ${remote}...`);
  if (spawnSync("git", ["push", remote, pushRef], { stdio: "inherit" }).status !== 0) {
    fail(`git push ${remote} ${pushRef} failed`);
  }
  if (spawnSync("git", ["push", remote, tag], { stdio: "inherit" }).status !== 0) {
    fail(`git push ${remote} ${tag} failed`);
  }
}

if (!githubRepo) {
  console.error("No github.com remote found — skipping `gh release create`. Run it manually if needed.");
  process.exit(0);
}

const dir = await mkdtemp(join(tmpdir(), "comparereleaseii-release-"));
const notesFile = join(dir, "notes.md");
await writeFile(notesFile, `${section}\n`);

console.error(`Creating GitHub release ${tag} on ${githubRepo}...`);
const create = spawnSync(
  "gh",
  ["release", "create", tag, "--repo", githubRepo, "--title", `${tag} — ${title}`, "--notes-file", notesFile],
  { stdio: "inherit" },
);
if (create.status !== 0) {
  fail("gh release create failed — the tag and pushes already went through, retry just that step.");
}

// The extension chain is two separate steps and the second one is the one
// that gets skipped: bumping tool.pin updates the extension REPO, while the
// installed copy (and with it the hourly watch) stays on the old release
// until `gh extension upgrade` runs on this machine. v0.12.0 and v0.13.0
// both shipped with the production watch left on v0.11.0 that way.
console.error(
  `\nRelease created. The watch does not run it yet — finish the chain:\n` +
    `  1. bump tool.pin in bmmmm/gh-comparereleaseii to ${tag}\n` +
    `  2. gh extension upgrade comparereleaseii   # updates the INSTALLED copy\n` +
    `  3. gh comparereleaseii --version           # must print ${tag.replace(/^v/, "")}\n`,
);
