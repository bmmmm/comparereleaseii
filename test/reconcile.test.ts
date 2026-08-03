// SPDX-License-Identifier: GPL-3.0-or-later
// The reconciliation layer: claims meet findings late and deterministically.
// The properties everything leans on: the identifier bar decides a link (one
// code span or two identifiers — never a single stray token), meta and
// skipped claims take no part, the join never mutates its inputs, and no
// findings means no reconciliation at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcile } from "../src/reconcile.ts";
import { analyzeRelease, type CheckSettings } from "../src/check.ts";
import type { JudgeEngine } from "../src/judge.ts";
import type {
  Claim,
  ClaimResult,
  Commit,
  DiffFile,
  Finding,
  ReleaseData,
  RepoContext,
  UncoveredCommit,
  Verdict,
} from "../src/types.ts";

function claim(over: Partial<Claim> = {}): Claim {
  return {
    id: 1,
    section: "Changed",
    text: "",
    kind: "change",
    prNumbers: [],
    shas: [],
    advisories: [],
    codeSpans: [],
    ...over,
  };
}

function result(c: Claim, verdict: Verdict = "verified"): ClaimResult {
  return {
    claim: c,
    verdict,
    confidence: 0.9,
    evidence: { commitShas: [], files: [], matchedTerms: [], methods: [] },
    reasoning: "",
    judged: false,
    generated: false,
  };
}

function finding(over: Partial<Finding> = {}): Finding {
  return { kind: "feature", audience: "operator", text: "", files: [], subsystem: "src", ...over };
}

function commitOf(fill: string, subject: string): Commit {
  return { sha: fill.repeat(40), subject, body: "", author: "dev", prNumbers: [] };
}

function uc(fill: string, subject: string, churn = 10): UncoveredCommit {
  return { commit: commitOf(fill, subject), additions: churn, deletions: 1, fileCount: 1 };
}

function df(path: string): DiffFile {
  return { path, status: "modified", additions: 3, deletions: 1, patch: undefined };
}

// ---------- the identifier bar ----------

test("a code-span hit alone confirms — the notes' own backtick is the strongest anchor", () => {
  const r = result(
    claim({ text: "Adds `resetJudgeStats` to the cache module", codeSpans: ["resetJudgeStats"] }),
  );
  const f = finding({ text: "Added resetJudgeStats function to reset counters" });
  const rec = reconcile([r], [f], [], null);
  assert.deepEqual(rec.confirmed, [{ finding: 0, claims: [0] }]);
  assert.deepEqual(rec.undocumented, []);
  assert.deepEqual(rec.unsupported, []);
});

test("one plain identifier is not a link — the bar wants a span or two identifiers", () => {
  const r = result(claim({ text: "improve the watchState handling" }));
  const f = finding({ text: "Reworked watchState transitions" });
  const rec = reconcile([r], [f], [], null);
  assert.deepEqual(rec.confirmed, []);
  assert.deepEqual(rec.undocumented, [0]);
  assert.deepEqual(rec.unsupported, [0]);
});

test("two identifiers clear the bar together", () => {
  const r = result(claim({ text: "rename watchState to pollCursor" }));
  const f = finding({ text: "watchState renamed to pollCursor across the state module" });
  const rec = reconcile([r], [f], [], null);
  assert.deepEqual(rec.confirmed, [{ finding: 0, claims: [0] }]);
  assert.deepEqual(rec.unsupported, []);
});

test("a finding's files carry the match like its text does", () => {
  const r = result(
    claim({ text: "split the state rules into `watch-state.ts`", codeSpans: ["watch-state.ts"] }),
  );
  const f = finding({
    text: "State transition rules extracted into a new module",
    files: ["src/watch-state.ts"],
  });
  const rec = reconcile([r], [f], [], null);
  assert.deepEqual(rec.confirmed, [{ finding: 0, claims: [0] }]);
});

// ---------- who takes part ----------

test("meta and skipped claims take no part — neither confirming nor unsupported", () => {
  const meta = result(
    claim({ id: 1, kind: "meta", text: "New Contributors did watchState and pollCursor work" }),
  );
  const carried = result(claim({ id: 2, text: "watchState becomes pollCursor" }), "skipped");
  const f = finding({ text: "watchState moved to pollCursor" });
  const rec = reconcile([meta, carried], [f], [], null);
  assert.deepEqual(rec.confirmed, []);
  assert.deepEqual(rec.undocumented, [0]);
  assert.deepEqual(rec.unsupported, []);
});

test("unsupported lists exactly the claims no finding observes", () => {
  const a = result(claim({ id: 1, text: "rename watchState to pollCursor" }));
  const b = result(claim({ id: 2, text: "add the `frobnicate` flag", codeSpans: ["frobnicate"] }));
  const f = finding({ text: "watchState renamed to pollCursor" });
  const rec = reconcile([a, b], [f], [], null);
  assert.deepEqual(rec.confirmed, [{ finding: 0, claims: [0] }]);
  assert.deepEqual(rec.unsupported, [1]);
});

// ---------- the uncovered order ----------

test("undocumented findings pull matching uncovered commits to the front — display only", () => {
  const r = result(claim({ text: "add the `frobnicate` flag", codeSpans: ["frobnicate"] }));
  const confirmedF = finding({ text: "frobnicate flag added", files: ["src/cli.ts"] });
  const undocF = finding({ text: "Silent retry loop added", files: ["src/retry.ts"] });
  const big = uc("a", "big refactor", 500);
  const silent = uc("b", "small change", 5);
  const commitFiles = new Map<string, DiffFile[]>([
    [big.commit.sha, [df("src/other.ts")]],
    [silent.commit.sha, [df("src/retry.ts")]],
  ]);
  const rec = reconcile([r], [confirmedF, undocF], [big, silent], commitFiles);
  assert.deepEqual(rec.undocumented, [1]);
  assert.deepEqual(rec.uncoveredOrder, [1, 0]);
});

test("an order that changes nothing is omitted", () => {
  const undocF = finding({ text: "Silent retry loop added", files: ["src/retry.ts"] });
  const first = uc("a", "silent retry", 500);
  const second = uc("b", "other", 5);
  const commitFiles = new Map<string, DiffFile[]>([
    [first.commit.sha, [df("src/retry.ts")]],
    [second.commit.sha, [df("src/other.ts")]],
  ]);
  const rec = reconcile([], [undocF], [first, second], commitFiles);
  assert.equal(rec.uncoveredOrder, undefined);
});

// ---------- purity ----------

test("the join is a pure view — inputs untouched, re-runs identical", () => {
  const results = [result(claim({ text: "rename watchState to pollCursor" }))];
  const findings = [finding({ text: "watchState renamed to pollCursor" })];
  const uncovered = [uc("a", "something", 10)];
  const commitFiles = new Map<string, DiffFile[]>([[uncovered[0].commit.sha, [df("src/x.ts")]]]);
  const before = structuredClone({ results, findings, uncovered });
  const one = reconcile(results, findings, uncovered, commitFiles);
  const two = reconcile(results, findings, uncovered, commitFiles);
  assert.deepEqual({ results, findings, uncovered }, before);
  assert.deepEqual(one, two);
});

// ---------- pipeline wiring ----------

const CONTEXT: RepoContext = { languages: null, codeBytes: null, releaseCadenceDays: null };

function file(path: string, patch: string | undefined, additions = 5, deletions = 2): DiffFile {
  return { path, status: "modified", additions, deletions, patch };
}

function data(over: Partial<ReleaseData> = {}): ReleaseData {
  return {
    repoLabel: "acme/app",
    baseRef: "v1.0.0",
    headRef: "v1.1.0",
    notes: "- Fixed the frobnicator\n",
    commits: [commitOf("a", "some work")],
    files: [
      file("src/server/api.go", `@@ -1,4 +1,6 @@ func Serve()\n-old route\n+new route\n`, 40, 10),
    ],
    commitFiles: async () => [],
    warnings: [],
    ...over,
  };
}

function settings(over: Partial<CheckSettings> = {}): CheckSettings {
  return {
    judgeMode: "auto",
    engine: null,
    escalateEngine: null,
    concurrency: 2,
    reverse: true,
    baseline: 0,
    ...over,
  };
}

const stubEngine: JudgeEngine = {
  name: "stub",
  async judge(prompt: string): Promise<string> {
    if (prompt.startsWith("You are summarizing a release")) {
      return '{"summary":"Stub release summary."}';
    }
    if (prompt.startsWith("You are describing what actually shipped")) {
      return JSON.stringify({
        findings: [{ kind: "feature", audience: "user", text: "stub finding", files: [] }],
      });
    }
    return '{"verdict":"verified","confidence":0.9,"files":[],"reasoning":"stub"}';
  },
};

test("analyzeRelease joins late: reconciliation with findings, absent without — scores pinned", async () => {
  const withFindings = await analyzeRelease(data(), CONTEXT, null, settings({ engine: stubEngine }));
  assert.ok(withFindings.findings?.findings.length);
  assert.ok(withFindings.reconciliation);
  // The stub finding names nothing the note claims: everything undocumented.
  assert.deepEqual(
    withFindings.reconciliation!.undocumented,
    withFindings.findings!.findings.map((_, i) => i),
  );

  // Findings off: no reconciliation, and the metrics do not move — the
  // score-neutrality pin for the whole layer.
  const noFindings = await analyzeRelease(
    data(),
    CONTEXT,
    null,
    settings({ engine: stubEngine, findings: false }),
  );
  assert.equal(noFindings.reconciliation, undefined);
  assert.deepEqual(withFindings.metrics, noFindings.metrics);

  // --judge off degrades honestly: no findings, no reconciliation — the
  // deterministic report grows no empty scaffold.
  const judgeOff = await analyzeRelease(data(), CONTEXT, null, settings({ judgeMode: "off" }));
  assert.equal(judgeOff.findings, undefined);
  assert.equal(judgeOff.reconciliation, undefined);
});
