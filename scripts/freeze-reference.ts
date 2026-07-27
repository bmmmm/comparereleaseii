// SPDX-License-Identifier: GPL-3.0-or-later
// Freeze a --calibrate --json run as the reference the gate compares against.
// The consistency test in test/calibrate.test.ts names this step whenever the
// golden set and the reference drift apart:
//
//   node bin/comparerelease.mjs --calibrate --json tmp/cal.json
//   node scripts/freeze-reference.ts tmp/cal.json "claude-cli/haiku (Claude Haiku 4.5)"
//
// Run the calibration at least twice with independent fresh caches first —
// single-run scores carry ±1-2 cases of verdict flicker (documented in
// docs/local-models.md), and a reference frozen off a lucky run is a weak
// yardstick.
import { readFile, writeFile } from "node:fs/promises";
import { gateCalibration, type Calibration } from "../src/calibrate.ts";

const [calPath, model] = process.argv.slice(2);
if (!calPath || !model) {
  console.error(
    'Usage: node scripts/freeze-reference.ts <calibration.json> "<model label>"',
  );
  process.exit(2);
}

const cal = JSON.parse(await readFile(calPath, "utf8")) as Calibration;
const gate = gateCalibration(cal);
const reference = {
  model,
  date: new Date().toISOString().slice(0, 10),
  passed: cal.passed,
  total: cal.outcomes.length,
  gate: gate.verdict,
  categories: gate.categories,
  outcomes: cal.outcomes.map((o) => ({ name: o.name, got: o.got, pass: o.pass })),
};
await writeFile("test/eval/reference-haiku.json", JSON.stringify(reference, null, 2) + "\n");
console.error(
  `Frozen: ${model} — ${reference.passed}/${reference.total}, gate ${reference.gate}, ${reference.date}`,
);
