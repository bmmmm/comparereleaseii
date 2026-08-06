// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A `find:`/`replace:` literal as the harness writes it — either quote
 * style, `\n` for the multi-line patterns. Not a JS parser: the assertion on
 * the count below is what proves this read the whole list. */
function literal(raw: string): string {
  const body = raw.slice(1, -1);
  return body.replace(/\\(n|\\|"|')/g, (_, c) => (c === "n" ? "\n" : c));
}

interface Mutant {
  guard: string;
  file: string;
  find: string;
  replace: string;
}

async function readMutants(): Promise<Mutant[]> {
  const source = await readFile(join(ROOT, "scripts/mutate.ts"), "utf8");
  const body = source.slice(source.indexOf("const MUTANTS"), source.indexOf("// Same file set as"));
  const entry =
    /guard:\s*("(?:[^"\\]|\\.)*"),\s*\n\s*file:\s*("(?:[^"\\]|\\.)*"),\s*\n\s*find:\s*((?:"(?:[^"\\]|\\.)*")|(?:'(?:[^'\\]|\\.)*')),\s*\n\s*replace:\s*((?:"(?:[^"\\]|\\.)*")|(?:'(?:[^'\\]|\\.)*')),/g;
  return [...body.matchAll(entry)].map((m) => ({
    guard: literal(m[1]),
    file: literal(m[2]),
    find: literal(m[3]),
    replace: literal(m[4]),
  }));
}

// `pnpm mutate` runs the whole suite once per guard — 25 minutes locally — and
// exits on the FIRST pattern that no longer matches its file. Three had gone
// stale under refactorings (two of them before this test existed, unseen
// because the nightly runs on the release mirror, which lags `main`), and the
// run died at 16 of 94 having measured nothing about the other 78. The
// staleness is readable in milliseconds; only the killing needs the 25 minutes.
test("every mutant still points at the code it claims to break", async () => {
  const mutants = await readMutants();
  // Without this a regex that stopped matching would pass as "nothing stale".
  assert.ok(
    mutants.length >= 90,
    `only parsed ${mutants.length} mutants out of scripts/mutate.ts — the reader has drifted from the file`,
  );

  const sources = new Map<string, string>();
  const stale: string[] = [];
  for (const m of mutants) {
    if (!sources.has(m.file)) sources.set(m.file, await readFile(join(ROOT, m.file), "utf8"));
    const occurrences = sources.get(m.file)!.split(m.find).length - 1;
    // The harness itself demands exactly one: two matches would mutate a
    // second site nobody reasoned about, zero would measure nothing.
    if (occurrences !== 1) stale.push(`${occurrences}× in ${m.file} — "${m.guard}"`);
  }
  assert.deepEqual(stale, [], `stale mutant patterns:\n  ${stale.join("\n  ")}`);
});

test("no mutant is a no-op, and every guard is named once", async () => {
  const mutants = await readMutants();
  // A find equal to its replace patches nothing, so the suite stays green and
  // the harness reports SURVIVED — a guard that reads as untested forever
  // while nothing is wrong with its test.
  assert.deepEqual(
    mutants.filter((m) => m.find === m.replace).map((m) => m.guard),
    [],
    "mutants that change nothing",
  );
  const seen = new Set<string>();
  const duplicates = mutants.filter((m) => !seen.add(m.guard)).map((m) => m.guard);
  assert.deepEqual(duplicates, [], "two mutants under one guard name — the report cannot tell them apart");
});
