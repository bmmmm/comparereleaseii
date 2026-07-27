// SPDX-License-Identifier: GPL-3.0-or-later
import { readFile } from "node:fs/promises";
import { cloneDirFor } from "./paths.ts";
import { loadGithubRelease, fetchGithubContext } from "./sources/github.ts";
import { ensureClone, loadLocalRange } from "./sources/local.ts";
import { parseClaims, markCarriedOver } from "./claims.ts";
import { verifyClaims, computeCoverage } from "./verify.ts";
import { suggestNotes } from "./suggest.ts";
import { computeMetrics } from "./metrics.ts";
import { checkPromises, type CarriedPromise } from "./promises.ts";
import { buildSnapshots, summarizeBaseline, type HistorySource } from "./history.ts";
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
  /** Where those releases come from — any forge, or null to skip the baseline. */
  history?: HistorySource | null;
  /** Draft a release-note line for the highest-churn undocumented commits. */
  suggest?: boolean;
  /** Cap on how many uncovered commits get an LLM-drafted suggestion (cost bound). */
  suggestLimit?: number;
  /** Still-open promises from earlier releases (watch state) to re-check. */
  carriedPromises?: CarriedPromise[];
}

/** Injection seam for tests — production always uses the real sources. */
export interface GithubLoadDeps {
  loadGithubRelease: typeof loadGithubRelease;
  fetchGithubContext: typeof fetchGithubContext;
  cloneDirFor: typeof cloneDirFor;
  ensureClone: typeof ensureClone;
  loadLocalRange: typeof loadLocalRange;
}

/**
 * Release data + repo context from GitHub, falling back to a partial clone
 * when the compare API truncates the diff.
 */
export async function loadGithubReleaseData(
  repo: string,
  opts: { tag?: string; base?: string; notesFile?: string },
  deps: GithubLoadDeps = { loadGithubRelease, fetchGithubContext, cloneDirFor, ensureClone, loadLocalRange },
): Promise<{ data: ReleaseData; context: RepoContext }> {
  let [data, context] = await Promise.all([
    deps.loadGithubRelease({ repo, tag: opts.tag, base: opts.base }),
    deps.fetchGithubContext(repo),
  ]);

  if (opts.notesFile) {
    data.notes = await readFile(opts.notesFile, "utf8");
  }

  if (data.truncated) {
    console.error("Compare API truncated the diff — falling back to a partial clone…");
    try {
      // A clone target in a shared temp dir is a symlink waiting to happen —
      // git would happily follow it and write outside the cache.
      const url = `https://github.com/${repo}.git`;
      const dir = await deps.cloneDirFor(url);
      if (!dir) throw new Error("no private cache directory for the clone fallback");
      await deps.ensureClone(url, dir);
      const range = await deps.loadLocalRange(dir, data.baseRef, data.headRef);
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

export interface RepoLink {
  /** Web URL prefix for commit/compare links, e.g. https://github.com/o/r. */
  base: string;
  /** GitLab spells commit/compare routes with a `/-/`; every other forge doesn't. */
  style: "github" | "gitlab";
}

/**
 * The full analysis pipeline for loaded release data: claims, verification,
 * coverage, metrics, report. `link` enables web links in the report; pass
 * null for sources without a known web origin (--local).
 */
export async function analyzeRelease(
  data: ReleaseData,
  context: RepoContext,
  link: RepoLink | null,
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

  // A single unbuildable snapshot already warns inside buildSnapshots; this
  // catch is the wholesale failure (release listing down, clone unusable) —
  // without a warning the report reads exactly like "too few releases".
  const baselinePromise =
    s.history && s.baseline > 0
      ? buildSnapshots(s.history, {
          count: s.baseline,
          before: data.headRef,
          concurrency: s.concurrency,
        }).catch(
          (err: Error) => {
            data.warnings.push(
              `Baseline unavailable (${err.message.split("\n")[0].slice(0, 120)}) — anomaly comparison against past releases skipped.`,
            );
            return null;
          },
        )
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

  // Promises are about LATER releases, so they inform and never score: the
  // flag is info-level and pushed after computeMetrics has fixed the numbers.
  const promises = checkPromises(data, s.carriedPromises ?? []);
  for (const p of promises) {
    if (p.status !== "broken") continue;
    metrics.flags.push({
      severity: "info",
      kind: "broken-promise",
      message: `Broken promise from ${p.from}: "${p.text.slice(0, 140)}" — ${p.note}`,
      files: [],
      commitShas: [],
    });
  }

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
    linkBase: link?.base,
    linkStyle: link?.style,
    promises: promises.length ? promises : undefined,
  };
}
