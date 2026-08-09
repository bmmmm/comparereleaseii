// SPDX-License-Identifier: GPL-3.0-or-later
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import {
  configuredEntries,
  nothingNewMessage,
  runWatch,
  runBackfill,
  sanitizeTag,
  validateWatchConfig,
  writeReportFiles,
  announceBackfill,
  checkAndRecord,
  type BackfillPlan,
  type CheckOutcome,
} from "../src/watch.ts";
import { computeScores } from "../src/metrics.ts";
import { toWatchIndexHtml, toWatchAtomFeed } from "../src/watch-index.ts";
import { runNotify } from "../src/util.ts";
import {
  countSkipped,
  pickNewReleases,
  pickBackfillReleases,
  isFlagged,
  hasDrifted,
  hasSoftened,
  alertDecision,
  judgeSofteningStreak,
  releaseWebUrl,
  scoreBaseline,
  baselineLevel,
  worstExit,
  carriedFromLedger,
  capLedger,
  updateAuthorLedger,
  recordChecked,
  recordCheckFailure,
  recordSkip,
  evaluateRules,
  matchesPathGlob,
  staleRules,
  BASELINE_WINDOW,
  DRIFT_WINDOW,
  MAX_AUTHOR_LEDGER,
  MAX_CHECK_ATTEMPTS,
  MAX_PROMISE_LEDGER,
  MAX_RULE_MATCHES,
  RULE_STALE_MIN,
  type ReleaseInfo,
  type WatchState,
  type CheckedRelease,
  type RepoState,
  type WatchRule,
  type WatchRepoConfig,
} from "../src/watch-state.ts";
import type { ClaimResult, Finding, PromiseCheck, ReleaseSurface, Report, Verdict } from "../src/types.ts";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

function rel(tag: string, publishedAt: string, extra: Partial<ReleaseInfo> = {}): ReleaseInfo {
  return { tag, publishedAt, prerelease: false, draft: false, ...extra };
}

test("pickNewReleases: first run checks only the latest release", () => {
  const releases = [
    rel("v3", "2026-07-20T00:00:00Z"),
    rel("v2", "2026-06-01T00:00:00Z"),
    rel("v1", "2026-05-01T00:00:00Z"),
  ];
  assert.deepEqual(
    pickNewReleases(releases, null).map((r) => r.tag),
    ["v3"],
  );
});

test("pickNewReleases: newer releases come oldest-first, capped to the newest", () => {
  const releases = [
    rel("v5", "2026-07-25T00:00:00Z"),
    rel("v4", "2026-07-20T00:00:00Z"),
    rel("v3", "2026-07-10T00:00:00Z"),
    rel("v2", "2026-06-01T00:00:00Z"),
  ];
  assert.deepEqual(
    pickNewReleases(releases, "2026-06-15T00:00:00Z").map((r) => r.tag),
    ["v3", "v4", "v5"],
  );
  assert.deepEqual(
    pickNewReleases(releases, "2026-06-15T00:00:00Z", { cap: 2 }).map((r) => r.tag),
    ["v4", "v5"],
  );
});

test("pickNewReleases: drafts and prereleases are skipped unless opted in", () => {
  const releases = [
    rel("v2-rc1", "2026-07-25T00:00:00Z", { prerelease: true }),
    rel("v2-draft", "2026-07-26T00:00:00Z", { draft: true }),
    rel("v1", "2026-07-01T00:00:00Z"),
  ];
  assert.deepEqual(pickNewReleases(releases, null).map((r) => r.tag), ["v1"]);
  assert.deepEqual(
    pickNewReleases(releases, null, { includePrerelease: true }).map((r) => r.tag),
    ["v2-rc1"],
  );
  assert.deepEqual(pickNewReleases(releases, "2026-07-30T00:00:00Z"), []);
});

test("pickNewReleases: tagPattern keeps non-matching tags out entirely", () => {
  const releases = [
    rel("nightly-20260802", "2026-08-02T00:00:00Z"),
    rel("v1.4.0", "2026-07-20T00:00:00Z"),
    rel("nightly-20260710", "2026-07-10T00:00:00Z"),
    rel("v1.3.0", "2026-06-01T00:00:00Z"),
  ];
  // First run: the newest MATCHING release, not the newest tag.
  assert.deepEqual(
    pickNewReleases(releases, null, { tagPattern: "^v\\d" }).map((r) => r.tag),
    ["v1.4.0"],
  );
  // Cursor past the last matching release: a new nightly alone is no news.
  assert.deepEqual(pickNewReleases(releases, "2026-07-25T00:00:00Z", { tagPattern: "^v\\d" }), []);
  // null (the defaults opt-out) behaves like no pattern at all.
  assert.deepEqual(
    pickNewReleases(releases, null, { tagPattern: null }).map((r) => r.tag),
    ["nightly-20260802"],
  );
  // countSkipped counts only what would have been checked.
  assert.equal(countSkipped(releases, "2026-05-01T00:00:00Z", { tagPattern: "^v\\d", cap: 1 }), 1);
  assert.equal(countSkipped(releases, "2026-05-01T00:00:00Z", { cap: 1 }), 3);
});

// A typo'd tagPattern looks exactly like a quiet repo — nothing matches,
// nothing is new — and a watch run that prints "up to date" for both leaves the
// mistake running for weeks. Telling them apart is the only reason this line
// exists, and nothing pinned it: the diagnosis could have been deleted whole
// and every test still passed.
test("a tagPattern that matches nothing says so instead of 'up to date'", () => {
  const releases = [rel("2026.2", "2026-02-01T00:00:00Z"), rel("2026.1", "2026-01-01T00:00:00Z")];

  const typo = nothingNewMessage("o/r", { repo: "o/r", tagPattern: "^v\\d" }, releases, null);
  assert.match(typo, /no release tag matches tagPattern/);
  assert.ok(typo.includes(JSON.stringify("^v\\d")), `the pattern itself must be quoted back: ${typo}`);

  // A pattern that does match, with nothing newer than the cursor: really up to date.
  assert.match(
    nothingNewMessage("o/r", { repo: "o/r", tagPattern: "^20" }, releases, "2026.2"),
    /up to date \(2026\.2\)/,
  );
  // No pattern, no releases — a repo that has never published is not a typo.
  assert.match(nothingNewMessage("o/r", { repo: "o/r" }, [], null), /up to date \(no releases\)/);
  // A pattern is only suspect when there is something for it to have matched.
  assert.match(
    nothingNewMessage("o/r", { repo: "o/r", tagPattern: "^v\\d" }, [], null),
    /up to date \(no releases\)/,
  );
});

test("pickBackfillReleases: tagPattern scopes the backfill the same way", () => {
  const releases = [
    rel("nightly-20260802", "2026-08-02T00:00:00Z"),
    rel("v1.4.0", "2026-07-20T00:00:00Z"),
    rel("v1.3.0", "2026-06-01T00:00:00Z"),
    rel("v1.2.0", "2026-05-01T00:00:00Z"),
  ];
  const fresh: RepoState = { lastPublishedAt: null, lastTag: null, history: [] };
  assert.deepEqual(
    pickBackfillReleases(releases, fresh, { releases: 2, tagPattern: "^v\\d" }).map((r) => r.tag),
    ["v1.3.0", "v1.4.0"],
  );
});

test("validateWatchConfig rejects an invalid tagPattern with the entry named", () => {
  assert.throws(
    () =>
      validateWatchConfig({
        repos: [{ repo: "owner/name", tagPattern: "([" }],
      }),
    /tagPattern.*owner\/name.*not a valid regular expression/s,
  );
  assert.throws(
    () =>
      validateWatchConfig({
        repos: [{ repo: "owner/name" }],
        defaults: { tagPattern: "(" },
      }),
    /tagPattern.*defaults/s,
  );
  // A valid pattern passes; null is the explicit per-entry opt-out.
  validateWatchConfig({ repos: [{ repo: "owner/name", tagPattern: "^v\\d" }] });
  validateWatchConfig({
    repos: [{ repo: "owner/name", tagPattern: null }],
    defaults: { tagPattern: "^v" },
  });
  // Any other non-string would stringify into a regex that matches nothing.
  assert.throws(
    () => validateWatchConfig({ repos: [{ repo: "owner/name", tagPattern: 5 as never }] }),
    /tagPattern.*must be a string or null/s,
  );
});

test("validateWatchConfig holds minCoverage to the CLI's 0–100 rule", () => {
  validateWatchConfig({ repos: [{ repo: "owner/name", minCoverage: 60 }] });
  for (const bad of [150, -1, 6.5, "60" as never]) {
    assert.throws(
      () => validateWatchConfig({ repos: [{ repo: "owner/name", minCoverage: bad }] }),
      /minCoverage.*0–100/s,
      `accepted ${JSON.stringify(bad)}`,
    );
  }
});

test("isFlagged: exit code, critical flags, or a score below threshold", () => {
  assert.equal(isFlagged(95, 0, 0), false);
  assert.equal(isFlagged(95, 1, 0), true);
  assert.equal(isFlagged(95, 0, 2), true);
  assert.equal(isFlagged(60, 0, 0), true);
  assert.equal(isFlagged(60, 0, 0, 50), false);
});

test("worstExit takes the maximum, empty batch passes", () => {
  assert.equal(worstExit([]), 0);
  assert.equal(worstExit([0, 0]), 0);
  assert.equal(worstExit([0, 1, 0]), 1);
  assert.equal(worstExit([1, 2, 0]), 2);
});

function checked(tag: string, score: number, flagged: boolean): CheckedRelease {
  return {
    tag,
    publishedAt: "2026-07-20T00:00:00Z",
    checkedAt: "2026-07-26T00:00:00Z",
    score,
    scoreLabel: score >= 85 ? "solid" : score >= 65 ? "minor gaps" : "suspicious",
    exitCode: flagged ? 1 : 0,
    criticalFlags: 0,
    flagCount: 0,
    flagged,
    engine: "test",
    verdicts: { verified: 1, partial: 0, noEvidence: 0, contradicted: 0 },
    report: `x/${tag}.html`,
  };
}

test("toWatchIndexHtml distinguishes an unverifiable release from a score collapse", () => {
  const fork = checked("v2", 72, false);
  fork.unverifiable = "out-of-repo";
  const state: WatchState = {
    version: 1,
    repos: {
      "fork/repo": {
        lastPublishedAt: "2026-07-20T00:00:00Z",
        lastTag: "v2",
        latest: fork,
        history: [fork],
      },
      // Same ballpark score, but its claims WERE checkable — no badge.
      "normal/repo": {
        lastPublishedAt: "2026-07-20T00:00:00Z",
        lastTag: "v1",
        latest: checked("v1", 72, false),
        history: [checked("v1", 72, false)],
      },
    },
  };
  const html = toWatchIndexHtml(state, "2026-07-26T00:00:00Z");
  assert.ok(html.includes("out of repo"), "badge names the shape");
  // Apostrophes are escaped now — an attribute value must not be closable.
  assert.ok(html.includes("not in this repo&#39;s own diff"), "title explains it");
  assert.equal(html.match(/class="tag"/g)?.length, 1, "only the fork row is tagged");
});

test("toWatchIndexHtml marks a score the check could not fully see", () => {
  // Measured on bitwarden/clients cli-v2026.7.0: the compare API truncated
  // the diff, the clone fallback failed, and 18 % of the diff scored 45 where
  // the whole diff scores 85. The report said so; the index did not.
  const partial = checked("v2", 45, true);
  partial.warnings = [
    "Compare API caps file lists at 300 — diff may be incomplete, use a local clone (--local) for full coverage.",
    "Partial-clone fallback failed: git clone --quiet --filter=blob:none… failed",
  ];
  const state: WatchState = {
    version: 1,
    repos: {
      "big/repo": {
        lastPublishedAt: "2026-07-20T00:00:00Z",
        lastTag: "v2",
        latest: partial,
        history: [partial],
      },
      "small/repo": {
        lastPublishedAt: "2026-07-20T00:00:00Z",
        lastTag: "v1",
        latest: checked("v1", 45, true),
        history: [checked("v1", 45, true)],
      },
    },
  };
  const html = toWatchIndexHtml(state, "2026-07-26T00:00:00Z");
  assert.equal(html.match(/class="incomplete"/g)?.length, 1, "only the truncated row is marked");
  assert.ok(html.includes("partial data"), "the badge says what is wrong");
  assert.ok(html.includes("Partial-clone fallback failed"), "the title carries the reason");
});

// The dashboard's whole job is "which repo needs a look today", and a repo
// whose judge stopped answering looks better than one whose judge works —
// the deterministic fallback is the milder reading. Without the mark, the
// row that most needs a look is the one that looks fine.
test("toWatchIndexHtml marks a repo whose judge stopped answering, and the feed says which claims fell back", () => {
  const silent = [1, 2, 3].map((i) => {
    const h = checked(`v${i}`, 90, false);
    h.checkedAt = `2026-07-2${i}T00:00:00Z`;
    h.unjudged = 4;
    return h;
  });
  const working = checked("w1", 90, false);
  const state: WatchState = {
    version: 1,
    repos: {
      "silent/repo": {
        lastPublishedAt: "2026-07-20T00:00:00Z",
        lastTag: "v3",
        latest: silent[2],
        history: silent,
      },
      "working/repo": {
        lastPublishedAt: "2026-07-20T00:00:00Z",
        lastTag: "w1",
        latest: working,
        history: [working],
      },
    },
  };
  const html = toWatchIndexHtml(state, "2026-07-26T00:00:00Z");
  assert.equal(html.match(/class="incomplete"/g)?.length, 1, "only the silent repo is marked");
  assert.ok(html.includes("3 checks unjudged"), "the badge counts the streak");

  const feed = toWatchAtomFeed(state, "2026-07-26T00:00:00Z");
  assert.match(
    feed,
    /4 claim\(s\) judged by the deterministic fallback/,
    "a feed reader told only the score is told the flattering half",
  );

  // Two outages are not a streak — the bar is three, and a repo that had one
  // bad night must not carry an alarm.
  const twice = silent.slice(0, 2);
  const short: WatchState = {
    version: 1,
    repos: {
      "silent/repo": {
        lastPublishedAt: "2026-07-20T00:00:00Z",
        lastTag: "v2",
        latest: twice[1],
        history: twice,
      },
    },
  };
  assert.doesNotMatch(toWatchIndexHtml(short, "t"), /checks unjudged/);
});

test("toWatchIndexHtml gives an unverified score its own bucket, not the same as a genuine mid score", () => {
  const capped = checked("v2", 65, false);
  capped.scoreLabel = "unverified";
  capped.unverifiable = "sourceless";
  const state: WatchState = {
    version: 1,
    repos: {
      "sourceless/repo": {
        lastPublishedAt: "2026-07-20T00:00:00Z",
        lastTag: "v2",
        latest: capped,
        history: [capped],
      },
      // Same numeric range, but genuinely scored — different bucket.
      "normal/repo": {
        lastPublishedAt: "2026-07-20T00:00:00Z",
        lastTag: "v1",
        latest: checked("v1", 70, false),
        history: [checked("v1", 70, false)],
      },
    },
  };
  const html = toWatchIndexHtml(state, "2026-07-26T00:00:00Z");
  assert.ok(html.includes('class="score unverified"'), "capped score gets its own class");
  assert.ok(html.includes('class="score mid"'), "genuinely-scored release keeps the numeric bucket");
});

test("toWatchIndexHtml marks flagged repos red and sorts them first", () => {
  const state: WatchState = {
    version: 1,
    repos: {
      "good/repo": {
        lastPublishedAt: "2026-07-20T00:00:00Z",
        lastTag: "v1",
        latest: checked("v1", 95, false),
        history: [checked("v1", 95, false)],
      },
      "bad/repo": {
        lastPublishedAt: "2026-07-20T00:00:00Z",
        lastTag: "v9",
        latest: checked("v9", 5, true),
        history: [checked("v9", 5, true)],
      },
    },
  };
  const html = toWatchIndexHtml(state, "2026-07-26T00:00:00Z");
  assert.ok(html.includes('class="flagged"'));
  assert.ok(html.includes("bad/repo"));
  const badIdx = html.indexOf("bad/repo");
  const goodIdx = html.indexOf("good/repo");
  assert.ok(badIdx < goodIdx, "flagged repo sorts first");
  assert.ok(html.includes('href="x/v9.html"'));
  assert.ok(html.includes('<div class="n">2</div><div class="t">repos watched</div>'));
  assert.ok(html.includes('<div class="n">1</div><div class="t">flagged</div>'));
});

test("toWatchIndexHtml: rows link the report, repo names their history, the forge one ↗", () => {
  const state: WatchState = {
    version: 1,
    repos: {
      "good/repo": {
        lastPublishedAt: "2026-07-20T00:00:00Z",
        lastTag: "v1",
        latest: { ...checked("v1", 95, false), components: { correctness: 94, completeness: null, risk: 70 } },
        history: [checked("v1", 95, false)],
      },
    },
  };
  const html = toWatchIndexHtml(state, "2026-07-26T00:00:00Z", [
    { key: "good/repo", repo: "good/repo" },
  ]);
  assert.ok(html.includes('data-href="x/v1.html"'), "row carries the report link");
  // The repo name is the internal drilldown; the forge is the small ↗ after
  // it — the same pattern the release column uses.
  assert.ok(
    html.includes('<a class="repo" href="x/index.html"'),
    "repo name opens the repo's history page",
  );
  assert.ok(
    html.includes('<a class="ext" href="https://github.com/good/repo"'),
    "the ↗ after the name opens the forge",
  );
  assert.ok(
    html.includes('href="https://github.com/good/repo/releases/tag/v1"'),
    "tag links to the GitHub release",
  );
  assert.ok(html.includes("94 · – · 70"), "score components shown, null completeness as dash");
  assert.ok(html.includes("2026-07-20"), "release date shown");
});

test("toWatchIndexHtml: trend needs history — one check renders no dots, two render links", () => {
  const one: WatchState = {
    version: 1,
    repos: {
      "a/x": {
        lastPublishedAt: "2026-07-20T00:00:00Z",
        lastTag: "v1",
        latest: checked("v1", 95, false),
        history: [checked("v1", 95, false)],
      },
    },
  };
  // The distribution legend also uses dot spans, so the discriminating
  // signal for "no trend" is the report-linked dot, not the dot class.
  assert.ok(!toWatchIndexHtml(one, "t").includes('title="v1: 95"'), "single check: no trend dots");
  const two: WatchState = {
    version: 1,
    repos: {
      "a/x": {
        lastPublishedAt: "2026-07-20T00:00:00Z",
        lastTag: "v2",
        latest: checked("v2", 80, false),
        history: [checked("v1", 95, false), checked("v2", 80, false)],
      },
    },
  };
  const html = toWatchIndexHtml(two, "t");
  assert.ok(html.includes('<a href="x/v1.html" title="v1: 95">'), "dots link to past reports");
});

test("toWatchIndexHtml: configured repos without a check yet get a pending row", () => {
  const state: WatchState = { version: 1, repos: {} };
  const html = toWatchIndexHtml(state, "2026-07-26T00:00:00Z", [
    { key: "fresh/repo", repo: "fresh/repo" },
  ]);
  assert.ok(html.includes("waiting for the first release check"));
  assert.ok(html.includes("fresh/repo"));
  // No history page exists yet — the waiting row's name keeps the forge link.
  assert.ok(
    html.includes('<a class="repo" href="https://github.com/fresh/repo"'),
    "a waiting repo's name links to its forge",
  );
  assert.ok(html.includes('<div class="n">1</div><div class="t">repos watched</div>'));
  assert.ok(html.includes('<div class="n">0</div><div class="t">flagged</div>'));
});

test("toWatchIndexHtml: state entries dropped from the config are not rendered", () => {
  const state: WatchState = {
    version: 1,
    repos: {
      "gone/repo": {
        lastPublishedAt: "2026-07-20T00:00:00Z",
        lastTag: "v1",
        latest: checked("v1", 95, false),
        history: [],
      },
    },
  };
  const html = toWatchIndexHtml(state, "2026-07-26T00:00:00Z", [
    { key: "kept/repo", repo: "kept/repo" },
  ]);
  assert.ok(!html.includes("gone/repo"));
  assert.ok(html.includes("kept/repo"));
});

function ledgerEntry(status: PromiseCheck["status"], text: string, carriedFor?: number): PromiseCheck {
  return { text, from: "v1.0.0", kind: "removal", status, carriedFor, files: [], note: "" };
}

test("only still-open promises ride to the next check, carry count intact", () => {
  const ledger = [
    ledgerEntry("kept", "shipped"),
    ledgerEntry("still-open", "pending", 4),
    ledgerEntry("broken", "lied"),
    // stale IS the exit — re-carrying it would undo the aging.
    ledgerEntry("stale", "ancient", 10),
  ];
  const carried = carriedFromLedger(ledger);
  assert.deepEqual(carried, [
    { text: "pending", from: "v1.0.0", kind: "removal", target: undefined, carriedFor: 4 },
  ]);
  assert.deepEqual(carriedFromLedger(undefined), []);
});

test("the ledger cap keeps still-open promises over this release's resolved ones", () => {
  // Resolved entries are display-only and discarded next run; a plain
  // head-slice would let them evict the carried promises the ledger exists
  // for. Build a ledger where exactly that would happen.
  const resolved = Array.from({ length: 30 }, (_, i) => ledgerEntry("kept", `kept-${i}`));
  const open = Array.from({ length: 30 }, (_, i) => ledgerEntry("still-open", `open-${i}`, i));
  const capped = capLedger([...resolved, ...open]);
  assert.equal(capped.length, MAX_PROMISE_LEDGER);
  // Every still-open entry survived; the tail resolved ones paid the cap.
  assert.equal(capped.filter((p) => p.status === "still-open").length, 30);
  assert.equal(capped.filter((p) => p.status === "kept").length, MAX_PROMISE_LEDGER - 30);
  // Under the cap nothing is reordered or dropped.
  const small = [ledgerEntry("kept", "a"), ledgerEntry("still-open", "b")];
  assert.deepEqual(capLedger(small), small);
});

test("scoreBaseline needs three checks before it calls a level", () => {
  assert.equal(scoreBaseline([{ score: 90 }, { score: 92 }]), null);
  assert.equal(scoreBaseline([{ score: 90 }, { score: 92 }, { score: 88 }]), 90);
  // Even count: rounded mean of the middle pair.
  assert.equal(scoreBaseline([{ score: 20 }, { score: 30 }, { score: 40 }, { score: 50 }]), 35);
});

test("alerting reads the score against the repo's own level", () => {
  // traefik: 9% churn coverage is its culture. Below the absolute default of
  // 65 on every release — a permanent alarm nobody reads.
  const traefik = [{ score: 25 }, { score: 27 }, { score: 24 }];
  assert.equal(isFlagged(25, 0, 0, 65, scoreBaseline(traefik)), false);
  // Until its baseline forms, the absolute threshold still stands in.
  assert.equal(isFlagged(25, 0, 0, 65, scoreBaseline(traefik.slice(0, 2))), true);
  // And a real collapse still alerts.
  assert.equal(isFlagged(4, 0, 0, 65, scoreBaseline(traefik)), true);

  // A repo normally at 95 dropping to 70 is the alarm no absolute default
  // would catch — 70 sits above notifyBelow.
  const solid = [{ score: 95 }, { score: 97 }, { score: 94 }];
  assert.equal(isFlagged(70, 0, 0, 65, scoreBaseline(solid)), true);
  assert.equal(isFlagged(90, 0, 0, 65, scoreBaseline(solid)), false);

  // Findings about the release itself are never silenced by history.
  assert.equal(isFlagged(25, 1, 0, 65, scoreBaseline(traefik)), true);
  assert.equal(isFlagged(25, 0, 1, 65, scoreBaseline(traefik)), true);
});

test("a repo whose own level slid is flagged, not normalised", () => {
  // The relative alert reads a release against the median of that repo's past
  // checks, and the publisher produces those checks. It fires once on the
  // step down and then the lower level IS the normal it compares against —
  // every release after that is "in line with this repo" again.
  const h = (...scores: number[]) => scores.map((score) => ({ score }));
  const settled = h(90, 88, 91, 89, 70, 68, 71, 69);
  assert.equal(
    isFlagged(69, 0, 0, 65, scoreBaseline(settled.slice(0, -1))),
    false,
    "the release itself sits inside the relative bar",
  );
  assert.equal(hasDrifted(settled), true, "but the level it is measured against moved 20");

  // An honest repo bobbing around its level is not drift.
  assert.equal(hasDrifted(h(90, 86, 92, 88, 91, 87, 90, 89)), false);
  // Nor is an improving one.
  assert.equal(hasDrifted(h(40, 45, 42, 70, 75, 72, 74, 71)), false);
  // Too little history to read a trend.
  assert.equal(hasDrifted(h(90, 50, 40)), false);
});

// 22 of 101 checked releases carried `judge-unavailable`. The fallback is by
// construction the MILDER reading, so an outage does not show up as a dip —
// the scores keep arriving, slightly generous, and every existing signal on
// the page reads them as the repo's level. Only a streak says otherwise.
test("three checks in a row judged without a judge is the finding, not the score", () => {
  const run = (day: number, unjudged?: number) => ({
    checkedAt: `2026-08-${String(day).padStart(2, "0")}T00:00:00Z`,
    ...(unjudged === undefined ? {} : { unjudged }),
  });

  // One outage is an outage; the third consecutive one is the alarm.
  assert.equal(judgeSofteningStreak([run(1), run(2, 4), run(3, 2)]), 2);
  assert.equal(hasSoftened([run(1), run(2, 4), run(3, 2)]), false);
  assert.equal(judgeSofteningStreak([run(1), run(2, 4), run(3, 2), run(4, 1)]), 3);
  assert.equal(hasSoftened([run(1), run(2, 4), run(3, 2), run(4, 1)]), true);

  // One answered check ends the streak — the judge came back.
  assert.equal(hasSoftened([run(1, 3), run(2, 3), run(3, 3), run(4)]), false);

  // `judge: off` is a configured choice, not a silence: no judge was asked,
  // so nothing fell back and there is nothing to alarm about.
  assert.equal(hasSoftened([run(1), run(2), run(3), run(4)]), false);

  // Ordered by when each check RAN. A backfill of old releases interleaves
  // freshly-checked past tags into a release-ordered history; reading that
  // order would let one backfilled entry hide a live outage mid-series.
  const outOfOrder = [run(4, 1), run(1), run(2, 4), run(3, 2)];
  assert.equal(judgeSofteningStreak(outOfOrder), 3, "sorted by check time, not by position");
});

// The three reasons a check reaches the operator used to be assembled inline
// in the run loop, where nothing could reach them: `|| drifted` had no test of
// its own, and neither would `|| softened`.
test("the alert decision: the release, the level under it, and the judge behind it", () => {
  const run = (day: number, unjudged?: number) => ({
    checkedAt: `2026-08-${String(day).padStart(2, "0")}T00:00:00Z`,
    ...(unjudged === undefined ? {} : { unjudged }),
  });
  const level = [{ score: 90 }, { score: 91 }, { score: 89 }];
  const base = { exitCode: 0, criticalFlags: 0, notifyBelow: 65, past: level };

  const quiet = alertDecision({ ...base, score: 90, runs: [run(1), run(2)] });
  assert.deepEqual(quiet, { flagged: false, drifted: false, softeningStreak: 0, scoreLevel: 90 });

  // The release itself.
  assert.equal(alertDecision({ ...base, score: 60, runs: [run(1)] }).flagged, true);
  assert.equal(alertDecision({ ...base, score: 90, exitCode: 1, runs: [run(1)] }).flagged, true);

  // The level sliding under a release that is otherwise inside the bar.
  const sliding = [90, 88, 91, 89, 70, 68, 71].map((score) => ({ score }));
  const slid = alertDecision({ ...base, past: sliding, score: 69, runs: [run(1)] });
  assert.equal(slid.drifted, true);
  assert.equal(slid.flagged, true, "a bar that came down to meet the score still alerts");

  // The judge behind it: a perfectly ordinary score, three runs of silence.
  const softened = alertDecision({
    ...base,
    score: 90,
    runs: [run(1), run(2, 3), run(3, 2), run(4, 1)],
  });
  assert.equal(softened.softeningStreak, 3);
  assert.equal(softened.flagged, true, "an outage must not pass as a good release");
  // Two is not three — the streak is reported only once it IS the finding.
  const short = alertDecision({ ...base, score: 90, runs: [run(1), run(2, 3), run(3, 2)] });
  assert.equal(short.softeningStreak, 0);
  assert.equal(short.flagged, false);
});

test("an exact 20-point drop is the case the constant names", () => {
  assert.equal(isFlagged(71, 0, 0, 65, 91), true);
  assert.equal(isFlagged(72, 0, 0, 65, 91), false);
});

// A rule anchors a DIRECTORY. Matching a prefix of a segment would make
// "src/au" a subscription to src/auth, and matching only whole paths would
// make every anchor a file anchor — the shape the corpus measurement
// rejected (exact paths recur at 22–60 %).
test("a path glob anchors whole segments and everything under them", () => {
  // Bare prefix: the anchor is a directory, not a file.
  assert.equal(matchesPathGlob("src/auth", "src/auth/token.go"), true);
  assert.equal(matchesPathGlob("src/auth", "src/auth"), true);
  assert.equal(matchesPathGlob("src/auth", "src/auth/deep/er/token.go"), true);
  assert.equal(matchesPathGlob("src/auth", "src/authz/token.go"), false, "whole segments");
  assert.equal(matchesPathGlob("src/au", "src/auth/token.go"), false, "not a text prefix");
  assert.equal(matchesPathGlob("auth", "src/auth/token.go"), false, "anchored at the root");

  // ** spans any number of segments, zero included.
  assert.equal(matchesPathGlob("**/auth", "auth/token.go"), true, "zero segments");
  assert.equal(matchesPathGlob("**/auth", "a/b/auth/token.go"), true);
  assert.equal(matchesPathGlob("**/auth", "a/authz/token.go"), false);
  assert.equal(matchesPathGlob("**", "anything/at/all.go"), true);

  // * is exactly one segment.
  assert.equal(matchesPathGlob("services/*/pkg", "services/api/pkg/x.go"), true);
  assert.equal(matchesPathGlob("services/*/pkg", "services/pkg/x.go"), false, "one, not zero");
  assert.equal(matchesPathGlob("services/*/pkg", "services/a/b/pkg/x.go"), false, "one, not two");

  // Spelling noise must not decide a subscription.
  assert.equal(matchesPathGlob("./src/auth/", "src/auth/token.go"), true);
  assert.equal(matchesPathGlob("", "src/auth/token.go"), false, "an empty pattern is not '*'");
});

test("evaluateRules reads each layer, and says which hits rest on the judge", () => {
  const surface: ReleaseSurface = {
    categories: [],
    symbols: [],
    moreSymbols: 0,
    envVars: { added: ["OIDC_ISSUER", "LOG_LEVEL"], removed: [] },
    cliFlags: { added: [], removed: [] },
    configKeys: { added: [], removed: [] },
    hosts: { added: ["api.github.com"], removed: ["old.example.com"] },
    migrations: ["db/migrations/003_users.sql"],
    apiRoutes: ["internal/api/routes.go"],
  };
  const findings: Finding[] = [
    { kind: "security", audience: "everyone", text: "auth check moved", files: ["a.go"], subsystem: "auth" },
    { kind: "feature", audience: "user", text: "new export", files: ["b.go"], subsystem: "cli" },
  ];
  const facts = { files: ["src/auth/token.go", "README.md"], surface, findings };

  const hit = (rule: WatchRule) => evaluateRules([rule], facts);

  assert.deepEqual(hit({ name: "auth", paths: ["src/auth"] }), [
    { rule: "auth", matched: ["src/auth/token.go"], judgeBased: false },
  ]);
  assert.deepEqual(hit({ name: "schema", surface: ["migrations"] }), [
    { rule: "schema", matched: ["migration: db/migrations/003_users.sql"], judgeBased: false },
  ]);
  assert.deepEqual(hit({ name: "api", surface: ["apiRoutes"] }), [
    { rule: "api", matched: ["route: internal/api/routes.go"], judgeBased: false },
  ]);
  assert.deepEqual(hit({ name: "traffic", surface: ["hosts"] }), [
    { rule: "traffic", matched: ["+host api.github.com", "-host old.example.com"], judgeBased: false },
  ]);
  // envVar names ONE variable — the bare layer would fire on every release
  // that touches env vars at all.
  assert.deepEqual(hit({ name: "oidc", surface: ["envVar:OIDC_ISSUER"] }), [
    { rule: "oidc", matched: ["+env OIDC_ISSUER"], judgeBased: false },
  ]);
  assert.deepEqual(hit({ name: "other", surface: ["envVar:DATABASE_URL"] }), []);
  // A finding-kind hit rests on model output and must carry that fact.
  assert.deepEqual(hit({ name: "sec", findingKinds: ["security"] }), [
    { rule: "sec", matched: ["finding: security — auth check moved"], judgeBased: true },
  ]);
  // …but not once a deterministic layer fired for the same rule.
  const both = hit({ name: "sec", paths: ["src/auth"], findingKinds: ["security"] });
  assert.equal(both[0].judgeBased, false);
  assert.deepEqual(both[0].matched, ["finding: security — auth check moved", "src/auth/token.go"]);

  // Nothing configured, nothing matched, nothing recorded.
  assert.deepEqual(evaluateRules([{ name: "quiet", paths: ["docs"] }], facts), []);
  assert.deepEqual(evaluateRules(undefined, facts), []);

  // A surface written before `hosts` existed claims nothing about hosts.
  const older: ReleaseSurface = { ...surface, hosts: undefined };
  assert.deepEqual(evaluateRules([{ name: "traffic", surface: ["hosts"] }], { files: [], surface: older }), []);
});

test("a rule's matched list is deduped, sorted and cut out loud", () => {
  const files = Array.from({ length: MAX_RULE_MATCHES + 3 }, (_, i) =>
    `src/auth/f${String(i).padStart(2, "0")}.go`,
  ).reverse();
  const [hit] = evaluateRules([{ name: "auth", paths: ["src/auth", "src"] }], {
    files: [...files, "src/auth/f00.go"],
  });
  assert.equal(hit.matched.length, MAX_RULE_MATCHES + 1, "the cut adds one line, it does not hide");
  assert.equal(hit.matched[0], "src/auth/f00.go", "sorted, and the duplicate counted once");
  assert.equal(hit.matched.at(-1), "… 3 more");
});

test("a rule hit is the fourth alert reason, on its own", () => {
  const run = { checkedAt: "2026-08-01T00:00:00Z" };
  const base = {
    score: 92,
    exitCode: 0,
    criticalFlags: 0,
    notifyBelow: 65,
    past: [{ score: 90 }, { score: 91 }, { score: 89 }],
    runs: [run],
  };
  const quiet = alertDecision(base);
  assert.equal(quiet.flagged, false);

  const hits = [{ rule: "schema", matched: ["migration: db/x.sql"], judgeBased: false }];
  const fired = alertDecision({ ...base, ruleHits: hits });
  assert.equal(fired.flagged, true, "a subscribed area moved — the score has no say in that");
  assert.deepEqual(fired.ruleHits, hits);

  // An entry WITH rules that none of fired decides exactly as before — the
  // field only exists once there is something to report.
  assert.deepEqual(alertDecision({ ...base, ruleHits: [] }), quiet);
  assert.equal("ruleHits" in quiet, false);
});

test("a rule that has matched nothing across many checks is reported, not read as calm", () => {
  const rules: WatchRule[] = [{ name: "auth", paths: ["src/auth"] }, { name: "schema", surface: ["migrations"] }];
  const measured = (hits: string[]) => ({
    ruleHits: hits.map((rule) => ({ rule, matched: ["x"], judgeBased: false })),
  });
  const ten = Array.from({ length: RULE_STALE_MIN }, () => measured([]));

  assert.deepEqual(staleRules(rules, ten.slice(1)), [], "too few checks to call it silence");
  assert.deepEqual(staleRules(rules, ten), ["auth", "schema"]);
  assert.deepEqual(staleRules(rules, [...ten.slice(1), measured(["auth"])]), ["schema"]);
  // Checks recorded before the rules existed carry no field and say nothing
  // about them — counting those would report every fresh rule as stale.
  assert.deepEqual(staleRules(rules, [...ten.slice(3), {}, {}, {}]), []);
});

test("validateWatchConfig rejects the rule shapes that would silently never fire", () => {
  const ok = (rules: WatchRule[]) => validateWatchConfig({ repos: [{ repo: "owner/name", rules }] });
  ok([{ name: "auth", paths: ["src/auth"] }]);
  ok([{ name: "surface", surface: ["migrations", "apiRoutes", "hosts", "envVar:OIDC_ISSUER"] }]);
  ok([{ name: "sec", findingKinds: ["security", "breaking"] }]);

  assert.throws(() => ok([{ name: "x", surface: ["envVars"] }]), /unknown surface layer.*envVars/s);
  assert.throws(() => ok([{ name: "x", surface: ["envVar:"] }]), /unknown surface layer/s);
  assert.throws(() => ok([{ name: "x", findingKinds: ["typo" as never] }]), /unknown finding kind/s);
  assert.throws(() => ok([{ name: "x" }]), /subscribes to nothing/s);
  assert.throws(() => ok([{ name: "x", paths: [] }]), /subscribes to nothing/s);
  assert.throws(() => ok([{ name: "x", paths: [" "] }]), /empty "paths" entry/s);
  assert.throws(() => ok([{ name: "", paths: ["src"] }]), /non-empty "name"/s);
  assert.throws(
    () => ok([{ name: "dup", paths: ["a"] }, { name: "dup", paths: ["b"] }]),
    /duplicate rule name "dup"/s,
  );
  // The defaults list is validated too, and names itself in the message.
  assert.throws(
    () =>
      validateWatchConfig({
        repos: [{ repo: "owner/name" }],
        defaults: { rules: [{ name: "x", surface: ["nope"] }] },
      }),
    /\(defaults\).*unknown surface layer/s,
  );
});

// Rules ride the ordinary defaults merge, and `{...defaults, ...entry}`
// REPLACES a list, it does not extend it. The docs say so because an
// operator who expects the union gets a subscription that quietly covers
// less than they think.
test("an entry's rules replace the defaults' list rather than extending it", () => {
  const entries = configuredEntries({
    defaults: { rules: [{ name: "schema", surface: ["migrations"] }] },
    repos: [
      { repo: "a/a" },
      { repo: "b/b", rules: [{ name: "auth", paths: ["src/auth"] }] },
      { repo: "c/c", rules: [] },
    ],
  });
  assert.deepEqual(entries[0].rules, [{ name: "schema", surface: ["migrations"] }], "inherited");
  assert.deepEqual(entries[1].rules, [{ name: "auth", paths: ["src/auth"] }], "replaced, not merged");
  assert.equal(entries[2].rules, undefined, "an empty list is no subscription");
});

test("the index row says which rule moved, and marks a judge-based hit", () => {
  const moved = checked("v9", 95, true);
  moved.ruleHits = [
    { rule: "schema", matched: ["migration: db/x.sql"], judgeBased: false },
    { rule: "sec<x>", matched: ["finding: security — a"], judgeBased: true },
  ];
  const state: WatchState = {
    version: 1,
    repos: {
      "o/r": { lastPublishedAt: "t", lastTag: "v9", latest: moved, history: [moved] },
    },
  };
  const html = toWatchIndexHtml(state, "t");
  assert.match(html, /class="rule"[^>]*>&#9873; schema, sec&lt;x&gt;\*</);
  assert.match(html, /rests on judge output/);
  assert.doesNotMatch(html, /sec<x>/, "a rule name is escaped like everything else");
  // A repo without rules keeps the row it had.
  const plain = checked("v9", 95, true);
  assert.doesNotMatch(
    toWatchIndexHtml({ version: 1, repos: { "o/r": { lastPublishedAt: "t", lastTag: "v9", latest: plain, history: [plain] } } }, "t"),
    /class="rule"/,
  );
});

// `--notify` runs a shell string on purpose. The report path handed to it is
// not the operator's — it carries a repo key and a tag from the config and the
// forge — so it must arrive as an argument, never as shell source.
test("the notify command cannot be extended by the report path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "notify-"));
  const marker = join(dir, "pwned");
  const seen = join(dir, "seen.txt");
  const hostile = join(dir, `v1.0.0"; touch ${marker}; echo ".json`);

  // runNotify appends the path itself, so the command names only its output.
  // Interpolating the path instead of passing it would close that quote and
  // run the `touch`.
  await runNotify(`printf '%s' > ${JSON.stringify(seen)}`, hostile);

  await assert.rejects(stat(marker), "the path opened a shell");
  assert.equal(await readFile(seen, "utf8"), hostile, "the path did not arrive intact");
});

test("releaseWebUrl speaks each forge's route dialect", () => {
  assert.equal(
    releaseWebUrl({ base: "https://gitea.com/gitea/tea", style: "github" }, "v0.14.2"),
    "https://gitea.com/gitea/tea/releases/tag/v0.14.2",
  );
  assert.equal(
    releaseWebUrl({ base: "https://gitlab.com/group/proj", style: "gitlab" }, "v1.0"),
    "https://gitlab.com/group/proj/-/releases/v1.0",
  );
  // Tags may carry slashes — one path component, always.
  assert.equal(
    releaseWebUrl({ base: "https://x.example/o/r", style: "github" }, "cli/v2.0"),
    "https://x.example/o/r/releases/tag/cli%2Fv2.0",
  );
  assert.equal(releaseWebUrl(null, "v1"), undefined);
});

test("toWatchIndexHtml links forge entries to their forge, never to GitHub", () => {
  const forgeRel = checked("v0.14.2", 88, false);
  forgeRel.releaseUrl = "https://gitea.com/gitea/tea/releases/tag/v0.14.2";
  const state: WatchState = {
    version: 1,
    repos: {
      "https://gitea.com/gitea/tea": {
        lastPublishedAt: "2026-07-20T00:00:00Z",
        lastTag: "v0.14.2",
        latest: forgeRel,
        history: [forgeRel],
      },
    },
  };
  const html = toWatchIndexHtml(state, "2026-07-26T00:00:00Z", [
    { key: "https://gitea.com/gitea/tea", repo: "gitea/tea", url: "https://gitea.com/gitea/tea" },
  ]);
  assert.ok(
    html.includes('<a class="ext" href="https://gitea.com/gitea/tea"'),
    "the ↗ after the name links to the forge",
  );
  assert.ok(
    html.includes('href="https://gitea.com/gitea/tea/releases/tag/v0.14.2"'),
    "release links to the forge's release page",
  );
  assert.ok(!html.includes("github.com"), "nothing points at GitHub for a forge entry");
  // The cell SHOWS owner/repo — an unlabeled forge entry's key is its whole
  // URL, which belongs in the title, not across the table. The name itself
  // opens the history page, whose directory derives from the report path.
  assert.ok(
    html.includes('<a class="repo" href="x/index.html"'),
    "the name opens the history page",
  );
  assert.ok(html.includes(">gitea/tea</a>"), "cell text is the slug, not the URL");
  assert.ok(!html.includes(">https://gitea.com/gitea/tea</a>"), "the URL is not the link text");
});

test("a URL-shaped repo without a forge link is not pinned on github.com", () => {
  // States written by older versions carry no releaseUrl; a forge entry whose
  // URL never parsed renders as plain text rather than a fabricated link.
  const rel = checked("v1", 80, false);
  const state: WatchState = {
    version: 1,
    repos: {
      weird: {
        lastPublishedAt: "2026-07-20T00:00:00Z",
        lastTag: "v1",
        latest: rel,
        history: [rel],
      },
    },
  };
  const html = toWatchIndexHtml(state, "t", [{ key: "weird", repo: "ssh://host/x/y" }]);
  assert.ok(!html.includes("github.com"), "no GitHub link fabricated from a URL");
});

test("watch config validation: exactly one of repo and repoUrl per entry", async () => {
  const opts = { configPath: "watch.json", cache: false };
  await assert.rejects(
    runWatch({ repos: [{ repo: "o/r", repoUrl: "https://forge.example/o/r" }] }, opts),
    /pass one per entry/,
  );
  await assert.rejects(runWatch({ repos: [{}] }, opts), /needs "repo"/);
  await assert.rejects(
    runWatch({ repos: [{ repoUrl: "https://forge.example" }] }, opts),
    /cannot read owner\/repo/,
  );
  await assert.rejects(
    runWatch({ repos: [{ repoUrl: "--upload-pack=evil" }] }, opts),
    /may not start with "-"/,
  );
  // A repository name in defaults would merge into every entry and split the
  // index key from the run-loop key — refused up front.
  await assert.rejects(
    runWatch({ repos: [{ repo: "o/r" }], defaults: { repoUrl: "https://f/o/r" } }, opts),
    /"defaults" cannot name a repository/,
  );
});

test("countSkipped ignores releases that would never be checked", () => {
  const releases = [
    { tag: "v2.0.0", publishedAt: "2026-07-20T00:00:00Z", prerelease: false, draft: false },
    { tag: "v2.0.0-rc2", publishedAt: "2026-07-19T00:00:00Z", prerelease: true, draft: false },
    { tag: "v2.0.0-rc1", publishedAt: "2026-07-18T00:00:00Z", prerelease: true, draft: false },
    { tag: "v1.9.0", publishedAt: "2026-07-01T00:00:00Z", prerelease: false, draft: false },
  ];
  const last = "2026-07-10T00:00:00Z";
  // Prereleases are not eligible: nothing was left behind, and the old
  // "raise maxPerRun to backfill" hint pointed at releases that would never
  // be checked anyway.
  assert.equal(countSkipped(releases, last, { cap: 3 }), 0);
  // With prereleases eligible and a cap of 1, two really are left behind.
  assert.equal(countSkipped(releases, last, { includePrerelease: true, cap: 1 }), 2);
  // First run checks only the latest by design — nothing counts as skipped.
  assert.equal(countSkipped(releases, null, { cap: 1 }), 0);
});

test("toWatchIndexHtml links each checked repo row to its history page", () => {
  const state: WatchState = {
    version: 1,
    repos: {
      "good/repo": {
        lastPublishedAt: "2026-07-20T00:00:00Z",
        lastTag: "v1",
        latest: checked("v1", 95, false),
        history: [checked("v1", 95, false)],
      },
    },
  };
  const html = toWatchIndexHtml(state, "t", [{ key: "good/repo", repo: "good/repo" }]);
  // The history dir is derived from the report path, so old states keep
  // working whatever their directory naming was.
  assert.ok(html.includes('href="x/index.html"'), "repo name links the history page");
  assert.ok(!html.includes(">history</a>"), "the trailing history link is gone — the name is it");
});

test("the index aggregates the watchlist: tiles, distribution, broken promises", () => {
  const state: WatchState = {
    version: 1,
    repos: {
      "a/a": {
        lastPublishedAt: "t", lastTag: "v1",
        latest: { ...checked("v1", 95, false), brokenPromises: 2 },
        history: [checked("v1", 95, false)],
      },
      "b/b": {
        lastPublishedAt: "t", lastTag: "v2",
        latest: checked("v2", 40, true),
        history: [checked("v2", 40, true)],
      },
      "c/c": {
        lastPublishedAt: "t", lastTag: "v3",
        latest: { ...checked("v3", 65, false), scoreLabel: "unverified" },
        history: [checked("v3", 65, false)],
      },
    },
  };
  const html = toWatchIndexHtml(state, "t", [
    { key: "a/a", repo: "a/a" },
    { key: "b/b", repo: "b/b" },
    { key: "c/c", repo: "c/c" },
    { key: "d/d", repo: "d/d" },
  ]);
  assert.ok(html.includes('<div class="n">4</div><div class="t">repos watched</div>'));
  assert.ok(html.includes('<div class="n">1</div><div class="t">flagged</div>'));
  assert.ok(html.includes('<div class="n">2</div><div class="t">broken promises</div>'));
  // Distribution counts the three checked repos in their buckets. The
  // unverified latest is scoreLabel "unverified" only in `latest`, not in
  // history — the tiles read latest.
  assert.ok(html.includes('title="1 repo(s) at 85+"'));
  assert.ok(html.includes('title="1 repo(s) at &lt;65"'));
  assert.ok(html.includes('title="1 repo(s) at unverified"'));
});

test("index rows carry sortable data and the headers offer the sorts", () => {
  const state: WatchState = {
    version: 1,
    repos: {
      "a/a": {
        lastPublishedAt: "t", lastTag: "v1",
        latest: { ...checked("v1", 95, false), criticalFlags: 2, flagCount: 3 },
        history: [checked("v1", 95, false)],
      },
    },
  };
  const html = toWatchIndexHtml(state, "t", [{ key: "a/a", repo: "a/a" }]);
  assert.ok(html.includes('data-score="95"'));
  assert.ok(html.includes('data-flags="2003"'), "critical flags outrank the plain count");
  assert.ok(html.includes('data-released="2026-07-20T00:00:00Z"'));
  for (const key of ["repo", "released", "score", "flags", "checked"]) {
    assert.ok(html.includes(`data-sort="${key}"`), `sortable header ${key}`);
  }
  assert.ok(html.includes('id="flagged-only"'), "the flagged-only toggle exists");
  assert.ok(html.includes("body.only-flagged"), "…and has a rule to act on");
});

test("the release feed reads across repos, newest release first", () => {
  const older = { ...checked("v1", 90, false), publishedAt: "2026-07-01T00:00:00Z" };
  const newer = { ...checked("v9", 50, true), publishedAt: "2026-07-22T00:00:00Z" };
  const middle = { ...checked("v5", 80, false), publishedAt: "2026-07-10T00:00:00Z" };
  const state: WatchState = {
    version: 1,
    repos: {
      "a/a": { lastPublishedAt: "t", lastTag: "v5", latest: middle, history: [older, middle] },
      "b/b": { lastPublishedAt: "t", lastTag: "v9", latest: newer, history: [newer] },
    },
  };
  const html = toWatchIndexHtml(state, "t", [
    { key: "a/a", repo: "a/a" },
    { key: "b/b", repo: "b/b" },
  ]);
  const feed = html.slice(html.indexOf("Release feed"));
  const posV9 = feed.indexOf(">v9</a>");
  const posV5 = feed.indexOf(">v5</a>");
  const posV1 = feed.indexOf(">v1</a>");
  assert.ok(posV9 !== -1 && posV5 !== -1 && posV1 !== -1, "all checks appear");
  assert.ok(posV9 < posV5 && posV5 < posV1, "interleaved across repos by release date");
});

test("the atom feed lists checks newest first with stable ids and relative links", () => {
  const HOSTILE = `v1"><img/src=x>&<script>`;
  const first = {
    ...checked(HOSTILE, 40, true),
    checkedAt: "2026-07-10T00:00:00Z",
    report: "x/v1.html",
    brokenPromises: 1,
    warnings: ["diff truncated"],
  };
  const second = { ...checked("v2", 90, false), checkedAt: "2026-07-20T00:00:00Z" };
  const state: WatchState = {
    version: 1,
    repos: {
      "a/a": { lastPublishedAt: "t", lastTag: "v2", latest: second, history: [first, second] },
    },
  };
  const xml = toWatchAtomFeed(state, "2026-07-26T00:00:00Z", [{ key: "a/a", repo: "a/a" }]);
  assert.ok(xml.startsWith(`<?xml version="1.0"`));
  assert.ok(!xml.includes("<img"), "hostile tag cannot become markup");
  assert.ok(!xml.includes("<script"), "hostile tag cannot become markup");
  assert.ok(xml.includes("<id>urn:comparereleaseii:a%2Fa:v2</id>"), "id derives from key and tag");
  assert.ok(xml.includes('href="x/v2.html"'), "links stay relative to the feed");
  assert.ok(
    xml.indexOf("v2 — 90/100") < xml.indexOf("40/100"),
    "entries ordered by checkedAt, newest first",
  );
  assert.ok(xml.includes("1 broken promise(s)"));
  assert.ok(xml.includes("diff truncated"), "partial-data warnings reach the summary");
  assert.ok(xml.includes("<updated>2026-07-20T00:00:00Z</updated>"), "entry updated = checkedAt");
});

test("a release tagged index cannot take over the history page's filename", () => {
  assert.equal(sanitizeTag("index"), "index_");
  assert.equal(sanitizeTag("INDEX"), "INDEX_", "case-insensitive filesystems collide too");
  assert.equal(sanitizeTag("v1.0/../index"), "v1.0_.._index");
  assert.equal(sanitizeTag("v1.2.3"), "v1.2.3");
});

function activity(key: string, commits: number, over: Record<string, unknown> = {}) {
  return { key, name: key, commits, sensitiveCommits: 0, binaryCommits: 0, ...over };
}

test("the author ledger accumulates identities and firstSeen never moves", () => {
  const r1 = updateAuthorLedger(undefined, [activity("a@x", 3), activity("b@x", 1)], "v1");
  assert.equal(r1.newAuthors, 2);
  assert.equal(r1.dropped, 0);
  const r2 = updateAuthorLedger(
    r1.ledger,
    [activity("a@x", 2, { name: "A renamed", logins: ["a-login"] })],
    "v2",
  );
  assert.equal(r2.newAuthors, 0, "a known identity is not new");
  const a = r2.ledger.find((x) => x.key === "a@x")!;
  assert.equal(a.firstSeen, "v1", "firstSeen is immutable");
  assert.equal(a.lastSeen, "v2");
  assert.equal(a.releases, 2);
  assert.equal(a.commits, 5);
  assert.equal(a.name, "A renamed");
  const r3 = updateAuthorLedger(r2.ledger, [activity("a@x", 1, { logins: [null] })], "v3");
  assert.deepEqual(r3.ledger.find((x) => x.key === "a@x")!.logins, ["a-login", null],
    "attribution changes accumulate — that shift is the fact worth keeping");
});

test("the author ledger cap keeps this release's identities, then the busiest", () => {
  let ledger = updateAuthorLedger(
    undefined,
    Array.from({ length: MAX_AUTHOR_LEDGER }, (_, i) => activity(`old${i}@x`, i + 2)),
    "v1",
  ).ledger;
  const update = updateAuthorLedger(ledger, [activity("fresh@x", 1)], "v2");
  assert.equal(update.ledger.length, MAX_AUTHOR_LEDGER);
  assert.equal(update.dropped, 1);
  assert.ok(update.ledger.some((a) => a.key === "fresh@x"), "the active identity survives the cap");
  assert.ok(!update.ledger.some((a) => a.key === "old0@x"), "the least active is what drops");
});

test("a release wider than the cap keeps its whole active set — new stays honest", () => {
  const wide = Array.from({ length: MAX_AUTHOR_LEDGER + 50 }, (_, i) => activity(`a${i}@x`, 1));
  const r1 = updateAuthorLedger(undefined, wide, "v1");
  assert.equal(r1.ledger.length, MAX_AUTHOR_LEDGER + 50, "every active identity survives");
  assert.equal(r1.dropped, 0);
  const r2 = updateAuthorLedger(r1.ledger, wide, "v2");
  assert.equal(r2.newAuthors, 0, "an identity the cap kept never recounts as new");
  // The next narrow release shrinks the ledger back to the cap.
  const r3 = updateAuthorLedger(r2.ledger, [activity("fresh@x", 1)], "v3");
  assert.equal(r3.ledger.length, MAX_AUTHOR_LEDGER);
  assert.equal(r3.dropped, 51);
});

test("recordCheckFailure: retries first, keeps state put, counts attempts on the same tag", () => {
  const rs: RepoState = { lastPublishedAt: "2026-01-01T00:00:00Z", lastTag: "v1", history: [] };
  const rel = { tag: "v2", publishedAt: "2026-02-01T00:00:00Z" };

  assert.equal(recordCheckFailure(rs, rel, "boom", "2026-02-02T00:00:00Z"), "retry");
  assert.deepEqual(rs.failing, { tag: "v2", attempts: 1, lastError: "boom" });
  assert.equal(rs.lastTag, "v1");
  assert.equal(rs.lastPublishedAt, "2026-01-01T00:00:00Z");

  assert.equal(recordCheckFailure(rs, rel, "boom again", "2026-02-03T00:00:00Z"), "retry");
  assert.equal(rs.failing!.attempts, 2);
  assert.equal(rs.failing!.lastError, "boom again");
});

test("recordCheckFailure: a different failing tag restarts the counter", () => {
  const rs: RepoState = { lastPublishedAt: null, lastTag: null, history: [] };
  recordCheckFailure(rs, { tag: "v2", publishedAt: "2026-02-01T00:00:00Z" }, "x", "t");
  recordCheckFailure(rs, { tag: "v2", publishedAt: "2026-02-01T00:00:00Z" }, "x", "t");
  assert.equal(rs.failing!.attempts, 2);
  assert.equal(recordCheckFailure(rs, { tag: "v3", publishedAt: "2026-03-01T00:00:00Z" }, "y", "t"), "retry");
  assert.deepEqual(rs.failing, { tag: "v3", attempts: 1, lastError: "y" });
});

test("recordCheckFailure: skips past the release after MAX_CHECK_ATTEMPTS, advancing the state", () => {
  const rs: RepoState = { lastPublishedAt: "2026-01-01T00:00:00Z", lastTag: "v1", history: [] };
  const rel = { tag: "v2", publishedAt: "2026-02-01T00:00:00Z" };
  for (let i = 1; i < MAX_CHECK_ATTEMPTS; i++) {
    assert.equal(recordCheckFailure(rs, rel, "no claims found", "t"), "retry");
  }
  assert.equal(recordCheckFailure(rs, rel, "no claims found", "2026-02-04T00:00:00Z"), "skip");
  assert.equal(rs.failing, undefined);
  assert.equal(rs.lastTag, "v2");
  assert.equal(rs.lastPublishedAt, "2026-02-01T00:00:00Z");
  assert.deepEqual(rs.skipped, [
    {
      tag: "v2",
      publishedAt: "2026-02-01T00:00:00Z",
      attempts: MAX_CHECK_ATTEMPTS,
      lastError: "no claims found",
      skippedAt: "2026-02-04T00:00:00Z",
    },
  ]);
});

test("recordCheckFailure: the skipped ledger is bounded, oldest entries drop", () => {
  const rs: RepoState = { lastPublishedAt: null, lastTag: null, history: [] };
  for (let n = 1; n <= 11; n++) {
    const rel = { tag: `v${n}`, publishedAt: `2026-01-${String(n).padStart(2, "0")}T00:00:00Z` };
    for (let i = 1; i <= MAX_CHECK_ATTEMPTS; i++) recordCheckFailure(rs, rel, "x", "t");
  }
  assert.equal(rs.skipped!.length, 10);
  assert.equal(rs.skipped![0].tag, "v2");
  assert.equal(rs.skipped![9].tag, "v11");
});

function at(tag: string, score: number, publishedAt: string): CheckedRelease {
  return { ...checked(tag, score, false), publishedAt };
}

test("pickBackfillReleases: the newest n eligible releases, oldest first, on a fresh repo", () => {
  const releases = [
    rel("v4", "2026-07-20T00:00:00Z"),
    rel("v3-rc", "2026-07-15T00:00:00Z", { prerelease: true }),
    rel("v3", "2026-07-10T00:00:00Z"),
    rel("v2", "2026-06-01T00:00:00Z"),
    rel("v1", "2026-05-01T00:00:00Z"),
  ];
  const fresh: RepoState = { lastPublishedAt: null, lastTag: null, history: [] };
  assert.deepEqual(
    pickBackfillReleases(releases, fresh, { releases: 3 }).map((r) => r.tag),
    ["v2", "v3", "v4"],
  );
  assert.deepEqual(
    pickBackfillReleases(releases, fresh, { releases: 2, includePrerelease: true }).map((r) => r.tag),
    ["v3-rc", "v4"],
  );
  assert.deepEqual(
    pickBackfillReleases(releases, fresh, { since: "2026-06-01" }).map((r) => r.tag),
    ["v2", "v3", "v4"],
  );
});

test("pickBackfillReleases: an interrupted backfill resumes without re-checking", () => {
  const releases = [
    rel("v3", "2026-07-10T00:00:00Z"),
    rel("v2", "2026-06-01T00:00:00Z"),
    rel("v1", "2026-05-01T00:00:00Z"),
  ];
  // The first half of the run landed in history; a broken release was given
  // up on and sits on the skipped record. Neither is picked again.
  const rs: RepoState = {
    lastPublishedAt: "2026-07-10T00:00:00Z",
    lastTag: "v3",
    history: [at("v1", 80, "2026-05-01T00:00:00Z"), at("v3", 85, "2026-07-10T00:00:00Z")],
    skipped: [
      { tag: "v2", publishedAt: "2026-06-01T00:00:00Z", attempts: 3, lastError: "x", skippedAt: "t" },
    ],
  };
  assert.deepEqual(pickBackfillReleases(releases, rs, { releases: 3 }), []);
});

test("pickBackfillReleases: releases newer than the poll cursor stay the watch run's job", () => {
  const releases = [
    rel("v5", "2026-07-25T00:00:00Z"),
    rel("v4", "2026-07-20T00:00:00Z"),
    rel("v3", "2026-07-10T00:00:00Z"),
    rel("v2", "2026-06-01T00:00:00Z"),
  ];
  const rs: RepoState = {
    lastPublishedAt: "2026-07-20T00:00:00Z",
    lastTag: "v4",
    history: [at("v4", 90, "2026-07-20T00:00:00Z")],
  };
  // v5 is new-and-unchecked — the catch-up's territory, with the state's
  // promise thread; backfill takes only the gap behind the cursor.
  assert.deepEqual(
    pickBackfillReleases(releases, rs, { releases: 4 }).map((r) => r.tag),
    ["v2", "v3"],
  );
});

test("recordChecked: a backfilled past release lands chronologically and moves nothing forward", () => {
  const newest = at("v3", 90, "2026-07-10T00:00:00Z");
  const rs: RepoState = {
    lastPublishedAt: "2026-07-10T00:00:00Z",
    lastTag: "v3",
    latest: newest,
    history: [newest],
  };
  const old = at("v1", 70, "2026-05-01T00:00:00Z");
  recordChecked(rs, old);
  assert.deepEqual(rs.history.map((h) => h.tag), ["v1", "v3"], "insert is chronological");
  assert.equal(rs.latest!.tag, "v3", "latest never moves backward");
  assert.equal(rs.lastPublishedAt, "2026-07-10T00:00:00Z", "the poll cursor never moves backward");
  assert.equal(rs.lastTag, "v3");
});

test("recordChecked: the watch path still advances cursor and latest", () => {
  const rs: RepoState = { lastPublishedAt: null, lastTag: null, history: [] };
  recordChecked(rs, at("v1", 80, "2026-05-01T00:00:00Z"));
  recordChecked(rs, at("v2", 85, "2026-06-01T00:00:00Z"));
  assert.equal(rs.lastTag, "v2");
  assert.equal(rs.lastPublishedAt, "2026-06-01T00:00:00Z");
  assert.equal(rs.latest!.tag, "v2");
  assert.deepEqual(rs.history.map((h) => h.tag), ["v1", "v2"]);
});

test("recordChecked: the history cap keeps the newest releases", () => {
  const rs: RepoState = { lastPublishedAt: null, lastTag: null, history: [] };
  for (let i = 1; i <= 6; i++) {
    recordChecked(rs, at(`v${i}`, 80, `2026-01-0${i}T00:00:00Z`), 4);
  }
  assert.deepEqual(rs.history.map((h) => h.tag), ["v3", "v4", "v5", "v6"]);
  // A late-arriving OLD check cannot evict a newer one once the cap is hit.
  recordChecked(rs, at("v0", 80, "2026-01-01T00:00:00Z"), 4);
  assert.deepEqual(rs.history.map((h) => h.tag), ["v3", "v4", "v5", "v6"]);
});

test("recordSkip: giving up on a backfilled old release keeps the cursor where it is", () => {
  const rs: RepoState = {
    lastPublishedAt: "2026-07-10T00:00:00Z",
    lastTag: "v3",
    history: [],
  };
  recordSkip(rs, { tag: "v1", publishedAt: "2026-05-01T00:00:00Z" }, 3, "boom", "t");
  assert.equal(rs.lastPublishedAt, "2026-07-10T00:00:00Z", "cursor did not move backward");
  assert.equal(rs.lastTag, "v3");
  assert.equal(rs.skipped![0].tag, "v1", "the release is on the unchecked record");
  // The watch loop's skip (a NEWER release) still advances it.
  recordSkip(rs, { tag: "v4", publishedAt: "2026-08-01T00:00:00Z" }, 3, "boom", "t");
  assert.equal(rs.lastPublishedAt, "2026-08-01T00:00:00Z");
  assert.equal(rs.lastTag, "v4");
});

test("baselineLevel reads the newest window — old note culture cannot dilute today's normal", () => {
  // Twenty old checks at 90, then a regime at 40: the repo's CURRENT level
  // is 40. A whole-history median would still say 90 and the relative alert
  // would fire on every release of the new normal.
  const history = [
    ...Array.from({ length: 20 }, () => ({ score: 90 })),
    ...Array.from({ length: BASELINE_WINDOW }, () => ({ score: 40 })),
  ];
  assert.equal(baselineLevel(history), 40);
  assert.equal(baselineLevel([{ score: 90 }, { score: 92 }]), null, "too few checks stays null");
});

test("hasDrifted reads a fixed window — an ancient level shift is the long view's story, not an alert", () => {
  // The shift from 90 to 70 happened long ago; inside the drift window the
  // level is a steady 70. Alerting on it forever would be noise.
  const ancient = [
    ...Array.from({ length: 20 }, () => ({ score: 90 })),
    ...Array.from({ length: DRIFT_WINDOW }, () => ({ score: 70 })),
  ];
  assert.equal(hasDrifted(ancient), false);
  // A shift INSIDE the window still alerts.
  const recent = [
    ...Array.from({ length: 20 }, () => ({ score: 95 })),
    ...Array.from({ length: DRIFT_WINDOW / 2 }, () => ({ score: 90 })),
    ...Array.from({ length: DRIFT_WINDOW / 2 }, () => ({ score: 65 })),
  ];
  assert.equal(hasDrifted(recent), true);
});

test("backfill validation: exactly one scope, a real date, known selectors", async () => {
  const cfg = { repos: [{ repo: "o/r" }] };
  const base = { configPath: "watch.json", cache: false, yes: true, only: [] as string[] };
  await assert.rejects(runBackfill(cfg, base), /exactly one scope/);
  await assert.rejects(
    runBackfill(cfg, { ...base, releases: 5, since: "2024-01-01" }),
    /exactly one scope/,
  );
  await assert.rejects(runBackfill(cfg, { ...base, since: "letzten monat" }), /--since must be a date/);
  await assert.rejects(
    runBackfill(cfg, { ...base, releases: 5, only: ["nope/nope"] }),
    /not in the watch config/,
  );
});

test("a backfilled flag says it never alerted — on the index row, the feed line and the atom feed", () => {
  const live = { ...checked("v2", 40, true), checkedAt: "2026-07-28T01:00:00Z" };
  const back = {
    ...checked("v1", 45, true),
    publishedAt: "2026-06-01T00:00:00Z",
    checkedAt: "2026-07-28T02:00:00Z",
    backfilled: true,
  };
  const state: WatchState = {
    version: 1,
    repos: {
      "o/r": {
        lastPublishedAt: "2026-07-20T00:00:00Z",
        lastTag: "v2",
        latest: live,
        history: [back, live],
      },
    },
  };
  const html = toWatchIndexHtml(state, "t", [{ key: "o/r", repo: "o/r" }]);
  assert.ok(
    html.includes("flagged on record, never alerted"),
    "the feed line qualifies the backfilled flag",
  );
  // The atom feed is the pull counterpart to --notify: a backfill dumping
  // 40 "new" entries on a feed reader is exactly the historical alert
  // noise notify refuses to make. Live checks stay.
  const xml = toWatchAtomFeed(state, "t", [{ key: "o/r", repo: "o/r" }]);
  assert.ok(xml.includes(">v2<") || xml.includes("v2 —"), "the live check is in the atom feed");
  assert.ok(!xml.includes("v1"), "the backfilled check is not");
});

test("the index states what scores measure — the entry page must not read as a project verdict", () => {
  const state: WatchState = {
    version: 1,
    repos: {
      "o/r": {
        lastPublishedAt: "2026-07-20T00:00:00Z",
        lastTag: "v1",
        latest: checked("v1", 45, true),
        history: [checked("v1", 45, true)],
      },
    },
  };
  const html = toWatchIndexHtml(state, "2026-07-28T00:00:00Z");
  assert.ok(
    html.includes("not project quality, and never people"),
    "framing line present on the dashboard",
  );
});

// The tag has always gone through a sanitizer; the state key did not, and a
// config entry with `label: "../.."` wrote its reports outside the reports
// directory. The fix is one call, it is not visible in any output, and no
// test held it: deleting `safeSegment` here passed the whole suite.
test("a label that tries to climb out of the reports directory cannot", async () => {
  const results: never[] = [];
  const report: Report = {
    repoLabel: "o/r",
    baseRef: "v1",
    headRef: "v2",
    stats: { commits: 1, files: 1, additions: 1, deletions: 0 },
    results,
    uncovered: [],
    reverseChecked: true,
    metrics: {
      scores: computeScores(results, 0, [], false),
      flags: [],
      files: [],
      churnCoveredRatio: 0,
      context: { languages: null, codeBytes: null, releaseCadenceDays: null },
      baseline: null,
      unverifiable: null,
    },
    warnings: [],
    truncated: false,
    engine: "off",
  };
  const repoState: RepoState = { lastPublishedAt: null, lastTag: null, history: [] };
  const reportsDir = await mkdtemp(join(tmpdir(), "crii-reports-"));

  const { dirKey, jsonPath } = await writeReportFiles({
    report,
    key: "../../escaped",
    tag: "v2",
    reportsDir,
    repoState,
  });

  // `..` may survive as text — what must not survive is a separator, because
  // only a whole `..` segment climbs. The property is where the path lands.
  assert.ok(!dirKey.includes("/"), `the key stayed a path, not one segment: ${dirKey}`);
  assert.ok(
    resolve(jsonPath).startsWith(resolve(reportsDir) + sep),
    `the report escaped its directory: ${resolve(jsonPath)}`,
  );
  // It really is on disk, under the sanitized name — not merely a safe string.
  await stat(jsonPath);
  await stat(join(reportsDir, dirKey, "v2.html"));

  // A tag doing the same thing is caught by the sanitizer it always had.
  const evil = await writeReportFiles({
    report,
    key: "o/r",
    tag: "../../v9",
    reportsDir,
    repoState,
  });
  assert.ok(
    resolve(evil.jsonPath).startsWith(resolve(reportsDir) + sep),
    `the tag escaped: ${resolve(evil.jsonPath)}`,
  );
});

// The cost statement has to precede the first paid check — a backfill can be
// an hour of judge calls, and the run asks for confirmation right after this.
// Nothing held it: the whole per-repo announcement could be dropped and the
// confirmation prompt would still appear, now with nothing to confirm about.
test("a backfill states its cost before it asks to be started", () => {
  const plan = (tags: string[]): ReleaseInfo[] =>
    tags.map((t, i) => rel(t, `2026-0${i + 1}-01T00:00:00Z`));
  const plans: BackfillPlan[] = [
    { rc: { repo: "o/busy" }, key: "o/busy", plan: plan(["v1", "v2", "v3"]), gh: null, forge: null },
    { rc: { repo: "o/quiet" }, key: "o/quiet", plan: [], gh: null, forge: null },
  ];
  const state: WatchState = {
    version: 1,
    repos: {
      "o/busy": {
        lastPublishedAt: null,
        lastTag: null,
        history: [{ tag: "v0", checkedAt: "2026-01-01T00:00:00Z", score: 90 } as CheckedRelease],
      },
    },
  };

  const said: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    said.push(args.join(" "));
  };
  let total: number;
  let quiet: number;
  try {
    total = announceBackfill(plans, [{ repo: "o/busy", judge: "auto" }], 2, state);
    // Judge off is a different order of cost, and must be said differently.
    quiet = announceBackfill(plans, [{ repo: "o/busy", judge: "off" }], 99, state);
  } finally {
    console.error = orig;
  }
  const out = said.join("\n");

  assert.equal(total, 3, "the count that gets confirmed");
  assert.equal(quiet, 3);
  // Which repo, how many, and the span — not just a number.
  assert.match(out, /o\/busy: 3 release\(s\) to check — v1 … v3/);
  // A repo with nothing to do stays silent.
  assert.doesNotMatch(out, /o\/quiet: /);
  // 1 kept check + 3 planned against historyLimit 2: the run says what it drops.
  assert.match(out, /historyLimit 2 keeps only the newest 2 of 4 checks/);
  assert.match(out, /~6 min judge time/);
  assert.match(out, /deterministic only \(judge off\), seconds per release/);

  // Nothing planned, nothing announced, and the caller learns to stop.
  const none: string[] = [];
  console.error = (...args: unknown[]) => {
    none.push(args.join(" "));
  };
  let empty: number;
  try {
    empty = announceBackfill([plans[1]], [{ repo: "o/quiet" }], 10, state);
  } finally {
    console.error = orig;
  }
  assert.equal(empty, 0);
  assert.equal(none.length, 0, `announced something for an empty plan: ${none.join("\n")}`);
});

// checkAndRecord folds a finished Report into a CheckedRelease and the repo's
// state — `evaluateRules`, `alertDecision` and the ledgers are each tested
// pure above, but nothing exercised the assembly that calls them and builds
// the record a real watch run writes to disk. The `safeSegment` guard removed
// from `writeReportFiles` earlier in this file and still passing every test
// is what that gap is worth: an untested fold can be deleted and nothing
// notices. `loadAndAnalyze` is the seam that makes this drivable without a
// network call, a `gh`/git subprocess or a judge — every production caller
// (`runWatch`, `runBackfill`) leaves it undefined, which falls back to the
// real `loadAndAnalyzeRelease`, so nothing below changes what a live run does.

const GITHUB_LINK = { base: "https://github.com/o/r", style: "github" } as const;
const FIXED_NOW = "2026-08-09T12:00:00.000Z";

/** A minimal, valid ClaimResult — only the fields checkAndRecord's verdict
 * tally and unjudged count actually read vary per case; the rest is the
 * smallest valid filler. */
function claimResult(verdict: Verdict, overrides: Partial<ClaimResult> = {}): ClaimResult {
  return {
    claim: {
      id: 1,
      section: "Changes",
      text: "does a thing",
      kind: "change",
      prNumbers: [],
      shas: [],
      advisories: [],
      codeSpans: [],
    },
    verdict,
    confidence: 1,
    evidence: { commitShas: [], files: [], matchedTerms: [], methods: [] },
    reasoning: "",
    judged: true,
    generated: false,
    ...overrides,
  };
}

/** A minimal, valid Report — the shape checkAndRecord folds into a
 * CheckedRelease. Every field a case cares about is set explicitly; the rest
 * is the smallest filler that satisfies the type and the renderers
 * `writeReportFiles` still calls for real. */
function fabricatedReport(overrides: Partial<Report> = {}): Report {
  return {
    repoLabel: "o/r",
    baseRef: "v1.0.0",
    headRef: "v2.0.0",
    stats: { commits: 3, files: 2, additions: 40, deletions: 5 },
    results: [],
    uncovered: [],
    reverseChecked: true,
    metrics: {
      scores: { correctness: 90, completeness: 80, risk: 85, overall: 88, label: "solid" },
      flags: [],
      files: [],
      churnCoveredRatio: 1,
      context: { languages: null, codeBytes: null, releaseCadenceDays: null },
      unverifiable: null,
      baseline: null,
    },
    warnings: [],
    truncated: false,
    engine: "off",
    ...overrides,
  };
}

/**
 * Drives the real `checkAndRecord` against a fabricated report — no network,
 * no `gh`/git subprocess, no judge (`judge: "off"` by default, and the fake
 * `engines` resolver never even reaches `resolveEngines`). `checkedAt` is
 * pinned via `mock.timers` so the recorded state is byte-comparable, not just
 * shape-comparable.
 */
async function check(opts: {
  report: Report;
  rc?: Partial<WatchRepoConfig>;
  rel?: Partial<ReleaseInfo>;
  repoState?: RepoState;
  backfilled?: boolean;
}): Promise<{ outcome: CheckOutcome; repoState: RepoState }> {
  const rc: WatchRepoConfig = { repo: "o/r", judge: "off", ...opts.rc };
  const rel: ReleaseInfo = {
    tag: "v2.0.0",
    publishedAt: "2026-06-01T00:00:00Z",
    prerelease: false,
    draft: false,
    ...opts.rel,
  };
  const repoState: RepoState = opts.repoState ?? { lastPublishedAt: null, lastTag: null, history: [] };
  const reportsDir = await mkdtemp(join(tmpdir(), "crii-checkAndRecord-"));
  mock.timers.enable({ apis: ["Date"], now: new Date(FIXED_NOW) });
  try {
    const outcome = await checkAndRecord({
      key: "o/r",
      rc,
      rel,
      repoState,
      target: undefined,
      carried: [],
      configDir: reportsDir,
      reportsDir,
      engines: async () => ({ engine: null, escalate: null }),
      cache: false,
      historyLimit: 20,
      backfilled: opts.backfilled,
      loadAndAnalyze: async () => ({ report: opts.report, link: GITHUB_LINK }),
    });
    return { outcome, repoState };
  } finally {
    mock.timers.reset();
  }
}

test("checkAndRecord assembles the full CheckedRelease shape from a fabricated report", async () => {
  const report = fabricatedReport({
    results: [
      claimResult("verified", { judgeFailed: true }),
      claimResult("verified"),
      claimResult("partial"),
      claimResult("no-evidence"),
      claimResult("contradicted"),
      claimResult("skipped"),
    ],
    metrics: {
      scores: { correctness: 91, completeness: 77, risk: 65, overall: 84, label: "solid" },
      flags: [
        { severity: "critical", kind: "secret", message: "a secret leaked", files: ["a.go"], commitShas: [] },
        { severity: "warn", kind: "noisy", message: "loud diff", files: ["b.go"], commitShas: [] },
      ],
      files: [],
      churnCoveredRatio: 1,
      context: { languages: null, codeBytes: null, releaseCadenceDays: null },
      unverifiable: null,
      baseline: null,
    },
    warnings: ["diff truncated"],
    scoringGeneration: 3,
    authors: [
      { key: "alice@x", name: "Alice", commits: 5, sensitiveCommits: 0, binaryCommits: 0 },
      { key: "bob@x", name: "Bob", commits: 2, sensitiveCommits: 1, binaryCommits: 0 },
    ],
    promises: [
      { text: "remove X", from: "v1.0.0", kind: "removal", status: "broken", files: [], note: "" },
      { text: "add Y", from: "v1.5.0", kind: "addition", status: "still-open", files: [], note: "" },
    ],
  });

  const { outcome, repoState } = await check({ report, backfilled: true });
  const c = outcome.checked;

  assert.equal(c.tag, "v2.0.0");
  assert.equal(c.publishedAt, "2026-06-01T00:00:00Z");
  assert.equal(c.checkedAt, FIXED_NOW, "checkedAt is 'now' — pinned so the record is byte-comparable");
  assert.equal(c.score, 84);
  assert.equal(c.scoreLabel, "solid");
  assert.deepEqual(c.components, { correctness: 91, completeness: 77, risk: 65 });
  assert.equal(c.scoringGeneration, 3);
  assert.equal(c.exitCode, 1, "a contradicted verdict fails the default fail-on gate");
  assert.equal(c.criticalFlags, 1);
  assert.equal(c.flagCount, 2);
  assert.equal(c.flagged, true);
  assert.deepEqual(c.warnings, ["diff truncated"]);
  assert.equal(c.brokenPromises, 1, "only the broken entry counts, the still-open one does not");
  assert.equal(c.engine, "off");
  assert.equal(c.unjudged, 1, "the one judgeFailed result — the skipped verdict is not a fallback");
  assert.deepEqual(
    c.verdicts,
    { verified: 2, partial: 1, noEvidence: 1, contradicted: 1 },
    "6 results, one skipped — counted by verdict, not by length",
  );
  assert.deepEqual(c.authors, { total: 2, new: 2, top1Share: 0.71, top1Name: "Alice" });
  assert.equal(c.unverifiable, undefined);
  assert.ok(
    Object.hasOwn(c, "unverifiable"),
    "the key exists even when its value is undefined — a plain property, not a conditional spread",
  );
  assert.equal(c.scoreLevel, null, "fewer than three past checks — no level to compare against yet");
  assert.equal("ruleHits" in c, false, "no rules configured — nothing to fold");
  assert.equal(c.report, "o_r/v2.0.0.html");
  assert.equal(c.releaseUrl, "https://github.com/o/r/releases/tag/v2.0.0");
  assert.equal(c.backfilled, true);

  // The state the run loop and the dashboard read afterwards.
  assert.equal(repoState.history.length, 1);
  assert.equal(repoState.history[0], c, "recordChecked folds the exact object checkAndRecord returned");
  assert.equal(repoState.latest, c);
  assert.equal(repoState.lastTag, "v2.0.0");
  assert.equal(repoState.lastPublishedAt, "2026-06-01T00:00:00Z");
  assert.equal(repoState.authors?.length, 2, "the author ledger folded both identities");
  assert.equal(repoState.authors?.find((a) => a.key === "alice@x")?.firstSeen, "v2.0.0");
});

test("a watch rule fires and its hit rides the CheckedRelease", async () => {
  const surface: ReleaseSurface = {
    categories: [],
    symbols: [],
    moreSymbols: 0,
    envVars: { added: [], removed: [] },
    cliFlags: { added: [], removed: [] },
    configKeys: { added: [], removed: [] },
    hosts: { added: [], removed: [] },
    migrations: ["db/migrations/010_add_sessions.sql"],
    apiRoutes: [],
  };
  const findings: Finding[] = [
    {
      kind: "security",
      audience: "everyone",
      text: "auth bypass patched",
      files: ["src/auth/mw.go"],
      subsystem: "auth",
    },
  ];
  const report = fabricatedReport({
    metrics: {
      scores: { correctness: 95, completeness: 90, risk: 92, overall: 93, label: "solid" },
      flags: [],
      files: [{ path: "src/auth/token.go", churn: 5, sensitive: null, coverage: "covered" }],
      churnCoveredRatio: 1,
      context: { languages: null, codeBytes: null, releaseCadenceDays: null },
      unverifiable: null,
      baseline: null,
    },
    surface,
    findings: {
      findings,
      budget: { maxChars: 1000, usedChars: 10, subsystemsRead: 1, subsystemsTotal: 1, filesRead: 1, filesTotal: 1 },
    },
  });

  const { outcome } = await check({
    report,
    rc: {
      rules: [
        { name: "auth", paths: ["src/auth"] },
        { name: "schema", surface: ["migrations"] },
        { name: "sec", findingKinds: ["security"] },
      ],
    },
  });
  const c = outcome.checked;
  assert.ok(c.ruleHits, "the field is present once the entry has rules");
  assert.deepEqual(c.ruleHits!.map((h) => h.rule).sort(), ["auth", "schema", "sec"]);
  const auth = c.ruleHits!.find((h) => h.rule === "auth")!;
  assert.deepEqual(auth.matched, ["src/auth/token.go"]);
  assert.equal(auth.judgeBased, false);
  const schema = c.ruleHits!.find((h) => h.rule === "schema")!;
  assert.deepEqual(schema.matched, ["migration: db/migrations/010_add_sessions.sql"]);
  const sec = c.ruleHits!.find((h) => h.rule === "sec")!;
  assert.equal(sec.judgeBased, true, "a finding-kind-only hit rests on judge output");
  // A high score, no exit code, no critical flags — the rule alone flags it.
  assert.equal(c.flagged, true, "a subscribed area moved — the score has no say in that");
  assert.equal(c.exitCode, 0);
  assert.equal(c.criticalFlags, 0);
});

test("an empty, clean check leaves every conditional field off the record", async () => {
  const report = fabricatedReport(); // no results, no warnings, no authors, no promises, no rules
  const { outcome } = await check({ report });
  const c = outcome.checked;
  assert.deepEqual(c.verdicts, { verified: 0, partial: 0, noEvidence: 0, contradicted: 0 });
  assert.equal("warnings" in c, false);
  assert.equal("scoringGeneration" in c, false);
  assert.equal("brokenPromises" in c, false);
  assert.equal("unjudged" in c, false);
  assert.equal("authors" in c, false);
  assert.equal("ruleHits" in c, false);
  assert.equal("backfilled" in c, false);
  assert.equal(c.exitCode, 0);
  assert.equal(c.flagged, false, "a solid score with nothing else wrong stays quiet");
});

test("a rule that matched nothing still carries an empty ruleHits — not an absent one", async () => {
  const history = [
    at("v1", 90, "2026-05-01T00:00:00Z"),
    at("v2", 91, "2026-05-02T00:00:00Z"),
    at("v3", 89, "2026-05-03T00:00:00Z"),
  ];
  const repoState: RepoState = {
    lastPublishedAt: "2026-05-03T00:00:00Z",
    lastTag: "v3",
    history,
  };
  const report = fabricatedReport({
    metrics: {
      scores: { correctness: 90, completeness: 85, risk: 88, overall: 90, label: "solid" },
      flags: [],
      files: [{ path: "README.md", churn: 1, sensitive: null, coverage: "covered" }],
      churnCoveredRatio: 1,
      context: { languages: null, codeBytes: null, releaseCadenceDays: null },
      unverifiable: null,
      baseline: null,
    },
  });
  const { outcome } = await check({
    report,
    rc: { rules: [{ name: "auth", paths: ["src/auth"] }] },
    repoState,
    rel: { tag: "v4", publishedAt: "2026-06-01T00:00:00Z" },
  });
  const c = outcome.checked;
  assert.deepEqual(c.ruleHits, [], "rules are configured, none fired — the field stays, it does not vanish");
  assert.equal(c.flagged, false, "an empty ruleHits is not a hit");
  assert.equal(c.scoreLevel, 90, "three past checks — the level now compares");
});
