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
import { isChangelogPath } from "./match.ts";
import { fileCategory, sensitiveCategory } from "./metrics.ts";
import { DEFAULTS_PATH, TEST_PATH, VENDORED_PATH, defaultCandidates } from "./substance.ts";
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
/**
 * The reserved read: files carrying a moved default, then files on a
 * defaults path, read first inside this slice of the budget. Churn ordering
 * never reaches them — the 2.4k-char codex hunk that flipped
 * `daemon_auto_start` ranked 369 of 1083 in its subsystem and the judge
 * never saw it. Taken from the budget, not added: the hard cap holds.
 */
export const RESERVED_CHARS = 4000;
export const RESERVED_NAME = "(defaults)";

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

/**
 * A directory holding this share of a release's files, with sub-directories
 * of its own, is a container (`codex-rs/`, `Maccy/`, `omlx/`): grouping by
 * its first segment collapses the release into one subsystem that one 20k
 * read has to cover. Data-driven where GROUPING_DIRS is a list — the list
 * named none of the three.
 */
const CONTAINER_SHARE = 0.8;

export function containerOf(paths: string[]): string | null {
  const counts = new Map<string, number>();
  const nested = new Set<string>();
  for (const p of paths) {
    const parts = p.split("/");
    if (parts.length < 2) continue;
    counts.set(parts[0], (counts.get(parts[0]) ?? 0) + 1);
    if (parts.length > 2) nested.add(parts[0]);
  }
  for (const [dir, n] of counts) {
    if (n >= CONTAINER_SHARE * paths.length && nested.has(dir)) return dir;
  }
  return null;
}

export function subsystemOf(path: string, container: string | null = null): string {
  const parts = path.split("/");
  if (parts.length === 1) return "(root)";
  if (parts.length > 2 && (parts[0] === container || GROUPING_DIRS.has(parts[0]))) {
    return `${parts[0]}/${parts[1]}`;
  }
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

/** A test by either spelling: fileCategory's (`tests/`, `_test.go`) or the
 * substance layer's (`_tests.rs`, `mocks/`). The notes never describe
 * test-only changes, so a test is read after every source file of its
 * subsystem and never with the sensitive-path boost — `sensitiveCategory`
 * exempts its own test spelling, but codex's `gateway_auth_login_tests.rs`
 * matched neither and took the subsystem's one read slot as auth source. */
const isTestFile = (f: DiffFile): boolean =>
  fileCategory(f.path) === "tests" || TEST_PATH.test(f.path);

/** Reading priority of one file: category-weighted churn, sensitive paths
 * boosted — what a reader of "what shipped" must not miss. */
function fileScore(f: DiffFile): number {
  const test = isTestFile(f);
  const weight = test ? CATEGORY_WEIGHT.tests : (CATEGORY_WEIGHT[fileCategory(f.path)] ?? 1);
  const sensitive = !test && sensitiveCategory(f.path) ? 4 : 0;
  return weight * Math.log2(2 + f.additions + f.deletions) + sensitive;
}

/** Source before tests, then priority, then name. */
const byPriority = (a: DiffFile, b: DiffFile): number =>
  Number(isTestFile(a)) - Number(isTestFile(b)) ||
  fileScore(b) - fileScore(a) ||
  byName(a.path, b.path);

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
  const eligible = files.filter(
    (f) =>
      f.patch &&
      // A changelog diff is the notes restating themselves — read as findings
      // evidence it turns "what shipped" back into "what the publisher says
      // shipped" (measured on OpenCloud: every finding cited CHANGELOG.md).
      // Same boundary evidence matching draws via isChangelogPath.
      !isChangelogPath(f.path) &&
      // Vendored code is someone else's release: the notes never describe it,
      // and `vendor` took the first read slot in 7 corpus releases.
      !VENDORED_PATH.test(f.path),
  );

  // The reserved read, filled the way capHunks will fill it: a file is in
  // while chars remain, and leaves its subsystem so no hunk is read twice.
  // Carriers go smallest first: the slice exists for the hunk churn
  // ordering buries, and one 4k carrier (OpenCloud's `introductionVersion`
  // stamp in webfinger/config.go) would otherwise fill it alone and push
  // the 1.5k `CleanStopWords` flip back out.
  const carriers = new Set(defaultCandidates(eligible).map((c) => c.file));
  const bySize = (a: DiffFile, b: DiffFile): number =>
    a.patch!.length - b.patch!.length || byName(a.path, b.path);
  const reserved: DiffFile[] = [];
  let reservedUsed = 0;
  for (const f of eligible
    .filter((f) => carriers.has(f.path) || DEFAULTS_PATH.test(f.path))
    .sort(
      (a, b) =>
        Number(carriers.has(b.path)) - Number(carriers.has(a.path)) ||
        (carriers.has(a.path) ? bySize(a, b) : byPriority(a, b)),
    )) {
    if (reservedUsed >= RESERVED_CHARS) break;
    reserved.push(f);
    reservedUsed += Math.min(f.patch!.length, RESERVED_CHARS - reservedUsed);
  }
  const taken = new Set(reserved.map((f) => f.path));

  const container = containerOf(eligible.map((f) => f.path));
  const groups = new Map<string, DiffFile[]>();
  for (const f of eligible) {
    if (taken.has(f.path)) continue;
    const key = subsystemOf(f.path, container);
    const list = groups.get(key) ?? [];
    list.push(f);
    groups.set(key, list);
  }
  const ordered = [...groups.entries()]
    .map(([name, fs]) => ({
      name,
      files: [...fs].sort(byPriority),
      score: fs.reduce((sum, f) => sum + fileScore(f), 0),
    }))
    .sort((a, b) => b.score - a.score || byName(a.name, b.name));
  let remaining = budgetChars;
  const plan: SubsystemPlan[] = [];
  if (reserved.length) {
    const alloc = Math.min(RESERVED_CHARS, remaining);
    remaining -= alloc;
    plan.push({ name: RESERVED_NAME, files: reserved, alloc });
  }
  for (const g of ordered) {
    const alloc = remaining >= MIN_CALL_CHARS ? Math.min(PER_CALL_CHARS, remaining) : 0;
    remaining -= alloc;
    plan.push({ name: g.name, files: g.files, alloc });
  }
  return plan;
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
