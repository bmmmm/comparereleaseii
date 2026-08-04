// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  anchorsTo,
  fabricatedClaim,
  noiseTokens,
  OVERSHOOT_VERSION,
  renderNotes,
  restateBumpTarget,
  UNDERSHOOT_VERSION,
} from "../scripts/notes-mutations.ts";
import { parseClaims } from "../src/claims.ts";
import { lexicalMatch } from "../src/match.ts";
import type { Claim, DiffFile } from "../src/types.ts";

function claim(text: string, over: Partial<Claim> = {}): Claim {
  return {
    id: 0,
    section: "What's Changed",
    text,
    kind: "change",
    prNumbers: [],
    shas: [],
    advisories: [],
    codeSpans: [],
    ...over,
  };
}

test("renderNotes round-trips through the parser it feeds", () => {
  // The harness compares a mutant against a control built the same way, so
  // what matters is that the rebuild survives parsing unchanged — a claim the
  // parser drops or splits would show up as a detection that never happened.
  const claims = [
    claim("Reject unrecognised DATABASE_URL instead of a silent SQLite fallback"),
    claim("Bump `serde` from 1.0.1 to 1.0.2 by @dependabot in #42", { prNumbers: [42] }),
    claim("Fix icon rendering on HiDPI displays", { section: "Fixed" }),
  ];
  const parsed = parseClaims(renderNotes(claims));
  assert.deepEqual(
    parsed.map((c) => c.text),
    claims.map((c) => c.text),
  );
  assert.deepEqual(
    parsed.map((c) => c.section),
    claims.map((c) => c.section),
  );
});

test("anchorsTo matches on an abbreviated sha or a shared PR number", () => {
  const sha = "f885d87827bcae30a07063f2723cd03458144a00";
  assert.equal(anchorsTo(claim("x", { shas: [sha.slice(0, 8)] }), sha, []), true);
  assert.equal(anchorsTo(claim("x", { prNumbers: [7] }), sha, [7, 9]), true);
  assert.equal(anchorsTo(claim("x", { prNumbers: [8] }), sha, [7, 9]), false);
  assert.equal(anchorsTo(claim("x"), sha, [7]), false);
});

test("noiseTokens picks diff identifiers no real claim already names", () => {
  const files: DiffFile[] = [
    {
      path: "src/net.rs",
      status: "modified",
      additions: 3,
      deletions: 0,
      patch:
        "@@ -1,1 +1,4 @@\n+    let retry_budget = 3;\n+    let retry_budget = 4;\n+    let handshake = true;\n",
    },
  ];
  // "handshake" is already claimed, so padding with it would not isolate the
  // hole the class exists to measure. The tokenizer splits identifiers on
  // underscores, so the padding is word-level ("retry", "budget") — which is
  // the finding, not a limitation: those are the substrings that occur
  // everywhere, and the matcher looks for substrings.
  const picked = noiseTokens(files, [claim("Improves the handshake path")], 2);
  assert.deepEqual(picked.sort(), ["budget", "retry"]);
  assert.ok(!picked.includes("handshake"));

  // Header lines are diff syntax, never diff content.
  const headersOnly = noiseTokens(
    [{ ...files[0], patch: "--- a/src/net.rs\n+++ b/src/net.rs\n" }],
    [],
    2,
  );
  assert.deepEqual(headersOnly, []);
});

test("the fabricated claim is exactly the shape the lexical bar settles", () => {
  // Two backticked identifiers score 3 each, and 6 clears the >= 5 bar that
  // settles a claim as verified with no judge involved. If this stops being
  // true the class stops measuring what it was built to measure.
  const files: DiffFile[] = [
    {
      path: "src/net.rs",
      status: "modified",
      additions: 2,
      deletions: 0,
      patch: "@@ -1,1 +1,3 @@\n+    let retry_budget = 3;\n+    let socket_timeout = 5;\n",
    },
  ];
  const planted = fabricatedClaim(noiseTokens(files, [], 2));
  assert.equal(planted.codeSpans.length, 2);
  assert.ok(lexicalMatch(planted, files).score >= 5);
});

test("restateBumpTarget moves only the target, never the origin", () => {
  const text = "Bump `actions/cache` from 5.0.3 to 5.0.4 by @dependabot in #91";
  assert.equal(
    restateBumpTarget(text, "5.0.4", OVERSHOOT_VERSION),
    "Bump `actions/cache` from 5.0.3 to 9999.0.0 by @dependabot in #91",
  );
  assert.equal(
    restateBumpTarget(text, "5.0.4", UNDERSHOOT_VERSION),
    "Bump `actions/cache` from 5.0.3 to 0.0.1 by @dependabot in #91",
  );
  // The origin version has to survive both: a claim that lost its "from" is
  // no longer a bump claim, and the pin join would never see it.
  assert.ok(restateBumpTarget(text, "5.0.4", OVERSHOOT_VERSION).includes("from 5.0.3"));
  assert.ok(restateBumpTarget(text, "5.0.4", UNDERSHOOT_VERSION).includes("from 5.0.3"));
});
