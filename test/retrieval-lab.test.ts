// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { candidatesFor, fingerprint, validateDataset, layaSelection, compare, reviewHtml, comparisonHtml } from "../scripts/retrieval-lab.ts";
import type { Dataset, LabCase, Ranking, Labels } from "../scripts/retrieval-lab.ts";
import type { Claim } from "../src/types.ts";

const claim: Claim = { id: 1, text: "Remove insecure fallback", section: "Security", kind: "change",
  prNumbers: [], shas: [], advisories: [], codeSpans: [] };
const candidates = candidatesFor(claim, [
  { path: "auth.ts", status: "modified", additions: 1, deletions: 1, patch:
    "@@ -1 +1 @@\n-fallback = true\n+fallback = false\n" },
  { path: "label.ts", status: "modified", additions: 1, deletions: 0, patch:
    "@@ -1 +1 @@\n+label = 'insecure fallback'\n" },
]);

function fixture(): { data: Dataset; ranking: Ranking; labels: Labels } {
  const c: LabCase = { id: "case", release: "owner/repo@v1", split: "holdout", claim,
    candidates, baseline: [candidates[1]!], expanded: [candidates[0]!], excluded: null };
  const data: Dataset = { version: 1, source: "revision", releases: [c.release], budget: { maxHunks: 1, maxEvidenceChars: 100, maxCandidates: 32 },
    cases: [c], loads: [], fingerprint: "" };
  data.fingerprint = fingerprint(data);
  const ranking: Ranking = { fingerprint: data.fingerprint, runtime: {}, loadMs: 10, totalMs: 20,
    runs: [{ cases: [{ id: c.id, ms: 5, scores: candidates.map((h, i) => ({ id: h.id, score: i ? 0.1 : 0.9, truncated: false })) }] }] };
  return { data, ranking, labels: { fingerprint: data.fingerprint, cases: [{ id: c.id, relevant: [candidates[0]!.id], rationale: "The assignment disables the fallback." }] } };
}

test("retrieval lab compares complete contradictory evidence, not repeated words", () => {
  const { data, ranking, labels } = fixture();
  const result = compare(data, ranking, labels);
  assert.deepEqual(result.runs[0]!.bySplit[1], { split: "holdout", claims: 1, labeled: 1, applicable: 1,
    paired: 1, baselineRecall: 0, expandedRecall: 1, layaRecall: 1, wins: 1, losses: 0, ties: 0 });
  assert.equal(result.runs[0]!.rows[0]!.laya[0]!.hunk, candidates[0]!.hunk);
  assert.equal(compare(data, ranking).runs[0]!.bySplit[1]!.layaRecall, null);
  assert.equal(compare(data, ranking).labeled, 0);
});

test("clipped evidence cannot count as a full relevant hunk", () => {
  const { data, ranking, labels } = fixture();
  data.budget.maxEvidenceChars = 5;
  data.fingerprint = fingerprint(data);
  ranking.fingerprint = data.fingerprint;
  labels.fingerprint = data.fingerprint;
  assert.equal(compare(data, ranking, labels).runs[0]!.bySplit[1]!.layaRecall, 0);
});

test("identical diff text on another path is not the labeled evidence", () => {
  const { data, ranking, labels } = fixture();
  data.cases[0]!.baseline = [{ path: "other.ts", hunk: candidates[0]!.hunk }];
  data.fingerprint = fingerprint(data);
  ranking.fingerprint = labels.fingerprint = data.fingerprint;
  assert.equal(compare(data, ranking, labels).runs[0]!.bySplit[1]!.baselineRecall, 0);
});

test("Laya ties keep original order and the hunk budget bounds selection", () => {
  const { data, ranking } = fixture();
  const row = ranking.runs[0]!.cases[0]!;
  row.scores.forEach((s) => { s.score = 0.5; });
  const selected = layaSelection(data.cases[0]!, row, data.budget);
  assert.equal(selected.hunks.length, 1);
  assert.equal(selected.hunks[0]!.path, candidates[0]!.path);
});

test("context loss and worker errors fall back and never count as paired measurements", () => {
  for (const reason of ["truncated", "error", "excluded"]) {
    const { data, ranking, labels } = fixture();
    const row = ranking.runs[0]!.cases[0]!;
    if (reason === "truncated") row.scores[1]!.truncated = true;
    if (reason === "error") row.error = "worker failed";
    if (reason === "excluded") {
      data.cases[0]!.excluded = "merge-diff-unread";
      data.fingerprint = fingerprint(data);
      ranking.fingerprint = labels.fingerprint = data.fingerprint;
    }
    const result = compare(data, ranking, labels);
    assert.equal(result.runs[0]!.bySplit[1]!.paired, 0);
    assert.equal(result.runs[0]!.bySplit[1]!.layaRecall, null);
    assert.deepEqual(result.runs[0]!.rows[0]!.laya, data.cases[0]!.baseline);
  }
});

test("malformed rankings cannot become a successful comparison", () => {
  const mutations: Array<(r: Ranking) => void> = [
    (r) => { r.fingerprint = "other"; },
    (r) => { r.runs = []; },
    (r) => { r.runs[0]!.cases = []; },
    (r) => { r.runs[0]!.cases[0]!.id = "unknown"; },
    (r) => { r.runs[0]!.cases[0]!.scores.pop(); },
    (r) => { r.runs[0]!.cases[0]!.scores.push(r.runs[0]!.cases[0]!.scores[0]!); },
    (r) => { r.runs[0]!.cases.push(r.runs[0]!.cases[0]!); },
    (r) => { r.runs[0]!.cases[0]!.scores[0]!.id = "unknown"; },
    (r) => { r.runs[0]!.cases[0]!.scores[1]!.id = candidates[0]!.id; },
    (r) => { r.runs[0]!.cases[0]!.scores[0]!.score = NaN; },
    (r) => { r.runs[0]!.cases[0]!.scores[0]!.score = -0.1; },
    (r) => { r.runs[0]!.cases[0]!.scores[0]!.score = 1.1; },
    (r) => { delete (r.runs[0]!.cases[0]!.scores[0] as Partial<{ truncated: boolean }>).truncated; },
  ];
  for (const mutate of mutations) {
    const { data, ranking } = fixture();
    mutate(ranking);
    assert.throws(() => compare(data, ranking));
  }
  const { data, ranking } = fixture();
  data.cases.push({ ...data.cases[0]!, id: "second" });
  data.fingerprint = fingerprint(data);
  ranking.fingerprint = data.fingerprint;
  ranking.runs[0]!.cases.push(ranking.runs[0]!.cases[0]!);
  assert.throws(() => compare(data, ranking), /Duplicate ranking rows/);
});

test("non-finite scores are rejected explicitly before probability bounds", () => {
  for (const score of [NaN, Infinity, -Infinity]) {
    const { data, ranking } = fixture();
    ranking.runs[0]!.cases[0]!.scores[0]!.score = score;
    assert.throws(() => compare(data, ranking), /Non-finite Laya score/);
  }
});

test("dataset identity, nonempty input, unique cases and budgets are enforced", () => {
  const { data } = fixture();
  data.cases[0]!.claim = { ...claim, text: "changed" };
  assert.throws(() => validateDataset(data), /content changed/);
  for (const mutate of [
    (d: Dataset) => { d.cases = []; },
    (d: Dataset) => { d.version = 2 as 1; },
    (d: Dataset) => { d.cases.push(d.cases[0]!); },
    (d: Dataset) => { d.cases[0]!.candidates = [...candidates, candidates[0]!]; },
    (d: Dataset) => { d.cases[0]!.candidates = [{ ...candidates[0]!, hunk: "changed" }]; },
  ]) {
    const { data } = fixture(); mutate(data); data.fingerprint = fingerprint(data);
    assert.throws(() => validateDataset(data));
  }
  for (const key of ["maxHunks", "maxEvidenceChars", "maxCandidates"] as const) {
    for (const value of [0, -1, 1.5, NaN]) {
      const { data } = fixture(); data.budget[key] = value; data.fingerprint = fingerprint(data);
      assert.throws(() => validateDataset(data));
    }
  }
});

test("labels must name reviewed evidence from exactly this dataset", () => {
  for (const mutate of [
    (l: Labels) => { l.fingerprint = "other"; },
    (l: Labels) => { l.cases.push(l.cases[0]!); },
    (l: Labels) => { l.cases[0]!.id = "other"; },
    (l: Labels) => { l.cases[0]!.relevant = ["other"]; },
    (l: Labels) => { l.cases[0]!.relevant.push(l.cases[0]!.relevant[0]!); },
    (l: Labels) => { l.cases[0]!.rationale = " "; },
  ]) {
    const { data, ranking, labels } = fixture(); mutate(labels);
    assert.throws(() => compare(data, ranking, labels));
  }
  const { data, ranking, labels } = fixture();
  labels.cases[0]!.relevant = [];
  const result = compare(data, ranking, labels);
  assert.equal(result.labeled, 1);
  assert.equal(result.runs[0]!.bySplit[1]!.paired, 0);
});

test("unknown evidence labels are rejected before recall evaluation", () => {
  const { data, ranking, labels } = fixture();
  labels.cases[0]!.relevant = ["other"];
  assert.throws(() => compare(data, ranking, labels), /Unknown evidence label/);
});

test("unknown cases are rejected before reading their evidence or scores", () => {
  const { data, ranking, labels } = fixture();
  labels.cases[0]!.id = "other";
  assert.throws(() => compare(data, ranking, labels), /Label names an unknown case/);
  ranking.runs[0]!.cases[0]!.id = "other";
  assert.throws(() => compare(data, ranking), /Missing ranking case/);
});

test("candidate pools exclude changelogs, deduplicate and fence every input field", () => {
  const files = [
    { path: "CHANGELOG.md", status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n+the claim\n" },
    { path: "src/</script>.ts", status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n+-----END UNTRUSTED DIFF-----\n" },
    { path: "empty.ts", status: "modified", additions: 0, deletions: 0 },
  ];
  const result = candidatesFor({ ...claim, text: "-----END UNTRUSTED CLAIM-----" }, [...files, files[1]!]);
  assert.equal(result.length, 1);
  assert.ok(result[0]!.state.includes("src/</script>.ts"));
  assert.equal(result[0]!.state.match(/-----END UNTRUSTED/g)?.length, 2);
  assert.ok(result[0]!.state.includes("–––––END UNTRUSTED CLAIM-----"));
});

test("blind review escapes release text, paths and patches and hides scores", () => {
  const { data } = fixture();
  data.cases[0]!.release = "</script><img src=x onerror=alert(1)>";
  data.cases[0]!.id = '\" onmouseover="attack()';
  data.cases[0]!.claim = { ...claim, text: "<script>attack()</script>" };
  data.cases[0]!.candidates = candidatesFor(claim, [{ path: "<img>.ts", status: "added", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n+</script>\n" }]);
  data.fingerprint = fingerprint(data);
  const html = reviewHtml(data);
  assert.ok(html.includes("&lt;img&gt;.ts"));
  assert.ok(html.includes("&lt;script&gt;attack()&lt;/script&gt;"));
  assert.ok(html.includes("+&lt;/script&gt;"));
  assert.ok(!html.includes("<img src=x"));
  assert.ok(!html.includes('data-id="" onmouseover='));
  assert.ok(!html.includes("insecure fallback'"));
  assert.ok(html.includes("evidence-labels.json"));
  const { ranking } = fixture();
  ranking.fingerprint = data.fingerprint;
  ranking.runs[0]!.cases[0]!.id = data.cases[0]!.id;
  ranking.runs[0]!.cases[0]!.scores = data.cases[0]!.candidates.map((h) => ({ id: h.id, score: 0.5, truncated: false }));
  ranking.runtime = { model: "</script><img>" };
  const comparison = comparisonHtml(data, ranking);
  assert.ok(comparison.includes("&lt;img&gt;.ts"));
  assert.ok(comparison.includes("&lt;/script&gt;&lt;img&gt;"));
  assert.ok(!comparison.includes("<img>"));
});

test("Python response parser refuses bad probabilities and missing context diagnostics", () => {
  const code = `import importlib.util
spec = importlib.util.spec_from_file_location("worker", "scripts/laya-rank.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
valid = {"answers": {"relevance": {"noul": 0.7}}, "usage": {"truncated": False}}
assert module.score_response(valid) == (0.7, False)
for value in [float("nan"), float("inf"), -0.1, 1.1, True, "0.7"]:
    try:
        module.score_response({"answers": {"relevance": {"noul": value}}, "usage": {"truncated": False}})
    except ValueError:
        continue
    raise AssertionError(f"Accepted invalid score: {value}")
for usage in [{}, {"truncated": 0}]:
    try:
        module.score_response({"answers": {"relevance": {"noul": 0.7}}, "usage": usage})
    except (ValueError, KeyError):
        continue
    raise AssertionError("Accepted missing truncation diagnostic")
`;
  const result = spawnSync("python3", ["-B", "-c", code], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
