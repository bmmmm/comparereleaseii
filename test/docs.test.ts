// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PIN_PATTERNS } from "../scripts/pin-patterns.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("copy-paste recipes pin the version in package.json", async () => {
  const { version } = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")) as {
    version: string;
  };
  const docs = (await readdir(join(ROOT, "docs")))
    .filter((f) => f.endsWith(".md"))
    .map((f) => join("docs", f));

  const pins: { file: string; tag: string }[] = [];
  for (const file of ["README.md", ...docs]) {
    const text = await readFile(join(ROOT, file), "utf8");
    for (const pattern of PIN_PATTERNS) {
      for (const m of text.matchAll(new RegExp(pattern, "g"))) {
        pins.push({ file, tag: m[1] as string });
      }
    }
  }

  // Without this the test passes silently once the patterns stop matching —
  // a green run would then mean "found nothing", not "everything is current".
  assert.ok(pins.length >= 3, `expected the known pins, found ${pins.length}`);
  assert.deepEqual(
    pins.filter((p) => p.tag !== `v${version}`),
    [],
    `stale version pins — package.json is at ${version}`,
  );
});

// The golden set's size is quoted as a selling point ("an N-case golden
// set") and has drifted on every single change to the set so far, each time
// leaving a doc behind. golden.json is the only source of truth for it.
//
// This cannot tell a current claim from a deliberate statement about the past
// ("measured against the 23-case set") and will flag both. That is on purpose:
// a sentence carrying a number that was only ever true at one moment rots
// either way, so the fix is to write it without the count, not to teach the
// guard to look away.
test("prose that counts golden cases matches golden.json", async () => {
  const cases = JSON.parse(
    await readFile(join(ROOT, "test/eval/golden.json"), "utf8"),
  ) as unknown[];
  const docs = (await readdir(join(ROOT, "docs")))
    .filter((f) => f.endsWith(".md"))
    .map((f) => join("docs", f));

  const counts: { file: string; said: string }[] = [];
  for (const file of ["README.md", ...docs]) {
    const text = await readFile(join(ROOT, file), "utf8");
    // "23-case golden set" and "and 20\ngolden cases carry" both count.
    for (const m of text.matchAll(/(\d+)[\s-]+(?:case\b|golden case)/gi)) {
      counts.push({ file, said: m[1] as string });
    }
  }

  assert.ok(counts.length >= 2, `expected the known counts, found ${counts.length}`);
  assert.deepEqual(
    counts.filter((c) => c.said !== String(cases.length)),
    [],
    `golden-case counts out of date — golden.json has ${cases.length}`,
  );
});

// CONTRIBUTING.md and docs/ARCHITECTURE.md are the map a contributor or
// coding agent reads before touching anything. Both once listed 14 of 20
// modules — watch mode, --suggest and `guidelines` were invisible to whoever
// read them. AGENTS.md carried the agent-facing copy until 2026-08-14, when
// it was moved out to hold that file inside its word budget: this list has to
// follow the table, or it asserts against a file that no longer has one.
const MODULE_MAPS = ["CONTRIBUTING.md", "docs/ARCHITECTURE.md"];

test("the module maps cover src/, and name nothing that is gone", async () => {
  const modules = [
    ...(await readdir(join(ROOT, "src"))).filter((f) => f.endsWith(".ts")).map((f) => `src/${f}`),
    ...(await readdir(join(ROOT, "src/sources")))
      .filter((f) => f.endsWith(".ts"))
      .map((f) => `src/sources/${f}`),
  ];

  for (const doc of MODULE_MAPS) {
    const text = await readFile(join(ROOT, doc), "utf8");
    assert.deepEqual(
      modules.filter((m) => !text.includes(`\`${m}\``)),
      [],
      `${doc} does not mention these modules`,
    );
    const named = [...text.matchAll(/`(src\/[\w/]+\.ts)`/g)].map((m) => m[1] as string);
    assert.deepEqual(
      [...new Set(named)].filter((m) => !modules.includes(m)),
      [],
      `${doc} names modules that no longer exist`,
    );
  }
});

test("the module maps list each module once", async () => {
  // Two sessions adding the same new module to the same table is how this
  // happened; the coverage check above is satisfied by either copy.
  for (const doc of MODULE_MAPS) {
    const text = await readFile(join(ROOT, doc), "utf8");
    const named = [...text.matchAll(/^\| `(src\/[\w/]+\.ts)` \|/gm)].map((m) => m[1] as string);
    const seen = new Set<string>();
    assert.deepEqual(
      named.filter((m) => (seen.has(m) ? true : (seen.add(m), false))),
      [],
      `${doc} lists these modules more than once`,
    );
  }
});

// CLAUDE.md is re-read every turn, so a symbol name that moved there is a wrong
// instruction repeated all session — worse than the README's, which is read
// once. It names the shared renderer helpers and two guards by identifier;
// every camelCase name it quotes must still be declared somewhere in src/.
test("CLAUDE.md quotes no symbol that src/ has renamed away", async () => {
  const text = await readFile(join(ROOT, "CLAUDE.md"), "utf8");
  const files = [
    ...(await readdir(join(ROOT, "src"))).filter((f) => f.endsWith(".ts")).map((f) => `src/${f}`),
    ...(await readdir(join(ROOT, "src/sources")))
      .filter((f) => f.endsWith(".ts"))
      .map((f) => `src/sources/${f}`),
  ];
  const sources = await Promise.all(files.map((f) => readFile(join(ROOT, f), "utf8")));
  const declared = new Set<string>();
  for (const src of sources) {
    for (const m of src.matchAll(/^\s*(?:export\s+)?(?:async\s+)?(?:function|const|class)\s+([A-Za-z0-9_$]+)/gm)) {
      declared.add(m[1] as string);
    }
  }
  // camelCase only: `origin`, `github` and `main` are prose, not symbols.
  const quoted = [...text.matchAll(/`([a-z][a-z0-9]*[A-Z][A-Za-z0-9]*)`/g)].map((m) => m[1] as string);
  assert.notEqual(quoted.length, 0, "no symbols found — the extraction broke, not the doc");
  assert.deepEqual(
    [...new Set(quoted)].filter((s) => !declared.has(s)),
    [],
    "CLAUDE.md names symbols that no longer exist in src/",
  );
});
