// SPDX-License-Identifier: GPL-3.0-or-later
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildJudgePrompt, makeOpenAiEngine, parseJudgeResponse, type JudgeEngine } from "./judge.ts";
import { withVerdictCache } from "./cache.ts";
import { pooled, c } from "./util.ts";

interface GoldenCase {
  name: string;
  section: string;
  claim: string;
  hunks: Array<{ path: string; hunk: string }>;
  expected: string[];
}

export interface CalibrationOutcome {
  name: string;
  expected: string[];
  got: string;
  pass: boolean;
  /** Claimed "verified" where the evidence does not support it — rubber-stamp. */
  overVerified: boolean;
  reasoning: string;
  ms: number;
}

export interface Calibration {
  engine: string;
  model?: string;
  outcomes: CalibrationOutcome[];
  passed: number;
  overVerified: number;
  /** Mean wall time per uncached call; null when everything came from cache. */
  avgMs: number | null;
}

const GOLDEN_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "test",
  "eval",
  "golden.json",
);

/** Run the golden set against an engine — answers "is MY model good enough?". */
export async function runCalibration(engine: JudgeEngine): Promise<Calibration> {
  const cases = JSON.parse(await readFile(GOLDEN_PATH, "utf8")) as GoldenCase[];
  const outcomes = await pooled(cases, 4, async (gc): Promise<CalibrationOutcome> => {
    const prompt = buildJudgePrompt({
      repoLabel: "eval/fixture",
      baseRef: "v1.0.0",
      headRef: "v1.1.0",
      section: gc.section,
      claimText: gc.claim,
      hunks: gc.hunks,
      commits: [],
    });
    const t0 = performance.now();
    try {
      const response = parseJudgeResponse(await engine.judge(prompt));
      const ms = performance.now() - t0;
      if ("need" in response) {
        // Asking for more files is the RIGHT answer when the provided hunks
        // cannot settle the claim — golden cases may expect it.
        return { name: gc.name, expected: gc.expected, got: "need", pass: gc.expected.includes("need"), overVerified: false, reasoning: `requested ${response.need.join(", ")}`, ms };
      }
      return {
        name: gc.name,
        expected: gc.expected,
        got: response.verdict,
        pass: gc.expected.includes(response.verdict),
        overVerified: response.verdict === "verified" && !gc.expected.includes("verified"),
        reasoning: response.reasoning,
        ms,
      };
    } catch (err) {
      return {
        name: gc.name,
        expected: gc.expected,
        got: "error",
        pass: false,
        overVerified: false,
        reasoning: (err as Error).message.slice(0, 160),
        ms: performance.now() - t0,
      };
    }
  });
  // Sub-50ms responses came from the verdict cache — useless for timing.
  const fresh = outcomes.filter((o) => o.ms >= 50);
  return {
    engine: engine.name,
    outcomes,
    passed: outcomes.filter((o) => o.pass).length,
    overVerified: outcomes.filter((o) => o.overVerified).length,
    avgMs: fresh.length ? fresh.reduce((s, o) => s + o.ms, 0) / fresh.length : null,
  };
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
  if (cal.passed === cal.outcomes.length) {
    return "Safe as sole judge for this golden set.";
  }
  if (cal.overVerified > 0) {
    return `NOT safe as sole judge: over-verified ${cal.overVerified} case(s) without real evidence. Keep escalation enabled (--escalate, default auto) or use a stronger model for release-critical verdicts.`;
  }
  return "Usable with escalation for release-critical verdicts (--escalate, default auto).";
}

/**
 * Calibrate every model a local server offers — sequential on purpose:
 * parallel model loads would force the server into constant swapping.
 */
export async function calibrateModels(
  models: string[],
  opts: { baseUrl: string; apiKey?: string; cache: boolean },
): Promise<Calibration[]> {
  const cals: Calibration[] = [];
  for (const [i, model] of models.entries()) {
    console.error(`Calibrating ${model} (${i + 1}/${models.length})…`);
    let engine = makeOpenAiEngine(model, opts.baseUrl, opts.apiKey);
    if (opts.cache) engine = withVerdictCache(engine);
    const cal = await runCalibration(engine);
    cals.push({ ...cal, model });
  }
  return cals;
}

export function printModelRanking(cals: Calibration[]): void {
  const ranked = rankCalibrations(cals);
  const total = ranked[0]?.outcomes.length ?? 0;
  console.log(`\nModel ranking — ${total} golden cases each\n`);
  const header = ["model", "passed", "over-verify", "s/call", "fit"];
  const rows = ranked.map((cal) => [
    cal.model ?? cal.engine,
    `${cal.passed}/${total}`,
    String(cal.overVerified),
    cal.avgMs === null ? "cached" : (cal.avgMs / 1000).toFixed(1),
    cal.passed === total ? "sole judge" : cal.overVerified > 0 ? "needs escalation!" : "escalation advised",
  ]);
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

export function printCalibration(cal: Calibration): void {
  console.log(`Judge calibration — ${cal.outcomes.length} golden cases via ${cal.engine}\n`);
  for (const o of cal.outcomes) {
    const mark = o.pass ? c.green("PASS") : o.overVerified ? c.red("FAIL!") : c.yellow("FAIL");
    console.log(`${mark} ${o.name}: got ${o.got}, expected ${o.expected.join("|")}`);
    if (!o.pass) console.log(c.dim(`     ${o.reasoning}`));
  }
  console.log(`\n${cal.passed}/${cal.outcomes.length} passed${cal.overVerified ? c.red(` · ${cal.overVerified} over-verified (rubber-stamp risk)`) : ""}`);
  console.log(recommendation(cal));
}
