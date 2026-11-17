// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import { tempDir } from "./temp-dir.ts";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  parseSelection,
  mergeCandidates,
  addRepos,
  addRepoUrl,
  removeRepo,
  loadConfig,
  REPO_RE,
  runWatchAdd,
  runWatchList,
  runWatchRemove,
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

test("config round-trip: unknown top-level keys survive an add", async (t) => {
  const dir = await tempDir(t, "wl-");
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

test("loadConfig: missing file yields an empty config, existed=false", async (t) => {
  const dir = await tempDir(t, "wl-");
  const { config, existed } = await loadConfig(join(dir, "nope.json"));
  assert.equal(existed, false);
  assert.deepEqual(config.repos, []);
});

test("loadConfig: broken JSON names the file in the error", async (t) => {
  const dir = await tempDir(t, "wl-");
  const path = join(dir, "watch.json");
  await writeFile(path, '{ "repos": [ }');
  await assert.rejects(loadConfig(path), (err: Error) => {
    assert.match(err.message, /not valid JSON/);
    assert.ok(err.message.includes(path));
    return true;
  });
});

test("loadConfig: rejects non-object configs and non-array repos instead of coercing", async (t) => {
  const dir = await tempDir(t, "wl-");
  for (const bad of ['["a/x"]', "null", '"hello"', '{ "repos": { "a/x": {} } }']) {
    const path = join(dir, "bad.json");
    await writeFile(path, bad);
    await assert.rejects(loadConfig(path), /not a watch config/);
  }
});

test("requireConfig: a run needs a config that exists, and one shaped like a config", async (t) => {
  const dir = await tempDir(t, "wl-");
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

test("loadConfig: missing repos key becomes an empty array, keys survive", async (t) => {
  const dir = await tempDir(t, "wl-");
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

test("mergeCandidates: an archived repo with an active twin is not counted as dropped", () => {
  const { candidates, archivedDropped } = mergeCandidates([
    [cand("o/twin", { archived: true }), cand("o/gone", { archived: true })],
    [cand("o/twin")],
  ]);
  assert.deepEqual(candidates.map((x) => x.repo), ["o/twin"]);
  assert.equal(archivedDropped, 1, "only o/gone vanished from the list");
});

test("addRepos: the same repo twice in one call is stored once", () => {
  const config: WatchConfig = { repos: [] };
  const res = addRepos(config, ["o/a", "o/a"]);
  assert.deepEqual(res, { added: ["o/a"], skipped: ["o/a"] });
  assert.deepEqual(config.repos, [{ repo: "o/a" }]);
});

test("addRepoUrl: several trailing slashes collapse into the stored spelling", () => {
  const config: WatchConfig = { repos: [] };
  assert.equal(addRepoUrl(config, "https://forge.example/o/r//"), true);
  assert.deepEqual(config.repos, [{ repoUrl: "https://forge.example/o/r" }]);
  assert.equal(addRepoUrl(config, "https://forge.example/o/r///"), false);
});

test("REPO_RE: matches the whole string, one owner and one repo segment", () => {
  assert.ok(REPO_RE.test("o/r.js-x_1"));
  assert.ok(!REPO_RE.test("a/b/c"));
  assert.ok(!REPO_RE.test("x a/b"));
  assert.ok(!REPO_RE.test("a/b c"));
});

test("loadConfig: a path that exists but cannot be read as a file is an error", async (t) => {
  const dir = await tempDir(t, "crii-wl-");
  await assert.rejects(loadConfig(dir), (err: NodeJS.ErrnoException) => err.code === "EISDIR");
});

test("runWatchAdd: refuses a malformed slug before it asks the forge anything", async (t) => {
  const dir = await tempDir(t, "crii-wl-");
  const path = join(dir, "watch.json");
  await assert.rejects(
    runWatchAdd({ configPath: path, repo: "has space/x" }),
    /watch add expects owner\/repo/,
  );
  await assert.rejects(runWatchAdd({ configPath: path }), /watch add expects owner\/repo/);
  await assert.rejects(readFile(path), { code: "ENOENT" }, "nothing was written");
});

test("runWatchRemove: a missing config is an error, a miss leaves the file byte-identical", async (t) => {
  t.mock.method(console, "error", () => {});
  const dir = await tempDir(t, "crii-wl-");
  const path = join(dir, "watch.json");
  await assert.rejects(runWatchRemove({ configPath: path, repo: "o/a" }), /does not exist/);
  await assert.rejects(readFile(path), { code: "ENOENT" });

  const compact = '{"repos":[{"repo":"o/a"}]}';
  await writeFile(path, compact);
  assert.equal(await runWatchRemove({ configPath: path, repo: "o/other" }), 0);
  assert.equal(await readFile(path, "utf8"), compact, "no rewrite when nothing matched");
});

test("runWatchList: prints per-repo options after the name, never the name as an option", async (t) => {
  t.mock.method(console, "error", () => {});
  const lines: string[] = [];
  t.mock.method(console, "log", (line: string) => lines.push(line));
  const dir = await tempDir(t, "crii-wl-");
  const path = join(dir, "watch.json");
  await writeFile(
    path,
    JSON.stringify({ repos: [{ repo: "o/a", notifyBelow: 50 }, { repoUrl: "https://f.example/o/b" }, { repo: "o/c" }] }),
  );
  assert.equal(await runWatchList({ configPath: path }), 0);
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^o\/a\b.*notifyBelow=50/);
  assert.doesNotMatch(lines[0], /repo=/);
  assert.doesNotMatch(lines[1], /repoUrl=/);
  assert.equal(lines[2], "o/c", "no options, no trailing padding");
});
