// SPDX-License-Identifier: GPL-3.0-or-later
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildJudgePrompt, parseJudgeResponse, type JudgeEngine } from "./judge.ts";
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
}

export interface Calibration {
  engine: string;
  outcomes: CalibrationOutcome[];
  passed: number;
  overVerified: number;
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
    try {
      const response = parseJudgeResponse(await engine.judge(prompt));
      if ("need" in response) {
        return { name: gc.name, expected: gc.expected, got: "need", pass: false, overVerified: false, reasoning: "requested more files" };
      }
      return {
        name: gc.name,
        expected: gc.expected,
        got: response.verdict,
        pass: gc.expected.includes(response.verdict),
        overVerified: response.verdict === "verified" && !gc.expected.includes("verified"),
        reasoning: response.reasoning,
      };
    } catch (err) {
      return {
        name: gc.name,
        expected: gc.expected,
        got: "error",
        pass: false,
        overVerified: false,
        reasoning: (err as Error).message.slice(0, 160),
      };
    }
  });
  return {
    engine: engine.name,
    outcomes,
    passed: outcomes.filter((o) => o.pass).length,
    overVerified: outcomes.filter((o) => o.overVerified).length,
  };
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
