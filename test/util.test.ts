// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractMarkdownSection } from "../src/util.ts";

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
