// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreClass, toRepoDetailHtml } from "../src/watch-detail.ts";
import { STALE_AFTER } from "../src/promises.ts";
import { scoreBaseline, type CheckedRelease, type RepoState, type WatchedEntry } from "../src/watch.ts";
import type { PromiseCheck } from "../src/types.ts";

const ENTRY: WatchedEntry = { key: "o/r", repo: "o/r" };

function check(tag: string, score: number, over: Partial<CheckedRelease> = {}): CheckedRelease {
  return {
    tag,
    publishedAt: "2026-07-01T00:00:00Z",
    checkedAt: "2026-07-02T00:00:00Z",
    score,
    scoreLabel: score >= 85 ? "solid" : score >= 65 ? "minor gaps" : "questionable",
    components: { correctness: score, completeness: score, risk: 100 },
    exitCode: 0,
    criticalFlags: 0,
    flagCount: 0,
    flagged: false,
    engine: "off",
    verdicts: { verified: 3, partial: 1, noEvidence: 1, contradicted: 0 },
    report: `o-r/${tag}.html`,
    ...over,
  };
}

function state(history: CheckedRelease[], promises?: PromiseCheck[]): RepoState {
  return {
    lastPublishedAt: history.at(-1)?.publishedAt ?? null,
    lastTag: history.at(-1)?.tag ?? null,
    latest: history.at(-1),
    history,
    ...(promises ? { promises } : {}),
  };
}

test("every recorded check renders as a dot linking to its own report", () => {
  const history = [check("v1", 90), check("v2", 70), check("v3", 40)];
  const html = toRepoDetailHtml(ENTRY, state(history), scoreBaseline(history), "t");
  for (const h of history) assert.ok(html.includes(`href="../${h.report}"`), h.tag);
  assert.equal(html.match(/class="pt"/g)?.length, 3);
  assert.ok(html.includes("<polyline"), "two or more checks draw the series line");
});

test("a single check renders its dot but no line", () => {
  const history = [check("v1", 90)];
  const html = toRepoDetailHtml(ENTRY, state(history), null, "t");
  assert.equal(html.match(/class="pt"/g)?.length, 1);
  assert.ok(!html.includes("<polyline"));
});

test("the median reference line follows the level the caller computed", () => {
  const history = [check("v1", 90), check("v2", 88), check("v3", 92)];
  const withLevel = toRepoDetailHtml(ENTRY, state(history), scoreBaseline(history), "t");
  assert.ok(withLevel.includes('class="median"'));
  assert.ok(withLevel.includes("median 90"));
  const two = history.slice(0, 2);
  const without = toRepoDetailHtml(ENTRY, state(two), scoreBaseline(two), "t");
  assert.ok(!without.includes('class="median"'), "below three checks there is no level to draw");
});

test("flagged checks wear the ring, unverified scores their own color", () => {
  const history = [
    check("v1", 80),
    check("v2", 30, { flagged: true, criticalFlags: 1 }),
    check("v3", 65, { scoreLabel: "unverified" }),
  ];
  const html = toRepoDetailHtml(ENTRY, state(history), scoreBaseline(history), "t");
  assert.equal(html.match(/class="flag-ring"/g)?.length, 1);
  assert.ok(html.includes('fill="#8250df"'), "unverified dot keeps its own bucket");
  assert.equal(scoreClass(65, "unverified"), "unverified");
  assert.equal(scoreClass(65, "minor gaps"), "mid");
});

test("verdict bars name tag and count per segment, no-evidence spelled out", () => {
  const history = [
    check("v1", 90, { verdicts: { verified: 2, partial: 0, noEvidence: 4, contradicted: 1 } }),
  ];
  const html = toRepoDetailHtml(ENTRY, state(history), null, "t");
  assert.ok(html.includes("<title>v1: 2 verified</title>"));
  assert.ok(html.includes("<title>v1: 4 no-evidence</title>"));
  assert.ok(html.includes("<title>v1: 1 contradicted</title>"));
  assert.ok(!html.includes("0 partial"), "empty segments are not drawn");
});

test("the releases table lists newest first with flags and notices", () => {
  const history = [
    check("v1", 90),
    check("v2", 45, {
      flagged: true,
      criticalFlags: 2,
      flagCount: 3,
      warnings: ["diff truncated"],
      brokenPromises: 1,
    }),
  ];
  const html = toRepoDetailHtml(ENTRY, state(history), null, "t");
  const v1 = html.indexOf("../o-r/v1.html");
  const v2 = html.indexOf("../o-r/v2.html");
  assert.ok(v2 !== -1 && v1 !== -1);
  assert.ok(html.lastIndexOf("../o-r/v2.html") > v1, "newest release is a table row too");
  assert.ok(html.includes("<b>2 critical</b> / 3"));
  assert.ok(html.includes("partial data"));
  assert.ok(html.includes("1 broken promise"));
});

test("the promise ledger shows the carry countdown toward stale", () => {
  const promises: PromiseCheck[] = [
    {
      text: "legacy API will be removed",
      from: "v1",
      kind: "removal",
      target: "v9",
      status: "still-open",
      carriedFor: 7,
      files: [],
      note: "no matching deletion in this diff",
    },
    {
      text: "old flag removed",
      from: "v0",
      kind: "removal",
      status: "broken",
      files: [],
      note: "target release reached without the removal",
    },
  ];
  const html = toRepoDetailHtml(ENTRY, state([check("v3", 80)]), null, "t");
  assert.ok(!html.includes("Promise ledger"), "no section without promises");
  const withLedger = toRepoDetailHtml(ENTRY, state([check("v3", 80)], promises), null, "t");
  assert.ok(withLedger.includes(`carry 7/${STALE_AFTER} until stale`));
  assert.ok(withLedger.includes(">broken</span>"));
  assert.ok(withLedger.includes("target: v9"));
});

test("hostile tags, notes and paths stay text everywhere on the page", () => {
  const HOSTILE = `v1"><img/src=x/onerror=alert(1)>`;
  const promises: PromiseCheck[] = [
    {
      text: `<script>alert(2)</script>`,
      from: HOSTILE,
      kind: "addition",
      status: "still-open",
      carriedFor: 1,
      files: ["a.ts"],
      note: `note "><img/src=y>`,
    },
  ];
  const history = [check(HOSTILE, 50, { report: `o-r/${HOSTILE}.html` }), check("v2", 60)];
  const html = toRepoDetailHtml(
    { key: "o/r", repo: HOSTILE, url: `https://forge.example/"><img/src=z>` },
    state(history, promises),
    null,
    "t",
  );
  assert.ok(!html.includes("<img"), "no payload became an element");
  assert.ok(!html.includes("<script>alert"), "promise text stays text");
});

test("the page links back to the index and out to the repo", () => {
  const html = toRepoDetailHtml(
    { key: "o/r", repo: "o/r" },
    state([check("v1", 90)]),
    null,
    "t",
  );
  assert.ok(html.includes('href="../index.html"'));
  assert.ok(html.includes('href="https://github.com/o/r"'));
  const forge = toRepoDetailHtml(
    { key: "fx", repo: "o/r", url: "https://forge.example/o/r" },
    state([check("v1", 90)]),
    null,
    "t",
  );
  assert.ok(forge.includes('href="https://forge.example/o/r"'));
  assert.ok(!forge.includes("github.com/o/r"), "a forge entry never points at GitHub");
});
