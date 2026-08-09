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
  //
  // Exactly the classes whose expectation is a property of the DIFF. A
  // generated class (`inverted-claim`) has one more link: whether the model
  // really inverted the sentence. Its rate moves when a model phrases the lie
  // differently, and freezing weather as a regression gate would make the file
  // fail for reasons that have nothing to do with the detector.
  const source = await readFile(join(ROOT, "scripts/mutate-notes.ts"), "utf8");
  const declared = source
    .slice(source.indexOf("const MUTATION_CLASSES"), source.indexOf("] as const;"))
    .match(/"([a-z-]+)"/g)
    ?.map((s) => s.replaceAll('"', ""));
  assert.ok(declared?.length, "could not read MUTATION_CLASSES out of the harness");
  const generated = source
    .slice(source.indexOf("const FROZEN_CLASSES"), source.indexOf("/**\n * The generated class"))
    .match(/m !== "([a-z-]+)"/g)
    ?.map((s) => s.replace(/.*"([a-z-]+)".*/, "$1")) ?? [];
  assert.ok(generated.length, "could not read the generated-class exclusions out of the harness");
  const frozen = declared.filter((c) => !generated.includes(c));

  const reference = await loadReference();
  assert.deepEqual(
    frozen.filter((c) => !(c in reference.classes)),
    [],
    "mutation classes with no frozen rate — re-run `pnpm mutate-notes <reports> --freeze`",
  );
  assert.deepEqual(
    generated.filter((c) => c in reference.classes),
    [],
    "a generated class has a frozen rate — its number is weather, not a regression signal",
  );
  assert.deepEqual(
    Object.keys(reference.classes).filter((c) => !frozen.includes(c)),
    [],
    "frozen rates for classes the harness no longer has",
  );
});

test("the omission mutation strips every claim-specific coverage route", async () => {
  // The drift this guards against has already happened once. The pin join
  // joined `computeCoverage` on 2026-08-06, a day after the omission block was
  // written against the anchor and the lexical bar alone, and for three days
  // the harness reported an `omission` miss on
  // `opencloud-eu/opencloud@v7.3.0` that was its own gap: it removed two
  // routes' worth of notes and left the bump claim that covered the commit
  // standing. A route added to coverage and not to this filter does not read
  // as a harness bug — it reads as a detector miss, which is worse than no
  // measurement at all.
  //
  // The union route is deliberately not in the list: it is claim-independent,
  // so "the claims covering via it" is every claim in the release.
  const source = await readFile(join(ROOT, "scripts/mutate-notes.ts"), "utf8");
  const filter = source.slice(
    source.indexOf("const covering = claims.filter("),
    source.indexOf("// A zero-churn commit hides nothing"),
  );
  assert.ok(filter.length, "could not read the omission block's covering filter");
  for (const route of ["anchorsTo", "lexicalMatch", "bumpCovers"]) {
    assert.ok(filter.includes(route), `the omission mutation does not strip the ${route} route`);
  }
});

test("the frozen rates are a measurement, not an aspiration", async () => {
  // The reference records open holes as such on purpose: freezing 100 %
  // everywhere would turn the yardstick into a wish and hide the very
  // findings the harness was built to produce. This test fails when someone
  // "fixes" the reference instead of the detector.
  const reference = await loadReference();
  for (const [name, { applicable, detected }] of Object.entries(reference.classes)) {
    assert.ok(applicable > 0, `${name} has no applicable cases in the reference`);
    assert.ok(detected <= applicable, `${name} detects more than it applies to`);
  }
  // The day every class reads perfect there are two possible explanations,
  // and "the harness stopped asking hard questions" is the likelier one.
  // Whoever gets there deletes this assertion and says which it was.
  assert.ok(
    Object.values(reference.classes).some(({ applicable, detected }) => detected < applicable),
    "every mutation class detects everything — the harness has run out of questions",
  );
});
