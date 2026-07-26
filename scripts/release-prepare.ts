// SPDX-License-Identifier: GPL-3.0-or-later
// Run `pnpm release:prepare <version>` before a release. It bumps
// package.json, renames the CHANGELOG's Unreleased section under the new
// version (with a fresh Unreleased above it), fixes known version pins, and
// gates on the project's own tests and its own dogfood check. It never
// commits — review `git diff`, write a real commit message, then run
// `pnpm release:publish`.
//
// The out-of-date-branch check exists because a stale multi-worktree
// checkout once cost a whole session: local main was seven commits behind
// origin/main, and the release work that followed had to be redone once
// that surfaced. This is the five-second check that would have caught it
// on the first command instead.
import { readFile, writeFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { extractChangelogSection } from "../src/sources/local.ts";
import { PIN_PATTERNS } from "./pin-patterns.ts";

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

const newVersion = process.argv[2];
if (!newVersion || !/^\d+\.\d+\.\d+$/.test(newVersion)) {
  console.error("Usage: pnpm release:prepare <version>  (e.g. 0.2.2)");
  process.exit(2);
}

const dirty = git("status", "--porcelain");
if (dirty) fail(`Working tree is not clean — commit or stash first:\n${dirty}`);

console.error("Fetching to check the branch is up to date...");
spawnSync("git", ["fetch"], { stdio: "inherit" });
const branch = git("branch", "--show-current");
const upstreamCheck = spawnSync("git", ["rev-parse", "--abbrev-ref", `${branch}@{upstream}`], {
  encoding: "utf8",
});
if (upstreamCheck.status === 0) {
  const upstream = upstreamCheck.stdout.trim();
  const behind = git("rev-list", "--count", `HEAD..${upstream}`);
  if (behind !== "0") {
    fail(
      `${branch} is ${behind} commit(s) behind ${upstream} — pull or merge before releasing. ` +
        `(Another worktree or session may have pushed since this checkout last fetched.)`,
    );
  }
} else {
  console.error(`Warning: ${branch} has no upstream configured — skipping the sync check.`);
}

const pkg = JSON.parse(await readFile("package.json", "utf8")) as { version: string };
const oldVersion = pkg.version;
if (newVersion === oldVersion) fail(`package.json is already at ${oldVersion}`);

const changelog = await readFile("CHANGELOG.md", "utf8");
if (!extractChangelogSection(changelog, "Unreleased")) {
  fail("CHANGELOG.md has no Unreleased section — write the release notes first.");
}

const heading = "## Unreleased";
const idx = changelog.indexOf(heading);
if (idx === -1) throw new Error("unreachable: Unreleased heading vanished mid-run");
const today = new Date().toISOString().slice(0, 10);
const newChangelog =
  changelog.slice(0, idx + heading.length) +
  `\n\n## ${newVersion} — ${today}` +
  changelog.slice(idx + heading.length);
await writeFile("CHANGELOG.md", newChangelog);
console.error(`CHANGELOG.md: renamed Unreleased -> ${newVersion} — ${today}, added a fresh Unreleased above it.`);

(pkg as Record<string, unknown>).version = newVersion;
await writeFile("package.json", JSON.stringify(pkg, null, 2) + "\n");
console.error(`package.json: ${oldVersion} -> ${newVersion}`);

const docs = (await readdir("docs")).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`);
let fixedPins = 0;
for (const file of ["README.md", ...docs]) {
  const original = await readFile(file, "utf8");
  let text = original;
  for (const pattern of PIN_PATTERNS) {
    text = text.replace(new RegExp(pattern, "g"), (match, tag: string) => {
      if (tag === `v${newVersion}`) return match;
      fixedPins++;
      return match.replace(tag, `v${newVersion}`);
    });
  }
  if (text !== original) {
    await writeFile(file, text);
    console.error(`${file}: bumped version pin(s) to v${newVersion}`);
  }
}
if (fixedPins === 0) console.error("No stale version pins found.");

console.error("\nRunning pnpm test...");
if (spawnSync("pnpm", ["test"], { stdio: "inherit" }).status !== 0) {
  fail("\ntests failed — fix before releasing (changes are left on disk, uncommitted).");
}

console.error("\nRunning pnpm dogfood...");
const dogfood = spawnSync("pnpm", ["dogfood"], { stdio: "inherit" });
if (dogfood.status !== 0) {
  fail("\ndogfood gate failed — fix the notes (or the code) before releasing.");
}

console.error(
  `\nReady. Review "git diff", then:\n` +
    `  git add package.json CHANGELOG.md README.md docs/\n` +
    `  git commit -m "Release v${newVersion}: <short pitch>"\n` +
    `  pnpm release:publish\n`,
);
