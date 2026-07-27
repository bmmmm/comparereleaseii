// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { runCalibration } from "../src/calibrate.ts";

// avgMs feeds the model ranking's speed column. An engine that errors slowly
// (timeouts) must not be ranked by its failure latency: with only failed
// calls there is no timing to report.
test("calibration timing ignores failed calls", async () => {
  const engine = {
    name: "always-fails",
    async judge(): Promise<string> {
      await new Promise((resolve) => setTimeout(resolve, 60));
      throw new Error("boom");
    },
  };
  const cal = await runCalibration(engine, 8);
  assert.equal(cal.passed, 0);
  assert.ok(cal.outcomes.every((o) => o.got === "error"));
  assert.equal(cal.avgMs, null, `failure latency leaked into avgMs: ${cal.avgMs}`);
});
