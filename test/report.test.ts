// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { exitCode, unverifiableNote, toMarkdown } from "../src/report.ts";
import { toHtml } from "../src/html.ts";
import { computeScores } from "../src/metrics.ts";
import type { ClaimResult, Report, Unverifiable } from "../src/types.ts";

function claimResult(verdict: ClaimResult["verdict"]): ClaimResult {
  return {
    claim: {
      id: 0,
      section: "What's changed",
      text: "Bug fixes and reliability improvements",
      kind: "change",
      prNumbers: [],
      shas: [],
      advisories: [],
      codeSpans: [],
    },
    verdict,
    confidence: 0.5,
    evidence: { commitShas: [], files: [], matchedTerms: [], methods: ["none"] },
    reasoning: "No identifier from the claim appears in the diff.",
    judged: false,
    generated: false,
  };
}

/** The claude-code v2.1.219 → v2.1.220 shape: notes without shipped source. */
function report(unverifiable: Unverifiable | null): Report {
  const results = [claimResult("no-evidence")];
  return {
    repoLabel: "anthropics/claude-code",
    baseRef: "v2.1.219",
    headRef: "v2.1.220",
    stats: { commits: 1, files: 2, additions: 12, deletions: 38 },
    results,
    uncovered: [],
    reverseChecked: true,
    metrics: {
      scores: computeScores(results, 0, [], unverifiable !== null),
      flags: [],
      files: [],
      churnCoveredRatio: 0,
      context: { languages: null, codeBytes: null, releaseCadenceDays: null },
      baseline: null,
      unverifiable,
    },
    warnings: [],
    truncated: false,
    engine: "off",
  };
}

const SOURCELESS: Unverifiable = {
  kind: "sourceless",
  reason: "This release's diff contains no source-code changes — claims could not be checked against code.",
};
const OUT_OF_REPO: Unverifiable = {
  kind: "out-of-repo",
  reason: "These notes describe changes that are not in this repo's own diff — across the last 5 releases only 8% of claims matched its code (fork, build or distribution repo).",
};

test("an unverifiable release is a category of its own, not suspicious", () => {
  for (const u of [SOURCELESS, OUT_OF_REPO]) {
    const r = report(u);
    assert.equal(unverifiableNote(r)?.heading !== undefined, true, u.kind);
    assert.notEqual(r.metrics.scores.label, "suspicious", u.kind);
  }

  // Same notes, same verdicts, but the claims were genuinely checkable here.
  const normal = report(null);
  assert.equal(unverifiableNote(normal), null);
  assert.equal(normal.metrics.scores.label, "suspicious");
});

test("the note never disagrees with the score's own label", () => {
  // Unverifiable classification held, but this particular claim still got
  // real evidence (e.g. anchored by commit sha) — computeScores does not
  // cap/label it "unverified" in that shape (see metrics.test.ts). The note
  // must not claim otherwise: no "Not verifiable" banner next to a clean score.
  const results = [claimResult("verified")];
  const r: Report = {
    repoLabel: "anthropics/claude-code",
    baseRef: "v2.1.219",
    headRef: "v2.1.220",
    stats: { commits: 1, files: 2, additions: 12, deletions: 38 },
    results,
    uncovered: [],
    reverseChecked: true,
    metrics: {
      scores: computeScores(results, 1, [], true),
      flags: [],
      files: [],
      churnCoveredRatio: 1,
      context: { languages: null, codeBytes: null, releaseCadenceDays: null },
      baseline: null,
      unverifiable: SOURCELESS,
    },
    warnings: [],
    truncated: false,
    engine: "off",
  };
  assert.notEqual(r.metrics.scores.label, "unverified");
  assert.equal(unverifiableNote(r), null);
});

test("--fail-on no-evidence does not fail on an unverifiable release", () => {
  assert.equal(exitCode(report(SOURCELESS), "no-evidence"), 0);
  assert.equal(exitCode(report(OUT_OF_REPO), "no-evidence"), 0);
  assert.equal(exitCode(report(null), "no-evidence"), 1);
  assert.equal(exitCode(report(SOURCELESS), "none"), 0);
});

test("markdown and html name the right category, per kind", () => {
  const sourceless = toMarkdown(report(SOURCELESS));
  assert.match(sourceless, /Not verifiable/);
  assert.match(sourceless, /no source file is part of this release's diff/);

  // A fork's notes are not "no source" — the heading must say what it is.
  const fork = toMarkdown(report(OUT_OF_REPO));
  assert.match(fork, /Changes outside this repo/);
  assert.match(fork, /not part of this repo's diff/);
  assert.doesNotMatch(fork, /no source file/);

  assert.doesNotMatch(toMarkdown(report(null)), /Not verifiable|Changes outside/);
  assert.match(toHtml(report(SOURCELESS)), /Not verifiable/);
  assert.match(toHtml(report(OUT_OF_REPO)), /Changes outside this repo/);
  assert.doesNotMatch(toHtml(report(null)), /Not verifiable|Changes outside/);
});
