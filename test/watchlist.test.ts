// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseSelection,
  mergeCandidates,
  addRepos,
  addRepoUrl,
  removeRepo,
  loadConfig,
  requireConfig,
  saveConfig,
  type RepoCandidate,
} from "../src/watchlist.ts";
import type { WatchConfig } from "../src/watch-state.ts";

function cand(repo: string, extra: Partial<RepoCandidate> = {}): RepoCandidate {
  return {
    repo,
    source: "watched",
    pushedAt: "2026-07-01T00:00:00Z",
    archived: false,
    description: null,
    ...extra,
  };
}

test("parseSelection: single numbers, ranges and combinations", () => {
  assert.deepEqual(parseSelection("3", 5), [3]);
  assert.deepEqual(parseSelection("1,3-5", 5), [1, 3, 4, 5]);
  assert.deepEqual(parseSelection(" 2 , 4 ", 5), [2, 4]);
  assert.deepEqual(parseSelection("2,2,2-3", 5), [2, 3]);
});

test("parseSelection: 'a' and 'all' select everything", () => {
  assert.deepEqual(parseSelection("a", 3), [1, 2, 3]);
  assert.deepEqual(parseSelection("ALL", 2), [1, 2]);
});

test("parseSelection: rejects out-of-range, inverted and garbage input", () => {
  assert.equal(parseSelection("0", 5), null);
  assert.equal(parseSelection("6", 5), null);
  assert.equal(parseSelection("4-2", 5), null);
  assert.equal(parseSelection("1-9", 5), null);
  assert.equal(parseSelection("x", 5), null);
  assert.equal(parseSelection("1;2", 5), null);
  assert.equal(parseSelection("", 5), null);
});

test("mergeCandidates: dedupes by repo, first source wins", () => {
  const { candidates } = mergeCandidates([
    [cand("a/x", { source: "watched" })],
    [cand("a/x", { source: "starred" }), cand("b/y", { source: "starred" })],
  ]);
  assert.deepEqual(
    candidates.map((c) => `${c.repo}:${c.source}`).sort(),
    ["a/x:watched", "b/y:starred"],
  );
});

test("mergeCandidates: drops archived repos and counts them once", () => {
  const { candidates, archivedDropped } = mergeCandidates([
    [cand("a/x", { archived: true })],
    [cand("a/x", { archived: true }), cand("b/y")],
  ]);
  assert.deepEqual(candidates.map((c) => c.repo), ["b/y"]);
  assert.equal(archivedDropped, 1);
});

test("mergeCandidates: sorts by pushedAt desc, null activity last", () => {
  const { candidates } = mergeCandidates([
    [
      cand("old/one", { pushedAt: "2024-01-01T00:00:00Z" }),
      cand("no/date", { pushedAt: null }),
      cand("new/one", { pushedAt: "2026-07-01T00:00:00Z" }),
    ],
  ]);
  assert.deepEqual(
    candidates.map((c) => c.repo),
    ["new/one", "old/one", "no/date"],
  );
});

test("addRepos: appends new repos, skips existing ones", () => {
  const config: WatchConfig = { repos: [{ repo: "a/x" }] };
  const { added, skipped } = addRepos(config, ["a/x", "b/y"]);
  assert.deepEqual(added, ["b/y"]);
  assert.deepEqual(skipped, ["a/x"]);
  assert.deepEqual(config.repos.map((r) => r.repo), ["a/x", "b/y"]);
});

test("addRepos: does not disturb entries with per-repo options", () => {
  const config: WatchConfig = {
    repos: [{ repo: "a/x", notesFile: "notes.md", label: "draft" }],
  };
  addRepos(config, ["b/y"]);
  assert.deepEqual(config.repos[0], { repo: "a/x", notesFile: "notes.md", label: "draft" });
});

test("removeRepo: removes every entry for the repo, reports the count", () => {
  const config: WatchConfig = {
    repos: [{ repo: "a/x" }, { repo: "a/x", label: "draft" }, { repo: "b/y" }],
  };
  assert.equal(removeRepo(config, "a/x"), 2);
  assert.deepEqual(config.repos.map((r) => r.repo), ["b/y"]);
  assert.equal(removeRepo(config, "c/z"), 0);
});

test("config round-trip: unknown top-level keys survive an add", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wl-"));
  const path = join(dir, "watch.json");
  await writeFile(
    path,
    JSON.stringify({
      notify: "ntfy publish releases",
      defaults: { engine: "openai", notifyBelow: 70 },
      repos: [{ repo: "a/x", notesFile: "notes.md" }],
    }),
  );
  const { config, existed } = await loadConfig(path);
  assert.equal(existed, true);
  addRepos(config, ["b/y"]);
  await saveConfig(path, config);
  const written = JSON.parse(await readFile(path, "utf8"));
  assert.equal(written.notify, "ntfy publish releases");
  assert.deepEqual(written.defaults, { engine: "openai", notifyBelow: 70 });
  assert.deepEqual(written.repos, [{ repo: "a/x", notesFile: "notes.md" }, { repo: "b/y" }]);
});

test("loadConfig: missing file yields an empty config, existed=false", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wl-"));
  const { config, existed } = await loadConfig(join(dir, "nope.json"));
  assert.equal(existed, false);
  assert.deepEqual(config.repos, []);
});

test("loadConfig: broken JSON names the file in the error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wl-"));
  const path = join(dir, "watch.json");
  await writeFile(path, '{ "repos": [ }');
  await assert.rejects(loadConfig(path), (err: Error) => {
    assert.match(err.message, /not valid JSON/);
    assert.ok(err.message.includes(path));
    return true;
  });
});

test("loadConfig: rejects non-object configs and non-array repos instead of coercing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wl-"));
  for (const bad of ['["a/x"]', "null", '"hello"', '{ "repos": { "a/x": {} } }']) {
    const path = join(dir, "bad.json");
    await writeFile(path, bad);
    await assert.rejects(loadConfig(path), /not a watch config/);
  }
});

test("requireConfig: a run needs a config that exists, and one shaped like a config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wl-"));
  // loadConfig tolerates a missing file — `watch add` creates one. A run does
  // not: it has nothing to do, and the message has to say where to look.
  await assert.rejects(
    requireConfig(join(dir, "absent.json")),
    /no such file.*docs\/watchdog\.md/,
  );
  const bad = join(dir, "bad.json");
  await writeFile(bad, '["a/x"]');
  await assert.rejects(requireConfig(bad), /not a watch config/);
  const good = join(dir, "good.json");
  await writeFile(good, '{"repos":[{"repo":"a/x"}]}');
  assert.deepEqual((await requireConfig(good)).repos, [{ repo: "a/x" }]);
});

test("loadConfig: missing repos key becomes an empty array, keys survive", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wl-"));
  const path = join(dir, "watch.json");
  await writeFile(path, '{ "notify": "cmd" }');
  const { config } = await loadConfig(path);
  assert.deepEqual(config.repos, []);
  assert.equal(config.notify, "cmd");
});

test("addRepoUrl dedupes on the URL; removeRepo drops URL entries by URL", () => {
  const config: WatchConfig = { repos: [{ repo: "o/r" }] };
  assert.equal(addRepoUrl(config, "https://gitea.com/gitea/tea"), true);
  assert.equal(addRepoUrl(config, "https://gitea.com/gitea/tea"), false);
  assert.deepEqual(config.repos, [{ repo: "o/r" }, { repoUrl: "https://gitea.com/gitea/tea" }]);
  // A GitHub slug never collides with a URL entry, and vice versa.
  assert.equal(removeRepo(config, "https://gitea.com/gitea/tea"), 1);
  assert.equal(removeRepo(config, "o/r"), 1);
  assert.equal(config.repos.length, 0);
});

test("URL spellings normalize: .git and trailing slash are the same repo", () => {
  // Exact-string dedupe stored the same repository twice — two state keys,
  // two report directories, one repo — and `remove <url>/` removed nothing
  // while claiming idempotence.
  const config: WatchConfig = { repos: [] };
  assert.equal(addRepoUrl(config, "https://gitea.com/gitea/tea"), true);
  assert.equal(addRepoUrl(config, "https://gitea.com/gitea/tea.git"), false);
  assert.equal(addRepoUrl(config, "https://gitea.com/gitea/tea/"), false);
  assert.equal(config.repos.length, 1);
  assert.equal(removeRepo(config, "https://gitea.com/gitea/tea.git"), 1);
  assert.equal(config.repos.length, 0);
});
