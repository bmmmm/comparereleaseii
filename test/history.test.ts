// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSnapshots, cloneHistory, type HistorySource } from "../src/history.ts";
import { changelogReleases } from "../src/sources/local.ts";

const exec = promisify(execFile);

// Snapshots are cached on disk, and a cache entry from another run would
// answer for code this test never called. Give the whole file its own root.
process.env.XDG_CACHE_HOME = await mkdtemp(join(tmpdir(), "crii-history-cache-"));

const CHANGELOG = `# Changelog

## 1.2.0

- Added \`rotateKey\` for scheduled rotation

## 1.1.0

- Added \`parseToken\` to the public API

## 1.0.0

- First release
`;

/**
 * A repo with three documented releases, one prerelease tag and one tag the
 * CHANGELOG says nothing about. Commit dates are pinned: tags sort by
 * creatordate, and two commits in the same second would tie.
 */
async function repoWithHistory(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "crii-history-"));
  const at = (month: number) => {
    const iso = `2026-0${month}-01T12:00:00Z`;
    return { env: { ...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso } };
  };
  const git = (args: string[], month?: number) =>
    exec("git", ["-C", repo, ...args], month ? at(month) : undefined);

  await git(["init", "-q"]);
  await git(["config", "user.email", "test@example.invalid"]);
  await git(["config", "user.name", "test"]);
  await writeFile(join(repo, "CHANGELOG.md"), CHANGELOG);
  await writeFile(join(repo, "app.ts"), "export const boot = () => 0;\n");
  await git(["add", "."]);
  await git(["commit", "-q", "-m", "First release"], 1);
  await git(["tag", "1.0.0"]);

  await writeFile(join(repo, "app.ts"), "export const boot = () => 0;\nexport const parseToken = () => 1;\n");
  await git(["commit", "-qam", "Add parseToken"], 2);
  await git(["tag", "1.1.0"]);

  await writeFile(
    join(repo, "app.ts"),
    "export const boot = () => 0;\nexport const parseToken = () => 1;\nexport const rotateKey = () => 2;\n",
  );
  await git(["commit", "-qam", "Add rotateKey"], 3);
  await git(["tag", "1.2.0-rc1"]);
  await git(["tag", "1.2.0"]);
  await git(["tag", "nightly-2026-03"]);
  return repo;
}

test("changelogReleases reads the release list a clone can see on its own", async () => {
  const repo = await repoWithHistory();
  const releases = await changelogReleases(repo);

  // Newest first, prerelease tags dropped, and a tag the CHANGELOG does not
  // document is not a release — it is a tag.
  assert.deepEqual(releases.map((r) => r.tag), ["1.2.0", "1.1.0", "1.0.0"]);
  assert.match(releases[0].notes, /rotateKey/);
  assert.ok(!releases[0].notes.includes("parseToken"), "only this release's section");
  assert.deepEqual(releases.map((r) => r.date), ["2026-03-01", "2026-02-01", "2026-01-01"]);
});

test("changelogReleases is empty, not an error, without a CHANGELOG", async () => {
  const repo = await mkdtemp(join(tmpdir(), "crii-history-bare-"));
  await exec("git", ["-C", repo, "init", "-q"]);
  assert.deepEqual(await changelogReleases(repo), []);
});

test("a baseline builds out of a clone, with no forge API in reach", async () => {
  const repo = await repoWithHistory();
  const snapshots = await buildSnapshots(
    cloneHistory({ dir: repo, slug: "team/app", cacheKey: "file:///history-test" }),
    { count: 5 },
  );

  // Three releases make two consecutive pairs; the oldest has nothing before it.
  assert.deepEqual(snapshots.map((s) => s.tag), ["1.2.0", "1.1.0"]);
  assert.deepEqual(snapshots.map((s) => s.base), ["1.1.0", "1.0.0"]);
  assert.equal(snapshots[0].commits, 1);
  assert.deepEqual(snapshots[0].authors, ["test"]);
  // The identifier in the notes is in the diff — this is the deterministic
  // number the out-of-repo gate reads, and it has to survive the clone path.
  assert.equal(snapshots[0].lexicalCoverage, 1);
});

test("`before` restricts the baseline to releases older than the one under test", async () => {
  const repo = await repoWithHistory();
  const snapshots = await buildSnapshots(
    cloneHistory({ dir: repo, slug: "team/app", cacheKey: "file:///history-before" }),
    { count: 5, before: "1.2.0" },
  );
  assert.deepEqual(snapshots.map((s) => s.tag), ["1.1.0"]);
});

test("a forge release list outranks the CHANGELOG the clone happens to carry", async () => {
  const repo = await repoWithHistory();
  const snapshots = await buildSnapshots(
    cloneHistory({
      dir: repo,
      slug: "team/app",
      cacheKey: "file:///history-forge",
      releases: [
        { tag: "1.2.0", notes: "- Nothing here matches the diff at all", date: "2026-03-02" },
        { tag: "1.1.0", notes: "- Added `parseToken` to the public API", date: "2026-02-02" },
      ],
    }),
    { count: 5 },
  );

  assert.deepEqual(snapshots.map((s) => s.tag), ["1.2.0"]);
  // Published notes were used, not the CHANGELOG section for the same tag —
  // which does name an identifier that is in the diff.
  assert.equal(snapshots[0].lexicalCoverage, 0);
  assert.equal(snapshots[0].date, "2026-03-02");
});

test("one release the source cannot answer for does not cost the whole baseline", async () => {
  // A clone makes this ordinary: a tag the last fetch never got, or a range
  // whose blobs the promisor remote refuses. It used to throw all the way up
  // into a `.catch(() => null)` at the call site — no baseline, nothing said.
  const source: HistorySource = {
    cacheKey: "file:///history-partial",
    slug: "team/app",
    listReleases: async () => [
      { tag: "v3", notes: "- newest", date: null },
      { tag: "v2", notes: "- middle", date: null },
      { tag: "v1", notes: "- oldest", date: null },
    ],
    loadRange: async (_base, head) => {
      if (head === "v3") throw new Error("could not fetch v3 from promisor remote");
      return { commits: [], files: [] };
    },
  };

  const snapshots = await buildSnapshots(source, { count: 5 });
  assert.deepEqual(snapshots.map((s) => s.tag), ["v2"]);
});
