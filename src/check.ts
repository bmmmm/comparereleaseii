// SPDX-License-Identifier: GPL-3.0-or-later
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { cacheDir, safeSegment } from "./paths.ts";
import { loadGithubRelease, fetchGithubContext } from "./sources/github.ts";
import { ensureClone, loadLocalRange } from "./sources/local.ts";
import { parseClaims, markCarriedOver } from "./claims.ts";
import { verifyClaims, computeCoverage } from "./verify.ts";
import { suggestNotes } from "./suggest.ts";
import { computeMetrics } from "./metrics.ts";
import { buildSnapshots, summarizeBaseline } from "./history.ts";
import type { JudgeEngine } from "./judge.ts";
import type { ReleaseData, Report, RepoContext } from "./types.ts";

export interface CheckSettings {
  judgeMode: "auto" | "all" | "off";
  engine: JudgeEngine | null;
  escalateEngine: JudgeEngine | null;
  concurrency: number;
  reverse: boolean;
  /** Number of previous releases for the anomaly baseline (0 disables). */
  baseline: number;
  /** Draft a release-note line for the highest-churn undocumented commits. */
  suggest?: boolean;
  /** Cap on how many uncovered commits get an LLM-drafted suggestion (cost bound). */
  suggestLimit?: number;
}

/**
 * Release data + repo context from GitHub, falling back to a partial clone
 * when the compare API truncates the diff.
 */
export async function loadGithubReleaseData(
  repo: string,
  opts: { tag?: string; base?: string; notesFile?: string },
): Promise<{ data: ReleaseData; context: RepoContext }> {
  let [data, context] = await Promise.all([
    loadGithubRelease({ repo, tag: opts.tag, base: opts.base }),
    fetchGithubContext(repo),
  ]);

  if (opts.notesFile) {
    data.notes = await readFile(opts.notesFile, "utf8");
  }

  if (data.truncated) {
    console.error("Compare API truncated the diff — falling back to a partial clone…");
    try {
      // A clone target in a shared temp dir is a symlink waiting to happen —
      // git would happily follow it and write outside the cache.
      const clones = await cacheDir("clones");
      if (!clones) throw new Error("no private cache directory for the clone fallback");
      const dir = join(clones, safeSegment(repo));
      await ensureClone(`https://github.com/${repo}.git`, dir);
      const range = await loadLocalRange(dir, data.baseRef, data.headRef);
      data = {
        ...data,
        ...range,
        truncated: false,
        warnings: data.warnings
          .filter((w) => !w.startsWith("Compare API"))
          .concat("Diff loaded from a local partial clone (compare API truncated)."),
      };
    } catch (err) {
      data.warnings.push(
        `Partial-clone fallback failed: ${(err as Error).message.slice(0, 120)}`,
      );
    }
  }
  return { data, context };
}

/**
 * The full analysis pipeline for loaded release data: claims, verification,
 * coverage, metrics, report. `repoSlug` (owner/repo) enables the release
 * baseline and web links; pass null for local sources.
 */
export async function analyzeRelease(
  data: ReleaseData,
  context: RepoContext,
  repoSlug: string | null,
  s: CheckSettings,
): Promise<Report> {
  const claims = parseClaims(data.notes);
  if (data.baseNotes) markCarriedOver(claims, data.baseNotes, data.baseRef);
  if (!claims.length) {
    throw new Error("No claims found in the release notes — nothing to check.");
  }
  console.error(
    `${claims.length} claims parsed from the notes of ${data.headRef}; verifying against ${data.commits.length} commits…`,
  );

  const baselinePromise =
    repoSlug && s.baseline > 0
      ? buildSnapshots(repoSlug, { count: s.baseline, before: data.headRef }).catch(() => null)
      : Promise.resolve(null);
  const [results, baselineSnapshots] = await Promise.all([
    verifyClaims(data, claims, {
      judgeMode: s.judgeMode,
      engine: s.engine,
      escalateEngine: s.escalateEngine,
      concurrency: s.concurrency,
      maxHunks: 6,
      maxEvidenceChars: 20000,
    }),
    baselinePromise,
  ]);
  const baseline = baselineSnapshots?.length ? summarizeBaseline(baselineSnapshots) : null;

  const coverage = s.reverse ? await computeCoverage(data, claims, results) : null;
  const metrics = computeMetrics({ data, results, coverage, context, baseline });

  let uncovered = coverage?.uncovered ?? [];
  if (s.suggest) {
    if (!s.engine) {
      console.error("--suggest needs a judge engine — skipping (run with --engine, or drop the flag).");
    } else if (uncovered.length) {
      uncovered = await suggestNotes(data, uncovered, {
        engine: s.engine,
        concurrency: s.concurrency,
        limit: s.suggestLimit ?? 15,
        // Same budget as claim verification: one commit's full diff can be
        // as large as the hunks judged for a claim, and these are the
        // highest-churn commits in the release — the ones least served by a
        // tight cap.
        maxEvidenceChars: 20000,
      });
    }
  }

  return {
    repoLabel: data.repoLabel,
    baseRef: data.baseRef,
    headRef: data.headRef,
    stats: {
      commits: data.commits.length,
      files: data.files.length,
      additions: data.files.reduce((sum, f) => sum + f.additions, 0),
      deletions: data.files.reduce((sum, f) => sum + f.deletions, 0),
    },
    results,
    uncovered,
    reverseChecked: s.reverse,
    metrics,
    warnings: data.warnings,
    truncated: data.truncated ?? false,
    engine: s.engine ? s.engine.name : "off (deterministic only)",
    linkBase: repoSlug ? `https://github.com/${repoSlug}` : undefined,
  };
}
