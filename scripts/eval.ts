#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Thin wrapper around the calibration module for repo development.
// Run: pnpm eval  (env: EVAL_ENGINE, EVAL_MODEL, EVAL_NO_CACHE)
import { selectEngine } from "../src/judge.ts";
import { withVerdictCache } from "../src/cache.ts";
import { runCalibration, printCalibration } from "../src/calibrate.ts";

const engineName = (process.env.EVAL_ENGINE as "claude-cli" | "api" | "openai") ?? "claude-cli";
let engine = selectEngine({ engine: engineName, model: process.env.EVAL_MODEL });
if (!engine) throw new Error("eval needs a judge engine");
if (!process.env.EVAL_NO_CACHE) engine = withVerdictCache(engine);

const cal = await runCalibration(engine);
printCalibration(cal);
process.exit(cal.passed === cal.outcomes.length ? 0 : 1);
