// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from "node:crypto";
import { countVerdicts } from "./report.ts";
import type { FileInsight, Report, RiskFlag, Verdict } from "./types.ts";

/** GitHub's file anchor on compare pages: "diff-" + sha256(path). */
function diffAnchor(path: string): string {
  return "diff-" + createHash("sha256").update(path).digest("hex");
}

function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
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

function treemapSvg(files: FileInsight[], compareUrl?: string): string {
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
    const stroke = f.sensitive ? "#e3b341" : "#0d1117";
    const strokeW = f.sensitive ? 2.5 : 1;
    const label =
      r.w > 70 && r.h > 16
        ? `<text x="${(r.x + 4).toFixed(1)}" y="${(r.y + 13).toFixed(1)}" font-size="10" fill="#e6edf3" opacity="0.9">${esc(
            (f.path.split("/").pop() ?? f.path).slice(0, Math.floor(r.w / 6)),
          )}</text>`
        : "";
    const title =
      `${f.path}\n±${f.churn} lines · ${f.coverage}` +
      `${f.sensitive ? ` · sensitive: ${f.sensitive}` : ""}` +
      `${f.functions?.length ? `\nfns: ${f.functions.join(", ")}` : ""}` +
      (compareUrl ? "\n(click to open the diff on GitHub)" : "");
    const tile = `<g><rect x="${r.x.toFixed(1)}" y="${r.y.toFixed(1)}" width="${r.w.toFixed(1)}" height="${r.h.toFixed(1)}" fill="${fill}" fill-opacity="0.82" stroke="${stroke}" stroke-width="${strokeW}"><title>${esc(title)}</title></rect>${label}</g>`;
    const linkable = compareUrl && !f.path.startsWith("(");
    return linkable
      ? `<a href="${compareUrl}#${diffAnchor(f.path)}" target="_blank" rel="noopener">${tile}</a>`
      : tile;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Diff treemap">${parts.join("")}</svg>`;
}

function scoreRing(score: number, label: string): string {
  const r = 52;
  const circ = 2 * Math.PI * r;
  const filled = (score / 100) * circ;
  const color = score >= 85 ? "#3fb950" : score >= 65 ? "#d29922" : score >= 45 ? "#f0883e" : "#f85149";
  return `<svg viewBox="0 0 120 120" class="ring"><circle cx="60" cy="60" r="${r}" fill="none" stroke="#21262d" stroke-width="10"/><circle cx="60" cy="60" r="${r}" fill="none" stroke="${color}" stroke-width="10" stroke-linecap="round" stroke-dasharray="${filled.toFixed(1)} ${circ.toFixed(1)}" transform="rotate(-90 60 60)"/><text x="60" y="58" text-anchor="middle" font-size="30" font-weight="700" fill="#e6edf3">${score}</text><text x="60" y="80" text-anchor="middle" font-size="12" fill="#8b949e">${esc(label)}</text></svg>`;
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

function flagsHtml(flags: RiskFlag[], linkBase?: string): string {
  if (!flags.length) return `<p class="ok">No risk flags.</p>`;
  const sevColor = { critical: "#f85149", warn: "#d29922", info: "#58a6ff" };
  return flags
    .map((f) => {
      const shas = f.commitShas
        .map((s) =>
          linkBase
            ? `<a href="${linkBase}/commit/${s}">${s.slice(0, 8)}</a>`
            : s.slice(0, 8),
        )
        .join(", ");
      return `<div class="flag" style="border-left-color:${sevColor[f.severity]}"><b>${f.severity.toUpperCase()}</b> ${esc(f.message)}${
        f.files.length ? `<div class="files">${esc(f.files.join(", "))}</div>` : ""
      }${shas ? `<div class="files">commits: ${shas}</div>` : ""}</div>`;
    })
    .join("");
}

function claimsHtml(report: Report, linkBase?: string): string {
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
        linkBase ? `<a href="${linkBase}/commit/${s}">${s.slice(0, 8)}</a>` : s.slice(0, 8),
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

export function toHtml(report: Report): string {
  const m = report.metrics;
  const s = m.scores;
  const ctx = m.context;
  const langs = ctx.languages
    ? Object.entries(ctx.languages)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([lang, bytes]) => `${lang} ${((bytes / (ctx.codeBytes || 1)) * 100).toFixed(0)}%`)
        .join(" · ")
    : "n/a";
  const compareUrl = report.linkBase
    ? `${report.linkBase}/compare/${report.baseRef}...${report.headRef}`
    : undefined;
  const hasSuggestions = report.uncovered.some((u) => u.suggestedNote);
  const uncoveredRows = report.uncovered
    .map(
      (u) =>
        `<tr><td>${
          report.linkBase
            ? `<a href="${report.linkBase}/commit/${u.commit.sha}">${u.commit.sha.slice(0, 8)}</a>`
            : u.commit.sha.slice(0, 8)
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
:root{color-scheme:dark}
body{background:#0d1117;color:#e6edf3;font:14px/1.5 -apple-system,'Segoe UI',sans-serif;margin:0;padding:24px;max-width:1200px;margin-inline:auto}
a{color:#58a6ff;text-decoration:none}a:hover{text-decoration:underline}
h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 10px;border-bottom:1px solid #21262d;padding-bottom:6px}h3{font-size:14px;margin:16px 0 6px;color:#8b949e}
.sub{color:#8b949e;margin-bottom:20px}
.cards{display:flex;gap:16px;align-items:center;flex-wrap:wrap;background:#161b22;border:1px solid #21262d;border-radius:10px;padding:16px}
.ring{width:120px;height:120px;flex-shrink:0}
.comp{display:flex;gap:24px;flex-wrap:wrap}
.comp div{text-align:center}.comp .n{font-size:22px;font-weight:700}.comp .t{color:#8b949e;font-size:12px}
.ctx{margin-left:auto;text-align:right;color:#8b949e;font-size:12px}
.bar{display:flex;height:14px;border-radius:7px;overflow:hidden;margin:10px 0 6px}
.seg{height:100%}
.legend{color:#8b949e;font-size:12px}.lg{margin-right:14px}.dot{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:4px;vertical-align:-1px}
svg{width:100%;height:auto;border-radius:8px}
.flag{background:#161b22;border:1px solid #21262d;border-left:4px solid;border-radius:6px;padding:8px 12px;margin:6px 0}
.files{color:#8b949e;font-size:12px;font-family:ui-monospace,monospace}
details{background:#161b22;border:1px solid #21262d;border-radius:6px;padding:6px 10px;margin:5px 0}
summary{cursor:pointer}
.chip{color:#0d1117;font-weight:700;font-size:11px;padding:1px 7px;border-radius:9px;margin-right:6px}
.gen{color:#8b949e;border:1px solid #30363d;font-size:10px;padding:0 5px;border-radius:8px;margin-right:6px}
.conf{color:#8b949e;font-size:12px}
.surplus{color:#d29922;font-size:12px;margin-top:4px}
.toolbar{display:flex;gap:8px;margin:10px 0;flex-wrap:wrap}
.toolbar button{background:#21262d;color:#e6edf3;border:1px solid #30363d;border-radius:6px;padding:4px 12px;cursor:pointer;font-size:12px}
.toolbar button:hover{background:#30363d}
.toolbar button.active{background:#1f6feb;border-color:#1f6feb}
body[data-filter="issues"] details[data-v="verified"],body[data-filter="issues"] details[data-v="skipped"]{display:none}
body[data-filter="handwritten"] details:has(.gen){display:none}
.detail{margin:8px 0 4px 4px;color:#c9d1d9}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #21262d;padding:5px 8px;text-align:left;font-size:13px}th{color:#8b949e}
.ok{color:#3fb950}
.note{color:#8b949e;font-size:12px}
footer{margin-top:32px;color:#484f58;font-size:12px}
</style></head><body>
<h1>Release-note fact check — ${esc(report.repoLabel)}</h1>
<div class="sub">${esc(report.baseRef)} → ${esc(report.headRef)} · ${report.stats.commits} commits · ${report.stats.files} files · +${report.stats.additions}/−${report.stats.deletions} · judge: ${esc(report.engine)}</div>

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
      ? `<br>baseline (${m.baseline.releases} rel.): median churn ±${m.baseline.medianChurn} · coverage ${Math.round(m.baseline.medianAnchoredCoverage * 100)}%`
      : ""
  }</div>
</div>

<h2>Claims at a glance</h2>
${verdictBar(report)}

<h2>Risk flags</h2>
${flagsHtml(m.flags, report.linkBase)}

<h2>Diff map <span class="note">— tile = file, size = changed lines, color = documentation status, amber border = sensitive path${compareUrl ? ", click opens the diff" : ""}</span></h2>
${treemapSvg(m.files, compareUrl)}
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
${claimsHtml(report, report.linkBase)}

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
