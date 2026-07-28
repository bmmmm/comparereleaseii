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

let writeWarned = false;

/** Judge calls this process paid for vs. answered from disk — the cost
 * question every long run gets asked ("wie teuer war das jetzt?"). */
const stats = { fresh: 0, cached: 0 };

export function judgeCallStats(): { fresh: number; cached: number } {
  return { ...stats };
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
            stats.cached++;
            return entry.response;
          }
        } catch {
          // cache miss
        }
      }
      stats.fresh++;
      const response = await engine.judge(prompt);
      if (file) {
        try {
          await writeFile(
            file,
            JSON.stringify({ version: VERSION, engine: engine.name, response }),
            { mode: 0o600 },
          );
        } catch (err) {
          // Best-effort, but never silent: a cache that stops persisting
          // makes every future run re-judge — slower and nondeterministic —
          // and that has been misread as a scoring regression before.
          if (!writeWarned) {
            writeWarned = true;
            console.error(
              `warning: could not write the verdict cache (${(err as Error).message.slice(0, 120)}) — verdicts will be re-judged on every run until this is fixed.`,
            );
          }
        }
      }
      return response;
    },
  };
}
