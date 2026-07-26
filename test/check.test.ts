// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeRelease } from "../src/check.ts";
import type { ReleaseData, RepoContext } from "../src/types.ts";

const CONTEXT: RepoContext = { languages: null, codeBytes: null, releaseCadenceDays: null };

function releaseData(): ReleaseData {
  return {
    repoLabel: "o/r",
    baseRef: "v1.0.0",
    headRef: "v1.1.0",
    notes: "- Fixed the `frobnicate` parser (#1)\n",
    commits: [],
    files: [],
    commitFiles: async () => [],
    warnings: [],
  };
}

// A baseline that fails wholesale (release listing down, not one snapshot)
// used to vanish through a bare `.catch(() => null)` — the report then looked
// identical to "repo has too few releases". The failure must be on the record.
test("a baseline failing wholesale surfaces as a report warning", async () => {
  const report = await analyzeRelease(releaseData(), CONTEXT, null, {
    judgeMode: "off",
    engine: null,
    escalateEngine: null,
    concurrency: 1,
    reverse: false,
    baseline: 5,
    history: {
      cacheKey: "test:o/r",
      slug: "o/r",
      listReleases: async () => {
        throw new Error("gh api exploded");
      },
      loadRange: async () => ({ commits: [], files: [] }),
    },
  });
  assert.equal(report.metrics.baseline, null);
  const warning = report.warnings.find((w) => w.includes("Baseline unavailable"));
  assert.ok(warning, `no baseline warning in ${JSON.stringify(report.warnings)}`);
  assert.ok(warning.includes("gh api exploded"), `cause missing from: ${warning}`);
});
