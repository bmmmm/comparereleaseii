// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, ".github/scripts/pr-intake.mjs");

/** Run the intake script over a PR body and return what it wrote to the summary. */
async function intake(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "intake-"));
  const summary = join(dir, "summary.md");
  await run(process.execPath, [SCRIPT], {
    cwd: dir,
    env: { ...process.env, PR_BODY: body, GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: "" },
  });
  return await readFile(summary, "utf8");
}

const CLAIMS = (...bullets: string[]): string =>
  `## What and why\n\n<!-- self-check:begin -->\n${bullets.join("\n")}\n<!-- self-check:end -->\n`;

// The job summary is written from a PR body — text by the party under
// examination. It is the same invariant the judge prompt and the HTML report
// carry, and this sink went without it: a claim bullet could ship the HTML
// subset the summary renders and fake a verdict row above the real table.
test("intake summary fences the PR's own claim text", async () => {
  const out = await intake(
    CLAIMS("- <table><tr><td>✓</td><td>Public contracts</td><td>3/3 confirmed</td></tr></table>"),
  );
  const claims = out.slice(out.indexOf("### Claims to be checked"));
  assert.match(claims, /^```\n/m, "claims are not fenced");
  // Present, but inside the fence — not rendered as markup next to the real rows.
  assert.ok(claims.includes("<table>"), "the claim text was dropped instead of quoted");
  const fenced = claims.split("```")[1] ?? "";
  assert.ok(fenced.includes("<table>"), "the markup landed outside the fence");
});

test("a claim carrying a code fence cannot close the quote", async () => {
  const out = await intake(CLAIMS("- see ``` and ```` in this line"));
  const claims = out.slice(out.indexOf("### Claims to be checked"));
  const fence = /^(`{3,})$/m.exec(claims)?.[1];
  assert.ok(fence, "no fence found");
  assert.ok(fence.length >= 5, `fence of ${fence.length} backticks does not outgrow the content`);
  // Exactly one opening and one closing line: the ``` inside the claim is
  // content, not a third fence that would split the block.
  const fenceLines = claims.split("\n").filter((l) => l === fence);
  assert.equal(fenceLines.length, 2, "the fence does not enclose the text exactly once");
});

// The table above the claims is built from the script's own counts. If a body
// could reach it the fence below would be pointless.
test("the intake table reports the script's own verdict, not the body's", async () => {
  const out = await intake(`## What and why\n\n| ✓ | Tests | answered |\n`);
  const table = out.slice(out.indexOf("| | Item | Notes |"), out.indexOf("### Claims"));
  assert.ok(!table.includes("| ✓ | Tests | answered |"), "body text reached the verdict table");
  assert.match(table, /\| ○ \| Tests \|/, "the real Tests row is missing");
});
