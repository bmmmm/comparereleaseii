// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

interface DetectionReference {
  date: string;
  releases: number;
  engine: string;
  classes: Record<string, { applicable: number; detected: number }>;
}

async function loadReference(): Promise<DetectionReference> {
  return JSON.parse(
    await readFile(join(ROOT, "test/eval/reference-detection.json"), "utf8"),
  ) as DetectionReference;
}

test("the detection reference covers exactly the harness's mutation classes", async () => {
  // `pnpm mutate-notes` compares against this file and fails on a class that
  // got worse. A class added to the harness without an entry here is a class
  // nothing watches — the same way growing the golden set used to leave
  // reference-haiku.json silently stale.
  const source = await readFile(join(ROOT, "scripts/mutate-notes.ts"), "utf8");
  const declared = source
    .slice(source.indexOf("const MUTATION_CLASSES"), source.indexOf("] as const;"))
    .match(/"([a-z-]+)"/g)
    ?.map((s) => s.replaceAll('"', ""));
  assert.ok(declared?.length, "could not read MUTATION_CLASSES out of the harness");

  const reference = await loadReference();
  assert.deepEqual(
    declared.filter((c) => !(c in reference.classes)),
    [],
    "mutation classes with no frozen rate — re-run `pnpm mutate-notes <reports> --freeze`",
  );
  assert.deepEqual(
    Object.keys(reference.classes).filter((c) => !declared.includes(c)),
    [],
    "frozen rates for classes the harness no longer has",
  );
});

test("the frozen rates are a measurement, not an aspiration", async () => {
  // Two classes are known open holes, and the reference records them as such
  // on purpose: freezing 100 % everywhere would turn the yardstick into a
  // wish and hide the very findings the harness was built to produce. This
  // test fails when someone "fixes" the reference instead of the detector.
  const reference = await loadReference();
  for (const [name, { applicable, detected }] of Object.entries(reference.classes)) {
    assert.ok(applicable > 0, `${name} has no applicable cases in the reference`);
    assert.ok(detected <= applicable, `${name} detects more than it applies to`);
  }
  const noise = reference.classes["backtick-noise"];
  assert.ok(
    noise.detected / noise.applicable < 0.5,
    "backtick-noise now detects a majority — that is a real improvement, so re-freeze " +
      "the reference and delete this assertion along with the hole it guards",
  );
});
