// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseUnifiedDiff } from "../src/sources/local.ts";
import { releaseSurface } from "../src/substance.ts";

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
  // The breadth route is deliberately not in the list, and the reason changed
  // on 2026-08-14 without the answer changing. It used to be excused as
  // claim-independent — a union, so "the claims covering via it" was every
  // claim in the release. Now it names one claim, and it still does not
  // belong here: that claim covers the commit because its evidence paths
  // coincide with the commit's files, not because it describes them. Stripping
  // it would delete the note that fools the detector and score the mutant as
  // caught, which is the one direction this harness must never move in.
  // `jundot/omlx@v0.5.0` was that case, a miss on purpose until the detector
  // closed it on 2026-08-17.
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
  // The reference records open holes as such on purpose: it is written by
  // `mutate-notes --freeze`, never by hand, so a rate below 100 % stays in it
  // until the detector, not the file, is fixed. This test only checks that
  // the table is sound; it cannot tell a hand edit from a measurement.
  const reference = await loadReference();
  for (const [name, { applicable, detected }] of Object.entries(reference.classes)) {
    assert.ok(applicable > 0, `${name} has no applicable cases in the reference`);
    assert.ok(detected <= applicable, `${name} detects more than it applies to`);
  }
  // Until 2026-10-13 a further assertion demanded one class below 100 %, on
  // the grounds that a perfect table more likely means a softer harness than
  // a better detector. It was the detector: the last miss (jundot/omlx@v0.5.0)
  // closed on 2026-08-17 when breadth earned by other commits stopped counting
  // (c573fc0, measured on the full corpus), with the five mutation classes
  // unchanged. A class that misses again goes into the reference through the
  // next freeze, as before.
});

// Every field case (docs/field-cases.md) is a regression test the day it is
// recorded: the real hunk, trimmed to the file that carries the change, and
// what the surface must read off it. A case is added before the fix with the
// expectation the fix has to meet — and a documented miss is a case too, so
// the day the decision behind it changes, this is what says so.
const FIELD_CASES: Array<{
  fixture: string;
  defaults: Array<[name: string, from: string, to: string]>;
  removedKeys?: string[];
}> = [
  {
    fixture: "openai-codex-rust-v0.157.0-daemon-auto-start.patch",
    defaults: [
      ["daemon_auto_start", "false", "true"],
      ["guardianv2.thread_context", "Stage::UnderDevelopment", "Stage::Stable"],
      ["guardianv2.thread_context", "false", "true"],
    ],
  },
  {
    fixture: "opencloud-eu-opencloud-v6.0.0-clean-stop-words.patch",
    defaults: [
      ["CleanStopWords", "true", "false"],
      ["BatchSize", "500", "50"],
    ],
  },
  {
    // A key removed is not a value moved: it lands in the key delta.
    fixture: "zed-industries-zed-v1.11.3-auto-replace-emoji-shortcode.patch",
    defaults: [],
    removedKeys: ["auto_replace_emoji_shortcode", "message_editor"],
  },
  {
    // Class C — a setter's argument — is off: the 2026-10-13 census found 88
    // of the corpus's 96 toggles unnamed AND noise (layout widths, i18n keys),
    // with `.promisc(false)` one real change among them. The miss is recorded
    // here, not hidden.
    fixture: "gyulyvgc-sniffnet-v1.4.2-promisc.patch",
    defaults: [],
  },
];

test("every field fixture reads as its case records", async () => {
  const dir = join(ROOT, "test/fixtures/field");
  const present = (await readdir(dir)).filter((f) => f.endsWith(".patch")).sort();
  assert.deepEqual(
    present,
    FIELD_CASES.map((c) => c.fixture).sort(),
    "a fixture without a case, or a case without a fixture",
  );
  for (const c of FIELD_CASES) {
    const files = parseUnifiedDiff(await readFile(join(dir, c.fixture), "utf8"));
    assert.ok(files.length, `${c.fixture} parsed to no files`);
    const s = releaseSurface(files);
    assert.deepEqual(
      s.defaults?.map((d) => [d.name, d.from, d.to]),
      c.defaults,
      c.fixture,
    );
    for (const k of c.removedKeys ?? []) {
      assert.ok(s.configKeys.removed.includes(k), `${c.fixture}: −key ${k}`);
    }
  }
});
