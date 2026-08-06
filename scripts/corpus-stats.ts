// SPDX-License-Identifier: GPL-3.0-or-later
// What a watched corpus says about release notes in general — the aggregate
// over every report a watch home has accumulated. Answers "how often do notes
// and diff disagree, across projects" with numbers someone else can re-derive.
//
// Repo names stay out of the output unless `--named` asks for them. This tool
// informs its operator; it does not publish compressed judgements next to
// other people's project names (ROADMAP.md, settled 2026-07-28). The default
// encodes that rule so a copy-paste into a public text cannot break it.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Report } from "../src/types.ts";
import { CLAIM_CLASSES, aggregate, dedupeReports } from "./corpus-aggregate.ts";

const args = process.argv.slice(2);
const named = args.includes("--named");
const asJson = args.includes("--json");
const dir = args.find((a) => !a.startsWith("--")) ?? "reports";

async function findReports(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(d: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    // Sorted: dedupeReports keeps the first read of a duplicate, so the winner
    // must not depend on the filesystem's iteration order.
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith(".json")) found.push(p);
    }
  }
  await walk(root);
  return found;
}

const files = await findReports(dir);
if (files.length === 0) {
  console.error(
    `No report JSON under ${dir}. Point this at a watch home's reports directory, e.g. ~/release-watch/reports.`,
  );
  process.exit(2);
}

const parsed: Report[] = [];
let unreadable = 0;
for (const f of files) {
  try {
    const r = JSON.parse(await readFile(f, "utf8")) as Report;
    if (!r?.repoLabel || !r.headRef || !r.metrics) unreadable++;
    else parsed.push(r);
  } catch {
    unreadable++;
  }
}

const all = dedupeReports(parsed);
const summary = aggregate(all);
const pct = (n: number, d: number) => (d === 0 ? "—" : `${((n / d) * 100).toFixed(1)} %`);

if (asJson) {
  const { repoLabels, ...rest } = summary;
  console.log(JSON.stringify({ ...rest, unreadableFiles: unreadable, ...(named ? { repoLabels } : {}) }, null, 2));
  process.exit(0);
}

const out: string[] = [];
out.push(`# Corpus statistics`);
out.push("");
out.push(
  `${summary.releases} releases across ${summary.repos} repositories` +
    (unreadable ? ` (${unreadable} file(s) unreadable or pre-schema, skipped)` : ""),
);
out.push("");
out.push(`| Measure | Value |`);
out.push(`|---|---|`);
out.push(`| Releases checked | ${summary.releases} |`);
out.push(`| Repositories | ${summary.repos} |`);
out.push(`| Reverse-checked (silent changes looked for) | ${summary.reverseChecked} |`);
out.push(`| Claims parsed | ${summary.claims} |`);
out.push(`| Claims put to a judge | ${summary.judged} (${pct(summary.judged, summary.claims)}) |`);
out.push(
  `| Releases with a critical flag | ${summary.releasesWithCriticalFlag} (${pct(summary.releasesWithCriticalFlag, summary.releases)}) |`,
);
out.push(
  `| Releases with a contradicted claim | ${summary.releasesWithContradictedClaim} (${pct(summary.releasesWithContradictedClaim, summary.releases)}) |`,
);
out.push(
  `| Trust score min / median / max | ${summary.score.min} / ${summary.score.median} / ${summary.score.max} |`,
);
const cov = summary.churnCoveredRatio.median;
out.push(`| Median share of changed lines a note covers | ${cov == null ? "—" : `${(cov * 100).toFixed(1)} %`} |`);
out.push("");
out.push(`## Verdicts`);
out.push("");
out.push(`| Verdict | Claims | Share |`);
out.push(`|---|---:|---:|`);
for (const [v, n] of Object.entries(summary.verdicts).sort((a, b) => b[1] - a[1])) {
  out.push(`| \`${v}\` | ${n} | ${pct(n, summary.claims)} |`);
}
out.push("");
out.push(`## Dependency-bump claims`);
out.push("");
const b = summary.bumps;
const others = summary.claims - b.claims;
const rate = (n: number, d: number) => (d === 0 ? "—" : `${((n / d) * 100).toFixed(2)} %`);
out.push(
  `A bump claim names a pin and a version, so the diff can settle it without` +
    ` reading prose. Counted apart because the corpus is what decides whether` +
    ` the class needs its own channel:`,
);
out.push("");
out.push(`| | Bump claims | Every other claim |`);
out.push(`|---|---:|---:|`);
out.push(`| Claims | ${b.claims} (${pct(b.claims, summary.claims)}) | ${others} |`);
for (const v of ["verified", "partial", "no-evidence", "contradicted", "skipped"]) {
  out.push(`| \`${v}\` | ${b.verdicts[v] ?? 0} | ${b.otherVerdicts[v] ?? 0} |`);
}
out.push(
  `| Contradicted rate | **${rate(b.verdicts.contradicted ?? 0, b.claims)}** | **${rate(b.otherVerdicts.contradicted ?? 0, others)}** |`,
);
out.push("");
out.push(`## The judge bill, by claim class`);
out.push("");
out.push(
  `Where the judge calls went. The classes are the ROUTES a claim takes, not` +
    ` its topic: what separates them is the evidence the deterministic pass` +
    ` already had before anything was asked. A class that costs a large share` +
    ` of the bill and answers with variance — the same engine, the same` +
    ` prompt, passes that disagree — is a candidate for a deterministic rule,` +
    ` the way the bump class was.`,
);
out.push("");
out.push(
  `Call counts are a **floor**: the report records that a judge answered, that` +
    ` a second engine reviewed, and every vote an independent pass returned.` +
    ` It records nothing about a \`need\` round that asked for more files, a` +
    ` verification pass that threw, an escalation that failed, or a surplus` +
    ` audit that found nothing. A class that looks expensive here is only more so.`,
);
out.push("");
const bill = summary.judgeBill;
out.push(`| Class | Claims | Judged | Calls (≥) | Share of bill | Second look | Split votes | Judge failed |`);
out.push(`|---|---:|---:|---:|---:|---:|---:|---:|`);
for (const cls of CLAIM_CLASSES) {
  const cb = bill.byClass[cls];
  if (!cb) continue;
  out.push(
    `| \`${cls}\` | ${cb.claims} | ${cb.judged} | ${cb.calls} | ${pct(cb.calls, bill.calls)} |` +
      ` ${cb.secondLook} | ${cb.split} | ${cb.failed} |`,
  );
}
out.push(
  `| **total** | **${summary.claims}** | **${summary.judged}** | **${bill.calls}** | | | | |`,
);
out.push("");
out.push(`### What each class answered`);
out.push("");
const VERDICT_ORDER = ["verified", "partial", "no-evidence", "contradicted", "skipped"];
out.push(`| Class | ${VERDICT_ORDER.map((v) => `\`${v}\``).join(" | ")} |`);
out.push(`|---|${VERDICT_ORDER.map(() => "---:").join("|")}|`);
for (const cls of CLAIM_CLASSES) {
  const cb = bill.byClass[cls];
  if (!cb) continue;
  out.push(`| \`${cls}\` | ${VERDICT_ORDER.map((v) => cb.verdicts[v] ?? 0).join(" | ")} |`);
}
out.push("");
out.push(`## Score labels`);
out.push("");
out.push(`| Label | Releases | Share |`);
out.push(`|---|---:|---:|`);
for (const [l, n] of Object.entries(summary.score.labels).sort((a, b) => b[1] - a[1])) {
  out.push(`| ${l} | ${n} | ${pct(n, summary.releases)} |`);
}
out.push("");
out.push(`## Risk flags raised`);
out.push("");
out.push(`| Flag | Count |`);
out.push(`|---|---:|`);
for (const [k, n] of Object.entries(summary.flagKinds).sort((a, b) => b[1] - a[1])) {
  out.push(`| \`${k}\` | ${n} |`);
}
if (named) {
  out.push("");
  out.push(`## Repositories included`);
  out.push("");
  for (const r of summary.repoLabels) out.push(`- ${r}`);
}
console.log(out.join("\n"));
