// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUnifiedDiff, extractChangelogSection } from "../src/sources/local.ts";

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
