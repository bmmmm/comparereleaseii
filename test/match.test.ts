// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractIdentifiers,
  anchorMatch,
  lexicalMatch,
  looksLikeIdentifier,
  rankHunks,
} from "../src/match.ts";
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

test("backticks around a dictionary word buy no extra weight", () => {
  // The bar (>= 5) settles a claim without a judge, and the note author owns
  // the backticks. Two common words that happen to occur in the diff must
  // therefore stay under it, while two real identifiers still clear it.
  const words = claim("Adds `true` and `bool` support", { codeSpans: ["true", "bool"] });
  assert.equal(lexicalMatch(words, files).score, 4);

  const shaped = claim("Adds `should_block_host` and `Cargo.toml` support", {
    codeSpans: ["should_block_host", "Cargo.toml"],
  });
  assert.equal(lexicalMatch(shaped, files).score, 6);

  // One hyphen decides nothing — prose writes "read-only" too. A second one
  // is a keybinding, and those are exactly the spans release notes name.
  assert.equal(looksLikeIdentifier("read-only"), false);
  assert.equal(looksLikeIdentifier("cmd-shift-v"), true);
  assert.equal(looksLikeIdentifier("$ref"), true);
  assert.equal(looksLikeIdentifier("sha256"), true);
});

test("a span under three characters is not an identifier at all", () => {
  // `!` occurs in nearly every diff, so finding it in this one is not
  // evidence — and the terms it would drag in are not the claim's evidence
  // either.
  const short = claim("Support search prefixes `!` and `->`", { codeSpans: ["!", "->"] });
  assert.deepEqual(extractIdentifiers(short), []);
  const m = lexicalMatch(short, files);
  assert.equal(m.score, 0);
  assert.deepEqual(m.files, []);
});

test("rankHunks prefers path matches over incidental content hits", () => {
  const ranked = rankHunks(claim("SSRF via the icon endpoint"), files, 2);
  assert.ok(ranked.length >= 1);
  assert.equal(ranked[0].path, "src/api/icons.rs");
});
