// SPDX-License-Identifier: GPL-3.0-or-later
//
// Which commits does the breadth route ALONE keep covered — and how thin is
// the claim that covers them?
//
// Issue #18's miss is a two-file commit covered because an unrelated claim
// happens to cite both paths: at 2 files the every-file bar is trivially met.
// Any repair candidate (a floor on the commit's file count, a proportionality
// bar against the citing claim's evidence size) must be aimed from the
// distribution of what the route holds in HONEST notes, not from the one
// pathological case — the five rejected candidates in `computeCoverage`'s
// comments all came from a comment instead of a measurement, and all missed.
//
// So this walks every corpus release control-side (real notes, judge off),
// re-evaluates the four coverage routes per commit the way
// `diagnose-coverage` does, and reports every commit where breadth is the
// only route standing: its file count, churn, and the best citing claim with
// the size of that claim's own evidence pool. What a candidate rule would
// uncover in the control is exactly this list — the settled rule binds: a
// repair that counts a documented commit as undocumented is not a repair.
//
//   node scripts/breadth-census.ts <reports dir>   # summary to stderr, JSON to stdout
//
// Reads the diffs from the clone cache; judge off throughout, so it needs no
// key and no network.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { analyzeRelease, type CheckSettings } from "../src/check.ts";
import { cloneDirFor } from "../src/paths.ts";
import { loadLocalRange, localRepoContext } from "../src/sources/local.ts";
import { lexicalMatch } from "../src/match.ts";
import { pinBumps, sameName } from "../src/pins.ts";
import { renderNotes } from "./notes-mutations.ts";
import { dedupeReports } from "./corpus-aggregate.ts";
import type { ClaimResult, DiffFile, Report } from "../src/types.ts";

const reportsDir = process.argv[2];
if (!reportsDir) {
  console.error("Usage: node scripts/breadth-census.ts <reports dir>");
  process.exit(2);
}

async function findReports(d: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith(".json")) found.push(p);
    }
  }
  await walk(d);
  return found;
}

const parsed: Report[] = [];
for (const f of await findReports(reportsDir)) {
  try {
    const r = JSON.parse(await readFile(f, "utf8")) as Report;
    if (r?.repoLabel && r.headRef && r.metrics && r.baseRef) parsed.push(r);
  } catch {
    /* not a report */
  }
}
const reports = dedupeReports(parsed);

const settings: CheckSettings = {
  judgeMode: "off",
  engine: null,
  escalateEngine: null,
  concurrency: 4,
  reverse: true,
  baseline: 0,
  history: null,
  findings: false,
};

interface BreadthOnly {
  repo: string;
  tag: string;
  sha: string;
  subject: string;
  files: number;
  churn: number;
  commitsInRelease: number;
  /** Claims whose own evidence reaches every file of the commit. */
  coveringClaims: number;
  bestClaimText: string;
  /** Size of the best covering claim's own evidence pool. */
  bestClaimEvidence: number;
}

const rows: BreadthOnly[] = [];
let releases = 0;
let skipped = 0;

for (const report of reports) {
  const clone = await cloneDirFor(report.linkBase ?? `https://github.com/${report.repoLabel}`);
  if (!clone) {
    skipped++;
    continue;
  }
  let range, context;
  try {
    range = await loadLocalRange(clone, report.baseRef, report.headRef);
    context = await localRepoContext(clone, report.headRef);
  } catch {
    skipped++;
    continue;
  }
  const claims = report.results.map((r) => r.claim);
  const control = await analyzeRelease(
    {
      repoLabel: report.repoLabel,
      baseRef: report.baseRef,
      headRef: report.headRef,
      ...range,
      notes: renderNotes(claims),
      warnings: [],
    },
    context,
    null,
    settings,
  );
  releases++;

  const uncovered = new Set((control.uncovered ?? []).map((u) => u.commit.sha));
  const isBump = (r: ClaimResult) => r.claim.bump !== undefined && r.claim.kind === "change";
  const covering = control.results.filter((r) => r.verdict === "verified" || r.verdict === "partial");
  const evidenceShas = new Set(covering.flatMap((r) => r.evidence.commitShas));
  const bumpClaims = covering.filter(isBump);
  const nonBump = covering.filter((r) => !isBump(r));
  const changeClaims = control.results
    .filter((r) => r.claim.kind === "change" && r.verdict !== "skipped")
    .map((r) => r.claim);

  for (const commit of range.commits) {
    if (uncovered.has(commit.sha)) continue;
    if (/^Merge (pull request|branch|remote)/i.test(commit.subject)) continue;
    if (evidenceShas.has(commit.sha)) continue;
    const files = await range.commitFiles(commit.sha).catch(() => [] as DiffFile[]);
    if (!files.length) continue;
    const pins = pinBumps(files);
    const viaPin =
      bumpClaims.length > 0 &&
      pins.length > 0 &&
      bumpClaims.some((r) => pins.some((p) => sameName(r.claim.bump!.name, p.name)));
    if (viaPin) continue;
    const perClaim = nonBump
      .map((r) => {
        const cited = new Set(r.evidence.files);
        return { r, hit: files.filter((f) => cited.has(f.path)).length, size: cited.size };
      })
      .filter((x) => x.hit === files.length);
    if (!perClaim.length) continue;
    const viaSubstance = changeClaims.some((cl) => lexicalMatch(cl, files).score >= 5);
    if (viaSubstance) continue;
    const best = perClaim.sort((a, b) => a.size - b.size)[0];
    rows.push({
      repo: report.repoLabel,
      tag: report.headRef,
      sha: commit.sha.slice(0, 8),
      subject: commit.subject.slice(0, 90),
      files: files.length,
      churn: files.reduce((n, f) => n + f.additions + f.deletions, 0),
      commitsInRelease: range.commits.length,
      coveringClaims: perClaim.length,
      bestClaimText: best.r.claim.text.slice(0, 90),
      bestClaimEvidence: best.size,
    });
  }
  console.error(`${report.repoLabel}@${report.headRef}: done (${rows.length} breadth-only so far)`);
}

const byFiles = new Map<number, number>();
for (const r of rows) byFiles.set(r.files, (byFiles.get(r.files) ?? 0) + 1);
console.error(
  `\n${releases} releases measured, ${skipped} skipped; ${rows.length} commits held by breadth alone.` +
    `\nfile-count distribution: ${[...byFiles.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([n, c]) => `${n}:${c}`)
      .join("  ")}`,
);
console.log(JSON.stringify({ releases, skipped, rows }, null, 1));
