// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadGuidelines } from "../src/guidelines.ts";

// Regression guard: if docs/writing-release-notes.md's agent-section heading
// ever gets renamed without updating guidelines.ts, this catches it — the
// same way the checker itself catches drift between prose and reality.
test("loadGuidelines extracts the agent checklist from the real docs file", async () => {
  const short = await loadGuidelines({ full: false });
  assert.ok(short.includes("AGENTS.md"));
  assert.ok(short.includes("comparerelease guidelines"));
  assert.ok(!short.startsWith("#"), "extracted section should not include the file's own H1");
});

test("loadGuidelines --full returns the entire guide, including the H1", async () => {
  const full = await loadGuidelines({ full: true });
  assert.ok(full.startsWith("# Writing release notes that hold up"));
  assert.ok(full.includes("Rules for AI coding agents"));
});
