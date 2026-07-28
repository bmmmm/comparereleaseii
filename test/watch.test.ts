// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  countSkipped,
  pickNewReleases,
  isFlagged,
  hasDrifted,
  releaseWebUrl,
  runNotify,
  runWatch,
  sanitizeTag,
  scoreBaseline,
  worstExit,
  toWatchIndexHtml,
  toWatchAtomFeed,
  carriedFromLedger,
  capLedger,
  updateAuthorLedger,
  recordCheckFailure,
  MAX_AUTHOR_LEDGER,
  MAX_CHECK_ATTEMPTS,
  MAX_PROMISE_LEDGER,
  type ReleaseInfo,
  type WatchState,
  type CheckedRelease,
  type RepoState,
} from "../src/watch.ts";
import type { PromiseCheck } from "../src/types.ts";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function rel(tag: string, publishedAt: string, extra: Partial<ReleaseInfo> = {}): ReleaseInfo {
  return { tag, publishedAt, prerelease: false, draft: false, ...extra };
}

test("pickNewReleases: first run checks only the latest release", () => {
  const releases = [
    rel("v3", "2026-07-20T00:00:00Z"),
    rel("v2", "2026-06-01T00:00:00Z"),
    rel("v1", "2026-05-01T00:00:00Z"),
  ];
  assert.deepEqual(
    pickNewReleases(releases, null).map((r) => r.tag),
    ["v3"],
  );
});

test("pickNewReleases: newer releases come oldest-first, capped to the newest", () => {
  const releases = [
    rel("v5", "2026-07-25T00:00:00Z"),
    rel("v4", "2026-07-20T00:00:00Z"),
    rel("v3", "2026-07-10T00:00:00Z"),
    rel("v2", "2026-06-01T00:00:00Z"),
  ];
  assert.deepEqual(
    pickNewReleases(releases, "2026-06-15T00:00:00Z").map((r) => r.tag),
    ["v3", "v4", "v5"],
  );
  assert.deepEqual(
    pickNewReleases(releases, "2026-06-15T00:00:00Z", { cap: 2 }).map((r) => r.tag),
    ["v4", "v5"],
  );
});

test("pickNewReleases: drafts and prereleases are skipped unless opted in", () => {
  const releases = [
    rel("v2-rc1", "2026-07-25T00:00:00Z", { prerelease: true }),
    rel("v2-draft", "2026-07-26T00:00:00Z", { draft: true }),
    rel("v1", "2026-07-01T00:00:00Z"),
  ];
  assert.deepEqual(pickNewReleases(releases, null).map((r) => r.tag), ["v1"]);
  assert.deepEqual(
    pickNewReleases(releases, null, { includePrerelease: true }).map((r) => r.tag),
    ["v2-rc1"],
  );
  assert.deepEqual(pickNewReleases(releases, "2026-07-30T00:00:00Z"), []);
});

test("isFlagged: exit code, critical flags, or a score below threshold", () => {
  assert.equal(isFlagged(95, 0, 0), false);
  assert.equal(isFlagged(95, 1, 0), true);
  assert.equal(isFlagged(95, 0, 2), true);
  assert.equal(isFlagged(60, 0, 0), true);
  assert.equal(isFlagged(60, 0, 0, 50), false);
});

test("worstExit takes the maximum, empty batch passes", () => {
  assert.equal(worstExit([]), 0);
  assert.equal(worstExit([0, 0]), 0);
  assert.equal(worstExit([0, 1, 0]), 1);
  assert.equal(worstExit([1, 2, 0]), 2);
});

function checked(tag: string, score: number, flagged: boolean): CheckedRelease {
  return {
    tag,
    publishedAt: "2026-07-20T00:00:00Z",
    checkedAt: "2026-07-26T00:00:00Z",
    score,
    scoreLabel: score >= 85 ? "solid" : score >= 65 ? "minor gaps" : "suspicious",
    exitCode: flagged ? 1 : 0,
    criticalFlags: 0,
    flagCount: 0,
    flagged,
    engine: "test",
    verdicts: { verified: 1, partial: 0, noEvidence: 0, contradicted: 0 },
    report: `x/${tag}.html`,
  };
}

test("toWatchIndexHtml distinguishes an unverifiable release from a score collapse", () => {
  const fork = checked("v2", 72, false);
  fork.unverifiable = "out-of-repo";
  const state: WatchState = {
    version: 1,
    repos: {
      "fork/repo": {
        lastPublishedAt: "2026-07-20T00:00:00Z",
        lastTag: "v2",
        latest: fork,
        history: [fork],
      },
      // Same ballpark score, but its claims WERE checkable — no badge.
      "normal/repo": {
        lastPublishedAt: "2026-07-20T00:00:00Z",
        lastTag: "v1",
        latest: checked("v1", 72, false),
        history: [checked("v1", 72, false)],
      },
    },
  };
  const html = toWatchIndexHtml(state, "2026-07-26T00:00:00Z");
  assert.ok(html.includes("out of repo"), "badge names the shape");
  // Apostrophes are escaped now — an attribute value must not be closable.
  assert.ok(html.includes("not in this repo&#39;s own diff"), "title explains it");
  assert.equal(html.match(/class="tag"/g)?.length, 1, "only the fork row is tagged");
});

test("toWatchIndexHtml marks a score the check could not fully see", () => {
  // Measured on bitwarden/clients cli-v2026.7.0: the compare API truncated
  // the diff, the clone fallback failed, and 18 % of the diff scored 45 where
  // the whole diff scores 85. The report said so; the index did not.
  const partial = checked("v2", 45, true);
  partial.warnings = [
    "Compare API caps file lists at 300 — diff may be incomplete, use a local clone (--local) for full coverage.",
    "Partial-clone fallback failed: git clone --quiet --filter=blob:none… failed",
  ];
  const state: WatchState = {
    version: 1,
    repos: {
      "big/repo": {
        lastPublishedAt: "2026-07-20T00:00:00Z",
        lastTag: "v2",
        latest: partial,
        history: [partial],
      },
      "small/repo": {
        lastPublishedAt: "2026-07-20T00:00:00Z",
        lastTag: "v1",
        latest: checked("v1", 45, true),
        history: [checked("v1", 45, true)],
      },
    },
  };
  const html = toWatchIndexHtml(state, "2026-07-26T00:00:00Z");
  assert.equal(html.match(/class="incomplete"/g)?.length, 1, "only the truncated row is marked");
  assert.ok(html.includes("partial data"), "the badge says what is wrong");
  assert.ok(html.includes("Partial-clone fallback failed"), "the title carries the reason");
});

test("toWatchIndexHtml gives an unverified score its own bucket, not the same as a genuine mid score", () => {
  const capped = checked("v2", 65, false);
  capped.scoreLabel = "unverified";
  capped.unverifiable = "sourceless";
  const state: WatchState = {
    version: 1,
    repos: {
      "sourceless/repo": {
        lastPublishedAt: "2026-07-20T00:00:00Z",
        lastTag: "v2",
        latest: capped,
        history: [capped],
      },
      // Same numeric range, but genuinely scored — different bucket.
      "normal/repo": {
        lastPublishedAt: "2026-07-20T00:00:00Z",
        lastTag: "v1",
        latest: checked("v1", 70, false),
        history: [checked("v1", 70, false)],
      },
    },
  };
  const html = toWatchIndexHtml(state, "2026-07-26T00:00:00Z");
  assert.ok(html.includes('class="score unverified"'), "capped score gets its own class");
  assert.ok(html.includes('class="score mid"'), "genuinely-scored release keeps the numeric bucket");
});

test("toWatchIndexHtml marks flagged repos red and sorts them first", () => {
  const state: WatchState = {
    version: 1,
    repos: {
      "good/repo": {
        lastPublishedAt: "2026-07-20T00:00:00Z",
        lastTag: "v1",
        latest: checked("v1", 95, false),
        history: [checked("v1", 95, false)],
      },
      "bad/repo": {
        lastPublishedAt: "2026-07-20T00:00:00Z",
        lastTag: "v9",
        latest: checked("v9", 5, true),
        history: [checked("v9", 5, true)],
      },
    },
  };
  const html = toWatchIndexHtml(state, "2026-07-26T00:00:00Z");
  assert.ok(html.includes('class="flagged"'));
  assert.ok(html.includes("bad/repo"));
  const badIdx = html.indexOf("bad/repo");
  const goodIdx = html.indexOf("good/repo");
  assert.ok(badIdx < goodIdx, "flagged repo sorts first");
  assert.ok(html.includes('href="x/v9.html"'));
  assert.ok(html.includes('<div class="n">2</div><div class="t">repos watched</div>'));
  assert.ok(html.includes('<div class="n">1</div><div class="t">flagged</div>'));
});

test("toWatchIndexHtml: whole rows link to the report, repos link to GitHub", () => {
  const state: WatchState = {
    version: 1,
    repos: {
      "good/repo": {
        lastPublishedAt: "2026-07-20T00:00:00Z",
        lastTag: "v1",
        latest: { ...checked("v1", 95, false), components: { correctness: 94, completeness: null, risk: 70 } },
        history: [checked("v1", 95, false)],
      },
    },
  };
  const html = toWatchIndexHtml(state, "2026-07-26T00:00:00Z", [
    { key: "good/repo", repo: "good/repo" },
  ]);
  assert.ok(html.includes('data-href="x/v1.html"'), "row carries the report link");
  assert.ok(html.includes('href="https://github.com/good/repo"'), "repo links to GitHub");
  assert.ok(
    html.includes('href="https://github.com/good/repo/releases/tag/v1"'),
    "tag links to the GitHub release",
  );
  assert.ok(html.includes("94 · – · 70"), "score components shown, null completeness as dash");
  assert.ok(html.includes("2026-07-20"), "release date shown");
});

test("toWatchIndexHtml: trend needs history — one check renders no dots, two render links", () => {
  const one: WatchState = {
    version: 1,
    repos: {
      "a/x": {
        lastPublishedAt: "2026-07-20T00:00:00Z",
        lastTag: "v1",
        latest: checked("v1", 95, false),
        history: [checked("v1", 95, false)],
      },
    },
  };
  // The distribution legend also uses dot spans, so the discriminating
  // signal for "no trend" is the report-linked dot, not the dot class.
  assert.ok(!toWatchIndexHtml(one, "t").includes('title="v1: 95"'), "single check: no trend dots");
  const two: WatchState = {
    version: 1,
    repos: {
      "a/x": {
        lastPublishedAt: "2026-07-20T00:00:00Z",
        lastTag: "v2",
        latest: checked("v2", 80, false),
        history: [checked("v1", 95, false), checked("v2", 80, false)],
      },
    },
  };
  const html = toWatchIndexHtml(two, "t");
  assert.ok(html.includes('<a href="x/v1.html" title="v1: 95">'), "dots link to past reports");
});

test("toWatchIndexHtml: configured repos without a check yet get a pending row", () => {
  const state: WatchState = { version: 1, repos: {} };
  const html = toWatchIndexHtml(state, "2026-07-26T00:00:00Z", [
    { key: "fresh/repo", repo: "fresh/repo" },
  ]);
  assert.ok(html.includes("waiting for the first release check"));
  assert.ok(html.includes("fresh/repo"));
  assert.ok(html.includes('<div class="n">1</div><div class="t">repos watched</div>'));
  assert.ok(html.includes('<div class="n">0</div><div class="t">flagged</div>'));
});

test("toWatchIndexHtml: state entries dropped from the config are not rendered", () => {
  const state: WatchState = {
    version: 1,
    repos: {
      "gone/repo": {
        lastPublishedAt: "2026-07-20T00:00:00Z",
        lastTag: "v1",
        latest: checked("v1", 95, false),
        history: [],
      },
    },
  };
  const html = toWatchIndexHtml(state, "2026-07-26T00:00:00Z", [
    { key: "kept/repo", repo: "kept/repo" },
  ]);
  assert.ok(!html.includes("gone/repo"));
  assert.ok(html.includes("kept/repo"));
});

function ledgerEntry(status: PromiseCheck["status"], text: string, carriedFor?: number): PromiseCheck {
  return { text, from: "v1.0.0", kind: "removal", status, carriedFor, files: [], note: "" };
}

test("only still-open promises ride to the next check, carry count intact", () => {
  const ledger = [
    ledgerEntry("kept", "shipped"),
    ledgerEntry("still-open", "pending", 4),
    ledgerEntry("broken", "lied"),
    // stale IS the exit — re-carrying it would undo the aging.
    ledgerEntry("stale", "ancient", 10),
  ];
  const carried = carriedFromLedger(ledger);
  assert.deepEqual(carried, [
    { text: "pending", from: "v1.0.0", kind: "removal", target: undefined, carriedFor: 4 },
  ]);
  assert.deepEqual(carriedFromLedger(undefined), []);
});

test("the ledger cap keeps still-open promises over this release's resolved ones", () => {
  // Resolved entries are display-only and discarded next run; a plain
  // head-slice would let them evict the carried promises the ledger exists
  // for. Build a ledger where exactly that would happen.
  const resolved = Array.from({ length: 30 }, (_, i) => ledgerEntry("kept", `kept-${i}`));
  const open = Array.from({ length: 30 }, (_, i) => ledgerEntry("still-open", `open-${i}`, i));
  const capped = capLedger([...resolved, ...open]);
  assert.equal(capped.length, MAX_PROMISE_LEDGER);
  // Every still-open entry survived; the tail resolved ones paid the cap.
  assert.equal(capped.filter((p) => p.status === "still-open").length, 30);
  assert.equal(capped.filter((p) => p.status === "kept").length, MAX_PROMISE_LEDGER - 30);
  // Under the cap nothing is reordered or dropped.
  const small = [ledgerEntry("kept", "a"), ledgerEntry("still-open", "b")];
  assert.deepEqual(capLedger(small), small);
});

test("scoreBaseline needs three checks before it calls a level", () => {
  assert.equal(scoreBaseline([{ score: 90 }, { score: 92 }]), null);
  assert.equal(scoreBaseline([{ score: 90 }, { score: 92 }, { score: 88 }]), 90);
  // Even count: rounded mean of the middle pair.
  assert.equal(scoreBaseline([{ score: 20 }, { score: 30 }, { score: 40 }, { score: 50 }]), 35);
});

test("alerting reads the score against the repo's own level", () => {
  // traefik: 9% churn coverage is its culture. Below the absolute default of
  // 65 on every release — a permanent alarm nobody reads.
  const traefik = [{ score: 25 }, { score: 27 }, { score: 24 }];
  assert.equal(isFlagged(25, 0, 0, 65, scoreBaseline(traefik)), false);
  // Until its baseline forms, the absolute threshold still stands in.
  assert.equal(isFlagged(25, 0, 0, 65, scoreBaseline(traefik.slice(0, 2))), true);
  // And a real collapse still alerts.
  assert.equal(isFlagged(4, 0, 0, 65, scoreBaseline(traefik)), true);

  // A repo normally at 95 dropping to 70 is the alarm no absolute default
  // would catch — 70 sits above notifyBelow.
  const solid = [{ score: 95 }, { score: 97 }, { score: 94 }];
  assert.equal(isFlagged(70, 0, 0, 65, scoreBaseline(solid)), true);
  assert.equal(isFlagged(90, 0, 0, 65, scoreBaseline(solid)), false);

  // Findings about the release itself are never silenced by history.
  assert.equal(isFlagged(25, 1, 0, 65, scoreBaseline(traefik)), true);
  assert.equal(isFlagged(25, 0, 1, 65, scoreBaseline(traefik)), true);
});

test("a repo whose own level slid is flagged, not normalised", () => {
  // The relative alert reads a release against the median of that repo's past
  // checks, and the publisher produces those checks. It fires once on the
  // step down and then the lower level IS the normal it compares against —
  // every release after that is "in line with this repo" again.
  const h = (...scores: number[]) => scores.map((score) => ({ score }));
  const settled = h(90, 88, 91, 89, 70, 68, 71, 69);
  assert.equal(
    isFlagged(69, 0, 0, 65, scoreBaseline(settled.slice(0, -1))),
    false,
    "the release itself sits inside the relative bar",
  );
  assert.equal(hasDrifted(settled), true, "but the level it is measured against moved 20");

  // An honest repo bobbing around its level is not drift.
  assert.equal(hasDrifted(h(90, 86, 92, 88, 91, 87, 90, 89)), false);
  // Nor is an improving one.
  assert.equal(hasDrifted(h(40, 45, 42, 70, 75, 72, 74, 71)), false);
  // Too little history to read a trend.
  assert.equal(hasDrifted(h(90, 50, 40)), false);
});

test("an exact 20-point drop is the case the constant names", () => {
  assert.equal(isFlagged(71, 0, 0, 65, 91), true);
  assert.equal(isFlagged(72, 0, 0, 65, 91), false);
});

// `--notify` runs a shell string on purpose. The report path handed to it is
// not the operator's — it carries a repo key and a tag from the config and the
// forge — so it must arrive as an argument, never as shell source.
test("the notify command cannot be extended by the report path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "notify-"));
  const marker = join(dir, "pwned");
  const seen = join(dir, "seen.txt");
  const hostile = join(dir, `v1.0.0"; touch ${marker}; echo ".json`);

  // runNotify appends the path itself, so the command names only its output.
  // Interpolating the path instead of passing it would close that quote and
  // run the `touch`.
  await runNotify(`printf '%s' > ${JSON.stringify(seen)}`, hostile);

  await assert.rejects(stat(marker), "the path opened a shell");
  assert.equal(await readFile(seen, "utf8"), hostile, "the path did not arrive intact");
});

test("releaseWebUrl speaks each forge's route dialect", () => {
  assert.equal(
    releaseWebUrl({ base: "https://gitea.com/gitea/tea", style: "github" }, "v0.14.2"),
    "https://gitea.com/gitea/tea/releases/tag/v0.14.2",
  );
  assert.equal(
    releaseWebUrl({ base: "https://gitlab.com/group/proj", style: "gitlab" }, "v1.0"),
    "https://gitlab.com/group/proj/-/releases/v1.0",
  );
  // Tags may carry slashes — one path component, always.
  assert.equal(
    releaseWebUrl({ base: "https://x.example/o/r", style: "github" }, "cli/v2.0"),
    "https://x.example/o/r/releases/tag/cli%2Fv2.0",
  );
  assert.equal(releaseWebUrl(null, "v1"), undefined);
});

test("toWatchIndexHtml links forge entries to their forge, never to GitHub", () => {
  const forgeRel = checked("v0.14.2", 88, false);
  forgeRel.releaseUrl = "https://gitea.com/gitea/tea/releases/tag/v0.14.2";
  const state: WatchState = {
    version: 1,
    repos: {
      "https://gitea.com/gitea/tea": {
        lastPublishedAt: "2026-07-20T00:00:00Z",
        lastTag: "v0.14.2",
        latest: forgeRel,
        history: [forgeRel],
      },
    },
  };
  const html = toWatchIndexHtml(state, "2026-07-26T00:00:00Z", [
    { key: "https://gitea.com/gitea/tea", repo: "gitea/tea", url: "https://gitea.com/gitea/tea" },
  ]);
  assert.ok(html.includes('href="https://gitea.com/gitea/tea"'), "repo cell links to the forge");
  assert.ok(
    html.includes('href="https://gitea.com/gitea/tea/releases/tag/v0.14.2"'),
    "release links to the forge's release page",
  );
  assert.ok(!html.includes("github.com"), "nothing points at GitHub for a forge entry");
  // The cell SHOWS owner/repo — an unlabeled forge entry's key is its whole
  // URL, which belongs in the title, not across the table.
  assert.ok(html.includes(">gitea/tea</a>"), "cell text is the slug, not the URL");
  assert.ok(!html.includes(">https://gitea.com/gitea/tea</a>"), "the URL is not the link text");
});

test("a URL-shaped repo without a forge link is not pinned on github.com", () => {
  // States written by older versions carry no releaseUrl; a forge entry whose
  // URL never parsed renders as plain text rather than a fabricated link.
  const rel = checked("v1", 80, false);
  const state: WatchState = {
    version: 1,
    repos: {
      weird: {
        lastPublishedAt: "2026-07-20T00:00:00Z",
        lastTag: "v1",
        latest: rel,
        history: [rel],
      },
    },
  };
  const html = toWatchIndexHtml(state, "t", [{ key: "weird", repo: "ssh://host/x/y" }]);
  assert.ok(!html.includes("github.com"), "no GitHub link fabricated from a URL");
});

test("watch config validation: exactly one of repo and repoUrl per entry", async () => {
  const opts = { configPath: "watch.json", cache: false };
  await assert.rejects(
    runWatch({ repos: [{ repo: "o/r", repoUrl: "https://forge.example/o/r" }] }, opts),
    /pass one per entry/,
  );
  await assert.rejects(runWatch({ repos: [{}] }, opts), /needs "repo"/);
  await assert.rejects(
    runWatch({ repos: [{ repoUrl: "https://forge.example" }] }, opts),
    /cannot read owner\/repo/,
  );
  await assert.rejects(
    runWatch({ repos: [{ repoUrl: "--upload-pack=evil" }] }, opts),
    /may not start with "-"/,
  );
  // A repository name in defaults would merge into every entry and split the
  // index key from the run-loop key — refused up front.
  await assert.rejects(
    runWatch({ repos: [{ repo: "o/r" }], defaults: { repoUrl: "https://f/o/r" } }, opts),
    /"defaults" cannot name a repository/,
  );
});

test("countSkipped ignores releases that would never be checked", () => {
  const releases = [
    { tag: "v2.0.0", publishedAt: "2026-07-20T00:00:00Z", prerelease: false, draft: false },
    { tag: "v2.0.0-rc2", publishedAt: "2026-07-19T00:00:00Z", prerelease: true, draft: false },
    { tag: "v2.0.0-rc1", publishedAt: "2026-07-18T00:00:00Z", prerelease: true, draft: false },
    { tag: "v1.9.0", publishedAt: "2026-07-01T00:00:00Z", prerelease: false, draft: false },
  ];
  const last = "2026-07-10T00:00:00Z";
  // Prereleases are not eligible: nothing was left behind, and the old
  // "raise maxPerRun to backfill" hint pointed at releases that would never
  // be checked anyway.
  assert.equal(countSkipped(releases, last, { cap: 3 }), 0);
  // With prereleases eligible and a cap of 1, two really are left behind.
  assert.equal(countSkipped(releases, last, { includePrerelease: true, cap: 1 }), 2);
  // First run checks only the latest by design — nothing counts as skipped.
  assert.equal(countSkipped(releases, null, { cap: 1 }), 0);
});

test("toWatchIndexHtml links each checked repo row to its history page", () => {
  const state: WatchState = {
    version: 1,
    repos: {
      "good/repo": {
        lastPublishedAt: "2026-07-20T00:00:00Z",
        lastTag: "v1",
        latest: checked("v1", 95, false),
        history: [checked("v1", 95, false)],
      },
    },
  };
  const html = toWatchIndexHtml(state, "t", [{ key: "good/repo", repo: "good/repo" }]);
  // The history dir is derived from the report path, so old states keep
  // working whatever their directory naming was.
  assert.ok(html.includes('href="x/index.html"'), "trend cell links the history page");
});

test("the index aggregates the watchlist: tiles, distribution, broken promises", () => {
  const state: WatchState = {
    version: 1,
    repos: {
      "a/a": {
        lastPublishedAt: "t", lastTag: "v1",
        latest: { ...checked("v1", 95, false), brokenPromises: 2 },
        history: [checked("v1", 95, false)],
      },
      "b/b": {
        lastPublishedAt: "t", lastTag: "v2",
        latest: checked("v2", 40, true),
        history: [checked("v2", 40, true)],
      },
      "c/c": {
        lastPublishedAt: "t", lastTag: "v3",
        latest: { ...checked("v3", 65, false), scoreLabel: "unverified" },
        history: [checked("v3", 65, false)],
      },
    },
  };
  const html = toWatchIndexHtml(state, "t", [
    { key: "a/a", repo: "a/a" },
    { key: "b/b", repo: "b/b" },
    { key: "c/c", repo: "c/c" },
    { key: "d/d", repo: "d/d" },
  ]);
  assert.ok(html.includes('<div class="n">4</div><div class="t">repos watched</div>'));
  assert.ok(html.includes('<div class="n">1</div><div class="t">flagged</div>'));
  assert.ok(html.includes('<div class="n">2</div><div class="t">broken promises</div>'));
  // Distribution counts the three checked repos in their buckets. The
  // unverified latest is scoreLabel "unverified" only in `latest`, not in
  // history — the tiles read latest.
  assert.ok(html.includes('title="1 repo(s) at 85+"'));
  assert.ok(html.includes('title="1 repo(s) at &lt;65"'));
  assert.ok(html.includes('title="1 repo(s) at unverified"'));
});

test("index rows carry sortable data and the headers offer the sorts", () => {
  const state: WatchState = {
    version: 1,
    repos: {
      "a/a": {
        lastPublishedAt: "t", lastTag: "v1",
        latest: { ...checked("v1", 95, false), criticalFlags: 2, flagCount: 3 },
        history: [checked("v1", 95, false)],
      },
    },
  };
  const html = toWatchIndexHtml(state, "t", [{ key: "a/a", repo: "a/a" }]);
  assert.ok(html.includes('data-score="95"'));
  assert.ok(html.includes('data-flags="2003"'), "critical flags outrank the plain count");
  assert.ok(html.includes('data-released="2026-07-20T00:00:00Z"'));
  for (const key of ["repo", "released", "score", "flags", "checked"]) {
    assert.ok(html.includes(`data-sort="${key}"`), `sortable header ${key}`);
  }
  assert.ok(html.includes('id="flagged-only"'), "the flagged-only toggle exists");
  assert.ok(html.includes("body.only-flagged"), "…and has a rule to act on");
});

test("the release feed reads across repos, newest release first", () => {
  const older = { ...checked("v1", 90, false), publishedAt: "2026-07-01T00:00:00Z" };
  const newer = { ...checked("v9", 50, true), publishedAt: "2026-07-22T00:00:00Z" };
  const middle = { ...checked("v5", 80, false), publishedAt: "2026-07-10T00:00:00Z" };
  const state: WatchState = {
    version: 1,
    repos: {
      "a/a": { lastPublishedAt: "t", lastTag: "v5", latest: middle, history: [older, middle] },
      "b/b": { lastPublishedAt: "t", lastTag: "v9", latest: newer, history: [newer] },
    },
  };
  const html = toWatchIndexHtml(state, "t", [
    { key: "a/a", repo: "a/a" },
    { key: "b/b", repo: "b/b" },
  ]);
  const feed = html.slice(html.indexOf("Release feed"));
  const posV9 = feed.indexOf(">v9</a>");
  const posV5 = feed.indexOf(">v5</a>");
  const posV1 = feed.indexOf(">v1</a>");
  assert.ok(posV9 !== -1 && posV5 !== -1 && posV1 !== -1, "all checks appear");
  assert.ok(posV9 < posV5 && posV5 < posV1, "interleaved across repos by release date");
});

test("the atom feed lists checks newest first with stable ids and relative links", () => {
  const HOSTILE = `v1"><img/src=x>&<script>`;
  const first = {
    ...checked(HOSTILE, 40, true),
    checkedAt: "2026-07-10T00:00:00Z",
    report: "x/v1.html",
    brokenPromises: 1,
    warnings: ["diff truncated"],
  };
  const second = { ...checked("v2", 90, false), checkedAt: "2026-07-20T00:00:00Z" };
  const state: WatchState = {
    version: 1,
    repos: {
      "a/a": { lastPublishedAt: "t", lastTag: "v2", latest: second, history: [first, second] },
    },
  };
  const xml = toWatchAtomFeed(state, "2026-07-26T00:00:00Z", [{ key: "a/a", repo: "a/a" }]);
  assert.ok(xml.startsWith(`<?xml version="1.0"`));
  assert.ok(!xml.includes("<img"), "hostile tag cannot become markup");
  assert.ok(!xml.includes("<script"), "hostile tag cannot become markup");
  assert.ok(xml.includes("<id>urn:comparereleaseii:a%2Fa:v2</id>"), "id derives from key and tag");
  assert.ok(xml.includes('href="x/v2.html"'), "links stay relative to the feed");
  assert.ok(
    xml.indexOf("v2 — 90/100") < xml.indexOf("40/100"),
    "entries ordered by checkedAt, newest first",
  );
  assert.ok(xml.includes("1 broken promise(s)"));
  assert.ok(xml.includes("diff truncated"), "partial-data warnings reach the summary");
  assert.ok(xml.includes("<updated>2026-07-20T00:00:00Z</updated>"), "entry updated = checkedAt");
});

test("a release tagged index cannot take over the history page's filename", () => {
  assert.equal(sanitizeTag("index"), "index_");
  assert.equal(sanitizeTag("INDEX"), "INDEX_", "case-insensitive filesystems collide too");
  assert.equal(sanitizeTag("v1.0/../index"), "v1.0_.._index");
  assert.equal(sanitizeTag("v1.2.3"), "v1.2.3");
});

function activity(key: string, commits: number, over: Record<string, unknown> = {}) {
  return { key, name: key, commits, sensitiveCommits: 0, binaryCommits: 0, ...over };
}

test("the author ledger accumulates identities and firstSeen never moves", () => {
  const r1 = updateAuthorLedger(undefined, [activity("a@x", 3), activity("b@x", 1)], "v1");
  assert.equal(r1.newAuthors, 2);
  assert.equal(r1.dropped, 0);
  const r2 = updateAuthorLedger(
    r1.ledger,
    [activity("a@x", 2, { name: "A renamed", logins: ["a-login"] })],
    "v2",
  );
  assert.equal(r2.newAuthors, 0, "a known identity is not new");
  const a = r2.ledger.find((x) => x.key === "a@x")!;
  assert.equal(a.firstSeen, "v1", "firstSeen is immutable");
  assert.equal(a.lastSeen, "v2");
  assert.equal(a.releases, 2);
  assert.equal(a.commits, 5);
  assert.equal(a.name, "A renamed");
  const r3 = updateAuthorLedger(r2.ledger, [activity("a@x", 1, { logins: [null] })], "v3");
  assert.deepEqual(r3.ledger.find((x) => x.key === "a@x")!.logins, ["a-login", null],
    "attribution changes accumulate — that shift is the fact worth keeping");
});

test("the author ledger cap keeps this release's identities, then the busiest", () => {
  let ledger = updateAuthorLedger(
    undefined,
    Array.from({ length: MAX_AUTHOR_LEDGER }, (_, i) => activity(`old${i}@x`, i + 2)),
    "v1",
  ).ledger;
  const update = updateAuthorLedger(ledger, [activity("fresh@x", 1)], "v2");
  assert.equal(update.ledger.length, MAX_AUTHOR_LEDGER);
  assert.equal(update.dropped, 1);
  assert.ok(update.ledger.some((a) => a.key === "fresh@x"), "the active identity survives the cap");
  assert.ok(!update.ledger.some((a) => a.key === "old0@x"), "the least active is what drops");
});

test("a release wider than the cap keeps its whole active set — new stays honest", () => {
  const wide = Array.from({ length: MAX_AUTHOR_LEDGER + 50 }, (_, i) => activity(`a${i}@x`, 1));
  const r1 = updateAuthorLedger(undefined, wide, "v1");
  assert.equal(r1.ledger.length, MAX_AUTHOR_LEDGER + 50, "every active identity survives");
  assert.equal(r1.dropped, 0);
  const r2 = updateAuthorLedger(r1.ledger, wide, "v2");
  assert.equal(r2.newAuthors, 0, "an identity the cap kept never recounts as new");
  // The next narrow release shrinks the ledger back to the cap.
  const r3 = updateAuthorLedger(r2.ledger, [activity("fresh@x", 1)], "v3");
  assert.equal(r3.ledger.length, MAX_AUTHOR_LEDGER);
  assert.equal(r3.dropped, 51);
});

test("recordCheckFailure: retries first, keeps state put, counts attempts on the same tag", () => {
  const rs: RepoState = { lastPublishedAt: "2026-01-01T00:00:00Z", lastTag: "v1", history: [] };
  const rel = { tag: "v2", publishedAt: "2026-02-01T00:00:00Z" };

  assert.equal(recordCheckFailure(rs, rel, "boom", "2026-02-02T00:00:00Z"), "retry");
  assert.deepEqual(rs.failing, { tag: "v2", attempts: 1, lastError: "boom" });
  assert.equal(rs.lastTag, "v1");
  assert.equal(rs.lastPublishedAt, "2026-01-01T00:00:00Z");

  assert.equal(recordCheckFailure(rs, rel, "boom again", "2026-02-03T00:00:00Z"), "retry");
  assert.equal(rs.failing!.attempts, 2);
  assert.equal(rs.failing!.lastError, "boom again");
});

test("recordCheckFailure: a different failing tag restarts the counter", () => {
  const rs: RepoState = { lastPublishedAt: null, lastTag: null, history: [] };
  recordCheckFailure(rs, { tag: "v2", publishedAt: "2026-02-01T00:00:00Z" }, "x", "t");
  recordCheckFailure(rs, { tag: "v2", publishedAt: "2026-02-01T00:00:00Z" }, "x", "t");
  assert.equal(rs.failing!.attempts, 2);
  assert.equal(recordCheckFailure(rs, { tag: "v3", publishedAt: "2026-03-01T00:00:00Z" }, "y", "t"), "retry");
  assert.deepEqual(rs.failing, { tag: "v3", attempts: 1, lastError: "y" });
});

test("recordCheckFailure: skips past the release after MAX_CHECK_ATTEMPTS, advancing the state", () => {
  const rs: RepoState = { lastPublishedAt: "2026-01-01T00:00:00Z", lastTag: "v1", history: [] };
  const rel = { tag: "v2", publishedAt: "2026-02-01T00:00:00Z" };
  for (let i = 1; i < MAX_CHECK_ATTEMPTS; i++) {
    assert.equal(recordCheckFailure(rs, rel, "no claims found", "t"), "retry");
  }
  assert.equal(recordCheckFailure(rs, rel, "no claims found", "2026-02-04T00:00:00Z"), "skip");
  assert.equal(rs.failing, undefined);
  assert.equal(rs.lastTag, "v2");
  assert.equal(rs.lastPublishedAt, "2026-02-01T00:00:00Z");
  assert.deepEqual(rs.skipped, [
    {
      tag: "v2",
      publishedAt: "2026-02-01T00:00:00Z",
      attempts: MAX_CHECK_ATTEMPTS,
      lastError: "no claims found",
      skippedAt: "2026-02-04T00:00:00Z",
    },
  ]);
});

test("recordCheckFailure: the skipped ledger is bounded, oldest entries drop", () => {
  const rs: RepoState = { lastPublishedAt: null, lastTag: null, history: [] };
  for (let n = 1; n <= 11; n++) {
    const rel = { tag: `v${n}`, publishedAt: `2026-01-${String(n).padStart(2, "0")}T00:00:00Z` };
    for (let i = 1; i <= MAX_CHECK_ATTEMPTS; i++) recordCheckFailure(rs, rel, "x", "t");
  }
  assert.equal(rs.skipped!.length, 10);
  assert.equal(rs.skipped![0].tag, "v2");
  assert.equal(rs.skipped![9].tag, "v11");
});
