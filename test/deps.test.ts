// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { lockfileSources, newDependencies, opacityIssue } from "../src/deps.ts";
import type { DiffFile } from "../src/types.ts";

function file(path: string, patch: string | undefined, extra: Partial<DiffFile> = {}): DiffFile {
  const additions = (patch ?? "").split("\n").filter((l) => l.startsWith("+")).length;
  return { path, status: "modified", additions, deletions: 0, patch, ...extra };
}

test("a package.json version bump inside a dependencies block adds no dependency", () => {
  const bump = file(
    "package.json",
    '@@ -5,3 +5,3 @@\n   "dependencies": {\n-    "left-pad": "^1.0.0",\n+    "left-pad": "^1.1.0",\n',
  );
  assert.deepEqual(newDependencies(bump), []);
});

test("a package.json block ends at a closer of its own indent", () => {
  // After the closing brace the section is unknown again, so the top-level
  // "version" key is metadata — not a dependency.
  const patch = [
    "@@ -2,4 +2,5 @@",
    '   "dependencies": {',
    '     "a": "1.0.0"',
    "   },",
    '+  "version": "9.9.9",',
    "",
  ].join("\n");
  assert.deepEqual(newDependencies(file("package.json", patch)), []);
});

test("a parent module of a known Go dependency is the same supplier", () => {
  const patch =
    "@@ -3,1 +3,2 @@ require (\n \texample.com/x/sub v1.0.0\n+\texample.com/x v1.2.0\n";
  assert.deepEqual(newDependencies(file("go.mod", patch)), []);
});

test("lockfileSources reports at most six foreign sources", () => {
  const lines = Array.from(
    { length: 8 },
    (_, i) => `+  resolved "git+ssh://git.example.com/r${i}.git"`,
  );
  const found = lockfileSources(file("yarn.lock", `@@ -0,0 +1,8 @@\n${lines.join("\n")}\n`));
  assert.equal(found.length, 6);
});

test("opacityIssue: a rename without a patch is fine, a patchless edit is not", () => {
  assert.equal(
    opacityIssue(file("src/b.ts", undefined, { status: "renamed", additions: 0, deletions: 0 })),
    null,
  );
  assert.equal(
    opacityIssue(file("src/b.ts", undefined, { status: "modified", additions: 0, deletions: 0 })),
    "no reviewable patch",
  );
  assert.equal(
    opacityIssue(file("src/b.ts", undefined, { status: "modified", additions: 3, deletions: 0 })),
    null,
    "a file the forge reports changes for, just without a patch, is not called empty",
  );
});

test("opacityIssue calls a line minified only above 800 characters", () => {
  const at = (n: number) => file("dist/app.js", `@@ -0,0 +1 @@\n+${"x".repeat(n)}`);
  assert.equal(opacityIssue(at(800)), null);
  assert.equal(opacityIssue(at(801)), "minified content");
});
