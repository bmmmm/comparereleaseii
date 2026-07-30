// SPDX-License-Identifier: GPL-3.0-or-later
// The watch dashboard and its Atom feed: the "which repo needs a look today"
// view across all watched repos, plus the pull counterpart to --notify.
// Rendering only — it reads the state and writes strings, so it shares
// nothing with the orchestration that produced that state.
import { esc } from "./util.ts";
import { SCORE_MINOR, SCORE_SOLID, scoreClass } from "./theme.ts";
import { reportDirOf } from "./watch-detail.ts";
import type { UnverifiableKind } from "./types.ts";
import type { RepoState, WatchState, WatchedEntry } from "./watch-state.ts";

/** Short enough for a table cell; the title carries the explanation. */
const UNVERIFIABLE_TAG: Record<UnverifiableKind, string> = {
  sourceless: "no source",
  "out-of-repo": "out of repo",
};
const UNVERIFIABLE_TITLE: Record<UnverifiableKind, string> = {
  sourceless: "This release's diff contains no source-code changes — its claims could not be checked against code.",
  "out-of-repo": "These notes describe code that is not in this repo's own diff (fork, build or distribution repo).",
};


/** Self-contained watch overview: one row per watched repo, red rows first,
 * whole rows link to the report; repos awaiting their first check are listed
 * too so a fresh `watch add` is visible immediately. */
export function toWatchIndexHtml(
  state: WatchState,
  generatedAt: string,
  configured?: WatchedEntry[],
): string {
  const entries: Array<{ key: string; repo: string; url?: string; rs: RepoState | undefined }> =
    configured
      ? configured.map((e) => ({ ...e, rs: state.repos[e.key] }))
      : Object.entries(state.repos).map(([key, rs]) => ({ key, repo: key, rs }));
  const withData = entries
    .filter((e) => e.rs?.latest)
    .sort((a, b) => {
      const fa = a.rs!.latest!.flagged ? 0 : 1;
      const fb = b.rs!.latest!.flagged ? 0 : 1;
      if (fa !== fb) return fa - fb;
      return (b.rs!.latest!.checkedAt ?? "").localeCompare(a.rs!.latest!.checkedAt ?? "");
    });
  const pending = entries.filter((e) => !e.rs?.latest);
  const flaggedCount = withData.filter((e) => e.rs!.latest!.flagged).length;
  // Unverified gets its own bucket, not folded into "mid" — a capped 65 for
  // "could not be checked" must not look like a genuinely scored 65-84.
  const bucketOf = (h: { score: number; scoreLabel: string }) => scoreClass(h.score, h.scoreLabel);
  const latest = withData.map((e) => e.rs!.latest!);
  const brokenTotal = latest.reduce((s, l) => s + (l.brokenPromises ?? 0), 0);
  // Score distribution across the CURRENT state of every repo — the shape of
  // the whole watchlist at a glance, in the same buckets the rows use.
  const dist = { good: 0, mid: 0, bad: 0, unverified: 0 };
  for (const l of latest) dist[bucketOf(l) as keyof typeof dist]++;
  const DIST_LABEL = {
    good: `${SCORE_SOLID}+`,
    mid: `${SCORE_MINOR}–${SCORE_SOLID - 1}`,
    bad: `&lt;${SCORE_MINOR}`,
    unverified: "unverified",
  };
  const distBar = latest.length
    ? `<div class="dist" role="img" aria-label="score distribution">${(
        Object.keys(dist) as Array<keyof typeof dist>
      )
        .filter((k) => dist[k] > 0)
        .map(
          (k) =>
            `<div class="seg ${k}" style="width:${((dist[k] / latest.length) * 100).toFixed(1)}%" title="${dist[k]} repo(s) at ${DIST_LABEL[k]}"></div>`,
        )
        .join("")}</div><div class="legend">${(Object.keys(dist) as Array<keyof typeof dist>)
        .map((k) => `<span class="lg"><span class="dot ${k}"></span>${DIST_LABEL[k]} ${dist[k]}</span>`)
        .join("")}</div>`
    : "";
  const cards = `<div class="cards">
<div><div class="n">${entries.length}</div><div class="t">repos watched</div></div>
<div><div class="n">${flaggedCount}</div><div class="t">flagged</div></div>
<div><div class="n">${brokenTotal}</div><div class="t">broken promise${brokenTotal === 1 ? "" : "s"}</div></div>
<div class="distcard"><div class="t">latest scores</div>${distBar}</div>
</div>`;
  // The feed reads along the releases' own axis, not the table's per-repo
  // one: what came out across the whole watchlist, newest first.
  const FEED_MAX = 30;
  const allChecks = withData
    .flatMap(({ key, rs }) => rs!.history.map((h) => ({ key, h })))
    .sort((a, b) =>
      (b.h.publishedAt ?? b.h.checkedAt).localeCompare(a.h.publishedAt ?? a.h.checkedAt),
    );
  const feedRows = allChecks
    .slice(0, FEED_MAX)
    .map(
      ({ key, h }) =>
        `<li><span class="when">${h.publishedAt ? esc(h.publishedAt.slice(0, 10)) : esc(h.checkedAt.slice(0, 10))}</span> <span${
          h.backfilled ? ` title="backfilled — checked after the fact${h.flagged ? "; flagged on record, never alerted" : ""}"` : ""
        }>${
          h.flagged ? "&#9888;" : "&#10003;"
        }</span> <b>${esc(key.includes("://") ? key.replace(/^\w+:\/\//, "") : key)}</b> <a href="${esc(h.report)}">${esc(h.tag)}</a> <span class="score ${bucketOf(h)}">${h.score}</span> ${esc(h.scoreLabel)}${
          h.brokenPromises ? ` <span class="incomplete">${h.brokenPromises} broken promise${h.brokenPromises > 1 ? "s" : ""}</span>` : ""
        }</li>`,
    )
    .join("\n");
  const feedSection = allChecks.length
    ? `<h2>Release feed <span class="note">— every checked release across the watchlist, newest first${
        allChecks.length > FEED_MAX ? ` (last ${FEED_MAX} of ${allChecks.length})` : ""
      } · <a href="feed.xml">atom</a></span></h2>
<ol class="feed">
${feedRows}
</ol>`
    : "";
  // A forge entry carries its own web URL; only plain owner/repo entries mean
  // GitHub. A URL-shaped `repo` (unparseable repoUrl) must not be pinned on
  // github.com just because it contains a slash. The cell shows owner/repo —
  // an unlabeled forge entry's key is its whole URL, which belongs in the
  // title, not across the table.
  const forgeHref = (repo: string, url?: string) =>
    url ?? (repo.includes("/") && !repo.includes("://") ? `https://github.com/${repo}` : null);
  const shownName = (key: string, repo: string) => (key.includes("://") ? repo : key);
  // The most prominent click in a row is the repo name, and the most valuable
  // drilldown is the repo's own history page — so the name opens it (the
  // common dashboard idiom: name = internal detail), and the forge moves to
  // a small ↗ right behind it, the same pattern the release column uses.
  const repoCell = (key: string, repo: string, url: string | undefined, rs: RepoState) => {
    const fh = forgeHref(repo, url);
    return (
      `<a class="repo" href="${esc(reportDirOf(rs, key))}/index.html" title="this repo's full history: score series, verdicts, promise ledger">${esc(shownName(key, repo))}</a>` +
      (fh
        ? ` <a class="ext" href="${esc(fh)}" target="_blank" rel="noopener" title="${esc(fh)}">&#8599;</a>`
        : "")
    );
  };
  // A waiting row has no history page yet — its name keeps the forge link.
  const pendingCell = (key: string, repo: string, url?: string) => {
    const fh = forgeHref(repo, url);
    const shown = shownName(key, repo);
    return fh
      ? `<a class="repo" href="${esc(fh)}" target="_blank" rel="noopener"${url ? ` title="${esc(url)}"` : ""}>${esc(shown)}</a>`
      : esc(shown);
  };
  const rows = withData
    .map(({ key, repo, url, rs }) => {
      const l = rs!.latest!;
      const v = l.verdicts;
      // A single dot would just repeat the score column — the trend earns
      // its place only once there is history, and then each dot links to
      // that release's report.
      const trend =
        rs!.history.length >= 2
          ? rs!.history
              .slice(-6)
              .map(
                (h) =>
                  `<a href="${esc(h.report)}" title="${esc(h.tag)}: ${h.score}"><span class="dot ${bucketOf(h)}"></span></a>`,
              )
              .join("")
          : "";
      const comp = l.components
        ? `${l.components.correctness} · ${l.components.completeness ?? "–"} · ${l.components.risk}`
        : "";
      const releaseHref =
        l.releaseUrl ??
        (repo.includes("/") && !url && !repo.includes("://")
          ? `https://github.com/${repo}/releases/tag/${encodeURIComponent(l.tag)}`
          : null);
      const releaseUrl = releaseHref
        ? ` <a class="ext" href="${esc(releaseHref)}" target="_blank" rel="noopener" title="release on its forge">&#8599;</a>`
        : "";
      return `<tr class="${l.flagged ? "flagged" : ""}" data-href="${esc(l.report)}" data-repo="${esc(key.toLowerCase())}" data-released="${l.publishedAt ? esc(l.publishedAt) : ""}" data-score="${l.score}" data-flags="${l.criticalFlags * 1000 + l.flagCount}" data-checked="${esc(l.checkedAt)}">
<td${l.backfilled ? ` title="backfilled — checked after the fact${l.flagged ? "; flagged on record, never alerted" : ""}"` : ""}>${l.flagged ? "&#9888;" : "&#10003;"}</td>
<td>${repoCell(key, repo, url, rs!)}</td>
<td><a href="${esc(l.report)}">${esc(l.tag)}</a>${releaseUrl}</td>
<td>${l.publishedAt ? esc(l.publishedAt.slice(0, 10)) : ""}</td>
<td><span class="score ${bucketOf(l)}" title="judge: ${esc(l.engine)}${
        typeof l.scoreLevel === "number" ? ` · this repo's median: ${l.scoreLevel}` : ""
      }">${l.score}</span> ${esc(l.scoreLabel)}${
        typeof l.scoreLevel === "number" && l.score < l.scoreLevel - 20
          ? ` <span class="drop" title="down from this repo's median of ${l.scoreLevel}">&#8595;${l.scoreLevel - l.score}</span>`
          : typeof l.scoreLevel === "number"
            ? ` <span class="level" title="this repo's median is ${l.scoreLevel}">~median</span>`
            : ""
      }${
        l.unverifiable
          ? ` <span class="tag" title="${esc(UNVERIFIABLE_TITLE[l.unverifiable])}">${esc(UNVERIFIABLE_TAG[l.unverifiable])}</span>`
          : ""
      }${
        l.warnings?.length
          ? ` <span class="incomplete" title="${esc(l.warnings.join(" · "))}">&#9888; partial data</span>`
          : ""
      }${
        l.brokenPromises
          ? ` <span class="incomplete" title="an earlier release promised a change this release was due to ship">&#9888; ${l.brokenPromises} broken promise${l.brokenPromises > 1 ? "s" : ""}</span>`
          : ""
      }</td>
<td class="comp">${comp}</td>
<td>${v.verified}&#10004; ${v.partial}&#9680; ${v.noEvidence}? ${v.contradicted}&#10008;</td>
<td>${l.criticalFlags ? `<b>${l.criticalFlags} critical</b>` : l.flagCount || ""}</td>
<td>${trend}</td>
<td title="${esc(l.checkedAt)}">${esc(l.checkedAt.slice(0, 10))}</td>
</tr>`;
    })
    .join("\n");
  const pendingRows = pending
    .map(
      ({ key, repo, url }) => `<tr class="pending">
<td>&#8943;</td>
<td>${pendingCell(key, repo, url)}</td>
<td colspan="8">waiting for the first release check</td>
</tr>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>comparereleaseii watch</title>
<style>
body{font:14px/1.5 system-ui,sans-serif;margin:2rem auto;max-width:75rem;padding:0 1rem;color:#1f2328;background:#fff}
h1{font-size:1.3rem} .sub{color:#59636e}
h2{font-size:1rem;margin-top:1.6rem}
.note{color:#59636e;font-size:.85em;font-weight:400}
.cards{display:flex;gap:26px;flex-wrap:wrap;align-items:center;background:#f6f8fa;border:1px solid #d1d9e0;border-radius:10px;padding:10px 16px;margin:12px 0}
.cards>div{text-align:center}.cards .n{font-size:20px;font-weight:700}.cards .t{color:#59636e;font-size:12px}
.distcard{min-width:180px;flex:1;text-align:left!important}
.dist{display:flex;height:10px;border-radius:5px;overflow:hidden;margin:4px 0 2px}
.dist .seg{height:100%;border-right:2px solid #f6f8fa}.dist .seg:last-child{border-right:0}
.seg.good,.dot.good{background:#1a7f37}.seg.mid,.dot.mid{background:#d4a72c}.seg.bad,.dot.bad{background:#cf222e}.seg.unverified,.dot.unverified{background:#8250df}
.legend{color:#59636e;font-size:11px}.lg{margin-right:10px}
button{background:#f6f8fa;color:#1f2328;border:1px solid #d1d9e0;border-radius:6px;padding:3px 10px;cursor:pointer;font-size:12px}
button.active{background:#cf222e;border-color:#cf222e;color:#fff}
body.only-flagged tr[data-href]:not(.flagged),body.only-flagged tr.pending{display:none}
table{border-collapse:collapse;width:100%;margin-top:1rem}
th,td{text-align:left;padding:.45rem .6rem;border-bottom:1px solid #d1d9e0}
th{font-size:.8rem;text-transform:uppercase;letter-spacing:.04em;color:#59636e}
th[data-sort]{cursor:pointer;white-space:nowrap}
th[data-sort]::after{content:" \\2195";color:#818b98}
th[data-sort].sorted[data-dir="asc"]::after{content:" \\2191";color:#1f2328}
th[data-sort].sorted[data-dir="desc"]::after{content:" \\2193";color:#1f2328}
.feed{list-style:none;padding:0;margin:.5rem 0}
.feed li{padding:.28rem 0;border-bottom:1px solid #d1d9e0}
.feed .when{color:#59636e;font-variant-numeric:tabular-nums;margin-right:.3rem}
tr.flagged{background:#fff1f0}
tr[data-href]{cursor:pointer}
tr[data-href]:hover{background:#f6f8fa}
tr.flagged[data-href]:hover{background:#ffe3e0}
tr.pending td{color:#59636e}
.score{display:inline-block;min-width:2.2em;text-align:center;border-radius:.6em;padding:0 .35em;font-weight:600;color:#fff}
.tag{display:inline-block;border:1px solid #58a6ff;color:#58a6ff;border-radius:.6em;padding:0 .4em;font-size:.8em;white-space:nowrap}
.drop{display:inline-block;border:1px solid #cf222e;color:#cf222e;border-radius:.6em;padding:0 .4em;font-size:.8em}
.incomplete{display:inline-block;border:1px solid #9a6700;color:#9a6700;border-radius:.6em;padding:0 .4em;font-size:.8em;white-space:nowrap}
.level{color:#8b949e;font-size:.8em}
.score.good{background:#1a7f37}.score.mid{background:#9a6700}.score.bad{background:#cf222e}.score.unverified{background:#8250df}
.comp{color:#59636e;white-space:nowrap}
.dot{display:inline-block;width:.55em;height:.55em;border-radius:50%;margin-right:2px}
.dot.good{background:#1a7f37}.dot.mid{background:#d4a72c}.dot.bad{background:#cf222e}.dot.unverified{background:#8250df}
a{color:#0969da;text-decoration:none}a:hover{text-decoration:underline}
a.repo{color:inherit}a.ext{font-size:.85em}
@media (prefers-color-scheme:dark){body{background:#0d1117;color:#e6edf3}th{color:#8d96a0}th,td{border-color:#30363d}tr.flagged{background:#3c1618}tr[data-href]:hover{background:#161b22}tr.flagged[data-href]:hover{background:#4a1c1f}tr.pending td{color:#8d96a0}.comp{color:#8d96a0}.incomplete{border-color:#d29922;color:#d29922}
.cards{background:#161b22;border-color:#30363d}.cards .t,.sub,.note,.legend,.feed .when{color:#8d96a0}
.dist .seg{border-color:#161b22}
button{background:#161b22;color:#e6edf3;border-color:#30363d}button.active{background:#cf222e;border-color:#cf222e;color:#fff}
th[data-sort]::after{color:#484f58}
th[data-sort].sorted[data-dir="asc"]::after,th[data-sort].sorted[data-dir="desc"]::after{color:#e6edf3}
.feed li{border-color:#30363d}}
</style></head><body>
<h1>Release watch</h1>
<p class="sub">generated ${esc(generatedAt)} by comparereleaseii · <a href="feed.xml">atom feed</a></p>
${cards}
<p class="sub"><button id="flagged-only" type="button">&#9888; flagged only</button> <span class="note">columns with &#8597; sort on click</span></p>
<table>
<thead><tr><th></th><th data-sort="repo">repo</th><th>release</th><th data-sort="released">released</th><th data-sort="score">trust score</th><th>c &middot; c &middot; r</th><th>verdicts</th><th data-sort="flags">flags</th><th>trend</th><th data-sort="checked">checked</th></tr></thead>
<tbody>
${rows}
${pendingRows}
</tbody></table>
${feedSection}
<p class="sub">rows: &#10003; passed &middot; &#9888; flagged &middot; &#8943; waiting &mdash;
verdicts: &#10004; verified &middot; &#9680; partial &middot; ? no evidence &middot; &#10008; contradicted &mdash;
c &middot; c &middot; r = correctness &middot; completeness &middot; risk</p>
<p class="sub">repo names open that repo&#39;s full record &middot; click anywhere else in a row for the current report &middot; trend dots (last 6 checks) open past reports &middot; &#8599; opens the repo or release on its forge</p>
<p class="sub">scores measure how well the release notes match the shipped diff &mdash; not project quality, and never people; every number links to the full evidence behind it</p>
<script>
for (const tr of document.querySelectorAll("tr[data-href]")) {
  tr.addEventListener("click", (e) => {
    if (e.target.closest("a")) return;
    location.href = tr.dataset.href;
  });
}
const tbody = document.querySelector("tbody");
const pendingRows = [...tbody.querySelectorAll("tr.pending")];
let sortKey = null;
let dir = 1;
for (const th of document.querySelectorAll("th[data-sort]")) {
  th.addEventListener("click", () => {
    const key = th.dataset.sort;
    // Repo names read naturally ascending; numbers and dates start with the
    // biggest/newest on top. A second click flips.
    dir = key === sortKey ? -dir : key === "repo" ? 1 : -1;
    sortKey = key;
    const numeric = key === "score" || key === "flags";
    const rows = [...tbody.querySelectorAll("tr[data-href]")].sort((a, b) => {
      const va = a.dataset[key] ?? "";
      const vb = b.dataset[key] ?? "";
      return dir * (numeric ? Number(va) - Number(vb) : va.localeCompare(vb));
    });
    for (const r of rows) tbody.appendChild(r);
    for (const r of pendingRows) tbody.appendChild(r);
    for (const o of document.querySelectorAll("th[data-sort]")) {
      o.classList.toggle("sorted", o === th);
      if (o === th) o.dataset.dir = dir > 0 ? "asc" : "desc";
      else delete o.dataset.dir;
    }
  });
}
document.getElementById("flagged-only").addEventListener("click", (e) => {
  document.body.classList.toggle("only-flagged");
  e.currentTarget.classList.toggle("active");
});
</script>
</body></html>
`;
}

/**
 * Static Atom feed next to the index — the pull counterpart to --notify's
 * push. Links are relative and resolve against the feed's own URL, so the
 * reports directory stays scp-able as a whole. Entry ids derive from state
 * key + tag and `updated` is the stored checkedAt, so re-rendering the feed
 * never re-publishes an old check as new.
 */
export function toWatchAtomFeed(
  state: WatchState,
  generatedAt: string,
  configured?: WatchedEntry[],
): string {
  const entries: Array<{ key: string; rs: RepoState | undefined }> = configured
    ? configured.map((e) => ({ key: e.key, rs: state.repos[e.key] }))
    : Object.entries(state.repos).map(([key, rs]) => ({ key, rs }));
  const checks = entries
    .filter((e) => e.rs)
    .flatMap(({ key, rs }) => rs!.history.map((h) => ({ key, h })))
    // A feed reader treats every entry as news. Backfilled checks are the
    // past — 40 of them arriving at once, several flagged, is exactly the
    // historical alert noise --notify refuses to make; the pull channel
    // refuses it too. They stay on the index's own feed section and pages.
    .filter(({ h }) => !h.backfilled)
    .sort((a, b) => b.h.checkedAt.localeCompare(a.h.checkedAt))
    .slice(0, 50);
  const items = checks.map(({ key, h }) => {
    const id = `urn:comparereleaseii:${encodeURIComponent(key)}:${encodeURIComponent(h.tag)}`;
    const v = h.verdicts;
    const summary =
      `score ${h.score}/100 (${h.scoreLabel})${h.flagged ? " — FLAGGED" : ""} · ` +
      `verdicts: ${v.verified} verified, ${v.partial} partial, ${v.noEvidence} no-evidence, ${v.contradicted} contradicted · ` +
      `flags: ${h.flagCount}${h.criticalFlags ? ` (${h.criticalFlags} critical)` : ""}` +
      (h.brokenPromises ? ` · ${h.brokenPromises} broken promise(s)` : "") +
      (h.warnings?.length ? ` · ${h.warnings.join(" · ")}` : "");
    return `<entry>
<id>${esc(id)}</id>
<title>${esc(`${key} ${h.tag} — ${h.score}/100 ${h.scoreLabel}${h.flagged ? " ⚠" : ""}`)}</title>
<updated>${esc(h.checkedAt)}</updated>
<link rel="alternate" type="text/html" href="${esc(h.report)}"/>
<summary>${esc(summary)}</summary>
</entry>`;
  });
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<id>urn:comparereleaseii:watch-feed</id>
<title>Release watch — comparereleaseii</title>
<updated>${esc(generatedAt)}</updated>
<author><name>comparereleaseii</name></author>
<link rel="alternate" type="text/html" href="index.html"/>
${items.join("\n")}
</feed>
`;
}
