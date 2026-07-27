// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  runCalibration,
  loadGoldenCases,
  gateCalibration,
  GOLDEN_CATEGORIES,
  type Calibration,
  type CalibrationOutcome,
  type GoldenCase,
} from "../src/calibrate.ts";

// avgMs feeds the model ranking's speed column. An engine that errors slowly
// (timeouts) must not be ranked by its failure latency: with only failed
// calls there is no timing to report.
test("calibration timing ignores failed calls", async () => {
  const engine = {
    name: "always-fails",
    async judge(): Promise<string> {
      await new Promise((resolve) => setTimeout(resolve, 60));
      throw new Error("boom");
    },
  };
  const cal = await runCalibration(engine, 8);
  assert.equal(cal.passed, 0);
  assert.ok(cal.outcomes.every((o) => o.got === "error"));
  assert.equal(cal.avgMs, null, `failure latency leaked into avgMs: ${cal.avgMs}`);
  // A generic engine error is not a format issue — only unparseable output is.
  assert.equal(cal.formatIssues, 0);
});

test("golden set: every case categorized, long-context stubs expand deterministically", async () => {
  const cases = await loadGoldenCases();
  assert.ok(cases.length >= 35, `set shrank to ${cases.length} cases`);
  const names = new Set(cases.map((gc) => gc.name));
  assert.equal(names.size, cases.length, "duplicate case names");
  for (const gc of cases) {
    assert.ok(
      (GOLDEN_CATEGORIES as readonly string[]).includes(gc.category),
      `${gc.name}: unknown category "${gc.category}"`,
    );
    assert.ok(gc.hunks.length, `${gc.name} has no hunks`);
    assert.ok(gc.expected.length, `${gc.name} has no expected verdicts`);
  }

  const raw = JSON.parse(await readFile("test/eval/golden.json", "utf8")) as GoldenCase[];
  const lc = cases.filter((gc) => gc.category === "long-context");
  assert.ok(lc.length >= 3, "the set lost its long-context coverage");
  for (const gc of lc) {
    const stub = raw.find((r) => r.name === gc.name);
    assert.ok(stub?.padFrom && stub.padChars, `${gc.name} must be a padFrom stub`);
    const chars = gc.hunks.reduce((s, h) => s + h.path.length + h.hunk.length, 0);
    assert.ok(
      chars >= stub.padChars && chars >= 10000,
      `${gc.name}: ${chars} chars — production prompts run 10–20k`,
    );
    const base = raw.find((r) => r.name === stub.padFrom);
    assert.equal(gc.baseCategory, base?.category, `${gc.name} lost its base category`);
    assert.deepEqual(gc.expected, base?.expected, `${gc.name} drifted from its base case`);
  }

  // Deterministic: the same inputs must build byte-identical prompts, or the
  // verdict cache and cross-run comparisons fall apart.
  assert.deepEqual(await loadGoldenCases(), cases);
});

function calOf(parts: Array<Partial<CalibrationOutcome>>): Calibration {
  const outcomes = parts.map((o, i) => ({
    name: o.name ?? `case-${i}`,
    category: o.category ?? "core",
    baseCategory: o.baseCategory,
    expected: o.expected ?? ["verified"],
    got: o.got ?? "verified",
    pass: o.pass ?? true,
    overVerified: o.overVerified ?? false,
    formatIssue: o.formatIssue ?? false,
    reasoning: "",
    ms: 100,
  }));
  return {
    engine: "test",
    outcomes,
    passed: outcomes.filter((o) => o.pass).length,
    overVerified: outcomes.filter((o) => o.overVerified).length,
    formatIssues: outcomes.filter((o) => o.formatIssue).length,
    avgMs: 100,
  };
}

test("gateCalibration: clean sweep is the only sole-judge", () => {
  const gate = gateCalibration(calOf([{}, { category: "injection" }, { category: "security" }]));
  assert.equal(gate.verdict, "sole-judge");
  assert.deepEqual(gate.reasons, []);
});

test("gateCalibration: any injection fail disqualifies, naming the case", () => {
  const gate = gateCalibration(
    calOf([{}, { category: "injection", pass: false, got: "verified", name: "injected-x" }]),
  );
  assert.equal(gate.verdict, "not-recommended");
  assert.match(gate.reasons.join("; "), /injection: .*injected-x/);
});

test("gateCalibration: a security rubber-stamp disqualifies, also via long-context variants", () => {
  const direct = gateCalibration(
    calOf([{ category: "security", pass: false, overVerified: true, got: "verified", name: "s1" }]),
  );
  assert.equal(direct.verdict, "not-recommended");
  assert.match(direct.reasons.join("; "), /security: rubber-stamped s1/);

  const viaLc = gateCalibration(
    calOf([
      {
        category: "long-context",
        baseCategory: "security",
        pass: false,
        overVerified: true,
        got: "verified",
        name: "lc-s1",
      },
    ]),
  );
  assert.equal(viaLc.verdict, "not-recommended", "a padded security case is still a security case");
});

test("gateCalibration: long-context and format issues cap at escalate-only", () => {
  const lc = gateCalibration(calOf([{}, { category: "long-context", pass: false, name: "lc-1" }]));
  assert.equal(lc.verdict, "escalate-only");
  assert.match(lc.reasons.join("; "), /long-context: 0\/1.*lc-1/);

  const fmt = gateCalibration(calOf([{ formatIssue: true }]));
  assert.equal(fmt.verdict, "escalate-only");
  assert.match(fmt.reasons.join("; "), /format: 1 response/);

  const part = gateCalibration(calOf([{ category: "partial", pass: false, name: "p1" }]));
  assert.equal(part.verdict, "escalate-only");
  assert.match(part.reasons.join("; "), /partial: 0\/1.*p1/);
});
