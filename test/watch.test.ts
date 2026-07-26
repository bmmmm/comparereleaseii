// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pickNewReleases,
  isFlagged,
  hasDrifted,
  scoreBaseline,
  worstExit,
  toWatchIndexHtml,
  type ReleaseInfo,
  type WatchState,
  type CheckedRelease,
} from "../src/watch.ts";

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
  assert.ok(html.includes("2 repos watched · 1 flagged"));
});

test("toWatchIndexHtml: whole rows link to the report, repos link to GitHub", () => {
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
  assert.ok(html.includes('href="https://github.com/good/repo"'), "repo links to GitHub");
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
  assert.ok(!toWatchIndexHtml(one, "t").includes('class="dot '), "single check: no trend dots");
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
  assert.ok(html.includes("1 repos watched · 0 flagged"));
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

test("an exact 20-point drop is the case the constant names", () => {
  assert.equal(isFlagged(71, 0, 0, 65, 91), true);
  assert.equal(isFlagged(72, 0, 0, 65, 91), false);
});
