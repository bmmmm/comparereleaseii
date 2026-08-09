// SPDX-License-Identifier: GPL-3.0-or-later
//
// Which coverage route keeps a hidden commit documented?
//
// `mutate-notes` answers whether an omission is caught. When it is not, the
// next question is always which of `computeCoverage`'s four routes covered
// the commit anyway — the anchor, the pin join, the evidence union, or the
// substance bar — and answering it by reading the code is how three repairs
// got proposed for a route that turned out not to be the one at fault (see
// the rejected candidates in `computeCoverage`'s own comments).
//
// So this rebuilds the mutant the harness built, then evaluates all four
// routes against the hidden commit by hand and prints which one fired. On
// 2026-08-09 it settled issue #8's open question in one run: all seven
// `omission` misses on the full corpus are the evidence union and nothing
// else, at shares from 0.60 to 1.00 — and the two at 1.00 mean no threshold
// on that share can close them.
//
//   node scripts/diagnose-coverage.ts "owner/repo@tag" ["owner/repo@tag" …]
//
// Reads the corpus from tmp/corpus and the diffs from the clone cache; judge
// off throughout, so it needs no key and no network.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { analyzeRelease, type CheckSettings } from "../src/check.ts";
import { cloneDirFor } from "../src/paths.ts";
import { loadLocalRange, localRepoContext } from "../src/sources/local.ts";
import { anchorMatch, lexicalMatch } from "../src/match.ts";
import { pinBumps, sameName } from "../src/pins.ts";
import { anchorsTo, bumpCovers, renderNotes, rendersAnyClaim } from "./notes-mutations.ts";
import { dedupeReports } from "./corpus-aggregate.ts";
import type { Claim, ClaimResult, DiffFile, Report, Verdict } from "../src/types.ts";

const TARGETS = process.argv.slice(2);

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
for (const f of await findReports("tmp/corpus")) {
  try {
    const r = JSON.parse(await readFile(f, "utf8")) as Report;
    if (r?.repoLabel && r.headRef && r.metrics && r.baseRef) parsed.push(r);
  } catch {
    /* not a report */
  }
}
const reports = dedupeReports(parsed).filter((r) => TARGETS.includes(`${r.repoLabel}@${r.headRef}`));

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

async function commitChurn(files: (sha: string) => Promise<DiffFile[]>, sha: string): Promise<number> {
  try {
    return (await files(sha)).reduce((n, f) => n + f.additions + f.deletions, 0);
  } catch {
    return 0;
  }
}

for (const report of reports) {
  const clone = await cloneDirFor(report.linkBase ?? `https://github.com/${report.repoLabel}`);
  if (!clone) continue;
  const range = await loadLocalRange(clone, report.baseRef, report.headRef);
  const context = await localRepoContext(clone, report.headRef);
  const claims = report.results.map((r) => r.claim);
  const base = { repoLabel: report.repoLabel, baseRef: report.baseRef, headRef: report.headRef, ...range };
  const analyse = (notes: string) =>
    analyzeRelease({ ...base, notes, warnings: [] }, context, null, settings);

  const control = await analyse(renderNotes(claims));
  const uncovered = new Set((control.uncovered ?? []).map((u) => u.commit.sha));
  const controlVerdict = new Map<string, Verdict>();
  for (const r of control.results) {
    const covers = r.verdict === "verified" || r.verdict === "partial";
    if (covers || !controlVerdict.has(r.claim.text)) controlVerdict.set(r.claim.text, r.verdict);
  }
  const ranked = (
    await Promise.all(
      range.commits
        .filter((c) => !uncovered.has(c.sha))
        .map(async (c) => ({ c, churn: await commitChurn(range.commitFiles, c.sha) })),
    )
  ).sort((a, b) => b.churn - a.churn);

  let hidden: { churn: number; sha: string; covering: Claim[] } | null = null;
  for (const { c, churn } of ranked.slice(0, 8)) {
    const files = await range.commitFiles(c.sha).catch(() => [] as DiffFile[]);
    const pins = pinBumps(files);
    const covering = claims.filter(
      (cl) =>
        anchorsTo(cl, c.sha, c.prNumbers) ||
        lexicalMatch(cl, files).score >= 5 ||
        bumpCovers(cl, controlVerdict.get(cl.text), pins),
    );
    if (churn > 0 && covering.length && rendersAnyClaim(claims.filter((cl) => !covering.includes(cl)))) {
      hidden = { churn, sha: c.sha, covering };
      break;
    }
  }
  if (!hidden) {
    console.log(`${report.repoLabel}@${report.headRef}: no mutable commit`);
    continue;
  }

  const kept = claims.filter((cl) => !hidden.covering.includes(cl));
  const mutant = await analyse(renderNotes(kept));
  const stillCovered = !(mutant.uncovered ?? []).some((u) => u.commit.sha === hidden.sha);
  const files = await range.commitFiles(hidden.sha).catch(() => [] as DiffFile[]);
  const commit = range.commits.find((c) => c.sha === hidden.sha)!;

  // The four routes, in the order computeCoverage tries them.
  const mutantClaims = mutant.results.map((r) => r.claim);
  const anchored = mutantClaims.some((cl) => anchorMatch(cl, [commit]).commits.length > 0);
  const evidenceShas = new Set(
    mutant.results
      .filter((r) => r.verdict === "verified" || r.verdict === "partial")
      .flatMap((r) => r.evidence.commitShas),
  );
  const isBump = (r: ClaimResult) => r.claim.bump !== undefined && r.claim.kind === "change";
  const bumpClaims = mutant.results.filter(
    (r) => (r.verdict === "verified" || r.verdict === "partial") && isBump(r),
  );
  const pins = pinBumps(files);
  const viaPin =
    bumpClaims.length > 0 &&
    pins.length > 0 &&
    bumpClaims.some((r) => pins.some((p) => sameName(r.claim.bump!.name, p.name)));
  const evidenceFiles = new Set(
    mutant.results
      .filter((r) => (r.verdict === "verified" || r.verdict === "partial") && !isBump(r))
      .flatMap((r) => r.evidence.files),
  );
  const hit = files.filter((f) => evidenceFiles.has(f.path)).length;
  const share = files.length ? hit / files.length : 0;
  const changeClaims = mutant.results
    .filter((r) => r.claim.kind === "change" && r.verdict !== "skipped")
    .map((r) => r.claim);
  const viaSubstance = changeClaims.some((cl) => lexicalMatch(cl, files).score >= 5);
  const substanceClaim = changeClaims.find((cl) => lexicalMatch(cl, files).score >= 5);

  console.log(
    `\n${report.repoLabel}@${report.headRef} — ${hidden.churn} lines, ${files.length} files, ` +
      `${hidden.covering.length} claim(s) removed, ${mutantClaims.length} left` +
      `\n  ${commit.subject.slice(0, 78)}` +
      `\n  still covered in the mutant: ${stillCovered}` +
      `\n  route anchor     : ${anchored} (evidence shas: ${evidenceShas.has(hidden.sha)})` +
      `\n  route pin join   : ${viaPin}${pins.length ? ` (${pins.length} pin(s) in the commit)` : ""}` +
      `\n  route union      : ${share >= 0.5} (${hit}/${files.length} = ${share.toFixed(2)})` +
      `\n  route substance  : ${viaSubstance}` +
      (substanceClaim ? ` — "${substanceClaim.text.slice(0, 60)}" scores ${lexicalMatch(substanceClaim, files).score}` : ""),
  );
}
