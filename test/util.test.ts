// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractMarkdownSection, run } from "../src/util.ts";

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
