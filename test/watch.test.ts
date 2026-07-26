// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pickNewReleases,
  isFlagged,
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
  assert.ok(html.includes("not in this repo's own diff"), "title explains it");
  assert.equal(html.match(/class="tag"/g)?.length, 1, "only the fork row is tagged");
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
