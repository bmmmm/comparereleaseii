// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyzeRelease,
  loadForgeRelease,
  loadGithubReleaseData,
  type ForgeTarget,
} from "../src/check.ts";
import { cloneHistory } from "../src/history.ts";
import type { ForgeListing } from "../src/sources/forge.ts";
import type { ReleaseData, RepoContext } from "../src/types.ts";

const exec = promisify(execFile);

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

/** A two-release repo with tags and a CHANGELOG — a stand-in for any forge clone. */
async function taggedRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "crii-forge-"));
  const git = (...args: string[]) => exec("git", ["-C", repo, ...args]);
  await git("init", "-q");
  await git("config", "user.email", "test@example.invalid");
  await git("config", "user.name", "test");
  await writeFile(
    join(repo, "CHANGELOG.md"),
    "# Changelog\n\n## v1.1.0\n\n- Changelog wording of `beta`\n\n## v1.0.0\n\n- Changelog wording of `alpha`\n",
  );
  await writeFile(join(repo, "alpha.txt"), "alpha\n");
  await git("add", "-A");
  await git("commit", "-q", "-m", "add alpha");
  await git("tag", "v1.0.0");
  await writeFile(join(repo, "beta.txt"), "beta\n");
  await git("add", "-A");
  await git("commit", "-q", "-m", "add beta");
  await git("tag", "v1.1.0");
  return repo;
}

function forgeTarget(dir: string, forge: ForgeListing | null): ForgeTarget {
  const releases = forge
    ? forge.releases
        .filter((r) => !r.draft && !r.prerelease)
        .map((r) => ({ tag: r.tag_name, notes: r.body, date: r.published_at?.slice(0, 10) ?? null }))
    : undefined;
  return {
    url: "https://forge.example/owner/app",
    dir,
    slug: "owner/app",
    origin: "https://forge.example",
    link: { base: "https://forge.example/owner/app", style: "github" },
    forge,
    releases,
    history: cloneHistory({
      dir,
      slug: "owner/app",
      cacheKey: "https://forge.example/owner/app",
      releases,
    }),
  };
}

const FORGE: ForgeListing = {
  kind: "forgejo",
  releases: [
    {
      tag_name: "v1.1.0",
      name: "v1.1.0",
      body: "- Published notes for `beta`",
      draft: false,
      prerelease: false,
      published_at: "2026-07-20T00:00:00Z",
    },
    {
      tag_name: "v1.0.0",
      name: "v1.0.0",
      body: "- Published notes for `alpha`",
      draft: false,
      prerelease: false,
      published_at: "2026-07-01T00:00:00Z",
    },
  ],
};

test("loadForgeRelease: published notes, the forge's base pick, and its base notes", async () => {
  const repo = await taggedRepo();
  const { data, context } = await loadForgeRelease(forgeTarget(repo, FORGE), { head: "v1.1.0" });
  assert.equal(data.repoLabel, "owner/app");
  assert.equal(data.headRef, "v1.1.0");
  assert.equal(data.baseRef, "v1.0.0", "base comes from the forge's release order");
  assert.equal(data.notes, "- Published notes for `beta`", "notes come from the API, not the CHANGELOG");
  assert.equal(data.baseNotes, "- Published notes for `alpha`", "base notes ride along from the same list");
  assert.equal(data.commits.length, 1);
  assert.ok(context, "repo context loaded from the clone");
});

test("loadForgeRelease without a head checks the newest stable release", async () => {
  const repo = await taggedRepo();
  const { data } = await loadForgeRelease(forgeTarget(repo, FORGE), {});
  assert.equal(data.headRef, "v1.1.0");
  assert.equal(data.notes, "- Published notes for `beta`");
});

test("loadForgeRelease: a tag the forge never published falls back to the CHANGELOG", async () => {
  const repo = await taggedRepo();
  const onlyOld: ForgeListing = { kind: "forgejo", releases: [FORGE.releases[1]] };
  const { data } = await loadForgeRelease(forgeTarget(repo, onlyOld), { head: "v1.1.0" });
  assert.equal(data.notes, "- Changelog wording of `beta`");
  // Media never mix: CHANGELOG head notes take CHANGELOG base notes.
  assert.equal(data.baseNotes, "- Changelog wording of `alpha`");
});
