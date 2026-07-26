// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseUnifiedDiff,
  extractChangelogSection,
  loadLocalRange,
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
