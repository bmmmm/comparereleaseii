// SPDX-License-Identifier: GPL-3.0-or-later
import { after, test } from "node:test";
import { tempDir } from "./temp-dir.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, readFile as readFileFs, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildSnapshots,
  cloneHistory,
  summarizeBaseline,
  type HistorySource,
  type ReleaseSnapshot,
} from "../src/history.ts";
import { changelogReleases } from "../src/sources/local.ts";

const exec = promisify(execFile);

// Snapshots are cached on disk, and a cache entry from another run would
// answer for code this test never called. Give the whole file its own root.
process.env.XDG_CACHE_HOME = await tempDir({ after }, "crii-history-cache-");

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
  const repo = await tempDir({ after }, "crii-history-");
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

test("changelogReleases is empty, not an error, without a CHANGELOG", async (t) => {
  const repo = await tempDir(t, "crii-history-bare-");
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
  // Identity keys are the git-header email, not the display name — that is
  // what lets an API-built baseline recognize clone-loaded commits.
  assert.deepEqual(snapshots[0].authors, ["test@example.invalid"]);
  // The identifier in the notes is in the diff — this is the deterministic
  // number the out-of-repo gate reads, and it has to survive the clone path.
  assert.equal(snapshots[0].lexicalCoverage, 1);
  // A clone attributes commits to no forge account — absent, not empty:
  // an empty map would read as "no linked account touched this".
  assert.equal(snapshots[0].emailAccounts, undefined);
});

test("API-built snapshots pair emails with accounts; clone-built ones stay silent", async () => {
  const commit = (email: string, login: string | null) => ({
    sha: "a".repeat(40),
    subject: "change",
    body: "",
    author: login ?? "Somebody",
    email,
    login,
    prNumbers: [],
  });
  const source: HistorySource = {
    cacheKey: "file:///history-logins",
    slug: "team/app",
    listReleases: async () => [
      { tag: "v2", notes: "", date: null },
      { tag: "v1", notes: "", date: null },
    ],
    // Jane's email is linked to her account; Bob commits with an address the
    // forge maps to no account — only the LINKED pairing is recorded, so a
    // never-linked email stays distinguishable from a broken pairing.
    loadRange: async () => ({
      commits: [commit("Jane@Example.invalid", "janedoe"), commit("bob@example.invalid", null)],
      files: [],
    }),
  };
  const snapshots = await buildSnapshots(source, { count: 5 });
  assert.deepEqual(snapshots[0].emailAccounts, { "jane@example.invalid": "janedoe" });
  const { summarizeBaseline } = await import("../src/history.ts");
  assert.deepEqual(summarizeBaseline(snapshots).emailAccounts, {
    "jane@example.invalid": "janedoe",
  });
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

test("a snapshot cached by a different tool version is rebuilt, not served", async () => {
  const { readdir, readFile: rf, writeFile: wf } = await import("node:fs/promises");
  const repo = await repoWithHistory();
  const source = cloneHistory({ dir: repo, slug: "team/app", cacheKey: "file:///history-version" });
  const first = await buildSnapshots(source, { count: 5 });
  assert.equal(first[0].lexicalCoverage, 1);

  // Corrupt the cached numbers and stamp them with another version — the
  // verdict cache learned this in 0.1.2; a formula change must not serve
  // stale medians here either.
  const dir = join(process.env.XDG_CACHE_HOME!, "comparereleaseii", "snapshots");
  const mine = (await readdir(dir)).filter((f) => f.startsWith("file_history-version"));
  assert.ok(mine.length >= 2, `expected cache files, got ${JSON.stringify(mine)}`);
  for (const f of mine) {
    const entry = JSON.parse(await rf(join(dir, f), "utf8"));
    entry.version = "0.0.1-other";
    entry.lexicalCoverage = 0.123;
    await wf(join(dir, f), JSON.stringify(entry));
  }
  const rebuilt = await buildSnapshots(source, { count: 5 });
  assert.notEqual(rebuilt[0].lexicalCoverage, 0.123, "stale cross-version snapshot was served");

  // Same numbers under the CURRENT version stay served — the cache still works.
  for (const f of mine) {
    const entry = JSON.parse(await rf(join(dir, f), "utf8"));
    entry.lexicalCoverage = 0.456;
    await wf(join(dir, f), JSON.stringify(entry));
  }
  const cached = await buildSnapshots(source, { count: 5 });
  assert.equal(cached[0].lexicalCoverage, 0.456, "same-version cache entry was not served");
});

const emptyRange = { commits: [], files: [] };

function fakeSource(
  cacheKey: string,
  tags: string[],
  loadRange: HistorySource["loadRange"] = async () => emptyRange,
  notes = "",
): HistorySource {
  return {
    cacheKey,
    slug: "team/app",
    listReleases: async () => tags.map((tag) => ({ tag, notes, date: null })),
    loadRange,
  };
}

function snap(over: Partial<ReleaseSnapshot>): ReleaseSnapshot {
  return {
    tag: "v1",
    base: "v0",
    date: null,
    commits: 0,
    files: 0,
    additions: 0,
    deletions: 0,
    claims: 0,
    anchoredCoverage: 1,
    lexicalCoverage: 1,
    sensitiveTouched: [],
    binaries: 0,
    newDeps: [],
    authors: [],
    ...over,
  };
}

test("a cached snapshot without lexical coverage is rebuilt even under the current version", async () => {
  let loads = 0;
  const source = fakeSource("test:history-nolex", ["v2", "v1"], async () => {
    loads++;
    return emptyRange;
  });
  await buildSnapshots(source, { count: 5 });
  assert.equal(loads, 1);
  await buildSnapshots(source, { count: 5 });
  assert.equal(loads, 1, "an intact entry of this version must be served");

  const dir = join(process.env.XDG_CACHE_HOME!, "comparereleaseii", "snapshots");
  const mine = (await readdir(dir)).filter((f) => f.includes("history-nolex"));
  assert.equal(mine.length, 1);
  const entry = JSON.parse(await readFileFs(join(dir, mine[0]), "utf8"));
  assert.equal(typeof entry.version, "string");
  delete entry.lexicalCoverage;
  await writeFile(join(dir, mine[0]), JSON.stringify(entry));
  await buildSnapshots(source, { count: 5 });
  assert.equal(loads, 2, "an entry that lost a field was served instead of rebuilt");
});

test("coverage ratios: empty ranges are fully anchored, claims that miss the diff score zero", async () => {
  const [empty] = await buildSnapshots(fakeSource("test:history-ratio-empty", ["v2", "v1"], undefined, "- Added `parseToken` to the API"), { count: 1 });
  assert.equal(empty.anchoredCoverage, 1, "no commits means nothing was left unanchored");
  assert.equal(empty.lexicalCoverage, 0, "a change claim with no diff to match is not covered");

  const [noClaims] = await buildSnapshots(fakeSource("test:history-ratio-none", ["v2", "v1"], undefined, ""), { count: 1 });
  assert.equal(noClaims.claims, 0);
  assert.equal(noClaims.lexicalCoverage, 1, "no change claims leaves nothing uncovered");

  const hit = async () => ({
    commits: [],
    files: [
      { path: "src/auth.ts", status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1,2 @@\n+export const parseToken = 1;\n" },
    ],
  });
  const [covered] = await buildSnapshots(fakeSource("test:history-ratio-hit", ["v2", "v1"], hit, "- Added `parseToken` to the API\n- Added `rotateKey` for rotation"), { count: 1 });
  assert.equal(covered.lexicalCoverage, 0.5, "one of two change claims appears in the diff");
});

test("a baseline stops at the number of past releases asked for", async () => {
  const source = fakeSource("test:history-count", ["v5", "v4", "v3", "v2", "v1"]);
  const two = await buildSnapshots(source, { count: 2 });
  assert.deepEqual(two.map((s) => s.tag), ["v5", "v4"]);
  assert.deepEqual(await buildSnapshots(source, { count: 0 }), []);
});

test("baseline medians average the two middle values of an even history", () => {
  const even = summarizeBaseline([
    snap({ additions: 10, deletions: 0, lexicalCoverage: 0.2 }),
    snap({ additions: 30, deletions: 10, lexicalCoverage: 0.6 }),
  ]);
  assert.equal(even.medianChurn, 25);
  assert.equal(even.medianLexicalCoverage, 0.4);
  const odd = summarizeBaseline([
    snap({ additions: 5 }),
    snap({ additions: 100 }),
    snap({ additions: 7 }),
  ]);
  assert.equal(odd.medianChurn, 7);
  assert.equal(summarizeBaseline([]).medianChurn, 0);
});

test("a baseline has shipped a binary only when some snapshot did", () => {
  assert.equal(summarizeBaseline([snap({ binaries: 0 }), snap({ binaries: 0 })]).everBinary, false);
  assert.equal(summarizeBaseline([snap({ binaries: 0 }), snap({ binaries: 2 })]).everBinary, true);
  assert.equal(summarizeBaseline([]).everBinary, false);
});

test("the newest snapshot wins when an email moved between accounts", () => {
  const baseline = summarizeBaseline([
    snap({ tag: "newest", emailAccounts: { "a@example.invalid": "new-login", "b@example.invalid": "only-new" } }),
    snap({ tag: "older", emailAccounts: { "a@example.invalid": "old-login", "c@example.invalid": "only-old" } }),
  ]);
  assert.deepEqual(baseline.emailAccounts, {
    "a@example.invalid": "new-login",
    "b@example.invalid": "only-new",
    "c@example.invalid": "only-old",
  });
});
