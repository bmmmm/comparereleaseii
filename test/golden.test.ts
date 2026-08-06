// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addGoldenCase, goldenCaseName, looksLikeSecurity } from "../src/golden.ts";
import {
  gateCalibration,
  loadGoldenCases,
  recommendation,
  type Calibration,
  type CalibrationOutcome,
  type GoldenCase,
} from "../src/calibrate.ts";
import type { ClaimResult, ReleaseData, Report } from "../src/types.ts";

function claimResult(over: Partial<ClaimResult["claim"]> = {}, verdict: ClaimResult["verdict"] = "verified"): ClaimResult {
  return {
    claim: {
      id: 3,
      section: "Bug Fixes",
      text: "Fix the send access-count bypass",
      kind: "change",
      prNumbers: [],
      shas: [],
      advisories: [],
      codeSpans: [],
      ...over,
    },
    verdict,
    confidence: 0.9,
    evidence: { commitShas: [], files: [], matchedTerms: [], methods: ["lexical"] },
    reasoning: "Identifiers appear in the diff.",
    judged: true,
    generated: false,
  };
}

function report(over: Partial<Report> = {}): Report {
  return {
    repoLabel: "dani-garcia/vaultwarden",
    baseRef: "1.34.0",
    headRef: "1.34.1",
    stats: { commits: 2, files: 1, additions: 6, deletions: 2 },
    results: [claimResult()],
    uncovered: [],
    reverseChecked: true,
    metrics: {
      scores: { correctness: 100, completeness: 100, risk: 100, overall: 100, label: "solid" },
      flags: [],
      files: [],
      churnCoveredRatio: 1,
      context: { languages: null, codeBytes: null, releaseCadenceDays: null },
      baseline: null,
      unverifiable: null,
    },
    warnings: [],
    truncated: false,
    engine: "test",
    linkBase: "https://github.com/dani-garcia/vaultwarden",
    ...over,
  };
}

/** The release the report describes, as the reload would hand it back. */
function releaseOf(patch = "@@ -1,3 +1,5 @@ fn register_access()\n+    let updated = 1;"): ReleaseData {
  return {
    repoLabel: "dani-garcia/vaultwarden",
    baseRef: "1.34.0",
    headRef: "1.34.1",
    notes: "",
    commits: [],
    files: [
      { path: "src/db/models/send.rs", status: "modified", additions: 6, deletions: 2, patch },
      { path: "src/api/core/mod.rs", status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n+// unrelated" },
    ],
    commitFiles: async () => [],
    warnings: [],
  };
}

async function fixture(
  reportOver: Partial<Report> = {},
  golden: GoldenCase[] = [],
): Promise<{ reportPath: string; goldenFile: string }> {
  const dir = await mkdtemp(join(tmpdir(), "golden-"));
  const reportPath = join(dir, "report.json");
  const goldenFile = join(dir, "golden.json");
  await writeFile(reportPath, JSON.stringify(report(reportOver), null, 2));
  await writeFile(goldenFile, JSON.stringify(golden, null, 2));
  return { reportPath, goldenFile };
}

const read = async (p: string): Promise<GoldenCase[]> =>
  JSON.parse(await readFile(p, "utf8")) as GoldenCase[];

// Every golden case used to be invented by hand, and a wrong verdict noticed
// in the field had no route back into the tool. This is the route: the human
// supplies what the verdict should have been, the tool supplies the material
// the question was actually asked on.
test("a claim lifted out of a report becomes a case with the release's own evidence", async () => {
  const { reportPath, goldenFile } = await fixture();
  const added = await addGoldenCase({
    reportPath,
    claimId: 3,
    verdict: "no-evidence",
    why: "the diff only renames a field; nothing enforces the limit",
    goldenFile,
    load: async () => releaseOf(),
  });

  assert.equal(added.total, 1);
  const [gc] = await read(goldenFile);
  assert.equal(gc.name, "dani-garcia-vaultwarden-1-34-1-claim3");
  assert.equal(gc.claim, "Fix the send access-count bypass");
  assert.equal(gc.section, "Bug Fixes");
  assert.deepEqual(gc.expected, ["no-evidence"]);
  // The misjudgement itself is on the record — `expected` alone would not say
  // what the case is a regression against.
  assert.equal(gc.lifted?.got, "verified");
  assert.equal(gc.lifted?.repo, "dani-garcia/vaultwarden");
  assert.equal(gc.lifted?.tag, "1.34.1");
  assert.match(gc.lifted!.why!, /nothing enforces the limit/);
  assert.match(gc.lifted!.added, /^\d{4}-\d{2}-\d{2}$/);
  // The hunks are the release's real diff, ranked the way a check ranks them.
  assert.ok(gc.hunks.length >= 1, "the case carries the evidence the judge saw");
  assert.equal(gc.hunks[0].path, "src/db/models/send.rs");
  assert.match(gc.hunks[0].hunk, /register_access/);
  // …and the file list the need protocol reads is wider than the hunks.
  assert.ok(gc.allPaths!.includes("src/api/core/mod.rs"));

  // The set stays loadable by the thing that runs it — a case the calibration
  // cannot read is not a regression test.
  const cases = await read(goldenFile);
  assert.equal(cases.length, 1);
  assert.ok(Array.isArray(cases[0].expected));
});

// The previous round of golden-set work was frozen because tuning the set and
// ranking models had poor marginal value; the fitness gate survived precisely
// because it ENDS that topic. A lift route that let this morning's case flip a
// judge from "sole judge" to "not recommended" would reopen it, and a set
// growing with unreviewed field cases would turn the gate into noise. So a
// lifted case is a regression test and nothing else until a person promotes it.
test("a lifted case is reported by the calibration but never moves the fitness verdict", async () => {
  const { reportPath, goldenFile } = await fixture();
  const added = await addGoldenCase({
    reportPath,
    claimId: 3,
    verdict: "no-evidence",
    goldenFile,
    load: async () => releaseOf(),
  });
  assert.equal(added.case.category, "field", "lifted cases do not land in a gate category");

  const outcome = (over: Partial<CalibrationOutcome>): CalibrationOutcome => ({
    name: "x",
    category: "core",
    expected: ["verified"],
    got: "verified",
    pass: true,
    overVerified: false,
    formatIssue: false,
    reasoning: "",
    ms: 100,
    ...over,
  });
  const cal = (outcomes: CalibrationOutcome[]): Calibration => ({
    engine: "test",
    outcomes,
    passed: outcomes.filter((o) => o.pass).length,
    overVerified: outcomes.filter((o) => o.overVerified).length,
    formatIssues: 0,
    avgMs: 100,
  });

  // A judge that sweeps every gate category and fails two lifted field cases
  // is still a sole judge — and is told, by name, what it got wrong.
  const withField = cal([
    outcome({ name: "core-1" }),
    outcome({ name: "sec-1", category: "security" }),
    outcome({ name: "field-1", category: "field", pass: false, got: "verified", expected: ["no-evidence"] }),
    outcome({ name: "field-2", category: "field", pass: false }),
  ]);
  const gate = gateCalibration(withField);
  assert.equal(gate.verdict, "sole-judge", "field failures do not downgrade a judge");
  assert.deepEqual(gate.fieldFailures, ["field-1", "field-2"]);
  assert.equal(gate.fieldTotal, 2);
  assert.match(recommendation(withField), /2 of your 2 lifted field case\(s\) wrong/);
  assert.match(recommendation(withField), /they do not gate/);

  // A rubber-stamped SECURITY case still disqualifies — promoting a case into
  // that category has to keep meaning what it meant.
  const promoted = cal([
    outcome({ name: "sec-1", category: "security", pass: false, overVerified: true }),
  ]);
  assert.equal(gateCalibration(promoted).verdict, "not-recommended");

  // …and a failing core case still means escalation.
  const core = cal([outcome({ name: "core-1", pass: false })]);
  assert.equal(gateCalibration(core).verdict, "escalate-only");
});

test("security material is suggested for promotion, never promoted automatically", async () => {
  assert.equal(looksLikeSecurity(claimResult({ section: "Security Fixes" })), true);
  assert.equal(looksLikeSecurity(claimResult({ advisories: ["GHSA-xxxx"] })), true);
  assert.equal(looksLikeSecurity(claimResult({ section: "Bug Fixes" })), false);

  const { reportPath, goldenFile } = await fixture({
    results: [claimResult({ section: "Security Fixes" })],
  });
  const added = await addGoldenCase({
    reportPath,
    claimId: 3,
    verdict: "no-evidence",
    goldenFile,
    load: async () => releaseOf(),
  });
  assert.equal(added.case.category, "field", "even security material waits for a person");
  assert.equal(added.securityLooking, true, "…but the caller is told to consider promoting it");
});

test("an explicit category is validated against the gate's own list", async () => {
  const { reportPath, goldenFile } = await fixture();
  await assert.rejects(
    addGoldenCase({
      reportPath,
      claimId: 3,
      verdict: "partial",
      category: "important",
      goldenFile,
      load: async () => releaseOf(),
    }),
    /--category must be one of/,
  );
  const ok = await addGoldenCase({
    reportPath,
    claimId: 3,
    verdict: "partial",
    category: "circularity",
    goldenFile,
    load: async () => releaseOf(),
  });
  assert.equal(ok.case.category, "circularity");
});

test("the verdict has to be one a judge can produce", async () => {
  const { reportPath, goldenFile } = await fixture();
  for (const bad of ["skipped", "wrong", "VERIFIED"]) {
    await assert.rejects(
      addGoldenCase({ reportPath, claimId: 3, verdict: bad, goldenFile, load: async () => releaseOf() }),
      /is not a verdict/,
      bad,
    );
  }
  assert.deepEqual(await read(goldenFile), [], "a rejected add writes nothing");
});

test("a claim id that is not in the report names the ids that are", async () => {
  const { reportPath, goldenFile } = await fixture();
  await assert.rejects(
    addGoldenCase({ reportPath, claimId: 99, verdict: "partial", goldenFile, load: async () => releaseOf() }),
    /has no claim 99 — its claim ids are 3/,
  );
});

test("the same claim cannot be added twice — the set must not grow duplicates", async () => {
  const { reportPath, goldenFile } = await fixture();
  await addGoldenCase({ reportPath, claimId: 3, verdict: "partial", goldenFile, load: async () => releaseOf() });
  await assert.rejects(
    addGoldenCase({ reportPath, claimId: 3, verdict: "no-evidence", goldenFile, load: async () => releaseOf() }),
    /is already in the golden set/,
  );
  assert.equal((await read(goldenFile)).length, 1);
});

// A case with no hunks would grade a model on the prompt preamble alone: it
// would pass or fail for reasons that have nothing to do with the release.
test("a claim the judge saw no diff evidence for cannot become a case", async () => {
  const { reportPath, goldenFile } = await fixture();
  const empty: ReleaseData = { ...releaseOf(), files: [] };
  await assert.rejects(
    addGoldenCase({ reportPath, claimId: 3, verdict: "no-evidence", goldenFile, load: async () => empty }),
    /no diff evidence at all/,
  );
});

test("a report checked from a local clone says which flag names the clone", async () => {
  const { reportPath, goldenFile } = await fixture({ linkBase: undefined });
  await assert.rejects(
    addGoldenCase({ reportPath, claimId: 3, verdict: "partial", goldenFile }),
    /pass --local <path>/,
  );
});

test("something that is not a report says so instead of half-reading it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "golden-"));
  const notJson = join(dir, "a.json");
  const notReport = join(dir, "b.json");
  const goldenFile = join(dir, "golden.json");
  await writeFile(notJson, "{ nope");
  await writeFile(notReport, JSON.stringify({ hello: "world" }));
  await writeFile(goldenFile, "[]");
  await assert.rejects(
    addGoldenCase({ reportPath: notJson, claimId: 0, verdict: "partial", goldenFile }),
    /is not JSON/,
  );
  await assert.rejects(
    addGoldenCase({ reportPath: notReport, claimId: 0, verdict: "partial", goldenFile }),
    /is not a comparereleaseii report/,
  );
});

test("case names are derived from the release, and survive hostile tags", () => {
  assert.equal(goldenCaseName(report(), 0), "dani-garcia-vaultwarden-1-34-1-claim0");
  const hostile = report({ repoLabel: "o/r", headRef: "../../etc/passwd" });
  assert.equal(goldenCaseName(hostile, 1), "o-r-etc-passwd-claim1");
});

// The set the tool ships must stay loadable through the same reader that runs
// it — a lifted case has one more field than a hand-written one, and a reader
// that chokes on it would take the whole calibration down with it.
test("the shipped golden set still loads with the lifted-case field in the type", async () => {
  const cases = await loadGoldenCases();
  assert.ok(cases.length > 0);
  for (const gc of cases) {
    assert.equal(typeof gc.name, "string");
    assert.ok(Array.isArray(gc.expected));
  }
});
