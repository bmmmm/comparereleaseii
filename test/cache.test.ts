// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withVerdictCache } from "../src/cache.ts";
import type { JudgeEngine } from "../src/judge.ts";

// Own cache root: cache.ts resolves XDG_CACHE_HOME at call time.
process.env.XDG_CACHE_HOME = await mkdtemp(join(tmpdir(), "crii-cache-test-"));

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
  assert.equal(await cached.judge("same prompt"), "answer for same prompt");
  assert.equal(await cached.judge("same prompt"), "answer for same prompt");
  assert.equal(engine.calls, 1);
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
