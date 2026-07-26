// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { exitCode, isNotVerifiable, toMarkdown } from "../src/report.ts";
import { toHtml } from "../src/html.ts";
import { computeScores } from "../src/metrics.ts";
import type { ClaimResult, Report } from "../src/types.ts";

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
function report(sourcelessDiff: boolean): Report {
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
      scores: computeScores(results, 0, [], sourcelessDiff),
      flags: [],
      files: [],
      churnCoveredRatio: 0,
      context: { languages: null, codeBytes: null, releaseCadenceDays: null },
      baseline: null,
      sourcelessDiff,
    },
    warnings: [],
    truncated: false,
    engine: "off",
  };
}

test("a docs-only release is not-verifiable, not suspicious", () => {
  const sourceless = report(true);
  assert.equal(isNotVerifiable(sourceless), true);
  assert.notEqual(sourceless.metrics.scores.label, "suspicious");

  // Same notes, same verdicts, but the diff did contain source: still a finding.
  const normal = report(false);
  assert.equal(isNotVerifiable(normal), false);
  assert.equal(normal.metrics.scores.label, "suspicious");
});

test("--fail-on no-evidence does not fail on an unverifiable diff", () => {
  assert.equal(exitCode(report(true), "no-evidence"), 0);
  assert.equal(exitCode(report(false), "no-evidence"), 1);
  assert.equal(exitCode(report(true), "none"), 0);
});

test("markdown and html surface the not-verifiable category", () => {
  const md = toMarkdown(report(true));
  assert.match(md, /Not verifiable/);
  assert.match(md, /no source file is part of this release's diff/);
  assert.doesNotMatch(toMarkdown(report(false)), /Not verifiable/);

  assert.match(toHtml(report(true)), /Not verifiable/);
  assert.doesNotMatch(toHtml(report(false)), /Not verifiable/);
});
