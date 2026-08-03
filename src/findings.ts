// SPDX-License-Identifier: GPL-3.0-or-later
// The LLM half of the second axis: budget-driven summarization of the diff
// into typed, audience-tagged findings. Hierarchical — hunks are read per
// subsystem, the release summary is synthesized from the findings alone —
// and blind to commit messages and notes by construction (the prompt
// builders in judge.ts never receive them). Prompts are a deterministic
// function of the diff, so the verdict cache makes an immediate re-run
// bit-identical and free. Informational: the score never reads this.
import { pooled } from "./util.ts";
import { capHunks } from "./verify.ts";
import { fileCategory, sensitiveCategory } from "./metrics.ts";
import {
  buildFindingsPrompt,
  buildFindingsRollupPrompt,
  parseFindingsOutput,
  parseFindingsSummary,
  type JudgeEngine,
} from "./judge.ts";
import type { DiffFile, Finding, FindingsSection, ReleaseData } from "./types.ts";

/** Diff chars one subsystem call may quote — the same order of magnitude as
 * claim verification's evidence budget. */
const PER_CALL_CHARS = 20000;
/** Total evidence budget across the release: ~6 subsystem reads. */
export const DEFAULT_FINDINGS_BUDGET = 120000;
/** Leftover budget below this reads a fragment too small to describe. */
const MIN_CALL_CHARS = 4000;

/** Container dirs whose first segment alone names nothing — the subsystem
 * of `services/web/Makefile` is `services/web`, not `services`. */
const GROUPING_DIRS = new Set([
  "services",
  "packages",
  "apps",
  "cmd",
  "crates",
  "modules",
  "plugins",
  "libs",
  "lib",
  "internal",
  "pkg",
  "src",
]);

export function subsystemOf(path: string): string {
  const parts = path.split("/");
  if (parts.length === 1) return "(root)";
  if (parts.length > 2 && GROUPING_DIRS.has(parts[0])) return `${parts[0]}/${parts[1]}`;
  return parts[0];
}

/** Locale-independent tiebreaker — localeCompare would make the plan (and
 * with it every cached prompt) depend on the host's locale. */
const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const CATEGORY_WEIGHT: Record<string, number> = {
  source: 3,
  migrations: 3,
  config: 2.5,
  dependencies: 1.5,
  "ci/build": 1.5,
  tests: 1,
  assets: 0.5,
  docs: 0.5,
};

/** Reading priority of one file: category-weighted churn, sensitive paths
 * boosted — what a reader of "what shipped" must not miss. */
function fileScore(f: DiffFile): number {
  const weight = CATEGORY_WEIGHT[fileCategory(f.path)] ?? 1;
  const sensitive = sensitiveCategory(f.path) ? 4 : 0;
  return weight * Math.log2(2 + f.additions + f.deletions) + sensitive;
}

export interface SubsystemPlan {
  name: string;
  /** Files with a patch, reading-priority first. */
  files: DiffFile[];
  /** Evidence chars allocated; 0 = not read in detail (declared, not silent). */
  alloc: number;
}

/**
 * The deterministic half of the pass: group the diff into subsystems, order
 * them by reading priority, and spend the budget top-down — full allocation
 * per subsystem until the remainder is too small to be worth a call. The
 * budget is a hard cap: subsystems beyond it get alloc 0 and are declared.
 */
export function planFindings(files: DiffFile[], budgetChars: number): SubsystemPlan[] {
  const groups = new Map<string, DiffFile[]>();
  for (const f of files) {
    if (!f.patch) continue;
    const key = subsystemOf(f.path);
    const list = groups.get(key) ?? [];
    list.push(f);
    groups.set(key, list);
  }
  const ordered = [...groups.entries()]
    .map(([name, fs]) => ({
      name,
      files: [...fs].sort((a, b) => fileScore(b) - fileScore(a) || byName(a.path, b.path)),
      score: fs.reduce((sum, f) => sum + fileScore(f), 0),
    }))
    .sort((a, b) => b.score - a.score || byName(a.name, b.name));
  let remaining = budgetChars;
  return ordered.map((g) => {
    const alloc = remaining >= MIN_CALL_CHARS ? Math.min(PER_CALL_CHARS, remaining) : 0;
    remaining -= alloc;
    return { name: g.name, files: g.files, alloc };
  });
}

export interface FindingsOptions {
  engine: JudgeEngine;
  concurrency: number;
  /** Hard evidence budget in chars (default DEFAULT_FINDINGS_BUDGET). */
  budgetChars?: number;
}

/**
 * Read the release diff into typed findings, subsystem by subsystem, within
 * a hard evidence budget — then synthesize the release summary from the
 * findings alone. A failed subsystem read is reported, never silently empty.
 */
export async function summarizeShipped(
  data: ReleaseData,
  opts: FindingsOptions,
): Promise<FindingsSection> {
  const budgetChars = opts.budgetChars ?? DEFAULT_FINDINGS_BUDGET;
  const plan = planFindings(data.files, budgetChars);
  const active = plan.filter((s) => s.alloc > 0);
  const perSubsystem = await pooled(active, opts.concurrency, async (sub) => {
    const hunks = capHunks(
      sub.files.map((f) => ({ path: f.path, hunk: f.patch! })),
      sub.alloc,
    );
    const prompt = buildFindingsPrompt({
      repoLabel: data.repoLabel,
      baseRef: data.baseRef,
      headRef: data.headRef,
      subsystem: sub.name,
      filesShown: new Set(hunks.map((h) => h.path)).size,
      filesTotal: sub.files.length,
      hunks,
    });
    try {
      const found = parseFindingsOutput(await opts.engine.judge(prompt));
      return { hunks, findings: found.map((f) => ({ ...f, subsystem: sub.name })) };
    } catch (err) {
      return {
        hunks,
        error: `${sub.name}: ${(err as Error).message.split("\n")[0].slice(0, 120)}`,
      };
    }
  });

  const findings: Finding[] = [];
  const errors: string[] = [];
  const readPaths = new Set<string>();
  let usedChars = 0;
  for (const r of perSubsystem) {
    usedChars += r.hunks.reduce((sum, h) => sum + h.hunk.length, 0);
    for (const h of r.hunks) readPaths.add(h.path);
    if (r.findings) findings.push(...r.findings);
    else errors.push(r.error);
  }

  let summary: string | undefined;
  if (findings.length) {
    try {
      summary =
        parseFindingsSummary(
          await opts.engine.judge(
            buildFindingsRollupPrompt({
              repoLabel: data.repoLabel,
              baseRef: data.baseRef,
              headRef: data.headRef,
              findings,
            }),
          ),
        ) || undefined;
    } catch (err) {
      errors.push(`release summary: ${(err as Error).message.split("\n")[0].slice(0, 120)}`);
    }
  }

  return {
    findings,
    summary,
    budget: {
      maxChars: budgetChars,
      usedChars,
      subsystemsRead: active.length,
      subsystemsTotal: plan.length,
      filesRead: readPaths.size,
      filesTotal: data.files.length,
    },
    errors: errors.length ? errors : undefined,
  };
}
