// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tempDir } from "./temp-dir.ts";
import {
  commandExists,
  esc,
  extractMarkdownSection,
  pooled,
  run,
  runNotify,
  truncate,
  writeJsonAtomic,
} from "../src/util.ts";

test("extractMarkdownSection returns the body between one heading and the next of equal-or-higher level", () => {
  const md = [
    "# Title",
    "",
    "intro text",
    "",
    "## Section A",
    "",
    "a body line 1",
    "a body line 2",
    "",
    "### A subsection stays inside A",
    "",
    "still a",
    "",
    "## Section B",
    "",
    "b body",
  ].join("\n");
  assert.equal(
    extractMarkdownSection(md, "Section A"),
    "a body line 1\na body line 2\n\n### A subsection stays inside A\n\nstill a",
  );
  assert.equal(extractMarkdownSection(md, "Section B"), "b body");
});

test("extractMarkdownSection returns null for a heading that doesn't exist", () => {
  assert.equal(extractMarkdownSection("# Title\n\ntext", "Missing"), null);
});

test("extractMarkdownSection matches heading text exactly, not as a substring", () => {
  const md = "## Section A extended\n\nwrong one\n\n## Section A\n\nright one";
  assert.equal(extractMarkdownSection(md, "Section A"), "right one");
});

test("extractMarkdownSection ignores # lines inside fenced code blocks", () => {
  const md = [
    "## Section A",
    "",
    "before the fence",
    "",
    "```bash",
    "# a shell comment, not a heading",
    "echo hi",
    "```",
    "",
    "after the fence",
    "",
    "## Section B",
    "",
    "b body",
  ].join("\n");
  const section = extractMarkdownSection(md, "Section A");
  assert.ok(section?.includes("after the fence"), `section was cut at the fence: ${JSON.stringify(section)}`);
});

// The child dying before it drains stdin (a claude CLI that errors at startup
// while a 20k-char judge prompt is being piped in) must reject through the
// promise, not crash the whole process with an unhandled 'error' event.
test("run() rejects instead of crashing when the child exits without reading a large stdin", async () => {
  await assert.rejects(
    run("false", [], { input: "x".repeat(10 * 1024 * 1024) }),
    /failed/,
  );
});

// The 64 MB ceiling is a decision, not an accident (kernel-scale releases
// are out of scope) — so overflowing it must name the cap and the way out,
// never blame the child process.
test("run() names the parse cap and --base when output exceeds maxBuffer", async () => {
  await assert.rejects(
    run("node", ["-e", "process.stdout.write('x'.repeat(2 * 1024 * 1024))"], {
      maxBuffer: 1024 * 1024,
    }),
    /1 MB.*--base/s,
  );
});

// Mutation-guard tests: each pins one decision in util.ts that a plain
// happy-path call would not notice moving.

test("commandExists needs the execute bit and skips an empty PATH entry", async (t) => {
  const dir = await tempDir(t, "crii-cmd-");
  await writeFile(join(dir, "crii-tool"), "#!/bin/sh\n", { mode: 0o755 });
  await writeFile(join(dir, "crii-plain"), "data\n", { mode: 0o644 });
  const savedPath = process.env.PATH;
  const savedCwd = process.cwd();
  try {
    process.env.PATH = dir;
    assert.equal(await commandExists("crii-tool"), true);
    assert.equal(await commandExists("crii-plain"), false, "present but not executable");
    // An empty entry would join to the bare name, i.e. the current directory.
    process.env.PATH = "";
    process.chdir(dir);
    assert.equal(await commandExists("crii-tool"), false);
  } finally {
    process.chdir(savedCwd);
    process.env.PATH = savedPath;
  }
});

test("truncate leaves a text of exactly maxChars alone", () => {
  assert.equal(truncate("abcde", 5), "abcde");
  assert.equal(truncate("abcdef", 5), "abcde\n… [truncated 1 chars]");
});

test("pooled never runs more than limit tasks at once and keeps result order", async () => {
  let inFlight = 0;
  let peak = 0;
  const out = await pooled([0, 1, 2, 3, 4, 5], 2, async (n) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setImmediate(r));
    inFlight--;
    return n * 10;
  });
  assert.equal(peak, 2);
  assert.deepEqual(out, [0, 10, 20, 30, 40, 50]);
});

test("esc escapes the ampersand first and neutralises a double quote", () => {
  assert.equal(esc("&lt;"), "&amp;lt;");
  assert.equal(esc('x" onmouseover="y'), "x&quot; onmouseover=&quot;y");
  assert.equal(esc("it's <b>"), "it&#39;s &lt;b&gt;");
});

test("runNotify reports the command's failure and passes the path as one argument", async (t) => {
  const dir = await tempDir(t, "crii-notify-");
  const report = join(dir, "a report.json");
  await writeFile(report, "{}");
  const realError = console.error;
  const warnings: string[] = [];
  console.error = (...args: unknown[]) => void warnings.push(args.join(" "));
  try {
    assert.equal(await runNotify("test -f", report), true, "a path with a space stays one argument");
    assert.equal(await runNotify("false", report), false);
  } finally {
    console.error = realError;
  }
  assert.match(warnings.join("\n"), /notify command exited with 1/);
});

test("writeJsonAtomic adds a trailing newline only when asked and leaves no sibling behind", async (t) => {
  const dir = await tempDir(t, "crii-json-");
  const plain = join(dir, "deep", "er", "plain.json");
  await writeJsonAtomic(plain, { a: 1 });
  assert.equal(await readFile(plain, "utf8"), '{\n  "a": 1\n}');
  const nl = join(dir, "nl.json");
  await writeJsonAtomic(nl, { a: 1 }, true);
  assert.equal(await readFile(nl, "utf8"), '{\n  "a": 1\n}\n');
  assert.deepEqual((await readdir(dir)).sort(), ["deep", "nl.json"]);
});
