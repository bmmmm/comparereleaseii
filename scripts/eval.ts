#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Judge eval harness: golden (claim, evidence) -> expected verdict cases.
// Needs a judge engine, so it is not part of `pnpm test`. Run: pnpm run eval
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildJudgePrompt, parseJudgeResponse, selectEngine } from "../src/judge.ts";
import { withVerdictCache } from "../src/cache.ts";
import { pooled, c } from "../src/util.ts";

interface GoldenCase {
  name: string;
  section: string;
  claim: string;
  hunks: Array<{ path: string; hunk: string }>;
  expected: string[];
}

const goldenPath = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "eval", "golden.json");
const cases = JSON.parse(await readFile(goldenPath, "utf8")) as GoldenCase[];

const engineName = (process.env.EVAL_ENGINE as "claude-cli" | "api") ?? "claude-cli";
let engine = selectEngine({ engine: engineName, model: process.env.EVAL_MODEL });
if (!engine) throw new Error("eval needs a judge engine");
if (!process.env.EVAL_NO_CACHE) engine = withVerdictCache(engine);

console.log(`Judge eval — ${cases.length} golden cases via ${engine.name}\n`);

const outcomes = await pooled(cases, 4, async (gc) => {
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
      return { gc, got: "need", pass: false, reasoning: "requested more files" };
    }
    return {
      gc,
      got: response.verdict,
      pass: gc.expected.includes(response.verdict),
      reasoning: response.reasoning,
    };
  } catch (err) {
    return { gc, got: "error", pass: false, reasoning: (err as Error).message.slice(0, 120) };
  }
});

let failed = 0;
for (const o of outcomes) {
  const mark = o.pass ? c.green("PASS") : c.red("FAIL");
  console.log(`${mark} ${o.gc.name}: got ${o.got}, expected ${o.gc.expected.join("|")}`);
  if (!o.pass) {
    failed++;
    console.log(c.dim(`     ${o.reasoning}`));
  }
}
console.log(`\n${outcomes.length - failed}/${outcomes.length} passed`);
process.exit(failed ? 1 : 0);
