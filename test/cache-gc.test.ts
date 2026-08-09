// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { VERSION } from "../src/paths.ts";
import {
  pruneVerdictCache,
  verdictCacheKey,
  verdictCacheStats,
  withVerdictCache,
} from "../src/cache.ts";

// cacheDir() resolves XDG_CACHE_HOME at call time, so every test gets its own.
async function withCacheHome<T>(fn: (verdicts: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "crii-gc-"));
  const verdicts = join(home, "comparereleaseii", "verdicts");
  await mkdir(verdicts, { recursive: true, mode: 0o700 });
  const before = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = home;
  try {
    return await fn(verdicts);
  } finally {
    if (before === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = before;
  }
}

async function plant(
  dir: string,
  name: string,
  entry: Record<string, unknown> | string,
): Promise<string> {
  const file = join(dir, `${name}.json`);
  await writeFile(file, typeof entry === "string" ? entry : JSON.stringify(entry));
  return file;
}

// FIRST in this file on purpose: the automatic sweep runs once per process,
// and this is the only test that can observe it happening.
test("the first cached judge call clears out what an earlier build left", async () => {
  await withCacheHome(async (verdicts) => {
    const dead = await plant(verdicts, "a".repeat(64), {
      version: "0.0.1-old",
      engine: "stub",
      response: "unreachable",
    });
    const engine = withVerdictCache({ name: "stub", judge: async () => "FRESH" });
    assert.equal(await engine.judge("swept"), "FRESH");
    const names = await readdir(verdicts);
    assert.ok(!names.includes(basename(dead)), `the orphan survived: ${names.join(", ")}`);
    assert.ok(
      names.includes(`${verdictCacheKey("stub", "swept")}.json`),
      "this run's own entry was written and kept",
    );
    // And the marker says this build is done here, so the next run pays a
    // readFile instead of a full scan.
    assert.equal((await readFile(join(verdicts, "gc.state"), "utf8")).trim(), VERSION);
  });
});

test("a sweep removes every build's entries but this one's", async () => {
  await withCacheHome(async (verdicts) => {
    await plant(verdicts, "b".repeat(64), { version: "0.9.0", engine: "e", response: "old" });
    await plant(verdicts, "c".repeat(64), { version: "0.5.1", engine: "e", response: "older" });
    await plant(verdicts, "d".repeat(64), { version: VERSION, engine: "e", response: "mine" });
    // Not an entry at all: it can never produce a hit, so it is dead weight
    // by the same measure.
    await plant(verdicts, "e".repeat(64), "{ truncated");

    const result = await pruneVerdictCache();
    assert.equal(result.scanned, true);
    assert.equal(result.removed, 3);
    assert.equal(result.kept, 1);
    assert.ok(result.freed > 0, "the removed entries had a size");
    assert.deepEqual(
      (await readdir(verdicts)).filter((n) => n.endsWith(".json")),
      [`${"d".repeat(64)}.json`],
    );
  });
});

test("--all empties the cache, this build's entries included", async () => {
  await withCacheHome(async (verdicts) => {
    await plant(verdicts, "b".repeat(64), { version: "0.9.0", engine: "e", response: "old" });
    await plant(verdicts, "d".repeat(64), { version: VERSION, engine: "e", response: "mine" });
    const result = await pruneVerdictCache({ all: true });
    assert.equal(result.removed, 2);
    assert.equal(result.kept, 0);
    assert.deepEqual(
      (await readdir(verdicts)).filter((n) => n.endsWith(".json")),
      [],
    );
  });
});

test("ifStale scans once per build, then costs one readFile", async () => {
  await withCacheHome(async (verdicts) => {
    await plant(verdicts, "b".repeat(64), { version: "0.9.0", engine: "e", response: "old" });
    const first = await pruneVerdictCache({ ifStale: true });
    assert.equal(first.scanned, true);
    assert.equal(first.removed, 1);

    // What a later run of the same build finds: the marker, and nothing to do.
    // Without the marker every check would re-read the whole directory.
    await plant(verdicts, "c".repeat(64), { version: "0.9.0", engine: "e", response: "planted after" });
    const second = await pruneVerdictCache({ ifStale: true });
    assert.equal(second.scanned, false);
    assert.equal(second.removed, 0);
    assert.ok(
      (await readdir(verdicts)).includes(`${"c".repeat(64)}.json`),
      "the marker really stopped the second scan",
    );
  });
});

test("stats count the entries per build that wrote them", async () => {
  await withCacheHome(async (verdicts) => {
    await plant(verdicts, "b".repeat(64), { version: "0.9.0", engine: "e", response: "old" });
    await plant(verdicts, "c".repeat(64), { version: "0.9.0", engine: "e", response: "old too" });
    await plant(verdicts, "d".repeat(64), { version: VERSION, engine: "e", response: "mine" });
    const stats = await verdictCacheStats();
    assert.equal(stats.entries, 3);
    assert.ok(stats.bytes > 0);
    // Descending, so the biggest pile of dead weight is the first thing read.
    assert.deepEqual(
      stats.byVersion.map((r) => [r.version, r.entries]),
      [
        ["0.9.0", 2],
        [VERSION, 1],
      ],
    );
  });
});
