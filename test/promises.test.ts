// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectPromise } from "../src/claims.ts";
import { checkPromises, targetReached, STALE_AFTER } from "../src/promises.ts";
import { analyzeRelease } from "../src/check.ts";
import type { ReleaseData, RepoContext } from "../src/types.ts";

test("detectPromise: future commitments yes, past-tense claims no", () => {
  assert.deepEqual(detectPromise("The legacy `token` API is deprecated and will be removed in v2.0"), {
    kind: "removal",
    target: "2.0",
  });
  assert.deepEqual(detectPromise("`--legacy` will be dropped in the next release"), {
    kind: "removal",
    target: "next",
  });
  assert.deepEqual(detectPromise("removal of the XML exporter is scheduled for 3.0"), {
    kind: "removal",
    target: "3.0",
  });
  assert.deepEqual(detectPromise("Native dark mode is planned for 1.5"), {
    kind: "addition",
    target: "1.5",
  });
  // Past tense is a claim about THIS release, not a promise.
  assert.equal(detectPromise("The deprecated `token` API was removed"), undefined);
  assert.equal(detectPromise("Dropped support for Node 16"), undefined);
  // The target only counts after the marker.
  assert.deepEqual(detectPromise("Introduced in 1.4; `x` will be removed in 3.0"), {
    kind: "removal",
    target: "3.0",
  });
  assert.equal(detectPromise("`x` was added in 1.4 and will be removed")?.target, undefined);
});

test("targetReached: version-aware, conservative on garbage", () => {
  assert.equal(targetReached("2.0", "v2.0.0"), true);
  assert.equal(targetReached("2.0", "v2.1"), true);
  assert.equal(targetReached("2.0", "v1.9.9"), false);
  assert.equal(targetReached("next", "anything"), true);
  assert.equal(targetReached(undefined, "v2.0"), false);
  assert.equal(targetReached("2.0", "nightly"), false, "unparseable head must not break promises");
});

function dataWith(over: Partial<ReleaseData>): ReleaseData {
  return {
    repoLabel: "o/r",
    baseRef: "v1.9.0",
    headRef: "v2.0.0",
    notes: "- Modernized the auth flow\n",
    commits: [],
    files: [],
    commitFiles: async () => [],
    warnings: [],
    ...over,
  };
}

const PROMISE_NOTES = "## Deprecations\n\n- The `legacyAuth` helper is deprecated and will be removed in v2.0\n";

test("a kept removal promise: the identifier disappears in this diff", () => {
  const data = dataWith({
    baseNotes: PROMISE_NOTES,
    files: [
      {
        path: "src/auth.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        patch: "@@ -1,3 +1,3 @@\n context\n-  legacyAuth();\n+  modernAuth();",
      },
    ],
  });
  const [p] = checkPromises(data);
  assert.equal(p.status, "kept");
  assert.deepEqual(p.files, ["src/auth.ts"]);
  assert.equal(p.from, "v1.9.0");
});

test("a broken promise: the target release shipped without the removal", () => {
  const data = dataWith({
    baseNotes: PROMISE_NOTES,
    files: [
      {
        path: "src/other.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        patch: "@@ -1,2 +1,3 @@\n context\n+  unrelated();",
      },
    ],
  });
  const [p] = checkPromises(data);
  assert.equal(p.status, "broken");
  assert.match(p.note, /v?2\.0/);
});

test("still-open: target not reached, or no target, or no identifier", () => {
  const notYet = dataWith({ baseNotes: PROMISE_NOTES, headRef: "v1.9.1" });
  assert.equal(checkPromises(notYet)[0].status, "still-open");

  const noTarget = dataWith({
    baseNotes: "## Notes\n\n- The `legacyAuth` helper will be removed in a future release\n",
  });
  assert.equal(checkPromises(noTarget)[0].status, "still-open");

  const noIdentifier = dataWith({
    baseNotes: "## Notes\n\n- Some things will be removed in the next release\n",
  });
  const [p] = checkPromises(noIdentifier);
  assert.equal(p.status, "still-open");
  assert.match(p.note, /no code identifier/);
});

test("carried promises are re-checked and deduplicated against base notes", () => {
  const data = dataWith({
    baseNotes: PROMISE_NOTES,
    files: [
      {
        path: "src/xml.ts",
        status: "removed",
        additions: 0,
        deletions: 40,
        patch: "@@ -1,3 +0,0 @@\n-export function xmlExport() {}\n",
      },
    ],
  });
  const carried = [
    { text: "The `xmlExport` writer will be removed", from: "v1.5.0", kind: "removal" as const },
    // Same sentence the base notes already carry — must not double-report.
    {
      text: "The `legacyAuth` helper is deprecated and will be removed in v2.0",
      from: "v1.8.0",
      kind: "removal" as const,
      target: "2.0",
    },
  ];
  const checks = checkPromises(data, carried);
  assert.equal(checks.length, 2, `deduplication failed: ${JSON.stringify(checks.map((c) => c.text))}`);
  const xml = checks.find((c) => c.from === "v1.5.0");
  assert.equal(xml?.status, "kept");
  assert.deepEqual(xml?.files, ["src/xml.ts"]);
  // Base-note promises come first: the watch ledger cap drops from the tail,
  // which must be the oldest carried entries, never this release's own.
  assert.deepEqual(checks.map((c) => c.from), ["v1.9.0", "v1.5.0"]);
});

test("a target-less promise ages out as stale instead of riding forever", () => {
  const carry = (carriedFor?: number) => [
    {
      text: "The `legacyAuth` helper will be removed in a future release",
      from: "v1.0.0",
      kind: "removal" as const,
      carriedFor,
    },
  ];
  const data = dataWith({});

  // Each check is one more carry, and the count rides in the result so the
  // watch state can hand it back next release.
  const [first] = checkPromises(data, carry());
  assert.equal(first.status, "still-open");
  assert.equal(first.carriedFor, 1);
  const [almost] = checkPromises(data, carry(STALE_AFTER - 2));
  assert.equal(almost.status, "still-open");
  assert.equal(almost.carriedFor, STALE_AFTER - 1);

  // The STALE_AFTER-th carry is the visible exit — status, not a silent drop.
  const [aged] = checkPromises(data, carry(STALE_AFTER - 1));
  assert.equal(aged.status, "stale");
  assert.match(aged.note, /aged out/);

  // A promise the diff resolves is never stale, however long it rode.
  const kept = dataWith({
    files: [
      {
        path: "src/auth.ts",
        status: "modified",
        additions: 0,
        deletions: 1,
        patch: "@@ -1,2 +1,1 @@\n context\n-  legacyAuth();",
      },
    ],
  });
  const [resolved] = checkPromises(kept, carry(STALE_AFTER + 3));
  assert.equal(resolved.status, "kept");
});

test("promises inform but never score: flag is info, numbers unchanged", async () => {
  const CONTEXT: RepoContext = { languages: null, codeBytes: null, releaseCadenceDays: null };
  const settings = {
    judgeMode: "off" as const,
    engine: null,
    escalateEngine: null,
    concurrency: 1,
    reverse: false,
    baseline: 0,
  };
  const withPromise = await analyzeRelease(dataWith({ baseNotes: PROMISE_NOTES }), CONTEXT, null, settings);
  const without = await analyzeRelease(dataWith({}), CONTEXT, null, settings);

  // Done criterion: a promised removal that never happened is on the record.
  const flag = withPromise.metrics.flags.find((f) => f.kind === "broken-promise");
  assert.ok(flag, "no broken-promise flag");
  assert.equal(flag.severity, "info");
  assert.equal(withPromise.promises?.[0].status, "broken");
  assert.deepEqual(withPromise.metrics.scores, without.metrics.scores, "promises moved the score");
});
