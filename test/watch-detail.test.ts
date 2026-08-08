// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isBotAuthor,
  reportDirOf,
  reportNavFor,
  toRepoDetailHtml,
} from "../src/watch-detail.ts";
import { scoreClass } from "../src/theme.ts";
import { STALE_AFTER } from "../src/promises.ts";
import {
  RULE_STALE_MIN,
  scoreBaseline,
  type CheckedRelease,
  type RepoState,
  type WatchRule,
  type WatchedEntry,
} from "../src/watch-state.ts";
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

// The fallback reads milder than the judge would, so an outage produces a run
// of ordinary — slightly generous — scores. Nothing else on the page can show
// that: the chart draws a perfectly healthy series.
test("a repo judged without a judge says so, on the page and per release", () => {
  const outage = [
    check("v1", 90),
    check("v2", 91, { unjudged: 3 }),
    check("v3", 92, { unjudged: 2 }),
    check("v4", 93, { unjudged: 1 }),
  ].map((h, i) => ({ ...h, checkedAt: `2026-07-0${i + 1}T00:00:00Z` }));
  const html = toRepoDetailHtml(ENTRY, state(outage), scoreBaseline(outage), "t");
  assert.match(html, /3 checks in a row were judged without a judge/, "the streak is the banner");
  assert.match(html, /since v2/, "…and it says where the silence started");
  assert.match(html, /3 unjudged/, "each affected release carries its own count");

  // The judge answering again ends it — a banner that outlives the outage is
  // an alarm nobody can clear.
  const recovered = [...outage, { ...check("v5", 94), checkedAt: "2026-07-05T00:00:00Z" }];
  assert.doesNotMatch(
    toRepoDetailHtml(ENTRY, state(recovered), scoreBaseline(recovered), "t"),
    /checks in a row were judged without a judge/,
  );

  // A repo with a working judge says nothing at all.
  const healthy = [check("v1", 90), check("v2", 91), check("v3", 92)];
  const clean = toRepoDetailHtml(ENTRY, state(healthy), scoreBaseline(healthy), "t");
  assert.doesNotMatch(clean, /unjudged/);
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

test("the releases table links each release to its forge, like the dashboard does", () => {
  const history = [
    check("v1", 90, { releaseUrl: "https://forge.example/o/r/releases/tag/v1" }),
    check("v2", 80),
  ];
  const html = toRepoDetailHtml(ENTRY, state(history), null, "t");
  assert.ok(
    html.includes('href="https://forge.example/o/r/releases/tag/v1"'),
    "the stored release URL is rendered",
  );
  // A check recorded before the URL was stored simply has no arrow — the row
  // still lists the release and links its report.
  assert.equal(html.match(/class="ext"/g)?.length, 1);
  assert.ok(html.includes("../o-r/v2.html"), "the report link is untouched");
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

test("reportDirOf keeps a legacy nested layout and rejects escape attempts", () => {
  assert.equal(reportDirOf({ latest: { report: "o-r/v1.html" } }, "o/r"), "o-r");
  assert.equal(
    reportDirOf({ latest: { report: "zen-browser/desktop/1.21.9b.html" } }, "zen-browser/desktop"),
    "zen-browser/desktop",
  );
  assert.equal(reportDirOf({ latest: { report: "../evil/v1.html" } }, "o/r"), "o_r");
  assert.equal(reportDirOf({}, "o/r"), "o_r");
});

test("a report's nav points at its own history page and the dashboard", () => {
  const nav = reportNavFor("/r", "/r/o_r", { latest: { report: "o_r/v1.html" } }, "o/r");
  assert.equal(nav.historyHref, "index.html", "the history page is the report's sibling");
  assert.equal(nav.indexHref, "../index.html");
});

test("a report's nav finds a history page the legacy layout left elsewhere", () => {
  // The state was written nested, so the history page stays there while a new
  // report lands in the sanitized directory — siblings they are not.
  const nav = reportNavFor(
    "/r",
    "/r/zen-browser_desktop",
    { latest: { report: "zen-browser/desktop/v1.html" } },
    "zen-browser/desktop",
  );
  assert.equal(nav.historyHref, "../zen-browser/desktop/index.html");
  assert.equal(nav.indexHref, "../index.html");
});

test("a legacy nested layout climbs the right number of levels", () => {
  const history = [
    check("v1", 80, { report: "zen-browser/desktop/v1.html" }),
    check("v2", 70, { report: "zen-browser/desktop/v2.html" }),
  ];
  const html = toRepoDetailHtml(
    { key: "zen-browser/desktop", repo: "zen-browser/desktop" },
    state(history),
    null,
    "t",
  );
  assert.ok(html.includes('href="../../index.html"'), "back link climbs two levels");
  assert.ok(html.includes('href="../../zen-browser/desktop/v2.html"'), "report links climb too");
});

test("the authors section states ledger facts, bot chip and attribution changes", () => {
  const rs: RepoState = {
    ...state([check("v3", 80, { authors: { total: 3, new: 1, top1Share: 0.62 } })]),
    authors: [
      {
        key: "r@x", name: "renovate[bot]", logins: ["renovate[bot]"],
        firstSeen: "v1", lastSeen: "v3", releases: 3, commits: 12,
        sensitiveCommits: 9, binaryCommits: 0,
      },
      {
        key: "j@x", name: `Jia<img src=x>`, logins: ["jiat75", null],
        firstSeen: "v2", lastSeen: "v3", releases: 2, commits: 40,
        sensitiveCommits: 2, binaryCommits: 1,
      },
      {
        key: "s@x", name: "Solo", firstSeen: "v1", lastSeen: "v1",
        releases: 1, commits: 1, sensitiveCommits: 0, binaryCommits: 0,
      },
    ],
  };
  const html = toRepoDetailHtml(ENTRY, rs, null, "t");
  assert.ok(html.includes("Authors"));
  assert.equal(html.match(/class="bot"/g)?.length, 1, "only the bot wears the chip");
  assert.ok(html.includes("@jiat75, no account"), "attribution history is listed");
  assert.ok(html.includes("attribution changed across releases"));
  assert.ok(!html.includes("<img"), "hostile author names stay text");
  assert.ok(html.indexOf("Jia") < html.indexOf("renovate[bot]"), "busiest identity first");
  assert.ok(html.includes("not a trust rating"), "the neutral framing is on the page");
  // Release rows carry the per-release author facts.
  assert.ok(html.includes("1 new"));
  assert.ok(html.includes("62% of this release"));
  // No ledger, no section.
  assert.ok(!toRepoDetailHtml(ENTRY, state([check("v1", 90)]), null, "t").includes(">Authors<"));
});

test("isBotAuthor stays narrow: word-bounded, known bots, no human false positives", () => {
  assert.equal(isBotAuthor("dependabot[bot]"), true);
  assert.equal(isBotAuthor("renovate"), true);
  assert.equal(isBotAuthor("cool-bot"), true);
  assert.equal(isBotAuthor("Some Human", ["github-actions"]), true);
  assert.equal(isBotAuthor("Botond"), false);
  assert.equal(isBotAuthor("Abbot"), false);
  assert.equal(isBotAuthor("Jia Tan"), false);
});

test("an evicted-ledger page qualifies its first-appearance counts", () => {
  const base: RepoState = {
    ...state([check("v3", 80)]),
    authors: [
      {
        key: "a@x", name: "A", firstSeen: "v1", lastSeen: "v3",
        releases: 3, commits: 5, sensitiveCommits: 0, binaryCommits: 0,
      },
    ],
  };
  const clean = toRepoDetailHtml(ENTRY, base, null, "t");
  assert.ok(!clean.includes("an upper bound"), "no qualifier while the ledger is complete");
  const evicted = toRepoDetailHtml(ENTRY, { ...base, authorsEvicted: true }, null, "t");
  assert.ok(evicted.includes("identities have been evicted"));
  assert.ok(evicted.includes("an upper bound"));
});

test("history page lists skipped releases, with the error escaped", () => {
  const rs = state([check("v1", 95)]);
  rs.skipped = [
    {
      tag: "v2<script>",
      publishedAt: "2026-07-10T00:00:00Z",
      attempts: 3,
      lastError: 'No claims found <img src=x onerror="alert(1)">',
      skippedAt: "2026-07-12T00:00:00Z",
    },
  ];
  const html = toRepoDetailHtml(ENTRY, rs, null, "2026-07-28T00:00:00Z");
  assert.ok(html.includes("Unchecked releases"), "section renders");
  assert.ok(html.includes("v2&lt;script&gt;"), "tag escaped");
  assert.ok(html.includes("No claims found &lt;img"), "error escaped");
  assert.ok(!html.includes("<img src=x"), "no raw payload");
  assert.ok(html.includes("2026-07-10"), "published date shown");
});

test("history page omits the skipped section when nothing was skipped", () => {
  const html = toRepoDetailHtml(ENTRY, state([check("v1", 95)]), null, "2026-07-28T00:00:00Z");
  assert.ok(!html.includes("Unchecked releases"));
});

test("a backfilled check in the releases table says it never alerted", () => {
  const history = [
    check("v1", 45, { flagged: true, backfilled: true }),
    check("v2", 90),
  ];
  const html = toRepoDetailHtml(ENTRY, state(history), null, "t");
  assert.ok(html.includes("flagged on record, never alerted"));
  const clean = toRepoDetailHtml(ENTRY, state([check("v2", 90)]), null, "t");
  assert.ok(!clean.includes("backfilled"), "live-only histories carry no qualifier");
});

test("the history page footer states what scores measure", () => {
  const html = toRepoDetailHtml(ENTRY, state([check("v1", 45)]), null, "2026-07-28T00:00:00Z");
  assert.ok(html.includes("not project quality, and never people"));
});

// The index says a rule fired; this page is where the operator finds out
// what fired it. Matched entries are release-authored — paths, hosts,
// finding sentences — so they are untrusted text, and a judge-based hit has
// to admit what it rests on.
test("the history page shows what moved a rule, escaped, and marks the judge-based hit", () => {
  const history = [
    check("v1", 90, {
      ruleHits: [
        { rule: "schema", matched: ["migration: db/<img src=x>.sql"], judgeBased: false },
        { rule: "sec", matched: ["finding: security — auth moved"], judgeBased: true },
      ],
    }),
    check("v2", 90, { ruleHits: [] }),
  ];
  const entry: WatchedEntry = {
    ...ENTRY,
    rules: [
      { name: "schema", surface: ["migrations"] },
      { name: "sec", findingKinds: ["security"] },
    ],
  };
  const html = toRepoDetailHtml(entry, state(history), null, "t");
  assert.match(html, /Watch rules/);
  assert.match(html, /db\/&lt;img src=x&gt;\.sql/, "a matched path is escaped");
  assert.doesNotMatch(html, /<img src=x/, "no raw payload");
  assert.match(html, /judge-based/, "the finding-kind hit says what it rests on");
  assert.equal(html.match(/judge-based/g)?.length, 1, "…and the deterministic one does not");

  // A repo with no rules and no hits keeps the page it had.
  assert.doesNotMatch(toRepoDetailHtml(ENTRY, state([check("v1", 90)]), null, "t"), /Watch rules/);
});

test("a rule silent across every check on record is reported as possibly stale", () => {
  const rules: WatchRule[] = [
    { name: "auth", paths: ["src/auth"] },
    { name: "schema", surface: ["migrations"] },
  ];
  const entry: WatchedEntry = { ...ENTRY, rules };
  const silent = Array.from({ length: RULE_STALE_MIN }, (_, i) =>
    check(`v${i}`, 90, { ruleHits: [] }),
  );
  const html = toRepoDetailHtml(entry, state(silent), null, "t");
  assert.match(html, /silent across every check on record: auth, schema/);
  assert.match(html, /may have moved out from under it/);

  // One hit clears that rule, and nine checks are not yet a silence.
  const withHit = [
    ...silent.slice(1),
    check("vx", 90, { ruleHits: [{ rule: "auth", matched: ["src/auth/a.go"], judgeBased: false }] }),
  ];
  assert.match(
    toRepoDetailHtml(entry, state(withHit), null, "t"),
    /silent across every check on record: schema\./,
  );
  assert.doesNotMatch(
    toRepoDetailHtml(entry, state(silent.slice(1)), null, "t"),
    /silent across every check/,
  );
});
