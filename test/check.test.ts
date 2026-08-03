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
  type CheckSettings,
  type ComponentLoader,
  type ForgeTarget,
} from "../src/check.ts";
import { cloneHistory } from "../src/history.ts";
import type { ForgeListing } from "../src/sources/forge.ts";
import type { DiffFile, ReleaseData, RepoContext } from "../src/types.ts";

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

// ---------- first-party expansion: depth-1 component sub-checks ----------

const GH_LINK = { base: "https://github.com/acme/app", style: "github" as const };

function pinFile(name: string, from: string, to: string): DiffFile {
  return {
    path: "Makefile",
    status: "modified",
    additions: 1,
    deletions: 1,
    patch: `@@ -1,2 +1,2 @@\n-${name}=${from}\n+${name}=${to}\n unrelated line\n`,
  };
}

function parentData(over: Partial<ReleaseData> = {}): ReleaseData {
  return {
    repoLabel: "acme/app",
    baseRef: "v1.0.0",
    headRef: "v1.1.0",
    notes: "- Bump web to `v2.1.0`\n",
    commits: [
      { sha: "b".repeat(40), subject: "bump web", body: "", author: "dev", prNumbers: [] },
    ],
    files: [pinFile("WEB_VERSION", "v2.0.0", "v2.1.0")],
    commitFiles: async () => [],
    warnings: [],
    ...over,
  };
}

/** The component release the loader hands back — has its own claims, a
 * source file with a symbol and an env read, and a first-party go.mod pin
 * of its own (the depth-1 trap). */
function childData(over: Partial<ReleaseData> = {}): ReleaseData {
  return {
    repoLabel: "acme/web",
    baseRef: "v2.0.0",
    headRef: "v2.1.0",
    notes: "- Faster `render` pipeline\n",
    commits: [
      { sha: "c".repeat(40), subject: "speed up render", body: "", author: "dev", prNumbers: [] },
      { sha: "d".repeat(40), subject: "chore", body: "", author: "dev", prNumbers: [] },
    ],
    files: [
      {
        path: "src/render.go",
        status: "modified",
        additions: 2,
        deletions: 1,
        patch: `@@ -1,4 +1,4 @@ func render()\n-old\n+new render path\n+\tcache := os.Getenv("WEB_CACHE")\n`,
      },
      {
        path: "go.mod",
        status: "modified",
        additions: 1,
        deletions: 1,
        patch: `@@ -1,1 +1,1 @@\n-\tgithub.com/acme/lib v1.0.0\n+\tgithub.com/acme/lib v1.1.0\n`,
      },
    ],
    commitFiles: async () => [],
    warnings: [],
    ...over,
  };
}

function expandSettings(over: Partial<CheckSettings> = {}): CheckSettings {
  return {
    judgeMode: "off",
    engine: null,
    escalateEngine: null,
    concurrency: 1,
    reverse: true,
    baseline: 0,
    components: { WEB_VERSION: "acme/web" },
    ...over,
  };
}

function stubLoader(data: () => ReleaseData = childData): {
  calls: Array<{ url: string; tag: string; base: string }>;
  load: ComponentLoader;
} {
  const calls: Array<{ url: string; tag: string; base: string }> = [];
  return {
    calls,
    load: async (url, opts) => {
      calls.push({ url, tag: opts.tag, base: opts.base });
      return { data: data(), context: CONTEXT };
    },
  };
}

test("a first-party pin expands into a component summary — and only one level deep", async () => {
  const loader = stubLoader();
  const report = await analyzeRelease(parentData(), CONTEXT, GH_LINK, expandSettings({ expand: loader.load }));
  // The child's own first-party pin (github.com/acme/lib) must never load:
  // depth stays 1, so exactly one call, and it is the configured component.
  assert.deepEqual(loader.calls, [
    { url: "https://github.com/acme/web", tag: "v2.1.0", base: "v2.0.0" },
  ]);
  assert.equal(report.components?.length, 1);
  const comp = report.components![0];
  assert.equal(comp.name, "web");
  assert.equal(comp.repo, "acme/web");
  assert.equal(comp.from, "v2.0.0");
  assert.equal(comp.to, "v2.1.0");
  assert.equal(comp.headRef, "v2.1.0");
  assert.equal(comp.error, undefined);
  assert.equal(typeof comp.score, "number");
  assert.ok(comp.claims && comp.claims.verified + comp.claims.partial + comp.claims["no-evidence"] + comp.claims.contradicted + comp.claims.skipped > 0);
  assert.equal(comp.stats?.commits, 2);
  assert.ok(
    comp.surface?.categories.some((t) => t.category === "source"),
    "child surface missing",
  );
  assert.ok(comp.surface?.envVars.added.includes("WEB_CACHE"));
  // The child's own pins are listed nowhere in the summary — and were not expanded.
  assert.ok(!loader.calls.some((call) => call.url.includes("acme/lib")));
});

test("third-party pins never expand, even with a loadable github repo", async () => {
  const loader = stubLoader();
  const data = parentData({
    notes: "- Bump zerolog\n",
    files: [
      {
        path: "go.mod",
        status: "modified",
        additions: 1,
        deletions: 1,
        patch: `@@ -1,1 +1,1 @@\n-\tgithub.com/rs/zerolog v1.31.0\n+\tgithub.com/rs/zerolog v1.32.0\n`,
      },
    ],
  });
  const report = await analyzeRelease(data, CONTEXT, GH_LINK, expandSettings({ components: undefined, expand: loader.load }));
  assert.ok(report.pins?.length, "the third-party bump itself is still listed");
  assert.equal(loader.calls.length, 0);
  assert.equal(report.components, undefined);
});

test("expansion is score-neutral: identical metrics and verdicts with and without it", async () => {
  const base = await analyzeRelease(parentData(), CONTEXT, GH_LINK, expandSettings());
  const expanded = await analyzeRelease(
    parentData(),
    CONTEXT,
    GH_LINK,
    expandSettings({ expand: stubLoader().load }),
  );
  assert.equal(base.components, undefined);
  assert.ok(expanded.components);
  assert.deepEqual(expanded.metrics, base.metrics);
  assert.deepEqual(expanded.results, base.results);
});

test("a v-prefix mismatch between pin and tags retries once, toggled", async () => {
  const tags: string[] = [];
  const load: ComponentLoader = async (_url, opts) => {
    tags.push(opts.tag);
    if (opts.tag.startsWith("v")) throw new Error("no such tag");
    return { data: childData({ baseRef: "2.0.0", headRef: "2.1.0" }), context: CONTEXT };
  };
  const report = await analyzeRelease(parentData(), CONTEXT, GH_LINK, expandSettings({ expand: load }));
  assert.deepEqual(tags, ["v2.1.0", "2.1.0"]);
  const comp = report.components![0];
  assert.equal(comp.error, undefined);
  assert.equal(comp.headRef, "2.1.0");
});

test("a component that fails to load becomes an actionable entry, not a crash", async () => {
  const load: ComponentLoader = async () => {
    throw new Error("clone exploded");
  };
  const report = await analyzeRelease(parentData(), CONTEXT, GH_LINK, expandSettings({ expand: load }));
  const comp = report.components![0];
  assert.ok(comp.error?.includes("clone exploded"), `cause missing from: ${comp.error}`);
  assert.ok(comp.error?.includes("tried v2.1.0 and 2.1.0"), `retry not declared: ${comp.error}`);
  assert.ok(comp.error?.includes("https://github.com/acme/web"), `source missing: ${comp.error}`);
  assert.equal(comp.score, undefined);
  // The parent check stands regardless.
  assert.ok(report.results.length > 0);
});

test("a notes-less component still reports its deterministic surface", async () => {
  const loader = stubLoader(() => childData({ notes: "" }));
  const report = await analyzeRelease(parentData(), CONTEXT, GH_LINK, expandSettings({ expand: loader.load }));
  const comp = report.components![0];
  assert.equal(comp.noNotes, true);
  assert.equal(comp.score, undefined);
  assert.equal(comp.error, undefined);
  assert.equal(comp.stats?.commits, 2);
  assert.ok(comp.surface?.categories.some((t) => t.category === "source"));
});

// The done-when behind "an immediate re-run pays zero additional judge
// calls": the verdict cache keys on the exact prompt, so a re-run is free
// iff an expanded check asks byte-identical questions both times. Ordering
// may vary under concurrency — the cache doesn't care — so the comparison
// is over sorted prompt lists.
test("an expanded check asks byte-identical judge questions on a re-run", async () => {
  const runPrompts = async (): Promise<string[]> => {
    const prompts: string[] = [];
    await analyzeRelease(
      parentData(),
      CONTEXT,
      GH_LINK,
      expandSettings({
        judgeMode: "all",
        concurrency: 4,
        engine: {
          name: "recorder",
          judge: async (p: string) => {
            prompts.push(p);
            return '{"verdict":"partial","confidence":0.5,"files":[],"reasoning":"stub"}';
          },
        },
        expand: stubLoader().load,
      }),
    );
    return prompts.sort();
  };
  const first = await runPrompts();
  const second = await runPrompts();
  assert.ok(first.length > 0, "the stub judge was never consulted");
  assert.deepEqual(second, first);
});

test("a pin on the checked repo itself never self-expands", async () => {
  const loader = stubLoader();
  const data = parentData({
    notes: "- Bump our own pinned installer version\n",
    files: [pinFile("SELF_VERSION", "v1.0.0", "v1.1.0")],
  });
  const report = await analyzeRelease(
    data,
    CONTEXT,
    GH_LINK,
    expandSettings({ components: { SELF_VERSION: "acme/app" }, expand: loader.load }),
  );
  assert.equal(loader.calls.length, 0);
  assert.equal(report.components, undefined);
  assert.equal(report.pins?.[0].firstParty, true, "the pin itself still renders as first-party");
});
