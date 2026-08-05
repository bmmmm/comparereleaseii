// SPDX-License-Identifier: GPL-3.0-or-later
//
// One writer per state file.
//
// `writeJsonAtomic` already makes each write all-or-nothing, which is a
// different question from this one: two runs that both read the state, then
// both write it, each produce a whole file — and the second one silently
// drops everything the first learned. That happened on 2026-08-04, when an
// hourly job and two backfills shared a watch home and three release records
// disappeared. The file was never corrupt for a moment; it was just written
// twice from the same starting point.
//
// So a run holds a lock for its whole lifetime — load, check, save — and a
// second run says so and leaves rather than working against a state it is
// going to lose to. Liveness is decided by the holder's pid on the same host,
// not by a timeout: a backfill judging 300 releases legitimately runs for
// hours, and a lock that expires under a working process is worse than no
// lock at all.
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";

export interface LockHolder {
  pid: number;
  host: string;
  startedAt: string;
  command: string;
}

export interface LockAcquired {
  ok: true;
  release: () => Promise<void>;
}

export interface LockDenied {
  ok: false;
  holder: LockHolder | null;
  /** Ready to print: who holds it, since when, and what to do about it. */
  message: string;
}

/** A lock whose host cannot be checked is stale after this — the last resort
 * for a watch home on a network share, where the pid means nothing. */
const FOREIGN_HOST_STALE_MS = 24 * 60 * 60 * 1000;

const lockPathFor = (statePath: string): string => `${statePath}.lock`;

async function readHolder(path: string): Promise<LockHolder | null> {
  try {
    const raw = await readFile(path, "utf8");
    const holder = JSON.parse(raw) as LockHolder;
    return typeof holder?.pid === "number" && typeof holder.host === "string" ? holder : null;
  } catch {
    return null;
  }
}

/** Does the process that wrote this lock still exist? */
function holderAlive(holder: LockHolder, now: number): boolean {
  if (holder.host !== hostname()) {
    // Another machine's pid says nothing about ours. Time is all that is left.
    const age = now - Date.parse(holder.startedAt);
    return !Number.isFinite(age) || age < FOREIGN_HOST_STALE_MS;
  }
  try {
    // Signal 0 checks for existence without delivering anything. EPERM means
    // the process is there and owned by someone else — still alive.
    process.kill(holder.pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Take the lock for `statePath`, or report who holds it. Never waits for a
 * running holder: the hourly job's next tick is an hour away, and a queue of
 * watch runs stacking up behind a long backfill is not an improvement.
 */
export async function acquireStateLock(
  statePath: string,
  now: number = Date.now(),
): Promise<LockAcquired | LockDenied> {
  const path = lockPathFor(statePath);
  const mine: LockHolder = {
    pid: process.pid,
    host: hostname(),
    startedAt: new Date(now).toISOString(),
    command: process.argv.slice(1).join(" "),
  };

  // The state file's own writer creates this directory on the way out; the
  // lock gets there first, so a watch home that does not exist yet must not
  // fail at the door.
  await mkdir(dirname(path), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // "wx" is the whole mechanism: create-or-fail is atomic, so two runs
      // racing here cannot both win, whatever the filesystem.
      const handle = await open(path, "wx");
      try {
        await handle.writeFile(JSON.stringify(mine));
      } finally {
        await handle.close();
      }
      const onSignal = (signal: NodeJS.Signals): never => {
        releaseSync(path, mine);
        process.exit(signal === "SIGINT" ? 130 : 143);
      };
      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);
      return {
        ok: true,
        release: async () => {
          process.off("SIGINT", onSignal);
          process.off("SIGTERM", onSignal);
          await release(path, mine);
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new Error(
          `Cannot lock ${path} (${(err as Error).message}) — the state file's directory has to be writable.`,
        );
      }
      let holder = await readHolder(path);
      if (!holder) {
        // Either a half-written lock from a process that died between the
        // create and the write, or one being written right now. Give the
        // second reading a moment before calling it abandoned.
        await wait(50);
        holder = await readHolder(path);
      }
      if (holder && holderAlive(holder, now)) {
        const since = holder.startedAt.replace("T", " ").slice(0, 19);
        return {
          ok: false,
          holder,
          message:
            `Another run holds ${path} (pid ${holder.pid} on ${holder.host}, since ${since} UTC` +
            `${holder.command ? `: ${holder.command}` : ""}). ` +
            "Nothing was checked. Wait for it to finish, or work on a copy with --state <file>; " +
            "if that process is gone, delete the lock file.",
        };
      }
      // The holder is gone. Take the lock over, once.
      await unlink(path).catch(() => {});
    }
  }
  return {
    ok: false,
    holder: null,
    message: `Could not take ${path} — it keeps reappearing between the check and the retry. Another run is starting up against the same state file.`,
  };
}

/** Remove the lock, but only while it is still ours. */
async function release(path: string, mine: LockHolder): Promise<void> {
  const holder = await readHolder(path);
  if (holder && (holder.pid !== mine.pid || holder.startedAt !== mine.startedAt)) return;
  await unlink(path).catch(() => {});
}

/** The same, from a signal handler, where nothing may await. */
function releaseSync(path: string, mine: LockHolder): void {
  try {
    unlinkSync(path);
  } catch {
    // Gone already, or never ours — either way there is nothing to undo.
  }
  process.stderr.write(`\nwatch: interrupted, released ${path} (pid ${mine.pid}).\n`);
}
