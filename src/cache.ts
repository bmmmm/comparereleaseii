// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from "node:crypto";
import { readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cacheDir, VERSION } from "./paths.ts";
import { pooled } from "./util.ts";
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

/**
 * Marker for "this build has already swept". Deliberately not a `.json` file:
 * the sweep reads every `.json` in the directory as an entry, and its own
 * bookkeeping must not look like one.
 */
const GC_STATE = "gc.state";

/** One entry as the sweep sees it — the version it was written under, and what it costs. */
interface StoredEntry {
  file: string;
  /** null when the file does not parse as an entry of ours. */
  version: string | null;
  bytes: number;
}

/**
 * Space on disk, not the length of the contents. Every entry is a few hundred
 * bytes in a filesystem block of its own, so the two differ by almost an order
 * of magnitude at this file count — 8292 entries measured 4.8 MB of JSON and
 * 33 MB of disk. The disk number is the one `du` prints and the one a person
 * who notices the directory is asking about.
 */
function diskBytes(st: { blocks?: number; size: number }): number {
  return st.blocks ? st.blocks * 512 : st.size;
}

/** Cache size for a person: MB once there is one, kB below — "0.0 MB" answers nothing. */
export function cacheBytes(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} kB`;
}

async function scanVerdicts(dir: string): Promise<StoredEntry[]> {
  const names = (await readdir(dir)).filter((n) => n.endsWith(".json"));
  return pooled(names, 16, async (name) => {
    const file = join(dir, name);
    try {
      const [text, st] = await Promise.all([readFile(file, "utf8"), stat(file)]);
      const entry = JSON.parse(text) as CacheEntry;
      return {
        file,
        version: typeof entry.version === "string" ? entry.version : null,
        bytes: diskBytes(st),
      };
    } catch {
      return { file, version: null, bytes: 0 };
    }
  });
}

/** What one sweep did. */
export interface VerdictCachePrune {
  /** false when `ifStale` found this build's marker already in place. */
  scanned: boolean;
  removed: number;
  kept: number;
  /** Disk space the removed entries occupied. */
  freed: number;
}

/**
 * Remove what the key scheme has already orphaned.
 *
 * The version is part of every key AND repeated inside the entry, so the
 * moment this tool is upgraded no entry of an earlier build can ever be read
 * again — it is not stale, it is unreachable. Nothing removed it: measured on
 * 2026-08-09 a two-month-old cache held 8135 entries / 32 MB of which 205
 * belonged to the running build. Unlinking on a read miss cannot fix that
 * either, because a miss never names the file that would have been hit.
 *
 * The version stays in the key — that is deliberate stale-replay protection
 * and it keeps scores comparable within a generation. This only takes out what
 * that design already made dead. A file that does not parse as an entry goes
 * with them: it can never produce a hit, so it is dead weight by the same
 * measure.
 *
 * `ifStale` makes it a no-op once this build has swept, which is what lets a
 * check call it on every run for the price of one `readFile`.
 */
export async function pruneVerdictCache(
  opts: { all?: boolean; ifStale?: boolean } = {},
): Promise<VerdictCachePrune> {
  const idle: VerdictCachePrune = { scanned: false, removed: 0, kept: 0, freed: 0 };
  const dir = await cacheDir("verdicts");
  if (!dir) return idle;
  const marker = join(dir, GC_STATE);
  if (opts.ifStale) {
    try {
      if ((await readFile(marker, "utf8")).trim() === VERSION) return idle;
    } catch {
      // No marker: this build has never swept here.
    }
  }
  let removed = 0;
  let kept = 0;
  let freed = 0;
  for (const entry of await scanVerdicts(dir)) {
    if (!opts.all && entry.version === VERSION) {
      kept++;
      continue;
    }
    try {
      await unlink(entry.file);
      removed++;
      freed += entry.bytes;
    } catch {
      // Another process got there first, or the file is not ours to remove.
      kept++;
    }
  }
  try {
    await writeFile(marker, `${VERSION}\n`, { mode: 0o600 });
  } catch {
    // Best effort: without the marker the next run sweeps again, which is
    // slow but never wrong.
  }
  return { scanned: true, removed, kept, freed };
}

/** The cache as a histogram over the builds that wrote it — what `cache stats` reports. */
export async function verdictCacheStats(): Promise<{
  dir: string | null;
  entries: number;
  bytes: number;
  byVersion: Array<{ version: string | null; entries: number; bytes: number }>;
}> {
  const dir = await cacheDir("verdicts");
  if (!dir) return { dir: null, entries: 0, bytes: 0, byVersion: [] };
  const stored = await scanVerdicts(dir);
  const tally = new Map<string | null, { version: string | null; entries: number; bytes: number }>();
  for (const e of stored) {
    const row = tally.get(e.version) ?? { version: e.version, entries: 0, bytes: 0 };
    row.entries++;
    row.bytes += e.bytes;
    tally.set(e.version, row);
  }
  return {
    dir,
    entries: stored.length,
    bytes: stored.reduce((n, e) => n + e.bytes, 0),
    byVersion: [...tally.values()].sort((a, b) => b.entries - a.entries),
  };
}

let sweeping: Promise<VerdictCachePrune> | null = null;

/**
 * One sweep per process, at the first cached judge call. It costs a `readFile`
 * on every run but the full scan only on the first run of a new build, and a
 * check that judges is the moment the cache is demonstrably in use — a person
 * who never judges never pays for the directory either.
 */
function sweepOnce(): Promise<VerdictCachePrune> {
  sweeping ??= pruneVerdictCache({ ifStale: true })
    .then((result) => {
      if (result.removed) {
        console.error(
          `verdict cache: removed ${result.removed} entr${result.removed === 1 ? "y" : "ies"} ` +
            `(${cacheBytes(result.freed)}) written by earlier builds — ` +
            "the version is part of every key, so they could never be read again.",
        );
      }
      return result;
    })
    .catch(() => ({ scanned: false, removed: 0, kept: 0, freed: 0 }));
  return sweeping;
}

/** Judge calls this process paid for vs. answered from disk — the cost
 * question every long run gets asked ("wie teuer war das jetzt?"). */
const stats = { fresh: 0, cached: 0 };

export function judgeCallStats(): { fresh: number; cached: number } {
  return { ...stats };
}

/**
 * Starts a run's bill at zero. The counters are process-global, so a second
 * run in the same process — two watch modes from one test, a backfill after a
 * poll — would otherwise report the first run's calls as its own.
 */
export function resetJudgeStats(): void {
  stats.fresh = 0;
  stats.cached = 0;
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
        // Before the read, not after: the sweep never touches this build's own
        // entries, but a directory it has finished with is the one this run
        // should be reading.
        await sweepOnce();
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
