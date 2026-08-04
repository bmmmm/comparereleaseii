// SPDX-License-Identifier: GPL-3.0-or-later
// The deterministic ladder (anchor/lexical/generated) decides most verdicts
// on anchored releases before any judge runs. This pins its answer for every
// golden case under --judge off: CI-fit, no LLM, and a scoring-rule change
// that silently shifts the ladder shows up as a diff against the pin.
//
// To refresh after a deliberate ladder change:
//   UPDATE_PINNED=1 node --test test/deterministic.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { loadGoldenCases } from "../src/calibrate.ts";
import { parseClaims } from "../src/claims.ts";
import { pinBumps } from "../src/pins.ts";
import { resolveBumpClaims } from "../src/reconcile.ts";
import { verifyClaims } from "../src/verify.ts";
import type { ReleaseData } from "../src/types.ts";

const PINNED = "test/eval/golden-deterministic.json";

test("the --judge off ladder answers are pinned over the golden set", async () => {
  const cases = await loadGoldenCases();
  const verdicts: Record<string, string> = {};
  for (const gc of cases) {
    const notes = `## ${gc.section}\n\n- ${gc.claim}\n`;
    const claims = parseClaims(notes);
    assert.equal(claims.length, 1, `${gc.name}: expected exactly one claim from its note line`);
    const data: ReleaseData = {
      repoLabel: "eval/fixture",
      baseRef: "v1.0.0",
      headRef: "v1.1.0",
      notes,
      commits: [],
      files: gc.hunks.map((h) => ({
        path: h.path,
        status: "modified",
        additions: 1,
        deletions: 0,
        patch: h.hunk,
      })),
      commitFiles: async () => [],
      warnings: [],
    };
    // Same wiring as analyzeRelease: the pin join is part of the ladder, so
    // the pin has to measure it. Building it here rather than passing an
    // empty map is what keeps this file honest about what --judge off does.
    const pins = pinBumps(data.files, { repoLabel: data.repoLabel });
    const bumps = new Map(
      resolveBumpClaims(claims, pins)
        .filter((b) => b.observed)
        .map((b) => [claims[b.claim].id, b]),
    );
    const results = await verifyClaims(data, claims, {
      judgeMode: "off",
      engine: null,
      escalateEngine: null,
      concurrency: 4,
      maxHunks: 6,
      maxEvidenceChars: 20000,
      bumps,
    });
    assert.equal(results.length, 1, `${gc.name}: one claim in, one result out`);
    verdicts[gc.name] = results[0].verdict;
  }

  if (process.env.UPDATE_PINNED) {
    await writeFile(PINNED, JSON.stringify(verdicts, null, 2) + "\n");
    console.error(`updated ${PINNED} — review the diff before committing`);
    return;
  }
  const pinned = JSON.parse(await readFile(PINNED, "utf8")) as Record<string, string>;
  assert.deepEqual(
    verdicts,
    pinned,
    "the deterministic ladder drifted — if the change is deliberate, refresh with UPDATE_PINNED=1 node --test test/deterministic.test.ts",
  );

  // The one property that must hold regardless of the exact pins: without a
  // judge, no golden case may claim "verified" out of thin air — the ladder
  // verifies only through anchors/lexical evidence, and hostile cases
  // (injection, fabricated features) carry none.
  for (const [name, verdict] of Object.entries(verdicts)) {
    const gc = cases.find((c) => c.name === name);
    if (verdict === "verified") {
      assert.ok(
        gc?.expected.includes("verified"),
        `${name}: the judge-free ladder rubber-stamped a case expecting ${gc?.expected.join("|")}`,
      );
    }
  }
});
