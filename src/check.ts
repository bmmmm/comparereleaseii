// SPDX-License-Identifier: GPL-3.0-or-later
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGithubRelease, fetchGithubContext } from "./sources/github.ts";
import { ensureClone, loadLocalRange } from "./sources/local.ts";
import { parseClaims } from "./claims.ts";
import { verifyClaims, computeCoverage } from "./verify.ts";
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

  const truncated = data.warnings.some((w) => w.includes("full coverage"));
  if (truncated) {
    console.error("Compare API truncated the diff — falling back to a partial clone…");
    try {
      const dir = join(tmpdir(), "comparereleaseii-cache", "clones", repo.replace("/", "_"));
      await ensureClone(`https://github.com/${repo}.git`, dir);
      const range = await loadLocalRange(dir, data.baseRef, data.headRef);
      data = {
        ...data,
        ...range,
        warnings: data.warnings
          .filter((w) => !w.includes("full coverage"))
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
    uncovered: coverage?.uncovered ?? [],
    reverseChecked: s.reverse,
    metrics,
    warnings: data.warnings,
    engine: s.engine ? s.engine.name : "off (deterministic only)",
    linkBase: repoSlug ? `https://github.com/${repoSlug}` : undefined,
  };
}
