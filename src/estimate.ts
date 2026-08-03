// SPDX-License-Identifier: GPL-3.0-or-later
// `--estimate`: what this check would cost before you pay for it. Runs the
// real verification pipeline against a stub engine that answers instantly and
// only counts, so the call count and prompt size are the ones a real run would
// produce — not a formula that drifts from the pipeline.
import { parseClaims } from "./claims.ts";
import { computeCoverage, verifyClaims } from "./verify.ts";
import { suggestNotes } from "./suggest.ts";
import { summarizeShipped } from "./findings.ts";
import type { JudgeEngine } from "./judge.ts";
import type { ReleaseData } from "./types.ts";

export interface EstimateOptions {
  judgeMode: "auto" | "all" | "off";
  concurrency: number;
  baseline: number;
  localPath: boolean;
  suggest: boolean;
  noReverse: boolean;
  suggestLimit: number;
  findings: boolean;
  findingsBudget?: number;
}

export async function printEstimate(data: ReleaseData, opts: EstimateOptions): Promise<number> {
  const claims = parseClaims(data.notes);
  if (!claims.length) {
    throw new Error("No claims found in the release notes — nothing to check.");
  }
  const est = { calls: 0, chars: 0 };
  const stub: JudgeEngine = {
    name: "estimate",
    judge: async (p: string) => {
      est.calls++;
      est.chars += p.length;
      // Shape-match the prompt so every downstream stage keeps running —
      // a findings pass whose parse comes back empty would skip the release
      // summary and undercount by one call.
      if (p.startsWith("You are describing what actually shipped")) {
        return '{"findings":[{"kind":"internal","audience":"user","text":"(estimate)","files":[]}]}';
      }
      if (p.startsWith("You are summarizing a release")) {
        return '{"summary":"(estimate)"}';
      }
      return '{"verdict":"partial","confidence":0.5,"files":[],"reasoning":"(estimate)"}';
    },
  };
  const results = await verifyClaims(data, claims, {
    judgeMode: opts.judgeMode,
    engine: stub,
    concurrency: 8,
    maxHunks: 6,
    maxEvidenceChars: 20000,
  });
  const change = results.filter((r) => r.claim.kind === "change");
  const generated = results.filter((r) => r.generated).length;

  let findingsCalls = 0;
  if (opts.findings) {
    const before = est.calls;
    await summarizeShipped(data, {
      engine: stub,
      concurrency: 8,
      budgetChars: opts.findingsBudget,
    });
    findingsCalls = est.calls - before;
  }

  let suggestTargets = 0;
  if (opts.suggest && !opts.noReverse) {
    // Reuse the same stub engine so its draft calls land in est.calls/chars —
    // the printed cost already covers --suggest, not just claim verification.
    const coverage = await computeCoverage(data, claims, results);
    suggestTargets = Math.min(coverage.uncovered.length, opts.suggestLimit);
    await suggestNotes(data, coverage.uncovered, {
      engine: stub,
      concurrency: 8,
      limit: opts.suggestLimit,
      maxEvidenceChars: 20000,
    });
  }

  const inTokens = Math.round(est.chars / 4);
  const reserve = Math.ceil(est.calls * 0.5);
  const timeMin = ((est.calls + reserve / 2) * 10) / opts.concurrency / 60;
  const apiCost = (inTokens / 1e6) * 1.0 + ((est.calls * 300) / 1e6) * 5.0;
  console.log(`\nCost estimate — ${data.repoLabel} ${data.baseRef} → ${data.headRef}`);
  console.log(`  Diff: ${data.commits.length} commits, ${data.files.length} files, ±${data.files.reduce((s, f) => s + f.additions + f.deletions, 0)} lines`);
  console.log(`  Claims: ${results.length} total — ${change.length} checkable (${generated} generated), ${results.length - change.length} informational`);
  if (findingsCalls) {
    console.log(
      `  Findings pass: ${findingsCalls} call(s) — subsystem reads + release summary, included below (--no-findings skips)`,
    );
  }
  if (opts.suggest) {
    console.log(
      opts.noReverse
        ? `  --suggest: no-op (--no-reverse disables the completeness check it drafts for)`
        : `  --suggest: up to ${suggestTargets} undocumented commit(s) drafted (--suggest-limit ${opts.suggestLimit}), included below`,
    );
  }
  console.log(`  LLM judge calls (auto): ${est.calls}, plus up to ${reserve} for retrieval rounds / second opinions`);
  console.log(`  Est. input ~${(inTokens / 1000).toFixed(0)}k tokens · wall clock ~${timeMin < 1 ? "<1" : timeMin.toFixed(0)} min via claude-cli · API cost ≈ $${apiCost.toFixed(2)} (haiku)`);
  if (opts.localPath) {
    console.log(
      `  Baseline: ${opts.baseline} past release(s) diffed out of the clone — no API, but a blobless clone fetches their file contents on demand, so budget roughly one head-sized diff each.`,
    );
  } else {
    console.log(`  GitHub API calls: ~${3 + data.commits.length + 2 * opts.baseline} (compare, per-commit diffs, baseline)`);
  }
  console.log(`  Verdict cache: repeated runs on unchanged data are free and deterministic.`);
  return 0;
}
