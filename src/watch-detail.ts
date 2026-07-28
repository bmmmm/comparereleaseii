// SPDX-License-Identifier: GPL-3.0-or-later
// Per-repo history page, written by watch next to the repo's reports. The
// index answers "which repo needs a look today"; this page answers "what has
// this repo been doing" — the full score series, verdict composition and
// flag history the state already carries but the six trend dots cannot show,
// plus the promise ledger with its carry countdowns.
import { safeSegment } from "./paths.ts";
import { STALE_AFTER } from "./promises.ts";
import type { PromiseCheck } from "./types.ts";
import type { AuthorRecord, CheckedRelease, RepoState, SkippedRelease, WatchedEntry } from "./watch.ts";
import { MAX_CHECK_ATTEMPTS } from "./watch.ts";

/**
 * Where a repo's reports live, relative to the reports root — derived from
 * the stored report path so states written before the sanitized layout keep
 * their nested directories (the history page must land where the index
 * links, and its relative links must climb the right number of levels).
 * Falls back to the sanitized key; a stored path whose segments could
 * escape the root is not trusted.
 */
export function reportDirOf(rs: { latest?: { report: string } }, key: string): string {
  const rel = rs.latest?.report ?? "";
  if (rel.includes("/")) {
    const dir = rel.slice(0, rel.lastIndexOf("/"));
    const segments = dir.split("/");
    if (segments.every((s) => s && s !== "." && s !== ".." && !s.includes("\\"))) return dir;
  }
  return safeSegment(key);
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Same buckets the index uses — a capped "unverified" is never a mid score. */
export function scoreClass(score: number, label: string): string {
  return label === "unverified" ? "unverified" : score >= 85 ? "good" : score >= 65 ? "mid" : "bad";
}

// Status colors, shared with the index dots; identity is never color-alone —
// every mark carries a tooltip and the table repeats the numbers as text.
const CLASS_COLOR: Record<string, string> = {
  good: "#1a7f37",
  mid: "#d4a72c",
  bad: "#cf222e",
  unverified: "#8250df",
};

const VERDICT_SERIES = [
  { key: "verified", symbol: "✔", color: "#3fb950" },
  { key: "partial", symbol: "◐", color: "#d29922" },
  { key: "noEvidence", symbol: "?", color: "#bc8cff" },
  { key: "contradicted", symbol: "✘", color: "#f85149" },
] as const;

const PROMISE_COLOR: Record<PromiseCheck["status"], string> = {
  kept: "#3fb950",
  broken: "#f85149",
  stale: "#b08800",
  "still-open": "#6e7681",
};

/** Shared x layout so the verdict bars sit exactly under their score dots. */
const W = 760;
const PAD_L = 34;
const PAD_R = 14;

function xAt(i: number, n: number): number {
  if (n === 1) return PAD_L + (W - PAD_L - PAD_R) / 2;
  return PAD_L + (i / (n - 1)) * (W - PAD_L - PAD_R);
}

/** Report paths in state are relative to the reports root; `root` is the
 * climb from this page's own directory back up to it. */
function reportHref(root: string, h: CheckedRelease): string {
  return `${root}${h.report}`;
}

function pointTitle(h: CheckedRelease): string {
  return (
    `${h.tag}: ${h.score} (${h.scoreLabel})${h.flagged ? " — flagged" : ""}` +
    `${h.publishedAt ? `\nreleased ${h.publishedAt.slice(0, 10)}` : ""}` +
    `\nchecked ${h.checkedAt.slice(0, 10)}` +
    `${h.criticalFlags ? `\n${h.criticalFlags} critical flag(s)` : ""}`
  );
}

/** Score series 0–100 with the repo's own median as the reference line. */
function scoreChart(history: CheckedRelease[], level: number | null, root: string): string {
  const n = history.length;
  const H = 210;
  const TOP = 10;
  const BOT = 26;
  const y = (v: number) => TOP + (1 - v / 100) * (H - TOP - BOT);
  const grid = [0, 25, 50, 75, 100]
    .map(
      (v) =>
        `<line x1="${PAD_L}" y1="${y(v).toFixed(1)}" x2="${W - PAD_R}" y2="${y(v).toFixed(1)}" class="grid"/>` +
        `<text x="${PAD_L - 6}" y="${(y(v) + 3).toFixed(1)}" class="axis" text-anchor="end">${v}</text>`,
    )
    .join("");
  const median =
    level === null
      ? ""
      : `<line x1="${PAD_L}" y1="${y(level).toFixed(1)}" x2="${W - PAD_R}" y2="${y(level).toFixed(1)}" class="median"><title>this repo&#39;s median: ${level}</title></line>` +
        `<text x="${W - PAD_R}" y="${(y(level) - 4).toFixed(1)}" class="axis" text-anchor="end">median ${level}</text>`;
  const line =
    n >= 2
      ? `<polyline points="${history
          .map((h, i) => `${xAt(i, n).toFixed(1)},${y(h.score).toFixed(1)}`)
          .join(" ")}" class="series"/>`
      : "";
  const dots = history
    .map((h, i) => {
      const cls = scoreClass(h.score, h.scoreLabel);
      const cx = xAt(i, n).toFixed(1);
      const cy = y(h.score).toFixed(1);
      const ring = h.flagged
        ? `<circle cx="${cx}" cy="${cy}" r="7.5" class="flag-ring"/>`
        : "";
      return `<a href="${esc(reportHref(root, h))}">${ring}<circle cx="${cx}" cy="${cy}" r="4.5" fill="${CLASS_COLOR[cls]}" class="pt"><title>${esc(pointTitle(h))}</title></circle></a>`;
    })
    .join("");
  // At most ~8 tag labels — the tooltips carry the rest. The edge labels
  // anchor inward so neither runs off the viewport.
  const step = Math.max(1, Math.ceil(n / 8));
  const labels = history
    .map((h, i) =>
      i % step === 0 || i === n - 1
        ? `<text x="${xAt(i, n).toFixed(1)}" y="${H - 8}" class="axis" text-anchor="${
            i === 0 && n > 1 ? "start" : i === n - 1 ? "end" : "middle"
          }">${esc(h.tag.length > 12 ? `${h.tag.slice(0, 11)}…` : h.tag)}</text>`
        : "",
    )
    .join("");
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Trust score per release">${grid}${median}${line}${dots}${labels}</svg>`;
}

/** Verdict composition per release — status-colored stacked counts, aligned
 * with the score chart above; the releases table repeats the numbers. */
function verdictChart(history: CheckedRelease[], root: string): string {
  const n = history.length;
  const H = 130;
  const TOP = 8;
  const BOT = 8;
  const totals = history.map((h) =>
    VERDICT_SERIES.reduce((s, v) => s + h.verdicts[v.key], 0),
  );
  const max = Math.max(...totals, 1);
  const slot = (W - PAD_L - PAD_R) / n;
  const barW = Math.min(26, Math.max(6, slot * 0.6));
  const scale = (H - TOP - BOT) / max;
  const bars = history
    .map((h, i) => {
      const x = (xAt(i, n) - barW / 2).toFixed(1);
      let yCursor = H - BOT;
      const segs = VERDICT_SERIES.map((v) => {
        const count = h.verdicts[v.key];
        if (!count) return "";
        const hgt = count * scale;
        yCursor -= hgt;
        return `<rect x="${x}" y="${yCursor.toFixed(1)}" width="${barW.toFixed(1)}" height="${hgt.toFixed(1)}" fill="${v.color}" class="seg"><title>${esc(h.tag)}: ${count} ${v.key === "noEvidence" ? "no-evidence" : v.key}</title></rect>`;
      }).join("");
      return `<a href="${esc(reportHref(root, h))}">${segs}</a>`;
    })
    .join("");
  const axis =
    `<text x="${PAD_L - 6}" y="${TOP + 4}" class="axis" text-anchor="end">${max}</text>` +
    `<text x="${PAD_L - 6}" y="${H - BOT}" class="axis" text-anchor="end">0</text>`;
  const legend = VERDICT_SERIES.map(
    (v) =>
      `<span class="lg"><span class="dot" style="background:${v.color}"></span>${v.symbol} ${v.key === "noEvidence" ? "no evidence" : v.key}</span>`,
  ).join("");
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Verdicts per release">${axis}${bars}</svg><div class="legend">${legend}</div>`;
}

function scoreCell(h: CheckedRelease): string {
  const cls = scoreClass(h.score, h.scoreLabel);
  const drop =
    typeof h.scoreLevel === "number" && h.score < h.scoreLevel - 20
      ? ` <span class="dropmark" title="down from this repo's median of ${h.scoreLevel}">&#8595;${h.scoreLevel - h.score}</span>`
      : "";
  const partial = h.warnings?.length
    ? ` <span class="notice" title="${esc(h.warnings.join(" · "))}">&#9888; partial data</span>`
    : "";
  const broken = h.brokenPromises
    ? ` <span class="notice" title="an earlier release promised a change this release was due to ship">&#9888; ${h.brokenPromises} broken promise${h.brokenPromises > 1 ? "s" : ""}</span>`
    : "";
  return `<span class="score ${cls}">${h.score}</span> ${esc(h.scoreLabel)}${drop}${partial}${broken}`;
}

function releasesTable(history: CheckedRelease[], root: string): string {
  const rows = [...history]
    .reverse()
    .map((h) => {
      const v = h.verdicts;
      const comp = h.components
        ? `${h.components.correctness} · ${h.components.completeness ?? "–"} · ${h.components.risk}`
        : "";
      const authors = h.authors
        ? `<span title="top identity authored ${Math.round(h.authors.top1Share * 100)}% of this release's commits">${h.authors.total}${
            h.authors.new ? ` <span class="notice" title="identities this watcher had never seen before">${h.authors.new} new</span>` : ""
          }</span>`
        : "";
      return `<tr class="${h.flagged ? "flagged" : ""}">
<td>${h.flagged ? "&#9888;" : "&#10003;"}</td>
<td><a href="${esc(reportHref(root, h))}">${esc(h.tag)}</a></td>
<td>${h.publishedAt ? esc(h.publishedAt.slice(0, 10)) : ""}</td>
<td>${scoreCell(h)}</td>
<td class="comp">${comp}</td>
<td>${v.verified}&#10004; ${v.partial}&#9680; ${v.noEvidence}? ${v.contradicted}&#10008;</td>
<td>${h.criticalFlags ? `<b>${h.criticalFlags} critical</b> / ${h.flagCount}` : h.flagCount || ""}</td>
<td>${authors}</td>
<td title="${esc(h.checkedAt)}">${esc(h.checkedAt.slice(0, 10))}</td>
</tr>`;
    })
    .join("\n");
  return `<table>
<thead><tr><th></th><th>release</th><th>released</th><th>trust score</th><th>c &middot; c &middot; r</th><th>verdicts</th><th>flags</th><th title="identities with commits in the release (new = never seen by this watcher)">authors</th><th>checked</th></tr></thead>
<tbody>
${rows}
</tbody></table>`;
}

/**
 * Name or account says it's automation. Word-bounded so Botond and Abbot
 * stay human; a wrong "bot" chip on a person is a mislabel, so the pattern
 * errs narrow.
 */
export function isBotAuthor(name: string, logins?: Array<string | null>): boolean {
  // Each candidate on its own — joining them would break the ^ anchors.
  const re = /\[bot\]|(^|[^a-z])bot([^a-z]|$)|^(dependabot|renovate|github-actions)/i;
  return [name, ...(logins ?? [])].some((s) => s !== null && re.test(s));
}

/** How the forge attribution reads as a neutral fact. */
function accountCell(logins: Array<string | null> | undefined): string {
  if (!logins || logins.length === 0) return `<span class="mutedcell">—</span>`;
  const parts = logins.map((l) => (l === null ? "no account" : `@${esc(l)}`));
  const changed = logins.length > 1;
  return `<span${changed ? ' class="notice" title="attribution changed across releases — the git email is forgeable, the account is not"' : ""}>${parts.join(", ")}</span>`;
}

/** The accumulated ledger as a table — facts per identity, no ratings. */
function authorsSection(ledger: AuthorRecord[], evicted: boolean): string {
  const rows = [...ledger]
    .sort((x, y) => y.commits - x.commits)
    .map(
      (a) => `<tr>
<td>${esc(a.name)}${isBotAuthor(a.name, a.logins) ? ` <span class="bot">bot</span>` : ""}</td>
<td>${accountCell(a.logins)}</td>
<td>${esc(a.firstSeen)}</td>
<td>${a.releases}</td>
<td>${a.commits}</td>
<td>${a.sensitiveCommits || ""}</td>
<td>${a.binaryCommits || ""}</td>
</tr>`,
    )
    .join("\n");
  return `<h2>Authors <span class="note">— identity facts accumulated over the checked releases; not a trust rating in either direction</span></h2>
${
    evicted
      ? `<p class="note">the ledger is capped, and identities have been evicted — a returning evicted identity recounts as "new", so first-appearance counts are an upper bound here</p>`
      : ""
  }<table>
<thead><tr><th>author</th><th>account</th><th>first seen</th><th>releases</th><th>commits</th><th title="commits touching dependency manifests, CI or auth/crypto paths">sensitive</th><th title="commits changing opaque binary files">binary</th></tr></thead>
<tbody>
${rows}
</tbody></table>`;
}

function promisesSection(promises: PromiseCheck[]): string {
  const entries = promises
    .map((p) => {
      const color = PROMISE_COLOR[p.status];
      const carry =
        p.status === "still-open"
          ? ` <span class="notice" title="a still-open promise leaves the ledger as stale after ${STALE_AFTER} carries">carry ${p.carriedFor ?? 0}/${STALE_AFTER} until stale</span>`
          : "";
      return `<div class="flag" style="border-left-color:${color}"><span class="chip" style="background:${color}">${p.status}</span> <b>${esc(p.from)}</b> ${esc(p.text)}${carry}<div class="files">${esc(p.note)}${p.target ? ` — target: ${esc(p.target)}` : ""}${p.files.length ? ` — ${esc(p.files.slice(0, 3).join(", "))}` : ""}</div></div>`;
    })
    .join("");
  return `<h2>Promise ledger <span class="note">— forward-looking notes tracked across releases; informational, never scored</span></h2>${entries}`;
}

/** Releases watch gave up on — shown so a skip is never silent: a gap in
 * the score series must be readable as "unchecked", not "fine". */
function skippedSection(skipped: SkippedRelease[]): string {
  const rows = [...skipped]
    .reverse()
    .map(
      (s) =>
        `<tr><td>${esc(s.tag)}</td><td>${s.publishedAt ? esc(s.publishedAt.slice(0, 10)) : ""}</td><td>${s.attempts}</td><td class="files">${esc(s.lastError)}</td><td title="${esc(s.skippedAt)}">${esc(s.skippedAt.slice(0, 10))}</td></tr>`,
    )
    .join("\n");
  return `<h2>Unchecked releases <span class="note">— checking failed ${MAX_CHECK_ATTEMPTS} runs in a row, so watch moved past them; no score exists for these</span></h2>
<table>
<thead><tr><th>release</th><th>released</th><th>attempts</th><th>last error</th><th>skipped</th></tr></thead>
<tbody>
${rows}
</tbody></table>`;
}

/**
 * The whole page from one repo's state. `level` is the repo's own median as
 * `scoreBaseline` computes it over the recorded history — passed in so this
 * module cannot drift from that one source of truth.
 */
export function toRepoDetailHtml(
  entry: WatchedEntry,
  rs: RepoState,
  level: number | null,
  generatedAt: string,
): string {
  const history = rs.history;
  const latest = rs.latest;
  const root = "../".repeat(reportDirOf(rs, entry.key).split("/").length);
  const repoLink = entry.url ?? (entry.repo.includes("/") && !entry.repo.includes("://")
    ? `https://github.com/${entry.repo}`
    : null);
  const title = `${entry.repo} — release watch history`;
  const flaggedCount = history.filter((h) => h.flagged).length;
  const stillOpen = (rs.promises ?? []).filter((p) => p.status === "still-open").length;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{color-scheme:light dark;
--bg:#ffffff;--card:#f6f8fa;--border:#d1d9e0;--fg:#1f2328;--muted:#59636e;--faint:#818b98;
--link:#0969da;--accent:#0969da;--flagged-bg:#fff1f0}
@media (prefers-color-scheme:dark){:root{
--bg:#0d1117;--card:#161b22;--border:#21262d;--fg:#e6edf3;--muted:#8b949e;--faint:#484f58;
--link:#58a6ff;--accent:#1f6feb;--flagged-bg:#3c1618}}
body{background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif;margin:2rem auto;max-width:60rem;padding:0 1rem}
h1{font-size:1.3rem;margin-bottom:2px} h2{font-size:15px;margin:26px 0 8px;border-bottom:1px solid var(--border);padding-bottom:5px}
.sub{color:var(--muted);margin-bottom:14px}
a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}
a.repo{color:inherit}
.cards{display:flex;gap:26px;flex-wrap:wrap;background:var(--card);border:1px solid var(--border);border-radius:10px;padding:12px 16px;margin:12px 0}
.cards div{text-align:center}.cards .n{font-size:20px;font-weight:700}.cards .t{color:var(--muted);font-size:12px}
svg{width:100%;height:auto}
.grid{stroke:var(--border);stroke-width:1}
.axis{font-size:9px;fill:var(--muted)}
.series{fill:none;stroke:var(--accent);stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
.median{stroke:var(--muted);stroke-width:1;stroke-dasharray:4 3}
.flag-ring{fill:none;stroke:#cf222e;stroke-width:1.5}
.seg{stroke:var(--bg);stroke-width:1}
.legend{color:var(--muted);font-size:12px;margin-top:2px}.lg{margin-right:14px}.dot{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:4px;vertical-align:-1px}
.score{display:inline-block;min-width:2.2em;text-align:center;border-radius:.6em;padding:0 .35em;font-weight:600;color:#fff}
.score.good{background:#1a7f37}.score.mid{background:#9a6700}.score.bad{background:#cf222e}.score.unverified{background:#8250df}
.dropmark{display:inline-block;border:1px solid #cf222e;color:#cf222e;border-radius:.6em;padding:0 .4em;font-size:.8em}
.notice{display:inline-block;border:1px solid #9a6700;color:#9a6700;border-radius:.6em;padding:0 .4em;font-size:.8em;white-space:nowrap}
.bot{display:inline-block;border:1px solid var(--muted);color:var(--muted);border-radius:.6em;padding:0 .4em;font-size:.8em}
.mutedcell{color:var(--muted)}
@media (prefers-color-scheme:dark){.notice{border-color:#d29922;color:#d29922}}
table{border-collapse:collapse;width:100%;margin-top:6px}
th,td{text-align:left;padding:.4rem .55rem;border-bottom:1px solid var(--border);font-size:13px}
th{font-size:.75rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
tr.flagged{background:var(--flagged-bg)}
.comp{color:var(--muted);white-space:nowrap}
.flag{background:var(--card);border:1px solid var(--border);border-left:4px solid;border-radius:6px;padding:8px 12px;margin:6px 0}
.chip{color:#fff;font-weight:700;font-size:11px;padding:1px 7px;border-radius:9px;margin-right:6px;text-shadow:0 0 2px rgba(0,0,0,.35)}
.files{color:var(--muted);font-size:12px;font-family:ui-monospace,monospace}
.note{color:var(--muted);font-size:12px;font-weight:400;text-transform:none;letter-spacing:0}
footer{margin-top:28px;color:var(--faint);font-size:12px}
</style></head><body>
<h1>${
    repoLink
      ? `<a class="repo" href="${esc(repoLink)}" target="_blank" rel="noopener">${esc(entry.repo)}</a>`
      : esc(entry.repo)
  } <span class="note">release watch history</span></h1>
<p class="sub"><a href="${esc(root)}index.html">&larr; all watched repos</a> · ${history.length} check${history.length === 1 ? "" : "s"} on record · generated ${esc(generatedAt)}</p>
${
  latest
    ? `<div class="cards">
  <div><div class="n">${scoreCell(latest)}</div><div class="t">latest: ${esc(latest.tag)}</div></div>
  <div><div class="n">${level ?? "–"}</div><div class="t">median of recorded checks</div></div>
  <div><div class="n">${flaggedCount}</div><div class="t">flagged of last ${history.length}</div></div>${
    stillOpen
      ? `\n  <div><div class="n">${stillOpen}</div><div class="t">promise${stillOpen === 1 ? "" : "s"} still open</div></div>`
      : ""
  }
</div>`
    : ""
}
<h2>Trust score over time <span class="note">— dots open that release&#39;s report; red ring = flagged</span></h2>
${scoreChart(history, level, root)}
<h2>Verdicts per release <span class="note">— claim verdict composition of each check</span></h2>
${verdictChart(history, root)}
<h2>Checked releases</h2>
${releasesTable(history, root)}
${rs.skipped?.length ? skippedSection(rs.skipped) : ""}
${rs.authors?.length ? authorsSection(rs.authors, rs.authorsEvicted ?? false) : ""}
${rs.promises?.length ? promisesSection(rs.promises) : ""}
<footer>generated by <a href="https://github.com/bmmmm/comparereleaseii">comparereleaseii</a> · <a href="https://github.com/bmmmm/comparereleaseii/blob/main/SCORING.md">how the score works</a></footer>
</body></html>
`;
}
