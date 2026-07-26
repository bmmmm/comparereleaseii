// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { suggestNotes } from "../src/suggest.ts";
import { parseSuggestOutput } from "../src/judge.ts";
import type { Commit, DiffFile, ReleaseData, UncoveredCommit } from "../src/types.ts";

function uncovered(sha: string, subject: string, files: DiffFile[]): UncoveredCommit {
  const commit: Commit = { sha, subject, body: "", author: "dev", prNumbers: [] };
  return { commit, additions: 3, deletions: 0, fileCount: files.length };
}

function dataWithFiles(byFiles: Record<string, DiffFile[]>): ReleaseData {
  return {
    repoLabel: "t/t",
    baseRef: "v1",
    headRef: "v2",
    notes: "",
    commits: [],
    files: [],
    commitFiles: async (sha: string) => byFiles[sha] ?? [],
    warnings: [],
  };
}

test("parseSuggestOutput extracts and caps the suggestion", () => {
  assert.equal(parseSuggestOutput('{"suggestion":"Add token validation to auth check"}'), "Add token validation to auth check");
  assert.equal(parseSuggestOutput('{"suggestion":""}'), "");
  assert.equal(parseSuggestOutput('{"suggestion":"' + "x".repeat(400) + '"}').length, 300);
});

test("suggestNotes drafts only the top-N uncovered commits, highest churn first", async () => {
  const files = [{ path: "src/auth.rs", status: "modified", additions: 2, deletions: 0, patch: "@@ -1 +1,2 @@ fn f()\n+validate();\n" }];
  const data = dataWithFiles({ a: files, b: files, c: files });
  const targets = [uncovered("a", "Add validation", files), uncovered("b", "Second", files), uncovered("c", "Third", files)];
  let calls = 0;
  const engine = {
    name: "stub",
    judge: async () => {
      calls++;
      return '{"suggestion":"Adds token validation to the auth check."}';
    },
  };
  const result = await suggestNotes(data, targets, { engine, concurrency: 2, limit: 2, maxEvidenceChars: 4000 });
  assert.equal(calls, 2);
  assert.equal(result[0].suggestedNote, "Adds token validation to the auth check.");
  assert.equal(result[1].suggestedNote, "Adds token validation to the auth check.");
  assert.equal(result[2].suggestedNote, undefined);
});

test("suggestNotes leaves a commit as-is when it has no diff or the judge fails", async () => {
  const data = dataWithFiles({ empty: [] });
  const engine = { name: "stub", judge: async () => { throw new Error("down"); } };
  const [result] = await suggestNotes(data, [uncovered("empty", "No diff available", [])], {
    engine,
    concurrency: 1,
    limit: 5,
    maxEvidenceChars: 4000,
  });
  assert.equal(result.suggestedNote, undefined);
});
