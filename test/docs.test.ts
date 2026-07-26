// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Recipes readers copy verbatim pin the tool at a tag. A release bumps
// package.json, and one forgotten file keeps handing them the previous
// version: v0.1.1 shipped with docs/watchdog.md still checking out v0.1.0,
// in a commit whose subject was "bump refs to the new tag". History and
// changelog entries may name old versions — these two patterns may not.
const PIN_PATTERNS = [
  String.raw`bmmmm/comparereleaseii@(v[\d.]+)`, // composite action ref
  String.raw`ref:\s*(v[\d.]+)`, // actions/checkout ref
];

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

// CONTRIBUTING.md and AGENTS.md are the map a contributor or coding agent
// reads before touching anything. Both once listed 14 of 20 modules — watch
// mode, --suggest and `guidelines` were invisible to whoever read them.
const MODULE_MAPS = ["CONTRIBUTING.md", "AGENTS.md"];

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
