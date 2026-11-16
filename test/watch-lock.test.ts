// SPDX-License-Identifier: GPL-3.0-or-later
import { after, test } from "node:test";
import { tempDir } from "./temp-dir.ts";
import assert from "node:assert/strict";
import { readFile, writeFile, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { acquireStateLock } from "../src/watch-lock.ts";
import { runWatch } from "../src/watch.ts";

const home = async (): Promise<string> => tempDir({ after }, "crii-lock-");

/** A pid no process can have: macOS and Linux both cap far below this. */
const DEAD_PID = 2147483647;

test("a second run finds the lock taken and says who has it", async () => {
  const state = join(await home(), "watch-state.json");
  const first = await acquireStateLock(state);
  assert.ok(first.ok);

  const second = await acquireStateLock(state);
  assert.equal(second.ok, false);
  if (second.ok) return;
  assert.equal(second.holder?.pid, process.pid);
  // The message has to carry the way out, not just the refusal.
  assert.match(second.message, /--state/);
  assert.match(second.message, /Nothing was checked/);

  await first.release();
  const third = await acquireStateLock(state);
  assert.ok(third.ok, "the lock is free once its holder released it");
  await third.release();
});

test("the lock of a process that is gone is taken over, not obeyed", async () => {
  // The case that keeps a watch home working after a crash or a SIGKILL:
  // nothing removes the file then, and a lock nobody holds must not be able
  // to stop every future run.
  const state = join(await home(), "watch-state.json");
  await writeFile(
    `${state}.lock`,
    JSON.stringify({
      pid: DEAD_PID,
      host: hostname(),
      startedAt: new Date().toISOString(),
      command: "watch --config watch.json",
    }),
  );
  const taken = await acquireStateLock(state);
  assert.ok(taken.ok);
  const holder = JSON.parse(await readFile(`${state}.lock`, "utf8"));
  assert.equal(holder.pid, process.pid);
  await taken.release();
});

test("a lock from another machine expires on time, since its pid means nothing here", async () => {
  const dir = await home();
  const fresh = join(dir, "fresh.json");
  const old = join(dir, "old.json");
  const now = Date.parse("2026-08-05T12:00:00Z");
  const foreign = (startedAt: string) =>
    JSON.stringify({ pid: 1234, host: "some-other-box", startedAt, command: "watch" });

  await writeFile(`${fresh}.lock`, foreign("2026-08-05T11:30:00Z"));
  const denied = await acquireStateLock(fresh, now);
  assert.equal(denied.ok, false, "half an hour old on an unreachable host is still a running check");

  await writeFile(`${old}.lock`, foreign("2026-08-03T11:30:00Z"));
  const taken = await acquireStateLock(old, now);
  assert.ok(taken.ok, "two days is past any run this tool has");
  await taken.release();
});

test("releasing removes only a lock that is still ours", async () => {
  const state = join(await home(), "watch-state.json");
  const mine = await acquireStateLock(state);
  assert.ok(mine.ok);
  // Someone decided we were dead and took over. Our release must not delete
  // their lock — that would leave the new holder running unprotected.
  const other = JSON.stringify({
    pid: process.pid + 1,
    host: hostname(),
    startedAt: new Date().toISOString(),
    command: "backfill",
  });
  await writeFile(`${state}.lock`, other);
  await mine.release();
  assert.equal(await readFile(`${state}.lock`, "utf8"), other);
});

test("a locked state file makes the run a no-op, not a failure", async () => {
  // The hourly job's answer to a backfill still running: check nothing, say
  // so, and exit clean — a non-zero code here would read as a bad release.
  const dir = await home();
  const state = join(dir, "watch-state.json");
  const held = await acquireStateLock(state);
  assert.ok(held.ok);

  const errors: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => void errors.push(args.join(" "));
  try {
    // The repo would need the network to poll — reaching it at all is the
    // failure this asserts against.
    const code = await runWatch(
      { repos: [{ repo: "o/r" }] },
      { configPath: join(dir, "watch.json"), cache: false, stateFile: state },
    );
    assert.equal(code, 0);
  } finally {
    console.error = realError;
    await held.release();
  }
  assert.match(errors.join("\n"), /Another run holds/);
  await assert.rejects(stat(state), "the locked-out run wrote no state");
});

test("the lock does not need the watch home to exist yet", async () => {
  const state = join(await home(), "nested", "deeper", "watch-state.json");
  const lock = await acquireStateLock(state);
  assert.ok(lock.ok, "a first run creates its state directory — the lock gets there first");
  assert.ok((await stat(`${state}.lock`)).isFile());
  await lock.release();
});

test("a lock from another machine is stale at exactly a day, live a millisecond sooner", async () => {
  const dir = await home();
  const now = Date.parse("2026-08-05T12:00:00Z");
  const foreign = (startedAt: string) =>
    JSON.stringify({ pid: 1234, host: "some-other-box", startedAt, command: "watch" });

  const young = join(dir, "young.json");
  await writeFile(`${young}.lock`, foreign("2026-08-04T12:00:00.001Z"));
  const denied = await acquireStateLock(young, now);
  assert.equal(denied.ok, false, "one millisecond short of a day is still inside the window");

  const exact = join(dir, "exact.json");
  await writeFile(`${exact}.lock`, foreign("2026-08-04T12:00:00Z"));
  const taken = await acquireStateLock(exact, now);
  assert.ok(taken.ok, "a day to the millisecond is past the window");
  await taken.release();
});

test("a lock from another machine whose start time cannot be read is kept alive", async () => {
  const state = join(await home(), "watch-state.json");
  await writeFile(
    `${state}.lock`,
    JSON.stringify({ pid: 1234, host: "some-other-box", startedAt: "not a date", command: "watch" }),
  );
  const res = await acquireStateLock(state);
  assert.equal(res.ok, false, "no age to judge by means no grounds to take it over");
});

test("a lock file that names no host is no holder and is taken over", async () => {
  const state = join(await home(), "watch-state.json");
  await writeFile(`${state}.lock`, JSON.stringify({ pid: DEAD_PID, startedAt: new Date().toISOString() }));
  const taken = await acquireStateLock(state);
  assert.ok(taken.ok);
  await taken.release();
});

test("release keeps a lock whose holder differs in pid alone or in start time alone", async () => {
  const dir = await home();
  const now = Date.parse("2026-08-05T12:00:00Z");
  const startedAt = new Date(now).toISOString();
  const takenOver = async (name: string, other: { pid: number; startedAt: string }) => {
    const state = join(dir, name);
    const mine = await acquireStateLock(state, now);
    assert.ok(mine.ok);
    const text = JSON.stringify({ ...other, host: hostname(), command: "backfill" });
    await writeFile(`${state}.lock`, text);
    await mine.release();
    assert.equal(await readFile(`${state}.lock`, "utf8"), text);
  };
  // Same start time, other process — only the pid tells them apart.
  await takenOver("pid.json", { pid: process.pid + 1, startedAt });
  // Same pid, later start — a pid reused by a newer run.
  await takenOver("start.json", { pid: process.pid, startedAt: new Date(now + 1000).toISOString() });
});
