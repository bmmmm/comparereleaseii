// SPDX-License-Identifier: GPL-3.0-or-later
import { after, test } from "node:test";
import { tempDir } from "./temp-dir.ts";
import assert from "node:assert/strict";
import { chmod, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  cacheBytes,
  judgeCallStats,
  pruneVerdictCache,
  resetJudgeStats,
  verdictCacheKey,
  verdictCacheStats,
  withVerdictCache,
} from "../src/cache.ts";
import { VERSION } from "../src/paths.ts";
import type { JudgeEngine } from "../src/judge.ts";

// Own cache root: cache.ts resolves XDG_CACHE_HOME at call time.
process.env.XDG_CACHE_HOME = await tempDir({ after }, "crii-cache-test-");

function countingEngine(): JudgeEngine & { calls: number } {
  const engine = {
    name: "stub",
    calls: 0,
    async judge(prompt: string): Promise<string> {
      engine.calls++;
      return `answer for ${prompt}`;
    },
  };
  return engine;
}

test("a second ask with the same prompt is served from disk", async () => {
  const engine = countingEngine();
  const cached = withVerdictCache(engine);
  // The stats are process-global (the summary line's data source), so this
  // test measures deltas — what these two calls added to the balance.
  const before = judgeCallStats();
  assert.equal(await cached.judge("same prompt"), "answer for same prompt");
  assert.equal(await cached.judge("same prompt"), "answer for same prompt");
  assert.equal(engine.calls, 1);
  const after = judgeCallStats();
  assert.equal(after.fresh - before.fresh, 1, "one call was paid for");
  assert.equal(after.cached - before.cached, 1, "one was answered from disk");
});

test("a run's bill starts at zero — the counters do not carry over", async () => {
  const cached = withVerdictCache(countingEngine());
  await cached.judge("bill prompt one");
  await cached.judge("bill prompt two");
  assert.ok(judgeCallStats().fresh >= 2, "calls landed on the balance");

  // What a second runWatch/runBackfill in the same process does before it
  // starts counting — without this it reports the first run's calls as its own.
  resetJudgeStats();
  assert.deepEqual(judgeCallStats(), { fresh: 0, cached: 0 });
  await cached.judge("bill prompt three");
  assert.equal(judgeCallStats().fresh, 1, "the new run counts only its own");
});

// Silently losing the cache silently loses determinism — the exact shape
// that turned an uncached 84 vs 90 into a phantom regression on 2026-07-26.
// cacheDir() already warns when the directory is unusable; a failing WRITE
// into a usable directory warned nobody.
test("a failing cache write warns once instead of silently re-judging forever", async () => {
  const verdicts = join(process.env.XDG_CACHE_HOME!, "comparereleaseii", "verdicts");
  await mkdir(verdicts, { recursive: true, mode: 0o700 });
  await chmod(verdicts, 0o500); // readable, listable, not writable — passes cacheDir's vetting
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.join(" "));
  };
  try {
    const engine = countingEngine();
    const cached = withVerdictCache(engine);
    await cached.judge("prompt A");
    await cached.judge("prompt B");
    assert.equal(engine.calls, 2);
    const warnings = lines.filter((l) => l.includes("verdict cache"));
    assert.equal(warnings.length, 1, `expected one write warning, got: ${JSON.stringify(lines)}`);
  } finally {
    console.error = orig;
    await chmod(verdicts, 0o700);
  }
});

const verdictsDir = (): string =>
  join(process.env.XDG_CACHE_HOME!, "comparereleaseii", "verdicts");

/** The first cached call sweeps the directory once per process; take that
 * out of the way so an entry planted afterwards is read, not swept. */
async function swept(): Promise<void> {
  await withVerdictCache(countingEngine()).judge("sweep primer");
  await mkdir(verdictsDir(), { recursive: true, mode: 0o700 });
}

/** Plants an entry under the key (engine, prompt) with arbitrary content. */
async function plant(engine: string, prompt: string, entry: object): Promise<void> {
  await writeFile(join(verdictsDir(), `${verdictCacheKey(engine, prompt)}.json`), JSON.stringify(entry));
}

test("an entry under the right key is served only to the engine that wrote it", async () => {
  await swept();
  await plant("stub", "engine prompt", { version: VERSION, engine: "someone-else", response: "planted" });
  const engine = countingEngine();
  assert.equal(await withVerdictCache(engine).judge("engine prompt"), "answer for engine prompt");
  assert.equal(engine.calls, 1, "a verdict written by another engine was served");
});

test("an entry stamped by another tool version is a miss even under a matching key", async () => {
  await swept();
  await plant("stub", "version prompt", { version: "0.0.0-other", engine: "stub", response: "planted" });
  const engine = countingEngine();
  assert.equal(await withVerdictCache(engine).judge("version prompt"), "answer for version prompt");
  assert.equal(engine.calls, 1, "a verdict from another tool version was served");
});

test("an entry whose response is not a string is a miss, not a verdict", async () => {
  await swept();
  await plant("stub", "shape prompt", { version: VERSION, engine: "stub", response: 42 });
  const engine = countingEngine();
  assert.equal(await withVerdictCache(engine).judge("shape prompt"), "answer for shape prompt");
  assert.equal(engine.calls, 1, "a non-string response was served as a verdict");
});

test("the same prompt asked of two engines is two cache entries", async () => {
  assert.notEqual(verdictCacheKey("engine-a", "p"), verdictCacheKey("engine-b", "p"));
  assert.notEqual(verdictCacheKey("a", "bp"), verdictCacheKey("ab", "p"));
  assert.equal(verdictCacheKey("engine-a", "p"), verdictCacheKey("engine-a", "p"));
});

test("the sweep's own marker is never counted or removed as a cache entry", async () => {
  await swept();
  await pruneVerdictCache({ ifStale: true });
  const names = await readdir(verdictsDir());
  assert.ok(names.includes("gc.state"), "the sweep left no marker — the test proves nothing");
  const stats = await verdictCacheStats();
  assert.equal(stats.entries, names.filter((n) => n.endsWith(".json")).length);
  assert.ok(!stats.byVersion.some((v) => v.version === null), "the marker was read as a foreign entry");
});

test("cacheBytes switches to MB at exactly one million bytes", () => {
  assert.equal(cacheBytes(1e6), "1.0 MB");
  assert.equal(cacheBytes(999_999), "1000 kB");
  assert.equal(cacheBytes(1500), "2 kB");
});
