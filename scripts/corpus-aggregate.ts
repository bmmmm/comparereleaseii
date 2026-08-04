// SPDX-License-Identifier: GPL-3.0-or-later
// The arithmetic behind `pnpm corpus-stats`, kept free of I/O so the counting
// rules can be tested against fixtures. `corpus-stats.ts` reads the files and
// renders; everything that decides a number lives here.
import { detectBumpClaim } from "../src/pins.ts";
import type { Report } from "../src/types.ts";

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

  for (const r of reports) {
    repos.add(r.repoLabel);
    let contradicted = false;
    for (const res of r.results ?? []) {
      claims++;
      verdicts[res.verdict] = (verdicts[res.verdict] ?? 0) + 1;
      if (res.judged) judged++;
      if (res.verdict === "contradicted") contradicted = true;
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
