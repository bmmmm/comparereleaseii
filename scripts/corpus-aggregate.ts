// SPDX-License-Identifier: GPL-3.0-or-later
// The arithmetic behind `pnpm corpus-stats`, kept free of I/O so the counting
// rules can be tested against fixtures. `corpus-stats.ts` reads the files and
// renders; everything that decides a number lives here.
import { detectBumpClaim } from "../src/pins.ts";
import type { ClaimResult, Report } from "../src/types.ts";

/**
 * What kind of question a claim put to the pipeline. Total by construction —
 * every claim lands in exactly one bucket — because the whole point is to
 * divide the judge bill without a remainder nobody accounts for.
 *
 * The classes are the routes, not the topics: `bump` is settled off the
 * diff's own pin delta, `generated` is boilerplate true by construction,
 * `meta` asserts nothing, and the four remaining ones differ in what evidence
 * the deterministic pass could find before any judge was asked. That is the
 * axis a deterministic rule can be built on; "security claims" or "UI claims"
 * is not.
 */
export type ClaimClass =
  | "meta"
  | "bump"
  | "generated"
  | "anchored-strong"
  | "anchored-weak"
  | "unanchored-lexical"
  | "unanchored-none";

export const CLAIM_CLASSES: ClaimClass[] = [
  "bump",
  "generated",
  "anchored-strong",
  "anchored-weak",
  "unanchored-lexical",
  "unanchored-none",
  "meta",
];

const ANCHORS = ["pr-anchor", "sha-anchor", "pin-anchor"];

/** Which class a stored result belongs to, read off the report alone. */
export function claimClass(res: ClaimResult): ClaimClass {
  if (res.claim?.kind === "meta") return "meta";
  // Reports written before the trait existed carry no `bump`; the class is
  // then read off the stored claim text, exactly as the bump summary does.
  if (res.claim?.bump ?? detectBumpClaim(res.claim?.text ?? "")) return "bump";
  if (res.generated) return "generated";
  const methods = res.evidence?.methods ?? [];
  const anchored = methods.some((m) => ANCHORS.includes(m));
  const lexical = methods.includes("lexical");
  if (anchored) return lexical ? "anchored-strong" : "anchored-weak";
  return lexical ? "unanchored-lexical" : "unanchored-none";
}

/**
 * Judge calls this claim demonstrably cost — a FLOOR, never the bill.
 *
 * What the report records: that a judge answered (`judged`), that a second
 * engine reviewed (`escalated` among the methods), and every vote an
 * independent verification pass returned (`votes`, whose first entry is the
 * original judgement). What it does not record: a `need` round that asked for
 * more files, a verification pass that threw, an escalation that failed, and
 * the surplus audit of a vague claim unless it found something. Each of those
 * is a call this returns nothing for, so the totals below understate — and a
 * class that already looks expensive at the floor is only more so.
 */
export function judgeCalls(res: ClaimResult): number {
  if (!res.judged && !res.judgeFailed) return 0;
  if (res.votes?.length) return res.votes.length + (res.surplus?.length ? 1 : 0);
  const escalated = (res.evidence?.methods ?? []).includes("escalated");
  return (escalated ? 2 : 1) + (res.surplus?.length ? 1 : 0);
}

/** What one class cost, and what came back for it. */
export interface ClassBill {
  claims: number;
  /** Claims a judge actually answered — the rest never left the diff. */
  judged: number;
  /** Claims the judge was asked about and could not answer. */
  failed: number;
  /** Floor on the calls spent; see judgeCalls for what is invisible. */
  calls: number;
  /** Claims that went through the independent verification passes. */
  secondLook: number;
  /**
   * …of those, the ones whose passes did not agree. The same engine, the same
   * prompt, a different answer: on that class the judge is contributing
   * variance, and a deterministic rule cannot do worse than a coin.
   */
  split: number;
  verdicts: Record<string, number>;
}

export interface JudgeBill {
  /** Floor on the corpus's total judge calls. */
  calls: number;
  byClass: Record<string, ClassBill>;
}

function emptyBill(): ClassBill {
  return { claims: 0, judged: 0, failed: 0, calls: 0, secondLook: 0, split: 0, verdicts: {} };
}

/**
 * The dependency-bump class, counted against everything else. A bump claim
 * states a pin and a version, which is the one claim shape a diff can settle
 * without reading a word of prose — and the corpus is what decides whether
 * it deserves its own channel.
 */
export interface BumpSummary {
  claims: number;
  verdicts: Record<string, number>;
  /** Same counts for every claim that is NOT a bump claim — the comparison
   * is the whole point of the number. */
  otherVerdicts: Record<string, number>;
}

export interface CorpusSummary {
  releases: number;
  repos: number;
  reverseChecked: number;
  claims: number;
  judged: number;
  verdicts: Record<string, number>;
  bumps: BumpSummary;
  /** What the judge was spent on, by claim class — the efficiency question. */
  judgeBill: JudgeBill;
  releasesWithCriticalFlag: number;
  releasesWithContradictedClaim: number;
  score: { min: number | null; median: number | null; max: number | null; labels: Record<string, number> };
  churnCoveredRatio: { releases: number; median: number | null; mean: number | null };
  flagKinds: Record<string, number>;
  repoLabels: string[];
}

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/**
 * A watch home carries reports written by several versions of this tool, and
 * the path layout changed with the path-segment sanitizer — the same release
 * can sit under both `owner/repo/` and `owner_repo/`. Identity is the release
 * itself, so counting files would inflate every figure here. The first report
 * for a key wins; callers pass files in a sorted order so the winner does not
 * depend on the filesystem.
 */
export function dedupeReports(reports: Report[]): Report[] {
  const byRelease = new Map<string, Report>();
  for (const r of reports) {
    if (!r?.repoLabel || !r.headRef || !r.metrics) continue;
    const key = `${r.repoLabel}@${r.headRef}`;
    if (!byRelease.has(key)) byRelease.set(key, r);
  }
  return [...byRelease.values()].sort((a, b) =>
    `${a.repoLabel}@${a.headRef}`.localeCompare(`${b.repoLabel}@${b.headRef}`),
  );
}

export function aggregate(reports: Report[]): CorpusSummary {
  const verdicts: Record<string, number> = {};
  const bumpVerdicts: Record<string, number> = {};
  const otherVerdicts: Record<string, number> = {};
  let bumpClaims = 0;
  const flagKinds: Record<string, number> = {};
  const labels: Record<string, number> = {};
  const scores: number[] = [];
  const coverage: number[] = [];
  const repos = new Set<string>();
  let claims = 0;
  let judged = 0;
  let withCritical = 0;
  let withContradicted = 0;
  let reverseChecked = 0;
  const byClass: Record<string, ClassBill> = {};
  let totalCalls = 0;

  for (const r of reports) {
    repos.add(r.repoLabel);
    let contradicted = false;
    for (const res of r.results ?? []) {
      claims++;
      verdicts[res.verdict] = (verdicts[res.verdict] ?? 0) + 1;
      if (res.judged) judged++;
      if (res.verdict === "contradicted") contradicted = true;

      const bill = (byClass[claimClass(res)] ??= emptyBill());
      bill.claims++;
      if (res.judged) bill.judged++;
      if (res.judgeFailed) bill.failed++;
      const calls = judgeCalls(res);
      bill.calls += calls;
      totalCalls += calls;
      if (res.votes?.length) {
        bill.secondLook++;
        if (new Set(res.votes).size > 1) bill.split++;
      }
      bill.verdicts[res.verdict] = (bill.verdicts[res.verdict] ?? 0) + 1;

      // Reports written before the trait existed carry no `bump`, and this
      // number exists precisely to predate the fix — so the class is read
      // off the stored claim text when the report does not name it.
      const bump = res.claim?.bump ?? detectBumpClaim(res.claim?.text ?? "");
      const bucket = bump ? bumpVerdicts : otherVerdicts;
      if (bump) bumpClaims++;
      bucket[res.verdict] = (bucket[res.verdict] ?? 0) + 1;
    }
    if (contradicted) withContradicted++;
    if (r.reverseChecked) reverseChecked++;

    const m = r.metrics;
    if (typeof m.churnCoveredRatio === "number") coverage.push(m.churnCoveredRatio);
    if (m.scores?.overall != null) {
      scores.push(m.scores.overall);
      labels[m.scores.label] = (labels[m.scores.label] ?? 0) + 1;
    }
    let critical = false;
    for (const f of m.flags ?? []) {
      const key = `${f.severity}/${f.kind}`;
      flagKinds[key] = (flagKinds[key] ?? 0) + 1;
      if (f.severity === "critical") critical = true;
    }
    if (critical) withCritical++;
  }

  return {
    releases: reports.length,
    repos: repos.size,
    reverseChecked,
    claims,
    judged,
    verdicts,
    bumps: { claims: bumpClaims, verdicts: bumpVerdicts, otherVerdicts },
    judgeBill: { calls: totalCalls, byClass },
    releasesWithCriticalFlag: withCritical,
    releasesWithContradictedClaim: withContradicted,
    score: {
      min: scores.length ? Math.min(...scores) : null,
      median: median(scores),
      max: scores.length ? Math.max(...scores) : null,
      labels,
    },
    churnCoveredRatio: {
      releases: coverage.length,
      median: median(coverage),
      mean: coverage.length ? coverage.reduce((a, b) => a + b, 0) / coverage.length : null,
    },
    flagKinds,
    repoLabels: [...repos].sort(),
  };
}
