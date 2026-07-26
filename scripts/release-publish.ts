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

console.error(`Tagging ${tag}...`);
git("tag", "-a", tag, "-m", `${tag} — ${title}`);

const branch = git("branch", "--show-current");
const remotes = git("remote").split("\n").filter(Boolean);
if (remotes.length === 0) fail("No git remotes configured — nothing to push to.");

let githubRepo: string | null = null;
for (const remote of remotes) {
  const url = git("remote", "get-url", remote);
  const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
  if (m) githubRepo = `${m[1]}/${m[2]}`;

  console.error(`Pushing ${branch} and ${tag} to ${remote}...`);
  if (spawnSync("git", ["push", remote, branch], { stdio: "inherit" }).status !== 0) {
    fail(`git push ${remote} ${branch} failed`);
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
