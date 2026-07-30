// SPDX-License-Identifier: GPL-3.0-or-later
// The long view: once a repo's record is deep enough, the unit of narrative
// is not the release — it is the phase and the exception. "Is this still the
// project I trusted three years ago, and if not, when did it change?" is a
// regime question no score line answers (the xz pattern IS a regime change).
// Everything here derives deterministically from the watch state: no judge,
// no network — which is what makes the detections unit-testable.
import { esc } from "./util.ts";
import { scoreClass } from "./theme.ts";
import type { AuthorRecord, CheckedRelease, RepoState } from "./watch-state.ts";

/** Below this many checks the score chart already tells the whole story. */
export const LONGVIEW_MIN_CHECKS = 12;

/** A score-level move this large opens a new phase — same magnitude the
 * relative alert calls a drop, so "phase" and "alert" speak one language. */
export const PHASE_SHIFT = 20;
/** Checks after a candidate change point that must confirm it — one outlier
 * release is an event, not a regime. */
const PHASE_CONFIRM = 3;
/** A phase must be at least this long before it can be broken. */
const PHASE_MIN = 3;
/** Top-identity commit share move that counts as a concentration change. */
const CONCENTRATION_SHIFT = 0.35;
/** Median release-interval factor that counts as a cadence change. */
const CADENCE_FACTOR = 3;
/** A first-seen identity immediately owning this share of a release's
 * commits is worth a line in the event log. */
const NEW_TOP_SHARE = 0.5;
/** Events shown; the selection is announced, never silent. */
const EVENTS_MAX = 20;

export type EventKind =
  | "level-shift"
  | "top-change"
  | "concentration"
  | "cadence"
  | "critical"
  | "flagged"
  | "broken-promise"
  | "new-top-author";

export interface PhaseReason {
  kind: Extract<EventKind, "level-shift" | "top-change" | "concentration" | "cadence">;
  text: string;
}

export interface Phase {
  /** Inclusive indices into the (chronological) history. */
  start: number;
  end: number;
  /** What opened this phase — empty for the first. */
  reasons: PhaseReason[];
}

function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Days between consecutive published dates — undated checks drop out. */
function gapsDays(checks: CheckedRelease[]): number[] {
  const dates = checks
    .map((h) => (h.publishedAt ? Date.parse(h.publishedAt) : NaN))
    .filter((t) => !Number.isNaN(t));
  const out: number[] = [];
  for (let i = 1; i < dates.length; i++) out.push((dates[i] - dates[i - 1]) / 86400000);
  return out;
}

function shares(checks: CheckedRelease[]): number[] {
  return checks.map((h) => h.authors?.top1Share).filter((s): s is number => typeof s === "number");
}

/** The identity that tops most checks of the stretch; ties go to the one
 * seen first (Map insertion order — deterministic). */
function dominantTop(checks: CheckedRelease[]): string | null {
  const counts = new Map<string, number>();
  for (const h of checks) {
    const t = h.authors?.top1Name;
    if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [name, count] of counts) {
    if (count > bestCount) {
      best = name;
      bestCount = count;
    }
  }
  return best;
}

const pct = (share: number) => `${Math.round(share * 100)}%`;

/**
 * Why the stretch after `cur` is a different regime — empty reasons when it
 * isn't. `offset` snaps the boundary to the first look-ahead check that
 * itself reads as the new regime: the median look-ahead trips as soon as a
 * MAJORITY of the window has moved, which is one check before the move when
 * the last old-regime release still sits at the window's head.
 */
function breakReasons(
  cur: CheckedRelease[],
  ahead: CheckedRelease[],
): { reasons: PhaseReason[]; offset: number } {
  const reasons: PhaseReason[] = [];
  const medCur = median(cur.slice(-5).map((h) => h.score))!;
  const medAhead = median(ahead.map((h) => h.score))!;
  if (Math.abs(medAhead - medCur) >= PHASE_SHIFT) {
    reasons.push({
      kind: "level-shift",
      text: `score level ${medAhead > medCur ? "rose" : "fell"}: ${Math.round(medCur)} → ${Math.round(medAhead)}`,
    });
  }
  const topCur = dominantTop(cur);
  const topAhead = dominantTop(ahead);
  const aheadCount = ahead.filter((h) => h.authors?.top1Name === topAhead).length;
  if (topCur && topAhead && topCur !== topAhead && aheadCount >= 2) {
    reasons.push({ kind: "top-change", text: `top author changed: ${topCur} → ${topAhead}` });
  }
  const shareCur = median(shares(cur));
  const shareAhead = median(shares(ahead));
  if (
    shareCur !== null &&
    shareAhead !== null &&
    Math.abs(shareAhead - shareCur) >= CONCENTRATION_SHIFT
  ) {
    reasons.push({
      kind: "concentration",
      text: `commit concentration ${shareAhead > shareCur ? "jumped" : "spread out"}: top identity ${pct(shareCur)} → ${pct(shareAhead)}`,
    });
  }
  const gapCur = median(gapsDays(cur));
  const gapAhead = median(gapsDays([cur[cur.length - 1], ...ahead]));
  if (
    gapCur !== null &&
    gapAhead !== null &&
    gapCur >= 1 &&
    gapAhead >= 1 &&
    (gapAhead >= gapCur * CADENCE_FACTOR || gapAhead <= gapCur / CADENCE_FACTOR)
  ) {
    reasons.push({
      kind: "cadence",
      text: `release cadence changed: every ~${Math.round(gapCur)} days → ~${Math.round(gapAhead)} days`,
    });
  }
  if (!reasons.length) return { reasons, offset: 0 };
  // Judged by the first (highest-priority) reason's own criterion.
  const belongs = (h: CheckedRelease): boolean => {
    switch (reasons[0].kind) {
      case "level-shift":
        return Math.abs(h.score - medAhead) <= Math.abs(h.score - medCur);
      case "top-change":
        return h.authors?.top1Name === topAhead;
      case "concentration": {
        const s = h.authors?.top1Share;
        return (
          typeof s === "number" && Math.abs(s - shareAhead!) <= Math.abs(s - shareCur!)
        );
      }
      case "cadence":
        return true;
    }
  };
  const idx = ahead.findIndex(belongs);
  return { reasons, offset: idx > 0 ? idx : 0 };
}

/**
 * Segment the history into stretches of stable behavior. A change point
 * needs PHASE_CONFIRM checks behind it agreeing that the level moved — a
 * single outlier stays an event. The last PHASE_CONFIRM−1 checks can never
 * open a phase of their own; until confirmed they read as part of the
 * current one.
 */
export function segmentPhases(history: CheckedRelease[]): Phase[] {
  if (!history.length) return [];
  const boundaries: Array<{ at: number; reasons: PhaseReason[] }> = [];
  let start = 0;
  for (let i = 1; i + PHASE_CONFIRM <= history.length; i++) {
    if (i - start < PHASE_MIN) continue;
    const { reasons, offset } = breakReasons(
      history.slice(start, i),
      history.slice(i, i + PHASE_CONFIRM),
    );
    if (reasons.length) {
      boundaries.push({ at: i + offset, reasons });
      start = i + offset;
    }
  }
  const phases: Phase[] = [];
  let s = 0;
  let why: PhaseReason[] = [];
  for (const b of boundaries) {
    phases.push({ start: s, end: b.at - 1, reasons: why });
    s = b.at;
    why = b.reasons;
  }
  phases.push({ start: s, end: history.length - 1, reasons: why });
  return phases;
}

export interface LongviewEvent {
  idx: number;
  tag: string;
  date: string | null;
  report: string;
  kind: EventKind;
  text: string;
}

/**
 * The 10–20 things that stood out across the record — facts only, each
 * linking its evidence. The framing rule of the page applies: behaviors and
 * transitions, never insinuations about people.
 */
export function collectEvents(
  history: CheckedRelease[],
  ledger: AuthorRecord[] | undefined,
  phases: Phase[],
): LongviewEvent[] {
  const events: LongviewEvent[] = [];
  const at = (i: number) => ({
    idx: i,
    tag: history[i].tag,
    date: history[i].publishedAt,
    report: history[i].report,
  });
  for (const p of phases) {
    for (const r of p.reasons) events.push({ ...at(p.start), kind: r.kind, text: r.text });
  }
  for (let i = 0; i < history.length; i++) {
    const h = history[i];
    if (h.criticalFlags > 0) {
      events.push({
        ...at(i),
        kind: "critical",
        text: `${h.criticalFlags} critical flag${h.criticalFlags > 1 ? "s" : ""}, scored ${h.score} (${h.scoreLabel})`,
      });
    } else if (h.flagged) {
      events.push({ ...at(i), kind: "flagged", text: `flagged at ${h.score} (${h.scoreLabel})` });
    }
    if (h.brokenPromises) {
      events.push({
        ...at(i),
        kind: "broken-promise",
        text: `${h.brokenPromises} promise${h.brokenPromises > 1 ? "s" : ""} from earlier notes broken`,
      });
    }
    const top = h.authors?.top1Name;
    // Never on the record's first check: there "first seen" is true of every
    // identity by definition — the maintainer topping their own repo would
    // read as an anomaly on every freshly backfilled history.
    if (
      i > 0 &&
      top &&
      (h.authors?.top1Share ?? 0) >= NEW_TOP_SHARE &&
      ledger?.some((a) => a.name === top && a.firstSeen === h.tag)
    ) {
      events.push({
        ...at(i),
        kind: "new-top-author",
        text: `${top}, first seen in this release, authored ${pct(h.authors!.top1Share)} of its commits`,
      });
    }
  }
  return events.sort((a, b) => a.idx - b.idx || a.kind.localeCompare(b.kind));
}

/** Regime information first, routine flags last — what the cap keeps when
 * a long record has more to say than a page should. */
const EVENT_PRIORITY: Record<EventKind, number> = {
  "level-shift": 0,
  "top-change": 1,
  concentration: 2,
  cadence: 3,
  critical: 4,
  "new-top-author": 5,
  "broken-promise": 6,
  flagged: 7,
};

export function selectEvents(events: LongviewEvent[]): { shown: LongviewEvent[]; dropped: number } {
  if (events.length <= EVENTS_MAX) return { shown: events, dropped: 0 };
  const shown = [...events]
    .sort((a, b) => EVENT_PRIORITY[a.kind] - EVENT_PRIORITY[b.kind] || a.idx - b.idx)
    .slice(0, EVENTS_MAX)
    .sort((a, b) => a.idx - b.idx || a.kind.localeCompare(b.kind));
  return { shown, dropped: events.length - EVENTS_MAX };
}

const EVENT_LABEL: Record<EventKind, string> = {
  "level-shift": "level shift",
  "top-change": "top author",
  concentration: "concentration",
  cadence: "cadence",
  critical: "critical",
  flagged: "flagged",
  "broken-promise": "broken promise",
  "new-top-author": "new top author",
};

function dateOf(h: CheckedRelease): string {
  return (h.publishedAt ?? h.checkedAt).slice(0, 10);
}

function phasesSection(history: CheckedRelease[], phases: Phase[]): string {
  const rows = phases
    .map((p) => {
      const checks = history.slice(p.start, p.end + 1);
      const scores = checks.map((h) => h.score);
      const min = Math.min(...scores);
      const max = Math.max(...scores);
      const med = Math.round(median(scores)!);
      const authorsMed = median(
        checks.map((h) => h.authors?.total).filter((n): n is number => typeof n === "number"),
      );
      const shareMed = median(shares(checks));
      const gapMed = median(gapsDays(checks));
      const flagged = checks.filter((h) => h.flagged).length;
      const criticals = checks.reduce((s, h) => s + h.criticalFlags, 0);
      const broken = checks.reduce((s, h) => s + (h.brokenPromises ?? 0), 0);
      const issues = [
        flagged ? `${flagged} flagged` : "",
        criticals ? `${criticals} critical` : "",
        broken ? `${broken} broken promise${broken > 1 ? "s" : ""}` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      const opened = p.reasons.length
        ? p.reasons.map((r) => esc(r.text)).join("<br>")
        : `<span class="mutedcell">start of the record</span>`;
      return `<tr>
<td>${esc(dateOf(checks[0]))} – ${esc(dateOf(checks[checks.length - 1]))}</td>
<td>${esc(checks[0].tag)} → ${esc(checks[checks.length - 1].tag)} <span class="mutedcell">(${checks.length})</span></td>
<td><span class="score ${scoreClass(med, "")}">${med}</span> <span class="mutedcell">${min}–${max}</span></td>
<td>${authorsMed !== null ? `${Math.round(authorsMed)} <span class="mutedcell">· top ${shareMed !== null ? pct(shareMed) : "?"}</span>` : `<span class="mutedcell">—</span>`}</td>
<td>${gapMed !== null ? `~${Math.round(gapMed)}d` : `<span class="mutedcell">—</span>`}</td>
<td>${issues || `<span class="mutedcell">—</span>`}</td>
<td class="opened">${opened}</td>
</tr>`;
    })
    .join("\n");
  return `<h2>Phases <span class="note">— stretches of stable behavior; the transitions carry the information</span></h2>
<table>
<thead><tr><th>period</th><th>releases</th><th title="median, with the phase's min–max range">score</th><th title="median identities per release · top identity's median commit share">authors</th><th title="median days between releases">cadence</th><th>issues</th><th>opened by</th></tr></thead>
<tbody>
${rows}
</tbody></table>`;
}

function eventsSection(events: LongviewEvent[], root: string): string {
  const { shown, dropped } = selectEvents(events);
  if (!shown.length) return "";
  const rows = shown
    .map(
      (e) =>
        `<li><span class="when">${esc(e.date ? e.date.slice(0, 10) : "")}</span> <span class="evt">${EVENT_LABEL[e.kind]}</span> ${esc(e.text)} — <a href="${esc(root + e.report)}">${esc(e.tag)}</a></li>`,
    )
    .join("\n");
  return `<h2>Event log <span class="note">— what stood out across the record; facts only, each links its evidence</span></h2>
${dropped ? `<p class="note">showing the ${EVENTS_MAX} most significant of ${EVENTS_MAX + dropped} events — the releases table below has every check.</p>` : ""}<ol class="events">
${rows}
</ol>`;
}

/** Strip geometry, shared by the yearly rows. */
const STRIP_W = 240;
const STRIP_H = 18;

function yearlyStrip(checks: CheckedRelease[], root: string): string {
  const x = (score: number) => 4 + (score / 100) * (STRIP_W - 8);
  const scores = checks.map((h) => h.score);
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const med = median(scores)!;
  const mid = STRIP_H / 2;
  const dots = checks
    .map((h) => {
      const cls = scoreClass(h.score, h.scoreLabel);
      return `<a href="${esc(root + h.report)}"><circle cx="${x(h.score).toFixed(1)}" cy="${mid}" r="3" class="sd ${cls}"><title>${esc(`${h.tag}: ${h.score} (${h.scoreLabel})${h.flagged ? " — flagged" : ""}`)}</title></circle></a>`;
    })
    .join("");
  return `<svg viewBox="0 0 ${STRIP_W} ${STRIP_H}" class="strip" role="img" aria-label="score range">
<line x1="${x(0)}" y1="${mid}" x2="${x(100)}" y2="${mid}" class="axisline"/>
<line x1="${x(min).toFixed(1)}" y1="${mid}" x2="${x(max).toFixed(1)}" y2="${mid}" class="range"/>
<line x1="${x(med).toFixed(1)}" y1="2" x2="${x(med).toFixed(1)}" y2="${STRIP_H - 2}" class="medtick"/>
${dots}</svg>`;
}

function yearlySection(history: CheckedRelease[], root: string): string {
  const byYear = new Map<string, CheckedRelease[]>();
  for (const h of history) {
    const year = (h.publishedAt ?? h.checkedAt).slice(0, 4);
    byYear.set(year, [...(byYear.get(year) ?? []), h]);
  }
  const rows = [...byYear.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([year, checks]) => {
      const scores = checks.map((h) => h.score);
      const flagged = checks.filter((h) => h.flagged).length;
      return `<tr>
<td>${esc(year)}</td>
<td>${checks.length}</td>
<td>${yearlyStrip(checks, root)}</td>
<td class="mutedcell">${Math.min(...scores)} · ${Math.round(median(scores)!)} · ${Math.max(...scores)}</td>
<td>${flagged ? `&#9888; ${flagged}` : ""}</td>
</tr>`;
    })
    .join("\n");
  return `<h2>Yearly distribution <span class="note">— each dot is a checked release and opens its report; the tick is the year&#39;s median</span></h2>
<table class="yearly">
<thead><tr><th>year</th><th>checks</th><th>scores 0–100</th><th>min · median · max</th><th>flagged</th></tr></thead>
<tbody>
${rows}
</tbody></table>`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function heatmapSection(history: CheckedRelease[]): string {
  const byMonth = new Map<string, CheckedRelease[]>();
  for (const h of history) {
    const month = (h.publishedAt ?? h.checkedAt).slice(0, 7);
    byMonth.set(month, [...(byMonth.get(month) ?? []), h]);
  }
  const years = [...new Set([...byMonth.keys()].map((m) => m.slice(0, 4)))].sort();
  const from = Number(years[0]);
  const to = Number(years[years.length - 1]);
  const rows: string[] = [];
  for (let y = from; y <= to; y++) {
    const cells = MONTHS.map((label, i) => {
      const key = `${y}-${String(i + 1).padStart(2, "0")}`;
      const checks = byMonth.get(key);
      if (!checks?.length) return `<td class="empty"></td>`;
      const med = Math.round(median(checks.map((h) => h.score))!);
      const allUnverified = checks.every((h) => h.scoreLabel === "unverified");
      const cls = scoreClass(med, allUnverified ? "unverified" : "");
      const flagged = checks.some((h) => h.flagged);
      const title = `${label} ${y}: ${checks.map((h) => `${h.tag} (${h.score}${h.flagged ? ", flagged" : ""})`).join(", ")}`;
      return `<td class="m ${cls}" title="${esc(title)}">${checks.length}${flagged ? "&#9888;" : ""}</td>`;
    }).join("");
    rows.push(`<tr><td class="y">${y}</td>${cells}</tr>`);
  }
  return `<h2>Release calendar <span class="note">— one cell per month, count of releases, color = the month&#39;s median score bucket; empty cells are months without a checked release</span></h2>
<table class="heat">
<thead><tr><th></th>${MONTHS.map((m) => `<th>${m}</th>`).join("")}</tr></thead>
<tbody>
${rows.join("\n")}
</tbody></table>`;
}

/**
 * All long-view sections, or "" while the record is too shallow — the page
 * grows once enough checks exist; no second page. Deterministic from state
 * alone: works identically with `--judge off`.
 */
export function longviewSections(rs: RepoState, root: string): string {
  const history = rs.history;
  if (history.length < LONGVIEW_MIN_CHECKS) return "";
  const phases = segmentPhases(history);
  const events = collectEvents(history, rs.authors, phases);
  return [
    phasesSection(history, phases),
    eventsSection(events, root),
    yearlySection(history, root),
    heatmapSection(history),
  ].join("\n");
}
