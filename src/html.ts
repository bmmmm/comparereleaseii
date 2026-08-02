// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from "node:crypto";
import { esc } from "./util.ts";
import { SCORE_MINOR, SCORE_QUESTIONABLE, SCORE_SOLID } from "./theme.ts";
import { carriedOver, countVerdicts, unverifiableNote } from "./report.ts";
import { scoreBreakdown, type ScoreStep } from "./metrics.ts";
import type { FileInsight, PinBump, Report, RiskFlag, Verdict } from "./types.ts";

/** GitHub's file anchor on compare pages: "diff-" + sha256(path). */
function diffAnchor(path: string): string {
  return "diff-" + createHash("sha256").update(path).digest("hex");
}

type LinkStyle = "github" | "gitlab";

/**
 * Refs are hostile: `git check-ref-format` accepts a tag called
 * `v1.0"><img/src=x/onerror=…>`, and that tag reaches us as `headRef`
 * straight from the release API. Percent-encode the ref, then escape the
 * whole URL for the attribute it is going into.
 *
 * GitHub and Forgejo/Gitea share their commit/compare route shape; GitLab
 * prefixes both with `/-/`.
 */
function commitUrl(linkBase: string, sha: string, style: LinkStyle = "github"): string {
  const route = style === "gitlab" ? "/-/commit/" : "/commit/";
  return esc(`${linkBase}${route}${encodeURIComponent(sha)}`);
}

function compareUrlOf(
  linkBase: string,
  baseRef: string,
  headRef: string,
  style: LinkStyle = "github",
): string {
  const route = style === "gitlab" ? "/-/compare/" : "/compare/";
  return esc(
    `${linkBase}${route}${encodeURIComponent(baseRef)}...${encodeURIComponent(headRef)}`,
  );
}

const VERDICT_COLOR: Record<Verdict, string> = {
  verified: "#3fb950",
  partial: "#d29922",
  "no-evidence": "#bc8cff",
  contradicted: "#f85149",
  skipped: "#6e7681",
};

const COVERAGE_COLOR: Record<FileInsight["coverage"], string> = {
  evidence: "#2ea043",
  covered: "#1f6feb",
  undocumented: "#da3633",
  unknown: "#6e7681",
};

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  file: FileInsight;
}

/** Squarified treemap layout into a fixed viewport. */
export function layoutTreemap(
  files: FileInsight[],
  width: number,
  height: number,
): Rect[] {
  const items = files.filter((f) => f.churn > 0);
  if (!items.length) return [];
  const totalValue = items.reduce((s, f) => s + f.churn, 0);
  const scale = (width * height) / totalValue;
  let remaining = items
    .map((f) => ({ file: f, area: f.churn * scale }))
    .sort((a, b) => b.area - a.area);

  const out: Rect[] = [];
  let x = 0;
  let y = 0;
  let w = width;
  let h = height;

  const worst = (row: Array<{ area: number }>, side: number): number => {
    const total = row.reduce((s, r) => s + r.area, 0);
    const thickness = total / side;
    let m = 0;
    for (const r of row) {
      const len = r.area / thickness;
      m = Math.max(m, len / thickness, thickness / len);
    }
    return m;
  };

  while (remaining.length) {
    const vertical = w < h;
    const side = vertical ? w : h;
    let count = 1;
    let best = worst(remaining.slice(0, 1), side);
    while (count < remaining.length) {
      const next = worst(remaining.slice(0, count + 1), side);
      if (next <= best) {
        best = next;
        count++;
      } else break;
    }
    const row = remaining.slice(0, count);
    remaining = remaining.slice(count);
    const rowArea = row.reduce((s, r) => s + r.area, 0);
    const thickness = rowArea / side;
    let offset = 0;
    for (const r of row) {
      const len = r.area / thickness;
      out.push(
        vertical
          ? { x: x + offset, y, w: len, h: thickness, file: r.file }
          : { x, y: y + offset, w: thickness, h: len, file: r.file },
      );
      offset += len;
    }
    if (vertical) {
      y += thickness;
      h -= thickness;
    } else {
      x += thickness;
      w -= thickness;
    }
    if (w <= 0.1 || h <= 0.1) break;
  }
  return out;
}

/**
 * One inline sparkline for the baseline trend: single series, so no legend —
 * the label next to it names it; values live in a native title tooltip.
 */
function sparkline(points: Array<{ label: string; value: number }>, title: string): string {
  if (points.length < 2) return "";
  const W = 84;
  const H = 18;
  const PAD = 3;
  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const x = (i: number) => PAD + (i / (points.length - 1)) * (W - 2 * PAD);
  const y = (v: number) => H - PAD - ((v - min) / span) * (H - 2 * PAD);
  const path = points.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const last = points[points.length - 1];
  const tip = `${title}\n${points.map((p) => `${p.label}: ${p.value}`).join("\n")}`;
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}"><title>${esc(tip)}</title><polyline points="${path}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${x(points.length - 1).toFixed(1)}" cy="${y(last.value).toFixed(1)}" r="2.5" fill="var(--accent)"/></svg>`;
}

function treemapSvg(files: FileInsight[], compareUrl?: string, anchors = true): string {
  const MAX_TILES = 130;
  const sorted = [...files].sort((a, b) => b.churn - a.churn);
  const top = sorted.slice(0, MAX_TILES);
  const rest = sorted.slice(MAX_TILES);
  const tiles: FileInsight[] = [...top];
  if (rest.length) {
    tiles.push({
      path: `(${rest.length} smaller files)`,
      churn: rest.reduce((s, f) => s + f.churn, 0),
      sensitive: null,
      coverage: "unknown",
    });
  }
  const W = 1160;
  const H = 560;
  const rects = layoutTreemap(tiles, W, H);
  const parts = rects.map((r) => {
    const f = r.file;
    const fill = COVERAGE_COLOR[f.coverage];
    const label =
      r.w > 70 && r.h > 16
        ? `<text x="${(r.x + 4).toFixed(1)}" y="${(r.y + 13).toFixed(1)}" font-size="10" fill="#ffffff" opacity="0.92">${esc(
            (f.path.split("/").pop() ?? f.path).slice(0, Math.floor(r.w / 6)),
          )}</text>`
        : "";
    const title =
      `${f.path}\n±${f.churn} lines · ${f.coverage}` +
      `${f.sensitive ? ` · sensitive: ${f.sensitive}` : ""}` +
      `${f.functions?.length ? `\nfns: ${f.functions.join(", ")}` : ""}` +
      (compareUrl ? "\n(click to open the compare view)" : "");
    const tile = `<g><rect class="tile${f.sensitive ? " tile-sens" : ""}" x="${r.x.toFixed(1)}" y="${r.y.toFixed(1)}" width="${r.w.toFixed(1)}" height="${r.h.toFixed(1)}" fill="${fill}" fill-opacity="0.82"><title>${esc(title)}</title></rect>${label}</g>`;
    const linkable = compareUrl && !f.path.startsWith("(");
    return linkable
      ? `<a href="${compareUrl}${anchors ? `#${diffAnchor(f.path)}` : ""}" target="_blank" rel="noopener">${tile}</a>`
      : tile;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Diff treemap">${parts.join("")}</svg>`;
}

// Unverified is its own color — a capped 65 must not read as the same
// "checked, minor gaps" yellow a genuinely-scored 65-84 gets.
function scoreColor(score: number, label: string): string {
  return label === "unverified"
    ? "#a371f7"
    : score >= SCORE_SOLID
      ? "#3fb950"
      : score >= SCORE_MINOR
        ? "#d29922"
        : score >= SCORE_QUESTIONABLE
          ? "#f0883e"
          : "#f85149";
}

function scoreRing(score: number, label: string): string {
  const r = 52;
  const circ = 2 * Math.PI * r;
  const filled = (score / 100) * circ;
  const color = scoreColor(score, label);
  return `<svg viewBox="0 0 120 120" class="ring"><circle cx="60" cy="60" r="${r}" fill="none" style="stroke:var(--border)" stroke-width="10"/><circle cx="60" cy="60" r="${r}" fill="none" stroke="${color}" stroke-width="10" stroke-linecap="round" stroke-dasharray="${filled.toFixed(1)} ${circ.toFixed(1)}" transform="rotate(-90 60 60)"/><text x="60" y="58" text-anchor="middle" font-size="30" font-weight="700" style="fill:var(--fg)">${score}</text><text x="60" y="80" text-anchor="middle" font-size="12" style="fill:var(--muted)">${esc(label)}</text></svg>`;
}

// Rounded to the displayed decimal BEFORE the zero test: the risk step's
// delta is the difference of two differently-associated float expressions,
// so a flag-free release carries a ±4e-15 residue that "+0.0" would render
// as a phantom deduction — and an exact −24 would render as −24.0.
function fmtDelta(v: number): string {
  const r = Math.round(Math.abs(v) * 10) / 10;
  if (r === 0) return "0";
  const s = Number.isInteger(r) ? String(r) : r.toFixed(1);
  return v < 0 ? `−${s}` : `+${s}`;
}

/** SCORING.md as a picture: 100, minus each weighted component gap, minus
 * the hard cap that binds, down to the reported overall. */
function waterfallSvg(steps: ScoreStep[], label: string): string {
  const LABEL_W = 250;
  const PLOT_W = 470;
  const NUM_W = 70;
  const ROW = 26;
  const TOP = 6;
  const W = LABEL_W + PLOT_W + NUM_W;
  const H = TOP + steps.length * ROW + 16;
  const x = (v: number) => LABEL_W + (Math.max(0, Math.min(100, v)) / 100) * PLOT_W;
  const grid = [0, 25, 50, 75, 100]
    .map(
      (v) =>
        `<line x1="${x(v).toFixed(1)}" y1="${TOP}" x2="${x(v).toFixed(1)}" y2="${H - 14}" class="wf-grid"/>` +
        `<text x="${x(v).toFixed(1)}" y="${H - 3}" class="wf-axis" text-anchor="middle">${v}</text>`,
    )
    .join("");
  const rows = steps
    .map((st, i) => {
      const y = TOP + i * ROW;
      const barY = y + 5;
      const barH = 13;
      const before = st.total - st.delta;
      const numX = LABEL_W + PLOT_W + 8;
      let bar: string;
      let num: string;
      if (st.kind === "start") {
        bar = `<rect x="${x(0).toFixed(1)}" y="${barY}" width="${(x(100) - x(0)).toFixed(1)}" height="${barH}" class="wf-start"/>`;
        num = "100";
      } else if (st.kind === "final") {
        bar = `<rect x="${x(0).toFixed(1)}" y="${barY}" width="${Math.max(x(st.total) - x(0), 1.5).toFixed(1)}" height="${barH}" fill="${scoreColor(st.total, label)}"/>`;
        num = String(st.total);
      } else {
        const cls = st.kind === "cap" ? "wf-cap" : st.kind === "adjustment" ? "wf-adj" : "wf-comp";
        const x1 = Math.min(x(before), x(st.total));
        const wdt = Math.max(Math.abs(x(before) - x(st.total)), 1.5);
        num = fmtDelta(st.delta);
        // A step that deducted nothing draws nothing — a floored-width bar
        // at the running total would read as a deduction that isn't there.
        bar =
          num === "0"
            ? ""
            : `<rect x="${x1.toFixed(1)}" y="${barY}" width="${wdt.toFixed(1)}" height="${barH}" class="${cls}"/>`;
      }
      // The dashed drop line ties each bar to where the previous one ended.
      const conn =
        i > 0
          ? `<line x1="${x(before).toFixed(1)}" y1="${(y - ROW + 5 + barH).toFixed(1)}" x2="${x(before).toFixed(1)}" y2="${(barY + barH).toFixed(1)}" class="wf-conn"/>`
          : "";
      const title = `<title>${esc(st.label)}${st.detail ? `\n${esc(st.detail)}` : ""}</title>`;
      return `<g>${title}<text x="${LABEL_W - 10}" y="${y + 15}" class="wf-label" text-anchor="end">${esc(st.label)}</text>${conn}${bar}<text x="${numX}" y="${y + 15}" class="wf-num">${num}</text></g>`;
    })
    .join("");
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Score derivation">${grid}${rows}</svg>`;
}

function verdictBar(report: Report): string {
  const counts = countVerdicts(report.results);
  const total = report.results.length || 1;
  const segs = (Object.keys(VERDICT_COLOR) as Verdict[])
    .filter((v) => counts[v] > 0)
    .map(
      (v) =>
        `<div class="seg" style="width:${((counts[v] / total) * 100).toFixed(1)}%;background:${VERDICT_COLOR[v]}" title="${v}: ${counts[v]}"></div>`,
    )
    .join("");
  const legend = (Object.keys(VERDICT_COLOR) as Verdict[])
    .map(
      (v) =>
        `<span class="lg"><span class="dot" style="background:${VERDICT_COLOR[v]}"></span>${v} ${counts[v]}</span>`,
    )
    .join("");
  return `<div class="bar">${segs}</div><div class="legend">${legend}</div>`;
}

/** Version pins the diff moves — first-party components as cards, the
 * third-party routine as one quiet table. */
function pinsHtml(pins: PinBump[]): string {
  const firstParty = pins.filter((p) => p.firstParty);
  const thirdParty = pins.filter((p) => !p.firstParty);
  const cards = firstParty
    .map((p) => {
      const shown = p.repo ? (p.repo.split("/")[1] ?? p.repo) : p.name;
      return `<div class="flag" style="border-left-color:#58a6ff"><span class="chip" style="background:#58a6ff">first-party</span> <b>${esc(`${shown} ${p.from} → ${p.to}`)}</b>${p.repo ? ` <span class="note">(${esc(p.repo)})</span>` : ""}${p.releaseUrl ? ` — <a href="${esc(p.releaseUrl)}">release</a>` : ""}<div class="files">${esc(p.file)}</div></div>`;
    })
    .join("");
  const rows = thirdParty
    .map(
      (p) =>
        `<tr><td>${esc(p.name)}</td><td>${esc(p.from)} → ${esc(p.to)}</td><td>${esc(p.file)}</td></tr>`,
    )
    .join("");
  return `<h2>Version pins moved <span class="note">— pinned versions this diff bumps; a first-party bump is a release of the product itself; informational, never scored</span></h2>${cards}${
    thirdParty.length
      ? `<table><tr><th>pin</th><th>bump</th><th>file</th></tr>${rows}</table>`
      : ""
  }`;
}

function flagsHtml(flags: RiskFlag[], linkBase?: string, style?: LinkStyle): string {
  if (!flags.length) return `<p class="ok">No risk flags.</p>`;
  const sevColor = { critical: "#f85149", warn: "#d29922", info: "#58a6ff" };
  return flags
    .map((f) => {
      const shas = f.commitShas
        .map((s) =>
          linkBase
            ? `<a href="${commitUrl(linkBase, s, style)}">${esc(s.slice(0, 8))}</a>`
            : esc(s.slice(0, 8)),
        )
        .join(", ");
      return `<div class="flag" style="border-left-color:${sevColor[f.severity]}"><b>${f.severity.toUpperCase()}</b> ${esc(f.message)}${
        f.files.length ? `<div class="files">${esc(f.files.join(", "))}</div>` : ""
      }${shas ? `<div class="files">commits: ${shas}</div>` : ""}</div>`;
    })
    .join("");
}

function claimsHtml(report: Report, linkBase?: string, style?: LinkStyle): string {
  const out: string[] = [];
  let section = "";
  for (const r of report.results) {
    if (r.claim.section !== section) {
      if (section) out.push("</div>");
      section = r.claim.section;
      out.push(`<h3>${esc(section)}</h3><div class="claims">`);
    }
    const color = VERDICT_COLOR[r.verdict];
    const commits = r.evidence.commitShas
      .slice(0, 3)
      .map((s) =>
        linkBase
          ? `<a href="${commitUrl(linkBase, s, style)}">${esc(s.slice(0, 8))}</a>`
          : esc(s.slice(0, 8)),
      )
      .join(", ");
    const body =
      r.verdict === "skipped"
        ? ""
        : `<div class="detail">${esc(r.reasoning)}${
            r.evidence.files.length
              ? `<div class="files">${esc(r.evidence.files.slice(0, 6).join(", "))}</div>`
              : ""
          }${
            r.evidence.functions?.length
              ? `<div class="files">fns: ${esc(r.evidence.functions.slice(0, 8).join(", "))}</div>`
              : ""
          }${
            r.surplus?.some((s) => s.notable)
              ? `<div class="surplus">hides: ${esc(
                  r.surplus
                    .filter((s) => s.notable)
                    .map((s) => `${s.description}${s.file ? ` (${s.file})` : ""}`)
                    .join(" · "),
                )}</div>`
              : ""
          }${commits ? `<div class="files">commits: ${commits}</div>` : ""}</div>`;
    out.push(
      `<details data-v="${r.verdict}"${r.verdict === "contradicted" || r.verdict === "no-evidence" ? " open" : ""}><summary><span class="chip" style="background:${color}">${r.verdict}</span>${r.generated ? `<span class="gen">gen</span>` : ""} ${esc(r.claim.text)} <span class="conf">${r.verdict === "skipped" ? "" : r.confidence.toFixed(2)}</span></summary>${body}</details>`,
    );
  }
  if (section) out.push("</div>");
  return out.join("");
}

function fmtBytes(n: number): string {
  if (n > 1_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  if (n > 1_000) return `${(n / 1_000).toFixed(0)} kB`;
  return `${n} B`;
}

/**
 * A watch-written report's way back into the generated site. Both links
 * depend only on where the file sits, which cannot change for a file that
 * already exists — so a report stays navigable without ever being rewritten.
 * A one-off CLI report has neither page to link to and omits the nav.
 */
export interface ReportNav {
  /** This repo's history page, relative to the report's own directory. */
  historyHref: string;
  /** The watch dashboard, relative to the report's own directory. */
  indexHref: string;
}

export function toHtml(report: Report, nav?: ReportNav): string {
  const m = report.metrics;
  const note = unverifiableNote(report);
  const carried = carriedOver(report);
  const s = m.scores;
  const ctx = m.context;
  const langs = ctx.languages
    ? Object.entries(ctx.languages)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([lang, bytes]) => `${lang} ${((bytes / (ctx.codeBytes || 1)) * 100).toFixed(0)}%`)
        .join(" · ")
    : "n/a";
  const style = report.linkStyle;
  const compareUrl = report.linkBase
    ? compareUrlOf(report.linkBase, report.baseRef, report.headRef, style)
    : undefined;
  // The sha256 file anchor is a GitHub compare-page feature — on other
  // forges the tiles still link to the compare view, just without the jump.
  const anchorsWork = report.linkBase?.startsWith("https://github.com/") ?? false;
  const hasSuggestions = report.uncovered.some((u) => u.suggestedNote);
  const uncoveredRows = report.uncovered
    .map(
      (u) =>
        `<tr><td>${
          report.linkBase
            ? `<a href="${commitUrl(report.linkBase, u.commit.sha, style)}">${esc(u.commit.sha.slice(0, 8))}</a>`
            : esc(u.commit.sha.slice(0, 8))
        }</td><td>${esc(u.commit.subject)}</td><td>+${u.additions}/−${u.deletions}</td><td>${u.fileCount}</td>${
          hasSuggestions ? `<td>${u.suggestedNote ? esc(u.suggestedNote) : "—"}</td>` : ""
        }</tr>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fact check: ${esc(report.repoLabel)} ${esc(report.headRef)}</title>
<style>
:root{color-scheme:light dark;
--bg:#ffffff;--card:#f6f8fa;--border:#d1d9e0;--btn-border:#d1d9e0;--btn-hover:#e7ebf0;
--fg:#1f2328;--detail:#333b43;--muted:#59636e;--faint:#818b98;
--link:#0969da;--accent:#0969da}
@media (prefers-color-scheme:dark){:root{
--bg:#0d1117;--card:#161b22;--border:#21262d;--btn-border:#30363d;--btn-hover:#30363d;
--fg:#e6edf3;--detail:#c9d1d9;--muted:#8b949e;--faint:#484f58;
--link:#58a6ff;--accent:#1f6feb}}
body{background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,'Segoe UI',sans-serif;margin:0;padding:24px;max-width:1200px;margin-inline:auto}
a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}
h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 10px;border-bottom:1px solid var(--border);padding-bottom:6px}h3{font-size:14px;margin:16px 0 6px;color:var(--muted)}
.sub{color:var(--muted);margin-bottom:20px}
.cards{display:flex;gap:16px;align-items:center;flex-wrap:wrap;background:var(--card);border:1px solid var(--border);border-radius:10px;padding:16px}
.ring{width:120px;height:120px;flex-shrink:0}
.comp{display:flex;gap:24px;flex-wrap:wrap}
.comp div{text-align:center}.comp .n{font-size:22px;font-weight:700}.comp .t{color:var(--muted);font-size:12px}
.ctx{margin-left:auto;text-align:right;color:var(--muted);font-size:12px}
.bar{display:flex;height:14px;border-radius:7px;overflow:hidden;margin:10px 0 6px}
.seg{height:100%}
.legend{color:var(--muted);font-size:12px}.lg{margin-right:14px}.dot{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:4px;vertical-align:-1px}
svg{width:100%;height:auto;border-radius:8px}
.spark{width:84px;height:18px;vertical-align:-4px;border-radius:0}
.wf-grid{stroke:var(--border);stroke-width:1}
.wf-axis{font-size:9px;fill:var(--muted)}
.wf-label{font-size:12px;fill:var(--fg)}
.wf-num{font-size:12px;fill:var(--muted);font-variant-numeric:tabular-nums}
.wf-start{fill:var(--border)}
.wf-comp{fill:#d29922}
.wf-cap{fill:#f85149}
.wf-adj{fill:#6e7681}
.wf-conn{stroke:var(--faint);stroke-width:1;stroke-dasharray:2 2}
.tile{stroke:var(--bg);stroke-width:1}
.tile-sens{stroke:#e3b341;stroke-width:2.5}
.flag{background:var(--card);border:1px solid var(--border);border-left:4px solid;border-radius:6px;padding:8px 12px;margin:6px 0}
.files{color:var(--muted);font-size:12px;font-family:ui-monospace,monospace}
details{background:var(--card);border:1px solid var(--border);border-radius:6px;padding:6px 10px;margin:5px 0}
summary{cursor:pointer}
.chip{color:#ffffff;font-weight:700;font-size:11px;padding:1px 7px;border-radius:9px;margin-right:6px;text-shadow:0 0 2px rgba(0,0,0,.35)}
.gen{color:var(--muted);border:1px solid var(--btn-border);font-size:10px;padding:0 5px;border-radius:8px;margin-right:6px}
.conf{color:var(--muted);font-size:12px}
.surplus{color:#d29922;font-size:12px;margin-top:4px}
.toolbar{display:flex;gap:8px;margin:10px 0;flex-wrap:wrap}
.toolbar button{background:var(--card);color:var(--fg);border:1px solid var(--btn-border);border-radius:6px;padding:4px 12px;cursor:pointer;font-size:12px}
.toolbar button:hover{background:var(--btn-hover)}
.toolbar button.active{background:var(--accent);border-color:var(--accent);color:#ffffff}
body[data-filter="issues"] details[data-v="verified"],body[data-filter="issues"] details[data-v="skipped"]{display:none}
body[data-filter="handwritten"] details:has(.gen){display:none}
.detail{margin:8px 0 4px 4px;color:var(--detail)}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--border);padding:5px 8px;text-align:left;font-size:13px}th{color:var(--muted)}
.ok{color:#3fb950}
.note{color:var(--muted);font-size:12px}
.banner{background:var(--card);border:1px solid var(--accent);border-left:4px solid var(--accent);border-radius:6px;padding:10px 12px;margin:14px 0}
footer{margin-top:32px;color:var(--faint);font-size:12px}
</style></head><body>
<h1>Release-note fact check — ${esc(report.repoLabel)}</h1>
${
  nav
    ? `<p class="sub"><a href="${esc(nav.historyHref)}">&larr; this repo's history</a> · <a href="${esc(nav.indexHref)}">all watched repos</a></p>\n`
    : ""
}<div class="sub">${esc(report.baseRef)} → ${esc(report.headRef)} · ${report.stats.commits} commits · ${report.stats.files} files · +${report.stats.additions}/−${report.stats.deletions} · judge: ${esc(report.engine)}</div>

<div class="cards">
  ${scoreRing(s.overall, s.label)}
  <div class="comp">
    <div><div class="n">${s.correctness}</div><div class="t">correctness<br>claims supported</div></div>
    <div><div class="n">${s.completeness === null ? "–" : s.completeness}</div><div class="t">completeness<br>churn documented</div></div>
    <div><div class="n">${s.risk}</div><div class="t">risk<br>100 − flag penalties</div></div>
  </div>
  <div class="ctx">repo: ${esc(langs)}${ctx.codeBytes ? ` · ${fmtBytes(ctx.codeBytes)} code` : ""}${
    ctx.releaseCadenceDays ? `<br>release cadence ~${ctx.releaseCadenceDays} d` : ""
  }${
    m.baseline
      ? `<br>baseline (${m.baseline.releases} rel.): median churn ±${m.baseline.medianChurn} ${sparkline(
          m.baseline.snapshots.map((s) => ({ label: s.tag, value: s.churn })),
          "Churn per release (oldest → newest)",
        )} · coverage ${Math.round(m.baseline.medianAnchoredCoverage * 100)}% ${sparkline(
          m.baseline.snapshots.map((s) => ({ label: s.tag, value: Math.round(s.coverage * 100) })),
          "Note coverage % per release (oldest → newest)",
        )}`
      : ""
  }</div>
</div>
${
  note ? `<div class="banner"><strong>${esc(note.heading)}</strong> — ${esc(note.reason)}</div>` : ""
}${
  carried
    ? `<div class="banner"><strong>Carried over</strong> — ${carried.count} claim(s) repeat ${esc(carried.baseRef)} verbatim; standing text, not scored.</div>`
    : ""
}
<h2>Score derivation <span class="note">— components, flag penalties and the hard cap, per <a href="https://github.com/bmmmm/comparereleaseii/blob/main/SCORING.md">SCORING.md</a></span></h2>
${waterfallSvg(scoreBreakdown(report), s.label)}

<h2>Claims at a glance</h2>
${verdictBar(report)}

<h2 id="risk-flags">Risk flags</h2>
${flagsHtml(m.flags, report.linkBase, style)}

<h2>Diff map <span class="note">— tile = file, size = changed lines, color = documentation status, amber border = sensitive path${compareUrl ? ", click opens the diff" : ""}</span></h2>
${treemapSvg(m.files, compareUrl, anchorsWork)}
<div class="legend">
  <span class="lg"><span class="dot" style="background:${COVERAGE_COLOR.evidence}"></span>cited as evidence</span>
  <span class="lg"><span class="dot" style="background:${COVERAGE_COLOR.covered}"></span>in documented commit</span>
  <span class="lg"><span class="dot" style="background:${COVERAGE_COLOR.undocumented}"></span>undocumented</span>
  <span class="lg"><span class="dot" style="background:${COVERAGE_COLOR.unknown}"></span>unknown</span>
  <span class="lg"><span class="dot" style="background:#e3b341"></span>sensitive path (border)</span>
</div>

<h2>Claims in detail</h2>
<div class="toolbar">
  <button data-filter="all" class="active">All claims</button>
  <button data-filter="issues">Issues only</button>
  <button data-filter="handwritten">Handwritten only</button>
  <button id="expand">Expand all</button>
  <button id="collapse">Collapse all</button>
</div>
${claimsHtml(report, report.linkBase, style)}

${
  report.promises?.length
    ? `<h2>Promises from earlier releases <span class="note">— forward-looking notes checked against this diff; informational, never scored</span></h2>${report.promises
        .map((p) => {
          const color =
            p.status === "kept"
              ? "#3fb950"
              : p.status === "broken"
                ? "#f85149"
                : p.status === "stale"
                  ? "#b08800"
                  : "#6e7681";
          return `<div class="flag" style="border-left-color:${color}"><span class="chip" style="background:${color}">${p.status}</span> <b>${esc(p.from)}</b> ${esc(p.text)}<div class="files">${esc(p.note)}${p.files.length ? ` — ${esc(p.files.slice(0, 3).join(", "))}` : ""}</div></div>`;
        })
        .join("")}`
    : ""
}
${report.pins?.length ? pinsHtml(report.pins) : ""}
<h2>Undocumented commits</h2>
${
  !report.reverseChecked
    ? `<p class="note">Completeness check skipped (--no-reverse).</p>`
    : report.uncovered.length
      ? `<table><tr><th>commit</th><th>subject</th><th>churn</th><th>files</th>${hasSuggestions ? "<th>suggested note</th>" : ""}</tr>${uncoveredRows}</table>`
      : `<p class="ok">All commits in the range are covered by the release notes.</p>`
}

${report.warnings.length ? `<h2>Warnings</h2>${report.warnings.map((w) => `<div class="flag" style="border-left-color:#d29922">${esc(w)}</div>`).join("")}` : ""}
<footer>generated by <a href="https://github.com/bmmmm/comparereleaseii">comparereleaseii</a> · <a href="https://github.com/bmmmm/comparereleaseii/blob/main/SCORING.md">how the score works</a></footer>
<script>
for (const b of document.querySelectorAll(".toolbar button[data-filter]")) {
  b.addEventListener("click", () => {
    document.body.dataset.filter = b.dataset.filter;
    for (const o of document.querySelectorAll(".toolbar button[data-filter]")) o.classList.toggle("active", o === b);
  });
}
document.getElementById("expand").addEventListener("click", () => {
  for (const d of document.querySelectorAll("details")) d.open = true;
});
document.getElementById("collapse").addEventListener("click", () => {
  for (const d of document.querySelectorAll("details")) d.open = false;
});
</script>
</body></html>`;
}
