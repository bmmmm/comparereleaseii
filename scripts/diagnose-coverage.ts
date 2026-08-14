// SPDX-License-Identifier: GPL-3.0-or-later
//
// Which coverage route keeps a hidden commit documented?
//
// `mutate-notes` answers whether an omission is caught. When it is not, the
// next question is always which of `computeCoverage`'s four routes covered
// the commit anyway — the anchor, the pin join, the breadth route, or the
// substance bar — and answering it by reading the code is how three repairs
// got proposed for a route that turned out not to be the one at fault (see
// the rejected candidates in `computeCoverage`'s own comments).
//
// So this rebuilds the mutant the harness built, then evaluates all four
// routes against the hidden commit by hand and prints which one fired. It has
// now settled issue #8 twice. On 2026-08-09 it named the route: all seven
// `omission` misses on the full corpus were the evidence union and nothing
// else, at shares from 0.60 to 1.00, so no threshold on that share could
// close the two at 1.00. On 2026-08-14 the per-claim breakdown named what a
// pooled share had hidden — one of those two sits at 0.75 for every single
// claim and reaches 1.00 only by adding a second claim's manifest — which is
// the measurement the route stopped pooling on.
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
  // The breadth route asks this of ONE claim at a time. Ranking every claim by
  // how much of the commit its own evidence reaches is what makes the answer
  // actionable: "0.75, and the missing file is a manifest another claim cites"
  // says which claim to read, where a pooled share said only "somebody".
  const perClaim = mutant.results
    .filter((r) => (r.verdict === "verified" || r.verdict === "partial") && !isBump(r))
    .map((r) => {
      const cited = new Set(r.evidence.files);
      const hit = files.filter((f) => cited.has(f.path)).length;
      return { claim: r.claim, hit, share: files.length ? hit / files.length : 0 };
    })
    .sort((a, b) => b.share - a.share);
  const best = perClaim[0];
  const viaBreadth = best !== undefined && files.length > 0 && best.hit === files.length;
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
      `\n  route breadth    : ${viaBreadth}` +
      (best
        ? ` (best single claim ${best.hit}/${files.length} = ${best.share.toFixed(2)} — "${best.claim.text.slice(0, 60)}")`
        : " (no claim can cover)") +
      `\n  route substance  : ${viaSubstance}` +
      (substanceClaim ? ` — "${substanceClaim.text.slice(0, 60)}" scores ${lexicalMatch(substanceClaim, files).score}` : ""),
  );
}
