// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectEvents,
  segmentPhases,
  selectEvents,
  longviewSections,
  LONGVIEW_MIN_CHECKS,
  type LongviewEvent,
} from "../src/watch-longview.ts";
import { toRepoDetailHtml } from "../src/watch-detail.ts";
import type { CheckedRelease, RepoState } from "../src/watch-state.ts";

/** Monthly cadence by default; index drives tag and date. */
function check(i: number, score: number, over: Partial<CheckedRelease> = {}): CheckedRelease {
  const year = 2020 + Math.floor(i / 12);
  const month = String((i % 12) + 1).padStart(2, "0");
  return {
    tag: `v${i}`,
    publishedAt: `${year}-${month}-10T00:00:00Z`,
    checkedAt: "2026-07-28T00:00:00Z",
    score,
    scoreLabel: score >= 85 ? "solid" : score >= 65 ? "minor gaps" : "questionable",
    exitCode: 0,
    criticalFlags: 0,
    flagCount: 0,
    flagged: false,
    engine: "off",
    verdicts: { verified: 1, partial: 0, noEvidence: 0, contradicted: 0 },
    report: `o-r/v${i}.html`,
    ...over,
  };
}

function series(scores: number[]): CheckedRelease[] {
  return scores.map((s, i) => check(i, s));
}

function state(history: CheckedRelease[]): RepoState {
  return {
    lastPublishedAt: history.at(-1)?.publishedAt ?? null,
    lastTag: history.at(-1)?.tag ?? null,
    latest: history.at(-1),
    history,
  };
}

test("a stable series is one phase; a confirmed level shift opens a second", () => {
  const stable = segmentPhases(series(Array(20).fill(90)));
  assert.equal(stable.length, 1);
  assert.deepEqual(stable[0], { start: 0, end: 19, reasons: [] });

  const shifted = segmentPhases(series([...Array(10).fill(90), ...Array(10).fill(50)]));
  assert.equal(shifted.length, 2);
  assert.equal(shifted[1].start, 10, "the phase opens where the level moved");
  assert.equal(shifted[1].reasons[0].kind, "level-shift");
  assert.match(shifted[1].reasons[0].text, /fell: 90 → 50/);
});

test("a single outlier release is an event, not a regime change", () => {
  const scores = Array(20).fill(90);
  scores[10] = 20;
  const phases = segmentPhases(series(scores));
  assert.equal(phases.length, 1, "one bad release does not split the history");
});

test("a confirmed top-author change opens a phase; a one-off does not", () => {
  const authored = (name: string) => ({ authors: { total: 3, new: 0, top1Share: 0.6, top1Name: name } });
  const handover = [
    ...Array.from({ length: 8 }, (_, i) => check(i, 90, authored("Alice"))),
    ...Array.from({ length: 8 }, (_, i) => check(8 + i, 90, authored("Mallory"))),
  ];
  const phases = segmentPhases(handover);
  assert.equal(phases.length, 2);
  assert.equal(phases[1].start, 8, "the phase opens exactly at the handover release");
  assert.equal(phases[1].reasons[0].kind, "top-change");
  assert.match(phases[1].reasons[0].text, /Alice → Mallory/);

  const oneOff = [
    ...Array.from({ length: 8 }, (_, i) => check(i, 90, authored("Alice"))),
    check(8, 90, authored("Guest")),
    ...Array.from({ length: 7 }, (_, i) => check(9 + i, 90, authored("Alice"))),
  ];
  assert.equal(segmentPhases(oneOff).length, 1, "a guest release is not a handover");

  // Two DIFFERENT guests in a row: no identity holds the look-ahead window,
  // so nothing is confirmed — the dominance count alone must not suffice.
  const twoGuests = [
    ...Array.from({ length: 8 }, (_, i) => check(i, 90, authored("Alice"))),
    check(8, 90, authored("Guest")),
    check(9, 90, authored("Other")),
    ...Array.from({ length: 6 }, (_, i) => check(10 + i, 90, authored("Alice"))),
  ];
  assert.equal(segmentPhases(twoGuests).length, 1, "unconfirmed churn is not a regime");
});

test("a cadence collapse opens a phase", () => {
  // Monthly for a year, then weekly: the release rhythm is part of the regime.
  const monthly = Array.from({ length: 12 }, (_, i) => check(i, 90));
  const weekly = Array.from({ length: 6 }, (_, i) => ({
    ...check(12 + i, 90),
    publishedAt: `2021-01-${String(3 + i * 7).padStart(2, "0")}T00:00:00Z`,
  }));
  const phases = segmentPhases([...monthly, ...weekly]);
  assert.equal(phases.length, 2);
  assert.equal(phases[1].reasons[0].kind, "cadence");
});

test("events: criticals, flags, broken promises and phase transitions, chronological", () => {
  const history = series([...Array(10).fill(90), ...Array(10).fill(50)]);
  history[3] = check(3, 88, { criticalFlags: 2, flagged: true });
  history[15] = check(15, 50, { brokenPromises: 1 });
  const events = collectEvents(history, undefined, segmentPhases(history));
  const kinds = events.map((e) => e.kind);
  assert.ok(kinds.includes("critical"));
  assert.ok(kinds.includes("level-shift"));
  assert.ok(kinds.includes("broken-promise"));
  assert.ok(!kinds.includes("flagged"), "a critical release is not double-listed as flagged");
  assert.deepEqual(
    events.map((e) => e.idx),
    [...events.map((e) => e.idx)].sort((a, b) => a - b),
    "events read chronologically",
  );
  const critical = events.find((e) => e.kind === "critical")!;
  assert.equal(critical.report, "o-r/v3.html", "each event links its evidence");
});

test("a first-seen identity immediately owning a release is an event — ledger-backed", () => {
  const history = series(Array(LONGVIEW_MIN_CHECKS).fill(90));
  history[7] = check(7, 90, { authors: { total: 2, new: 1, top1Share: 0.8, top1Name: "Newcomer" } });
  const ledger = [
    {
      key: "n@x", name: "Newcomer", firstSeen: "v7", lastSeen: "v7",
      releases: 1, commits: 8, sensitiveCommits: 0, binaryCommits: 0,
    },
  ];
  const events = collectEvents(history, ledger, segmentPhases(history));
  const evt = events.find((e) => e.kind === "new-top-author");
  assert.ok(evt, "the event fires");
  assert.match(evt!.text, /Newcomer/);
  assert.match(evt!.text, /80%/);
  // The same identity topping a LATER release is not "first seen" again.
  const later = [...history];
  later[9] = check(9, 90, { authors: { total: 2, new: 0, top1Share: 0.9, top1Name: "Newcomer" } });
  const laterEvents = collectEvents(later, ledger, segmentPhases(later));
  assert.equal(laterEvents.filter((e) => e.kind === "new-top-author").length, 1);
  // A small first appearance stays out of the log.
  const small = [...history];
  small[7] = check(7, 90, { authors: { total: 5, new: 1, top1Share: 0.2, top1Name: "Newcomer" } });
  assert.equal(
    collectEvents(small, ledger, segmentPhases(small)).filter((e) => e.kind === "new-top-author").length,
    0,
  );
  // Never on the record's first check: every identity is "first seen" there
  // by definition — a maintainer topping their own freshly backfilled repo
  // is not an anomaly (found live on junegunn/fzf).
  const first = series(Array(LONGVIEW_MIN_CHECKS).fill(90));
  first[0] = check(0, 90, { authors: { total: 2, new: 2, top1Share: 0.9, top1Name: "Maintainer" } });
  const firstLedger = [
    {
      key: "m@x", name: "Maintainer", firstSeen: "v0", lastSeen: "v11",
      releases: 12, commits: 90, sensitiveCommits: 0, binaryCommits: 0,
    },
  ];
  assert.equal(
    collectEvents(first, firstLedger, segmentPhases(first)).filter((e) => e.kind === "new-top-author").length,
    0,
  );
});

test("the event selection keeps regime information over routine flags, and says what it dropped", () => {
  // The regime event sits LATE in the record — a plain "first 20" cut
  // would drop exactly the event the log exists for.
  const events: LongviewEvent[] = [
    ...Array.from({ length: 25 }, (_, i) => ({
      idx: i, tag: `v${i}`, date: null, report: "r",
      kind: "flagged" as const, text: "flagged",
    })),
    { idx: 25, tag: "v25", date: null, report: "r", kind: "level-shift", text: "shift" },
  ];
  const { shown, dropped } = selectEvents(events);
  assert.equal(shown.length, 20);
  assert.equal(dropped, 6);
  assert.ok(shown.some((e) => e.kind === "level-shift"), "the regime event survives the cap");
  assert.equal(shown[shown.length - 1].kind, "level-shift", "…and still reads chronologically");
});

test("below the threshold the page stays as it was — no long-view sections", () => {
  const rs = state(series(Array(LONGVIEW_MIN_CHECKS - 1).fill(90)));
  assert.equal(longviewSections(rs, "../"), "");
  const html = toRepoDetailHtml({ key: "o/r", repo: "o/r" }, rs, null, "t");
  assert.ok(!html.includes("Phases"), "detail page has no phases section yet");
});

test("a deep backfilled record renders phases, events, yearly strips and the calendar", () => {
  // 118 monthly checks across a decade: solid years, then a decline regime.
  // The last two months of the final year stay empty — a visible gap.
  const history = series([...Array(60).fill(92), ...Array(58).fill(55)]);
  history[30] = check(30, 90, { criticalFlags: 1, flagged: true });
  const rs = state(history);
  const html = toRepoDetailHtml({ key: "o/r", repo: "o/r" }, rs, 55, "t");
  assert.ok(html.includes("Phases"), "phases section renders");
  assert.ok(html.includes("Event log"), "event log renders");
  assert.ok(html.includes("Yearly distribution"), "yearly section renders");
  assert.ok(html.includes("Release calendar"), "calendar renders");
  assert.match(html, /fell: 92 → 55/, "the transition carries the information");
  assert.ok(html.includes("2020"), "years are labeled");
  assert.ok(html.includes('class="empty"'), "months without releases stay visibly empty");
  assert.ok(html.includes("start of the record"), "the first phase names no fake trigger");
});

test("long-view output escapes hostile tags and author names", () => {
  const HOSTILE = `<img src=x onerror=alert(1)>`;
  const history = series(Array(LONGVIEW_MIN_CHECKS).fill(90)).map((h, i) =>
    i === 5
      ? {
          ...h,
          tag: `v5${HOSTILE}`,
          report: `o-r/v5.html`,
          flagged: true,
          criticalFlags: 1,
          authors: { total: 1, new: 0, top1Share: 1, top1Name: HOSTILE },
        }
      : h,
  );
  const html = longviewSections(state(history), "../");
  assert.ok(!html.includes("<img"), "no payload becomes markup");
});

test("the calendar cell carries count, flag symbol and per-release tooltip — never color alone", () => {
  const history = series(Array(LONGVIEW_MIN_CHECKS).fill(90));
  // Two releases in one month, one flagged.
  history[5] = check(5, 40, { flagged: true });
  history[6] = { ...check(6, 88), publishedAt: history[5].publishedAt };
  const html = longviewSections(state(history), "../");
  assert.ok(html.includes(">2&#9888;</td>") || html.includes(">2⚠</td>"), "count and flag symbol in the cell");
  assert.match(html, /title="[^"]*v5 \(40, flagged\)[^"]*v6 \(88\)/, "tooltip names each release");
});
