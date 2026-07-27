// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeRelease, loadGithubReleaseData } from "../src/check.ts";
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

// The compare API truncating is the one case where check data switches source
// mid-load: diff and commits come from a clone while everything else stays
// API-shaped. The rewrite must say so, drop the stale truncation warning, and
// mark the author identities as unmatchable (git names vs API logins).
test("truncation fallback: clone replaces the diff, warnings rewritten, sources marked mixed", async () => {
  const calls: string[] = [];
  const truncated = releaseData();
  truncated.truncated = true;
  truncated.warnings.push("Compare API truncated the file list (300 of 612 files)");
  const { data } = await loadGithubReleaseData(
    "o/r",
    {},
    {
      loadGithubRelease: async () => truncated,
      fetchGithubContext: async () => CONTEXT,
      cloneDirFor: async (url) => {
        calls.push(`dir:${url}`);
        return "/tmp/fake-clone";
      },
      ensureClone: async (url, dir) => {
        calls.push(`clone:${url}:${dir}`);
      },
      loadLocalRange: async () => ({
        commits: [
          {
            sha: "a".repeat(40),
            subject: "s",
            body: "",
            author: "Jane Doe",
            email: "jane@example.com",
            prNumbers: [],
          },
        ],
        files: [{ path: "src/x.ts", status: "modified", additions: 2, deletions: 1 }],
        commitFiles: async () => [],
      }),
    },
  );
  assert.deepEqual(calls, [
    "dir:https://github.com/o/r.git",
    "clone:https://github.com/o/r.git:/tmp/fake-clone",
  ]);
  assert.equal(data.truncated, false);
  assert.equal(data.commits[0].author, "Jane Doe");
  // The clone carries the email — the cross-source identity key that lets
  // baselineFlags match these commits against an API-built baseline.
  assert.equal(data.commits[0].email, "jane@example.com");
  assert.ok(!data.warnings.some((w) => w.startsWith("Compare API")), "stale truncation warning kept");
  assert.ok(data.warnings.some((w) => w.includes("local partial clone")), "no fallback notice");
});

test("truncation fallback failing keeps the truncated data and says why", async () => {
  const truncated = releaseData();
  truncated.truncated = true;
  const { data } = await loadGithubReleaseData(
    "o/r",
    {},
    {
      loadGithubRelease: async () => truncated,
      fetchGithubContext: async () => CONTEXT,
      cloneDirFor: async () => "/tmp/fake-clone",
      ensureClone: async () => {
        throw new Error("git clone exploded");
      },
      loadLocalRange: async () => {
        throw new Error("unreachable");
      },
    },
  );
  assert.equal(data.truncated, true);
  const warning = data.warnings.find((w) => w.includes("Partial-clone fallback failed"));
  assert.ok(warning, `no failure warning in ${JSON.stringify(data.warnings)}`);
  assert.ok(warning.includes("git clone exploded"), `cause missing from: ${warning}`);
});
