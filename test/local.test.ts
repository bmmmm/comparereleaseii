// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertCloneUrl,
  ensureClone,
  parseUnifiedDiff,
  extractChangelogSection,
  loadLocalRange,
  loadLocalRelease,
  EMPTY_TREE,
} from "../src/sources/local.ts";

const exec = promisify(execFile);

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 line
+added line
-removed line
diff --git a/new.txt b/new.txt
new file mode 100644
index 000..333
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,1 @@
+hello
`;

test("parseUnifiedDiff splits files, counts changes, detects status", () => {
  const files = parseUnifiedDiff(DIFF);
  assert.equal(files.length, 2);
  assert.equal(files[0].path, "src/a.ts");
  assert.equal(files[0].status, "modified");
  assert.equal(files[0].additions, 1);
  assert.equal(files[0].deletions, 1);
  assert.ok(files[0].patch?.startsWith("@@"));
  assert.equal(files[1].path, "new.txt");
  assert.equal(files[1].status, "added");
});

const CHANGELOG = `# Changelog

## [1.2.0] - 2026-07-01

- Added feature X
- Fixed bug Y

## [1.1.0] - 2026-06-01

- Old stuff
`;

test("extractChangelogSection returns only the tagged section", () => {
  const section = extractChangelogSection(CHANGELOG, "1.2.0");
  assert.ok(section);
  assert.ok(section.includes("feature X"));
  assert.ok(!section.includes("Old stuff"));
});

test("extractChangelogSection returns null for unknown tags", () => {
  assert.equal(extractChangelogSection(CHANGELOG, "9.9.9"), null);
});

test("extractChangelogSection keeps content after a fenced block with # lines", () => {
  const changelog = [
    "# Changelog",
    "",
    "## 0.2.0 — 2026-07-26",
    "",
    "- Added the frobnicator (#12)",
    "",
    "Example upgrade:",
    "",
    "```bash",
    "# install the new version",
    "brew upgrade foo",
    "```",
    "",
    "- Second real entry after the code block (#13)",
    "",
    "## 0.1.0 — 2026-07-01",
    "",
    "- Initial release",
    "",
  ].join("\n");
  const section = extractChangelogSection(changelog, "0.2.0");
  assert.ok(section?.includes("Second real entry"), `section cut at the fence: ${JSON.stringify(section)}`);
  assert.ok(section?.includes("# install the new version"));
  assert.ok(!section?.includes("Initial release"));
});

test("extractChangelogSection matches bare and v-prefixed headings", () => {
  const bare = "# Changelog\n\n## 0.1.0 — 2026-07-26\n\n- Initial release\n";
  assert.ok(extractChangelogSection(bare, "0.1.0")?.includes("Initial release"));

  const prefixed = "# Changelog\n\n## v1.2.0\n\n- Feature\n\n## v1.1.0\n\n- Old\n";
  const section = extractChangelogSection(prefixed, "v1.2.0");
  assert.ok(section?.includes("Feature"));
  assert.ok(!section?.includes("Old"));

  // "0.1.0" must not match inside "10.1.0".
  const trap = "# Changelog\n\n## 10.1.0\n\n- Wrong section\n";
  assert.equal(extractChangelogSection(trap, "0.1.0"), null);

  // The dogfood gate asks for "Unreleased" by name once package.json's
  // version is already tagged — otherwise it would check shipped notes
  // against the diff that came after them, and blame the notes for it.
  const wip = "# Changelog\n\n## Unreleased\n\n- In flight\n\n## 0.1.2 — 2026-07-26\n\n- Shipped\n";
  const unreleased = extractChangelogSection(wip, "Unreleased");
  assert.ok(unreleased?.includes("In flight"));
  assert.ok(!unreleased?.includes("Shipped"));
});

test("loadLocalRange with the empty tree covers the full history", async () => {
  const repo = await mkdtemp(join(tmpdir(), "crii-local-test-"));
  const git = (...args: string[]) => exec("git", ["-C", repo, ...args]);
  await git("init", "-q");
  await git("config", "user.email", "test@example.invalid");
  await git("config", "user.name", "test");
  await writeFile(join(repo, "a.txt"), "first\n");
  await git("add", "a.txt");
  await git("commit", "-q", "-m", "first commit");
  await writeFile(join(repo, "b.txt"), "second\n");
  await git("add", "b.txt");
  await git("commit", "-q", "-m", "second commit");

  const range = await loadLocalRange(repo, EMPTY_TREE, "HEAD");
  assert.equal(range.commits.length, 2);
  assert.deepEqual(
    range.files.map((f) => f.path).sort(),
    ["a.txt", "b.txt"],
  );
  assert.ok(range.files.every((f) => f.status === "added"));
});

test("assertCloneUrl refuses what git would run instead of clone", () => {
  // `ext::` is a transport helper: git executes the rest. A leading dash is
  // an option, and `--upload-pack=` runs a command too. Neither needs a shell,
  // so passing argv instead of a shell string is not what stops them.
  assert.throws(() => assertCloneUrl("ext::sh -c 'touch /tmp/pwned'"), /transport helper/);
  assert.throws(() => assertCloneUrl("--upload-pack=touch /tmp/pwned"), /may not start with/);
  assert.throws(() => assertCloneUrl("-u"), /may not start with/);
  assert.throws(() => assertCloneUrl("git.example.com/team/app"), /Not a repository URL/);
  assert.throws(() => assertCloneUrl(""), /Not a repository URL/);

  // The ordinary forms every forge prints stay accepted.
  for (const url of [
    "https://forgejo.example.com/your-org/app.git",
    "http://localhost:3000/team/app.git",
    "ssh://git@gitlab.example.com:2222/group/proj.git",
    "git://git.example.com/app.git",
    "file:///srv/mirrors/app.git",
    "git@github.com:bmmmm/comparereleaseii.git",
  ]) {
    assert.equal(assertCloneUrl(url), url, url);
  }
});

test("--repo-url checks a forge nobody wrote an API client for", async () => {
  // The whole point of 4.2a: a clone answers the diff, the commits, the
  // subjects, the authors and the tags. Only the notes live on the forge, so
  // they come from the CHANGELOG section — and this test never touches one.
  const origin = await mkdtemp(join(tmpdir(), "crii-origin-"));
  const git = (...args: string[]) => exec("git", ["-C", origin, ...args]);
  await git("init", "-q");
  await git("config", "user.email", "test@example.invalid");
  await git("config", "user.name", "test");
  await writeFile(join(origin, "app.ts"), "export const parseToken = () => 1;\n");
  await writeFile(
    join(origin, "CHANGELOG.md"),
    "# Changelog\n\n## 1.1.0\n\n- Added `parseToken` to the public API\n\n## 1.0.0\n\n- First\n",
  );
  await git("add", ".");
  await git("commit", "-q", "-m", "first release");
  await git("tag", "1.0.0");
  await writeFile(join(origin, "app.ts"), "export const parseToken = () => 2;\nexport const rotate = () => 0;\n");
  await git("commit", "-qam", "Add rotate and change parseToken");
  await git("tag", "1.1.0");

  const clone = join(await mkdtemp(join(tmpdir(), "crii-clone-")), "app");
  const url = `file://${origin}`;
  await ensureClone(url, clone);
  // Second call is the cached path — fetch, not clone, and still fine.
  await ensureClone(url, clone);

  const data = await loadLocalRelease({ repo: clone, head: "1.1.0" });
  assert.equal(data.headRef, "1.1.0");
  assert.equal(data.baseRef, "1.0.0");
  assert.equal(data.commits.length, 1);
  assert.match(data.commits[0].subject, /Add rotate/);
  assert.deepEqual(data.files.map((f) => f.path), ["app.ts"]);
  // Notes came from the CHANGELOG section for the head tag, no forge API.
  assert.match(data.notes, /parseToken/);
  assert.ok(!data.notes.includes("First"), "only the section for this release");
});

test("a fetch that fails costs freshness, not the cached clone", async () => {
  const origin = await mkdtemp(join(tmpdir(), "crii-origin2-"));
  const git = (...args: string[]) => exec("git", ["-C", origin, ...args]);
  await git("init", "-q");
  await git("config", "user.email", "test@example.invalid");
  await git("config", "user.name", "test");
  await writeFile(join(origin, "a.txt"), "one\n");
  await git("add", ".");
  await git("commit", "-q", "-m", "first");
  await git("tag", "1.0.0");

  const clone = join(await mkdtemp(join(tmpdir(), "crii-clone2-")), "app");
  await ensureClone(`file://${origin}`, clone);

  // Whatever makes the update fail — offline, expired token, a credential
  // helper that cannot write — the clone on disk is still the answer. Before,
  // this took the `git clone` branch and died on a non-empty directory.
  await exec("git", ["-C", clone, "remote", "set-url", "origin", "file:///nonexistent-crii"]);
  await ensureClone(`file://${origin}`, clone);
  const { stdout } = await exec("git", ["-C", clone, "tag", "-l"]);
  assert.match(stdout, /1\.0\.0/, "the cached clone survived and still answers");
});

test("loadLocalRelease skips prerelease tags when picking the base for a stable head", async () => {
  const repo = await mkdtemp(join(tmpdir(), "crii-local-test-"));
  const git = (...args: string[]) => exec("git", ["-C", repo, ...args]);
  await git("init", "-q");
  await git("config", "user.email", "test@example.invalid");
  await git("config", "user.name", "test");
  await writeFile(join(repo, "a.txt"), "one\n");
  await git("add", "a.txt");
  await git("commit", "-q", "-m", "first");
  await git("tag", "v0.1.0");
  await writeFile(join(repo, "b.txt"), "two\n");
  await git("add", "b.txt");
  await git("commit", "-q", "-m", "rc work");
  await git("tag", "v0.2.0-rc1");
  await writeFile(join(repo, "c.txt"), "three\n");
  await git("add", "c.txt");
  await git("commit", "-q", "-m", "stable work");
  await git("tag", "v0.2.0");
  await writeFile(
    join(repo, "CHANGELOG.md"),
    "# Changelog\n\n## 0.2.0\n\n- Added b.txt and c.txt support (#1)\n\n## 0.1.0\n\n- First\n",
  );

  // The GitHub path never baselines a stable release against an rc — the
  // clone path must not either, or the diff shrinks to rc..stable while the
  // notes describe everything since the last stable.
  const data = await loadLocalRelease({ repo, head: "v0.2.0" });
  assert.equal(data.baseRef, "v0.1.0");
  assert.equal(data.commits.length, 2);

  // A prerelease head keeps the nearest tag, prerelease or not — same as
  // pickBaseRelease, which only filters prereleases for stable targets.
  const rc = await loadLocalRelease({
    repo,
    head: "v0.2.0-rc1",
    notesFile: join(repo, "CHANGELOG.md"),
  });
  assert.equal(rc.baseRef, "v0.1.0");
});

test("added lines whose content starts with ++ or -- are still counted", () => {
  // `++i;` added => diff line `+++i;`, which the header guard used to eat.
  const diff = `diff --git a/x.c b/x.c
index 111..222 100644
--- a/x.c
+++ b/x.c
@@ -1,2 +1,3 @@
 int i = 0;
+++i;
+--j;
@@ -10,1 +11,1 @@
-old line
+new line
`;
  const [file] = parseUnifiedDiff(diff);
  assert.equal(file.additions, 3, "++i; and +--j; must count as additions");
  assert.equal(file.deletions, 1);
});

test("the repo label resolves the path before taking its basename", async () => {
  const repo = await mkdtemp(join(tmpdir(), "crii-label-"));
  const git = (...args: string[]) => exec("git", ["-C", repo, ...args]);
  await git("init", "-q");
  await git("config", "user.email", "test@example.invalid");
  await git("config", "user.name", "test");
  await writeFile(join(repo, "a.txt"), "one\n");
  await writeFile(join(repo, "CHANGELOG.md"), "# Changelog\n\n## 1.0.0\n\n- First (#1)\n");
  await git("add", ".");
  await git("commit", "-q", "-m", "first");
  await git("tag", "1.0.0");

  // `--local .` used to report the repo as "." (basename of the raw path).
  const dotted = await loadLocalRelease({ repo: `${repo}/.`, head: "1.0.0" });
  assert.notEqual(dotted.repoLabel, ".");
  assert.equal(dotted.repoLabel, repo.split("/").pop());
});
