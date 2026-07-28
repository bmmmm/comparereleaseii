// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  applyJudgeChoice,
  cronLine,
  expandHome,
  judgeOptions,
  launchdPlist,
  launchdRunner,
  scheduleSpec,
} from "../src/setup.ts";
import type { WatchRepoConfig } from "../src/watch.ts";

test("scheduleSpec: hours, minutes and daily; nonsense and sub-5m refused", () => {
  assert.deepEqual(scheduleSpec("6h"), { seconds: 21_600, cron: "17 */6 * * *" });
  assert.deepEqual(scheduleSpec("1h"), { seconds: 3600, cron: "17 * * * *" });
  assert.deepEqual(scheduleSpec("30m"), { seconds: 1800, cron: "*/30 * * * *" });
  assert.deepEqual(scheduleSpec("daily"), { seconds: 86_400, cron: "17 6 * * *" });
  assert.deepEqual(scheduleSpec("24h"), scheduleSpec("daily"));
  assert.deepEqual(scheduleSpec("60m"), scheduleSpec("1h"));
  // Under five minutes is polling, not watching; zero and prose are noise.
  assert.equal(scheduleSpec("3m"), null);
  assert.equal(scheduleSpec("0h"), null);
  assert.equal(scheduleSpec("25h"), null);
  assert.equal(scheduleSpec("whenever"), null);
  // Non-divisors would give cron a ragged schedule (`*/7` fires at :56 then
  // :00) that silently diverges from launchd's exact interval.
  assert.equal(scheduleSpec("7m"), null);
  assert.equal(scheduleSpec("7h"), null);
  assert.equal(scheduleSpec("13h"), null);
});

test("applyJudgeChoice clears the other mode's leftovers", () => {
  // An adopted config carrying judge:"off" from an earlier setup must not
  // silently disable the engine picked now — runWatch reads judge first.
  const defaults: Partial<WatchRepoConfig> = { judge: "off", notifyBelow: 50 };
  applyJudgeChoice(defaults, { engine: "claude-cli", note: "" });
  assert.deepEqual(defaults, { engine: "claude-cli", escalate: "auto", notifyBelow: 50 });

  // And the way back: picking off clears the engine trio.
  applyJudgeChoice(defaults, { engine: "off", note: "" });
  assert.deepEqual(defaults, { judge: "off", escalate: "auto", notifyBelow: 50 });

  // A local model's name means nothing to claude-cli/api.
  const local: Partial<WatchRepoConfig> = {
    engine: "openai",
    model: "qwen3.5",
    openaiUrl: "http://127.0.0.1:8010/v1",
  };
  applyJudgeChoice(local, { engine: "api", note: "" });
  assert.deepEqual(local, { engine: "api", escalate: "auto" });
});

test("expandHome expands the tilde a path prompt receives", () => {
  assert.equal(expandHome("~/release-watch"), join(homedir(), "release-watch"));
  assert.equal(expandHome("~"), homedir());
  assert.equal(expandHome("/opt/watch"), "/opt/watch");
  assert.equal(expandHome("not~home"), "not~home");
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

test("launchd plist: label, interval, log — the program is the named runner, nothing else", () => {
  const plist = launchdPlist({
    label: "comparereleaseii.watch.release-watch",
    program: "/Users/smith & jones/release-watch/comparereleaseii-watch",
    logPath: "/Users/smith & jones/release-watch/watch.log",
    seconds: 21_600,
  });
  assert.ok(
    plist.includes("<string>comparereleaseii.watch.release-watch</string>"),
    "label carries the home dir's name so two watch homes can coexist",
  );
  assert.ok(plist.includes("<integer>21600</integer>"), "interval carried");
  // The program IS the job's user-visible name (launchctl print, Background
  // Items) — a /bin/sh wrapper here would announce the watchdog as "sh".
  assert.ok(
    plist.includes(
      "<string>/Users/smith &amp; jones/release-watch/comparereleaseii-watch</string>",
    ),
    "runner is the program, xml-escaped",
  );
  assert.ok(!plist.includes("/bin/sh"), "no shell wrapper");
  assert.equal(plist.match(/<string>/g)!.length, 4, "label, program, two log paths — nothing else");
});

test("launchd runner: shebang, PATH prefix, exec line — hostile paths stay quoted", () => {
  const runner = launchdRunner({
    node: "/usr/local/bin/node",
    bin: "/Users/o'brien/comparereleaseii/bin/comparerelease.mjs",
    config: "/Users/o'brien/release-watch/watch.json",
  });
  assert.ok(runner.startsWith("#!/bin/sh\n"), "executable shell script");
  // launchd's bare environment knows neither gh nor a package-manager node;
  // the old `sh -l` route read ~/.profile, which zsh users don't have.
  assert.ok(runner.includes('PATH="$HOME/.local/bin:'), "PATH prefix carried by the script itself");
  assert.ok(runner.includes("exec '/usr/local/bin/node'"), "execs node directly");
  // The apostrophe must close-escape-reopen, or the path would end the quote.
  assert.ok(runner.includes("o'\\''brien"), "single quotes escaped for sh");
  assert.ok(runner.includes("watch --config"), "runs watch against the config");
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
