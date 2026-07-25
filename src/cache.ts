// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JudgeEngine } from "./judge.ts";

const DIR = join(tmpdir(), "comparereleaseii-cache", "verdicts");

export function verdictCacheKey(engineName: string, prompt: string): string {
  return createHash("sha256").update(`${engineName}\0${prompt}`).digest("hex");
}

/**
 * Same prompt + same engine → same answer, from disk. Makes re-runs
 * deterministic and free; LLM nondeterminism only ever happens once per
 * distinct question.
 */
export function withVerdictCache(engine: JudgeEngine): JudgeEngine {
  return {
    name: engine.name,
    async judge(prompt: string): Promise<string> {
      const file = join(DIR, `${verdictCacheKey(engine.name, prompt)}.json`);
      try {
        return (JSON.parse(await readFile(file, "utf8")) as { response: string }).response;
      } catch {
        // cache miss
      }
      const response = await engine.judge(prompt);
      try {
        await mkdir(DIR, { recursive: true });
        await writeFile(file, JSON.stringify({ engine: engine.name, response }));
      } catch {
        // cache write is best-effort
      }
      return response;
    },
  };
}
