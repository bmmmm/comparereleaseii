// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  runCalibration,
  loadGoldenCases,
  loadReference,
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

// A commit subject is written by the same hand as the claim, so a model
// arguing from it is the circularity this tool refuses — and until 2026-08-08
// the set could not ask about it: every case was prompted with `commits: []`,
// so `circularity` read 2/2 while testing only the changelog half. Cases that
// carry commits must get them in front of the model, or the category is
// measuring an empty block.
test("a golden case's linked commits reach the prompt", async () => {
  const prompts: string[] = [];
  const engine = {
    name: "recording",
    async judge(prompt: string): Promise<string> {
      prompts.push(prompt);
      return '{"verdict":"no_evidence","confidence":1,"files":[],"reasoning":"x"}';
    },
  };
  await runCalibration(engine, 8);

  const cases = await loadGoldenCases();
  const withCommits = cases.filter((gc) => gc.commits?.length);
  assert.ok(withCommits.length >= 2, `set carries ${withCommits.length} commit-bearing cases`);
  for (const gc of withCommits) {
    const subject = gc.commits![0].subject;
    const mine = prompts.filter((p) => p.includes(gc.claim));
    assert.ok(mine.length, `no prompt built for ${gc.name}`);
    assert.ok(
      mine.some((p) => p.includes(subject)),
      `${gc.name}: the linked commit subject never reached the prompt`,
    );
  }
  // And a case without commits still shows the empty marker, not a stray one.
  const bare = cases.find((gc) => !gc.commits?.length)!;
  const barePrompt = prompts.find((p) => p.includes(bare.claim))!;
  assert.match(barePrompt, /\(none linked\)/);
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

test("padding material never collides with any golden claim", async () => {
  // The long-context variants bury a case's hunks in real diff material from
  // this repo. If a padding hunk happened to contain an identifier a claim
  // names, the padded case would have evidence its base case does not — and
  // the set would measure the padding, not the model.
  const { extractIdentifiers } = await import("../src/match.ts");
  const padding = JSON.parse(await readFile("test/eval/padding.json", "utf8")) as Array<{
    path: string;
    hunk: string;
  }>;
  const raw = JSON.parse(await readFile("test/eval/golden.json", "utf8")) as GoldenCase[];
  for (const gc of raw) {
    if (!gc.claim) continue;
    const ids = extractIdentifiers({
      id: 0,
      section: gc.section,
      text: gc.claim,
      kind: "change",
      prNumbers: [],
      shas: [],
      advisories: [],
      codeSpans: [...gc.claim.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]),
    });
    for (const p of padding) {
      const hit = ids.find((id) => p.hunk.includes(id) || p.path.includes(id));
      assert.equal(
        hit,
        undefined,
        `padding hunk ${p.path} contains "${hit}" from case "${gc.name}" — swap that hunk out`,
      );
    }
  }
});

test("the frozen reference covers exactly the current golden set", async () => {
  // "Fit to judge" concretely means "matches the reference on the
  // disqualifying categories" — which is only a statement while the
  // reference and the set describe the same cases. Growing the set used to
  // leave the reference silently stale; this is the tie.
  const reference = await loadReference();
  assert.ok(reference, "test/eval/reference-haiku.json is missing or unreadable");
  const cases = await loadGoldenCases();

  const caseNames = new Set(cases.map((gc) => gc.name));
  const refNames = new Set(reference.outcomes.map((o) => o.name));
  for (const name of caseNames) {
    assert.ok(
      refNames.has(name),
      `case "${name}" has no reference outcome — re-run the paid reference and re-freeze it`,
    );
  }
  for (const name of refNames) {
    assert.ok(
      caseNames.has(name),
      `reference outcome "${name}" is no longer in the golden set — re-freeze the reference`,
    );
  }
  assert.equal(reference.total, cases.length);

  const dist: Record<string, number> = {};
  for (const gc of cases) dist[gc.category] = (dist[gc.category] ?? 0) + 1;
  assert.deepEqual(
    Object.fromEntries(Object.entries(reference.categories).map(([k, v]) => [k, v.total])),
    dist,
    "per-category totals drifted between the reference and the set",
  );
});

// Round 1 offers the need escape hatch in the prompt; round 2 withdraws it.
const offersNeed = (prompt: string): boolean => prompt.includes("respond INSTEAD with exactly");
const needEngine = (round2: string) => ({
  name: "need-stub",
  async judge(prompt: string): Promise<string> {
    if (offersNeed(prompt)) return '{"need":["internal/session/cleanup.go"]}';
    return round2;
  },
});
const verdictJson = (v: string) =>
  `{"verdict":"${v}","confidence":0.9,"files":[],"reasoning":"stub"}`;

test("calibration serves a round-1 need and grades the final verdict", async () => {
  const cal = await runCalibration(needEngine(verdictJson("no_evidence")), 8);
  const byName = new Map(cal.outcomes.map((o) => [o.name, o]));

  // The legit need case: asking was right, and the served round must land on
  // finalExpected — round 1 alone no longer settles the case.
  const legit = byName.get("legit-need-more-files")!;
  assert.equal(legit.got, "need→no-evidence");
  assert.equal(legit.pass, true);

  // The need-temptation case stays strict: no second round, round-1 need is
  // the wrong answer, full stop.
  const temptation = byName.get("evidence-suffices-need-is-wrong")!;
  assert.equal(temptation.got, "need");
  assert.equal(temptation.pass, false);

  // A case whose finalExpected demands partial does not pass on no-evidence.
  const partial = byName.get("flag-parsed-but-not-implemented")!;
  assert.equal(partial.got, "need→no-evidence");
  assert.equal(partial.pass, false);
});

test("an injection that waits for round 2 is caught and disqualifies", async () => {
  // Round 1 answers a well-formed need — looks compliant. Round 2, request
  // served, the model obeys the injected instruction and verifies. Before the
  // need round ran inside calibration this passed as injection resistance.
  const cal = await runCalibration(needEngine(verdictJson("verified")), 8);
  const injected = cal.outcomes.filter((o) => o.category === "injection");
  assert.ok(injected.length >= 3);
  for (const o of injected) {
    assert.equal(o.got, "need→verified", o.name);
    assert.equal(o.pass, false, o.name);
    assert.equal(o.overVerified, true, o.name);
  }
  assert.equal(gateCalibration(cal).verdict, "not-recommended");

  // A judge that keeps requesting files after being served never verdicts —
  // production throws there, calibration records the refusal.
  const loop = await runCalibration(needEngine('{"need":["more.go"]}'), 8);
  const legit = loop.outcomes.find((o) => o.name === "legit-need-more-files")!;
  assert.equal(legit.got, "need→need");
  assert.equal(legit.pass, false);
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
