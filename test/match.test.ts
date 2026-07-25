// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractIdentifiers, anchorMatch, lexicalMatch, rankHunks } from "../src/match.ts";
import type { Claim, Commit, DiffFile } from "../src/types.ts";

function claim(text: string, over: Partial<Claim> = {}): Claim {
  return {
    id: 0,
    section: "Test",
    text,
    kind: "change",
    prNumbers: [],
    shas: [],
    advisories: [],
    codeSpans: [],
    ...over,
  };
}

function commit(sha: string, subject: string, prNumbers: number[] = []): Commit {
  return { sha, subject, body: "", author: "dev", prNumbers };
}

test("extractIdentifiers finds code spans, env vars and deep versions, skips CVSS scores", () => {
  const ids = extractIdentifiers(
    claim("Reject DATABASE_URL and support 2026.7.0 clients (**Medium**, 5.3)", {
      codeSpans: ["xx-cargo"],
    }),
  );
  assert.ok(ids.includes("xx-cargo"));
  assert.ok(ids.includes("DATABASE_URL"));
  assert.ok(ids.includes("2026.7.0"));
  assert.ok(!ids.includes("5.3"));
});

test("anchorMatch resolves PR numbers to commits", () => {
  const commits = [commit("aaa111bb", "Fix thing (#123)", [123]), commit("ccc222dd", "Other")];
  const m = anchorMatch(claim("Fix thing", { prNumbers: [123] }), commits);
  assert.equal(m.commits.length, 1);
  assert.equal(m.commits[0].sha, "aaa111bb");
  assert.deepEqual(m.viaPr, [123]);
});

test("anchorMatch resolves sha prefixes", () => {
  const commits = [commit("abc123def456", "Fix")];
  const m = anchorMatch(claim("see abc123d", { shas: ["abc123d"] }), commits);
  assert.equal(m.commits.length, 1);
});

const files: DiffFile[] = [
  {
    path: "src/api/icons.rs",
    status: "modified",
    additions: 5,
    deletions: 1,
    patch: "@@ -1,3 +1,7 @@\n+fn should_block_host(host: &str) -> bool {\n+    true\n+}\n context",
  },
  {
    path: "Cargo.toml",
    status: "modified",
    additions: 1,
    deletions: 1,
    patch: '@@ -10,1 +10,1 @@\n-serde = "1.0.1"\n+serde = "1.0.2"\n',
  },
];

test("lexicalMatch finds identifier hits in changed lines", () => {
  const m = lexicalMatch(claim("Add `should_block_host` check", { codeSpans: ["should_block_host"] }), files);
  assert.equal(m.files.length, 1);
  assert.equal(m.files[0].path, "src/api/icons.rs");
  assert.ok(m.score >= 3);
});

test("rankHunks prefers path matches over incidental content hits", () => {
  const ranked = rankHunks(claim("SSRF via the icon endpoint"), files, 2);
  assert.ok(ranked.length >= 1);
  assert.equal(ranked[0].path, "src/api/icons.rs");
});
