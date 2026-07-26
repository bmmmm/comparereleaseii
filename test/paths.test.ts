// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, chmodSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheDir, safeSegment, VERSION } from "../src/paths.ts";
import { verdictCacheKey, withVerdictCache } from "../src/cache.ts";

async function withCacheHome<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const before = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = dir;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = before;
  }
}

test("the cache never lands in the shared temp dir", async () => {
  // Every key is computable from public data (notes + diff are published), so
  // a world-writable /tmp lets anyone plant the verdict for a release before
  // it is checked.
  const home = mkdtempSync(join(tmpdir(), "crii-home-"));
  const dir = await withCacheHome(home, async () => cacheDir("verdicts"));
  assert.ok(dir, "a private cache directory is available");
  assert.ok(dir!.startsWith(home), "and it is the one we pointed at");
  assert.ok(
    !dir!.startsWith(join(tmpdir(), "comparereleaseii-cache")),
    "not the old shared-temp location",
  );
});

test("a cache directory writable by others is refused, not used", async () => {
  const home = mkdtempSync(join(tmpdir(), "crii-home-"));
  const hostile = join(home, "comparereleaseii", "verdicts");
  mkdirSync(hostile, { recursive: true });
  chmodSync(hostile, 0o777);
  const dir = await withCacheHome(home, async () => cacheDir("verdicts"));
  assert.equal(dir, null);
});

test("the verdict key is bound to the tool version", () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+/);
  // The pre-fix key: engine + prompt only. Sharing a slot across versions is
  // how a verdict produced by a different prompt or scoring rule survives an
  // upgrade.
  const legacy = createHash("sha256").update(`engine\0prompt`).digest("hex");
  assert.notEqual(verdictCacheKey("engine", "prompt"), legacy);
  assert.equal(
    verdictCacheKey("engine", "prompt"),
    createHash("sha256").update(`${VERSION}\0engine\0prompt`).digest("hex"),
  );
});

test("a cache entry from another version or engine is ignored", async () => {
  const home = mkdtempSync(join(tmpdir(), "crii-home-"));
  await withCacheHome(home, async () => {
    const dir = await cacheDir("verdicts");
    assert.ok(dir);
    const prompt = `entry-test-${process.pid}`;
    const planted = { file: join(dir!, `${verdictCacheKey("e1", prompt)}.json`) };
    writeFileSync(
      planted.file,
      JSON.stringify({ version: "0.0.1-other", engine: "e1", response: "PLANTED" }),
    );
    let calls = 0;
    const engine = withVerdictCache({
      name: "e1",
      judge: async () => {
        calls++;
        return "FRESH";
      },
    });
    assert.equal(await engine.judge(prompt), "FRESH");
    assert.equal(calls, 1);
    // …and the fresh answer is now cached under this version.
    assert.equal(await engine.judge(prompt), "FRESH");
    assert.equal(calls, 1);
  });
});

test("safeSegment keeps a hostile ref name inside one path component", () => {
  assert.equal(safeSegment("release/1.0"), "release_1.0");
  assert.equal(safeSegment("../../etc/passwd"), ".._.._etc_passwd");
  assert.equal(safeSegment(""), "_");
});

test("cloneDirFor keys every spelling of the same repo to one directory", async () => {
  process.env.XDG_CACHE_HOME ??= await (await import("node:fs/promises")).mkdtemp(
    (await import("node:path")).join((await import("node:os")).tmpdir(), "crii-paths-"),
  );
  const { cloneDirFor } = await import("../src/paths.ts");
  const a = await cloneDirFor("https://github.com/o/r.git");
  const b = await cloneDirFor("https://github.com/o/r");
  const c = await cloneDirFor("https://github.com/o/r/");
  assert.ok(a, "no cache dir available");
  assert.equal(a, b);
  assert.equal(a, c);
  // Different repos stay apart.
  assert.notEqual(a, await cloneDirFor("https://github.com/o/other"));
});
