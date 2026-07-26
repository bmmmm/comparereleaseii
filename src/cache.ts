// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cacheDir, VERSION } from "./paths.ts";
import type { JudgeEngine } from "./judge.ts";

export function verdictCacheKey(engineName: string, prompt: string): string {
  return createHash("sha256")
    .update(`${VERSION}\0${engineName}\0${prompt}`)
    .digest("hex");
}

interface CacheEntry {
  version?: string;
  engine?: string;
  response?: string;
}

/**
 * Same prompt + same engine + same tool version → same answer, from disk.
 * Makes re-runs deterministic and free; LLM nondeterminism only ever happens
 * once per distinct question. The version is part of the key so an upgrade
 * that changes the prompt or the scoring rules cannot serve an answer to a
 * question this build never asked.
 */
export function withVerdictCache(engine: JudgeEngine): JudgeEngine {
  return {
    name: engine.name,
    async judge(prompt: string): Promise<string> {
      const dir = await cacheDir("verdicts");
      const file = dir ? join(dir, `${verdictCacheKey(engine.name, prompt)}.json`) : null;
      if (file) {
        try {
          const entry = JSON.parse(await readFile(file, "utf8")) as CacheEntry;
          if (
            entry.version === VERSION &&
            entry.engine === engine.name &&
            typeof entry.response === "string"
          ) {
            return entry.response;
          }
        } catch {
          // cache miss
        }
      }
      const response = await engine.judge(prompt);
      if (file) {
        try {
          await writeFile(
            file,
            JSON.stringify({ version: VERSION, engine: engine.name, response }),
            { mode: 0o600 },
          );
        } catch {
          // cache write is best-effort
        }
      }
      return response;
    },
  };
}
