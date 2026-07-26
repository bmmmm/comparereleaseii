// SPDX-License-Identifier: GPL-3.0-or-later
import { pooled } from "./util.ts";
import { capHunks } from "./verify.ts";
import { buildSuggestPrompt, parseSuggestOutput, type JudgeEngine } from "./judge.ts";
import type { ReleaseData, UncoveredCommit } from "./types.ts";

export interface SuggestOptions {
  engine: JudgeEngine;
  concurrency: number;
  /** Only the top N uncovered commits (by churn, already sorted) get drafted — bounds LLM cost. */
  limit: number;
  maxEvidenceChars: number;
}

/**
 * Draft a release-note line for the highest-churn undocumented commits, so
 * the completeness gap comes with a starting point instead of just a flag.
 * Best-effort: a commit whose draft fails or has no diff is returned as-is.
 */
export async function suggestNotes(
  data: ReleaseData,
  uncovered: UncoveredCommit[],
  opts: SuggestOptions,
): Promise<UncoveredCommit[]> {
  const targets = uncovered.slice(0, opts.limit);
  if (!targets.length) return uncovered;
  const drafted = await pooled(targets, opts.concurrency, async (u) => {
    const files = await data.commitFiles(u.commit.sha).catch(() => []);
    const hunks = capHunks(
      files.filter((f) => f.patch).map((f) => ({ path: f.path, hunk: f.patch! })),
      opts.maxEvidenceChars,
    );
    if (!hunks.length) return u;
    try {
      const suggestion = parseSuggestOutput(
        await opts.engine.judge(
          buildSuggestPrompt({ repoLabel: data.repoLabel, commitSubject: u.commit.subject, hunks }),
        ),
      );
      return suggestion ? { ...u, suggestedNote: suggestion } : u;
    } catch {
      return u;
    }
  });
  return [...drafted, ...uncovered.slice(opts.limit)];
}
