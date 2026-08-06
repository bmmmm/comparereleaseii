// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DIALS, paretoFront, type Point } from "../scripts/sweep.ts";

function point(over: Partial<Point> & { value: string }): Point {
  return {
    detection: { applicable: 10, detected: 10, rate: 1 },
    perClass: {},
    golden: { cases: 39, agree: 20, rubberStamps: 0, wouldJudge: 30 },
    corpus: { claims: 100, wouldJudge: 40 },
    scores: { correctness: 60, completeness: 90, overall: 70 },
    ...over,
  };
}

// The sweep patches a literal in the source. A rename or a refactor leaves the
// pattern matching nothing — and the script would then measure the same code
// at every value and print a perfectly flat front, which is the most
// convincing possible way to be wrong. The runtime throws on it; this catches
// it in CI, where the sweep itself cannot run (it needs a watch home).
test("every sweep dial still points at a literal that is in the source", async () => {
  assert.ok(DIALS.length >= 3, "the dial set is not empty");
  for (const dial of DIALS) {
    assert.ok(dial.sites.length >= 1, `${dial.name} names no site`);
    assert.ok(
      dial.values.includes(dial.current),
      `${dial.name}: the value in the source (${dial.current}) is not among the swept values`,
    );
    for (const s of dial.sites) {
      const source = await readFile(s.file, "utf8");
      const find = s.pattern.replace("%", dial.current);
      assert.ok(
        source.includes(find),
        `${dial.name}: ${s.file} does not contain "${find}" — the dial has drifted from the source`,
      );
      // The placeholder has to be a placeholder: a pattern without `%` would
      // "apply" every value as the same string.
      assert.ok(s.pattern.includes("%"), `${dial.name}: ${s.file} pattern has no % placeholder`);
    }
  }
});

test("the front keeps what nothing dominates, and drops what something does", () => {
  const best = point({ value: "a" });
  // Worse on every axis: strictly dominated, so it cannot be on the front.
  const worse = point({
    value: "b",
    detection: { applicable: 10, detected: 5, rate: 0.5 },
    golden: { cases: 39, agree: 15, rubberStamps: 1, wouldJudge: 30 },
    corpus: { claims: 100, wouldJudge: 60 },
  });
  assert.deepEqual(
    paretoFront([best, worse]).map((p) => p.value),
    ["a"],
  );

  // A genuine trade-off — more detection, more judge calls — keeps both.
  const cheaper = point({
    value: "c",
    detection: { applicable: 10, detected: 8, rate: 0.8 },
    corpus: { claims: 100, wouldJudge: 20 },
  });
  assert.deepEqual(
    paretoFront([best, cheaper]).map((p) => p.value).sort(),
    ["a", "c"],
  );

  // Rubber-stamping is its own axis: a point that buys two extra agreements
  // by waving one fabrication through must not read as an improvement.
  const stamped = point({
    value: "d",
    golden: { cases: 39, agree: 22, rubberStamps: 1, wouldJudge: 30 },
  });
  assert.deepEqual(
    paretoFront([best, stamped]).map((p) => p.value).sort(),
    ["a", "d"],
    "a stamp is a cost, so neither dominates the other",
  );

  // A value whose measurement failed is not a point on any front.
  const broken = point({ value: "e", failed: "mutate-notes produced nothing" });
  assert.deepEqual(
    paretoFront([best, broken]).map((p) => p.value),
    ["a"],
  );
});
