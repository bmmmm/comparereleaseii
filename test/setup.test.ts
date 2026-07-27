// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { cronLine, judgeOptions, launchdPlist, scheduleSpec } from "../src/setup.ts";

test("scheduleSpec: hours, minutes and daily; nonsense and sub-5m refused", () => {
  assert.deepEqual(scheduleSpec("6h"), { seconds: 21_600, cron: "17 */6 * * *" });
  assert.deepEqual(scheduleSpec("1h"), { seconds: 3600, cron: "17 * * * *" });
  assert.deepEqual(scheduleSpec("30m"), { seconds: 1800, cron: "*/30 * * * *" });
  assert.deepEqual(scheduleSpec("daily"), { seconds: 86_400, cron: "17 6 * * *" });
  assert.deepEqual(scheduleSpec("24h"), scheduleSpec("daily"));
  // Under five minutes is polling, not watching; zero and prose are noise.
  assert.equal(scheduleSpec("3m"), null);
  assert.equal(scheduleSpec("0h"), null);
  assert.equal(scheduleSpec("25h"), null);
  assert.equal(scheduleSpec("whenever"), null);
});

test("judgeOptions: what the machine offers, best first, off always last", () => {
  const all = judgeOptions({
    hasClaude: true,
    env: { ANTHROPIC_API_KEY: "k", OPENAI_BASE_URL: "http://127.0.0.1:8010/v1" },
  });
  assert.deepEqual(
    all.map((o) => o.engine),
    ["claude-cli", "api", "openai", "off"],
  );
  assert.equal(all[2].openaiUrl, "http://127.0.0.1:8010/v1");
  // A bare machine still gets the deterministic path.
  const bare = judgeOptions({ hasClaude: false, env: {} });
  assert.deepEqual(bare.map((o) => o.engine), ["off"]);
});

test("launchd plist: sh -lc command, interval, log — hostile paths stay quoted", () => {
  const plist = launchdPlist({
    node: "/usr/local/bin/node",
    bin: "/Users/o'brien/comparereleaseii/bin/comparerelease.mjs",
    config: "/Users/o'brien/release-watch/watch.json",
    logPath: "/Users/o'brien/release-watch/watch.log",
    seconds: 21_600,
  });
  assert.ok(plist.includes("<integer>21600</integer>"), "interval carried");
  assert.ok(plist.includes("<string>/bin/sh</string><string>-lc</string>"), "login shell for PATH");
  // The apostrophe must close-escape-reopen, or the path would end the quote.
  assert.ok(plist.includes("o'\\''brien"), "single quotes escaped for sh");
  assert.ok(!/<string>[^<]*'[^\\]/.test(plist.split("ProgramArguments")[0]), "label stays clean");
  assert.ok(plist.includes("watch --config"), "runs watch against the config");
});

test("cron line: schedule, PATH prefix, quoted paths, log redirect", () => {
  const line = cronLine({
    node: "/usr/bin/node",
    bin: "/srv/comparereleaseii/bin/comparerelease.mjs",
    config: "/srv/release-watch/watch.json",
    logPath: "/srv/release-watch/watch.log",
    cron: "17 */6 * * *",
  });
  assert.ok(line.startsWith("17 */6 * * * "), "cron expression first");
  assert.ok(line.includes('PATH="$HOME/.local/bin:'), "PATH prefix for cron's bare environment");
  assert.ok(line.includes("'/srv/release-watch/watch.json'"), "config quoted");
  assert.ok(line.endsWith(">> '/srv/release-watch/watch.log' 2>&1"), "log redirect last");
});
