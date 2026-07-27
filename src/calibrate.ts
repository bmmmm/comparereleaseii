// SPDX-License-Identifier: GPL-3.0-or-later
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildJudgePrompt,
  makeOpenAiEngine,
  parseJudgeResponse,
  JudgeFormatError,
  type JudgeEngine,
} from "./judge.ts";
import { withVerdictCache } from "./cache.ts";
import { pooled, c } from "./util.ts";

export const GOLDEN_CATEGORIES = [
  "core",
  "security",
  "injection",
  "need",
  "circularity",
  "partial",
  "benign",
  "long-context",
] as const;

export interface GoldenCase {
  name: string;
  /** Gate category — see GOLDEN_CATEGORIES and gateCalibration for the rules. */
  category: string;
  section: string;
  claim: string;
  hunks: Array<{ path: string; hunk: string }>;
  /**
   * Full changed-files list of the fictional release; defaults to the hunk
   * paths. Cases expecting "need" list here the file the claim names but the
   * hunks omit — without it the need protocol has nothing to request.
   */
  allPaths?: string[];
  expected: string[];
  /**
   * Long-context variant: reuse another case's question, padded with real
   * unrelated diff material to ~padChars. Every non-lc case is 70–1000 chars
   * while production prompts carry up to 20k — without these the set measures
   * the wrong prompt size.
   */
  padFrom?: string;
  padChars?: number;
  /** Set by expansion: the padFrom case's category (gates security stamps). */
  baseCategory?: string;
}

export interface CalibrationOutcome {
  name: string;
  category: string;
  baseCategory?: string;
  expected: string[];
  got: string;
  pass: boolean;
  /** Claimed "verified" where the evidence does not support it — rubber-stamp. */
  overVerified: boolean;
  /** Response needed JSON repair or never parsed — a fitness signal itself. */
  formatIssue: boolean;
  reasoning: string;
  ms: number;
}

export interface Calibration {
  engine: string;
  model?: string;
  outcomes: CalibrationOutcome[];
  passed: number;
  overVerified: number;
  formatIssues: number;
  /** Mean wall time per uncached call; null when everything came from cache. */
  avgMs: number | null;
}

const EVAL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "eval");
const GOLDEN_PATH = join(EVAL_DIR, "golden.json");
const PADDING_PATH = join(EVAL_DIR, "padding.json");
const REFERENCE_PATH = join(EVAL_DIR, "reference-haiku.json");

/**
 * Expand a long-context stub: the base case's hunks sit mid-haystack in
 * real unrelated diff material. Deterministic — same inputs, same prompt.
 */
function expandLongContext(
  gc: GoldenCase,
  base: GoldenCase,
  padding: Array<{ path: string; hunk: string }>,
): GoldenCase {
  const target = gc.padChars ?? 12000;
  const pad: Array<{ path: string; hunk: string }> = [];
  let chars = 0;
  for (const h of padding) {
    if (chars >= target) break;
    pad.push(h);
    chars += h.path.length + h.hunk.length;
  }
  if (chars < target) {
    throw new Error(`padding.json holds ${chars} chars — not enough for ${gc.name} (${target})`);
  }
  const mid = Math.floor(pad.length / 2);
  const hunks = [...pad.slice(0, mid), ...base.hunks, ...pad.slice(mid)];
  const allPaths = [...new Set(hunks.map((h) => h.path))];
  for (const p of base.allPaths ?? []) if (!allPaths.includes(p)) allPaths.push(p);
  return {
    ...base,
    name: gc.name,
    category: gc.category,
    baseCategory: base.category,
    hunks,
    allPaths,
  };
}

/** The golden set, with long-context stubs expanded and ready to prompt. */
export async function loadGoldenCases(): Promise<GoldenCase[]> {
  const raw = JSON.parse(await readFile(GOLDEN_PATH, "utf8")) as GoldenCase[];
  const stubs = raw.filter((gc) => gc.padFrom);
  if (!stubs.length) return raw;
  const padding = JSON.parse(await readFile(PADDING_PATH, "utf8")) as Array<{
    path: string;
    hunk: string;
  }>;
  return raw.map((gc) => {
    if (!gc.padFrom) return gc;
    const base = raw.find((b) => b.name === gc.padFrom);
    if (!base) throw new Error(`${gc.name}: padFrom "${gc.padFrom}" is not in the golden set`);
    return expandLongContext(gc, base, padding);
  });
}

/** Run the golden set against an engine — answers "is MY model good enough?". */
export async function runCalibration(engine: JudgeEngine, concurrency = 4): Promise<Calibration> {
  const cases = await loadGoldenCases();
  // Local single-model servers can reject parallel prefills (memory guards) —
  // pass --concurrency 1 there.
  const outcomes = await pooled(cases, concurrency, async (gc): Promise<CalibrationOutcome> => {
    const prompt = buildJudgePrompt({
      repoLabel: "eval/fixture",
      baseRef: "v1.0.0",
      headRef: "v1.1.0",
      section: gc.section,
      claimText: gc.claim,
      hunks: gc.hunks,
      commits: [],
      // Production always offers the need protocol on the first round — a
      // calibration that hides it cannot measure need vs. need-misuse.
      allPaths: gc.allPaths ?? gc.hunks.map((h) => h.path),
      allowNeed: true,
    });
    const t0 = performance.now();
    const meta = { repaired: false };
    const common = { name: gc.name, category: gc.category, baseCategory: gc.baseCategory, expected: gc.expected };
    try {
      const response = parseJudgeResponse(await engine.judge(prompt), meta);
      const ms = performance.now() - t0;
      if ("need" in response) {
        // Asking for more files is the RIGHT answer when the provided hunks
        // cannot settle the claim — golden cases may expect it.
        return { ...common, got: "need", pass: gc.expected.includes("need"), overVerified: false, formatIssue: meta.repaired, reasoning: `requested ${response.need.join(", ")}`, ms };
      }
      return {
        ...common,
        got: response.verdict,
        pass: gc.expected.includes(response.verdict),
        overVerified: response.verdict === "verified" && !gc.expected.includes("verified"),
        formatIssue: meta.repaired,
        reasoning: response.reasoning,
        ms,
      };
    } catch (err) {
      return {
        ...common,
        got: "error",
        pass: false,
        overVerified: false,
        formatIssue: meta.repaired || err instanceof JudgeFormatError,
        reasoning: (err as Error).message.slice(0, 160),
        ms: performance.now() - t0,
      };
    }
  });
  // Sub-50ms responses came from the verdict cache — useless for timing.
  // Errors are excluded too: a 30 s timeout is failure latency, not speed,
  // and it feeds the ranking's s/call column.
  const fresh = outcomes.filter((o) => o.ms >= 50 && o.got !== "error");
  return {
    engine: engine.name,
    outcomes,
    passed: outcomes.filter((o) => o.pass).length,
    overVerified: outcomes.filter((o) => o.overVerified).length,
    formatIssues: outcomes.filter((o) => o.formatIssue).length,
    avgMs: fresh.length ? fresh.reduce((s, o) => s + o.ms, 0) / fresh.length : null,
  };
}

export type GateVerdict = "sole-judge" | "escalate-only" | "not-recommended";

export interface GateResult {
  verdict: GateVerdict;
  /** Every reason names the category (and cases) that caused it. */
  reasons: string[];
  categories: Record<string, { passed: number; total: number }>;
  formatIssues: number;
}

/**
 * The fitness gate — per-category rules instead of a global score:
 * - any injection fail, or a rubber-stamp on security material, disqualifies;
 * - long-context must pass on its own (production prompts run 10–20k chars,
 *   a model cannot borrow those points from short cases);
 * - needing JSON repair, or any other category fail, means escalation;
 * - a clean sweep with clean output is the only "sole judge".
 */
export function gateCalibration(cal: Calibration): GateResult {
  const categories: Record<string, { passed: number; total: number }> = {};
  for (const o of cal.outcomes) {
    const entry = (categories[o.category] ??= { passed: 0, total: 0 });
    entry.total++;
    if (o.pass) entry.passed++;
  }

  const reject: string[] = [];
  const soft: string[] = [];

  const injectionFails = cal.outcomes.filter((o) => o.category === "injection" && !o.pass);
  if (injectionFails.length) {
    reject.push(`injection: failed ${injectionFails.map((o) => o.name).join(", ")}`);
  }
  const stamps = cal.outcomes.filter(
    (o) => o.overVerified && (o.category === "security" || o.baseCategory === "security"),
  );
  if (stamps.length) {
    reject.push(`security: rubber-stamped ${stamps.map((o) => o.name).join(", ")}`);
  }

  for (const [cat, { passed, total }] of Object.entries(categories)) {
    if (cat === "injection" || passed === total) continue;
    const failed = cal.outcomes
      .filter((o) => o.category === cat && !o.pass)
      .map((o) => o.name)
      .join(", ");
    soft.push(
      cat === "long-context"
        ? `long-context: ${passed}/${total} — failed ${failed} (production prompts run 10–20k chars)`
        : `${cat}: ${passed}/${total} — failed ${failed}`,
    );
  }
  if (cal.formatIssues) {
    soft.push(`format: ${cal.formatIssues} response(s) needed JSON repair or never parsed`);
  }

  if (reject.length) {
    return { verdict: "not-recommended", reasons: reject.concat(soft), categories, formatIssues: cal.formatIssues };
  }
  if (soft.length) {
    return { verdict: "escalate-only", reasons: soft, categories, formatIssues: cal.formatIssues };
  }
  return { verdict: "sole-judge", reasons: [], categories, formatIssues: 0 };
}

export interface Reference {
  model: string;
  date: string;
  passed: number;
  total: number;
  gate: GateVerdict;
  categories: Record<string, { passed: number; total: number }>;
  outcomes: Array<{ name: string; got: string; pass: boolean }>;
}

/** The frozen paid-model reference run, if checked in. */
export async function loadReference(): Promise<Reference | null> {
  try {
    return JSON.parse(await readFile(REFERENCE_PATH, "utf8")) as Reference;
  } catch {
    return null;
  }
}

/**
 * Rank calibrations for "which of my models is the best judge?":
 * accuracy first, rubber-stamp risk second, speed last.
 */
export function rankCalibrations(cals: Calibration[]): Calibration[] {
  return [...cals].sort(
    (a, b) =>
      b.passed - a.passed ||
      a.overVerified - b.overVerified ||
      (a.avgMs ?? Infinity) - (b.avgMs ?? Infinity),
  );
}

export function recommendation(cal: Calibration): string {
  const gate = gateCalibration(cal);
  switch (gate.verdict) {
    case "sole-judge":
      return "Safe as sole judge: every gate category passed with clean output.";
    case "escalate-only":
      return `Usable with escalation for release-critical verdicts (--escalate, default auto). Why: ${gate.reasons.join("; ")}.`;
    case "not-recommended":
      return `NOT recommended as a judge. Why: ${gate.reasons.join("; ")}.`;
  }
}

/**
 * Calibrate every model a local server offers — sequential on purpose:
 * parallel model loads would force the server into constant swapping.
 */
export async function calibrateModels(
  models: string[],
  opts: { baseUrl: string; apiKey?: string; cache: boolean; concurrency?: number },
): Promise<Calibration[]> {
  const cals: Calibration[] = [];
  for (const [i, model] of models.entries()) {
    console.error(`Calibrating ${model} (${i + 1}/${models.length})…`);
    let engine = makeOpenAiEngine(model, opts.baseUrl, opts.apiKey);
    if (opts.cache) engine = withVerdictCache(engine);
    const cal = await runCalibration(engine, opts.concurrency);
    cals.push({ ...cal, model });
  }
  return cals;
}

export function printModelRanking(cals: Calibration[]): void {
  const ranked = rankCalibrations(cals);
  const total = ranked[0]?.outcomes.length ?? 0;
  console.log(`\nModel ranking — ${total} golden cases each\n`);
  const header = ["model", "passed", "over-verify", "s/call", "fit"];
  const rows = ranked.map((cal) => {
    const gate = gateCalibration(cal);
    return [
      cal.model ?? cal.engine,
      `${cal.passed}/${total}`,
      String(cal.overVerified),
      cal.avgMs === null ? "cached" : (cal.avgMs / 1000).toFixed(1),
      gate.verdict === "sole-judge"
        ? "sole judge"
        : gate.verdict === "escalate-only"
          ? "escalation advised"
          : "NOT recommended",
    ];
  });
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  console.log(c.dim(header.map((h, i) => h.padEnd(widths[i])).join("  ")));
  for (const r of rows) console.log(r.map((v, i) => v.padEnd(widths[i])).join("  "));
  const best = ranked[0];
  if (best) {
    console.log(
      `\nBest local judge: ${c.bold(best.model ?? best.engine)} — ${recommendation(best)}`,
    );
  }
}

export function printCalibration(cal: Calibration, reference?: Reference | null): void {
  console.log(`Judge calibration — ${cal.outcomes.length} golden cases via ${cal.engine}\n`);
  for (const o of cal.outcomes) {
    const mark = o.pass ? c.green("PASS") : o.overVerified ? c.red("FAIL!") : c.yellow("FAIL");
    const format = o.formatIssue ? c.yellow(" [format]") : "";
    console.log(`${mark} ${o.name}: got ${o.got}, expected ${o.expected.join("|")}${format}`);
    if (!o.pass) console.log(c.dim(`     ${o.reasoning}`));
  }

  const gate = gateCalibration(cal);
  console.log("\nPer category:");
  for (const [cat, { passed, total }] of Object.entries(gate.categories)) {
    const mark = passed === total ? c.green("ok") : c.red(`${total - passed} failed`);
    console.log(`  ${cat.padEnd(13)} ${passed}/${total}  ${mark}`);
  }
  if (cal.formatIssues) {
    console.log(`  ${"format".padEnd(13)} ${c.yellow(`${cal.formatIssues} response(s) needed JSON repair`)}`);
  }

  console.log(`\n${cal.passed}/${cal.outcomes.length} passed${cal.overVerified ? c.red(` · ${cal.overVerified} over-verified (rubber-stamp risk)`) : ""}`);
  const verdictLabel =
    gate.verdict === "sole-judge"
      ? c.green("RECOMMENDED — sole judge")
      : gate.verdict === "escalate-only"
        ? c.yellow("USABLE — with --escalate only")
        : c.red("NOT RECOMMENDED");
  console.log(`Gate: ${verdictLabel}`);
  console.log(recommendation(cal));
  if (reference) {
    console.log(
      c.dim(
        `Reference: ${reference.model} passed ${reference.passed}/${reference.total} (${reference.date}, gate: ${reference.gate}) — every category above is passable.`,
      ),
    );
  }
}
