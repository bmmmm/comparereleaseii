// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertRepoSlug,
  extractPrNumbers,
  ghApi,
  pickBaseRelease,
  rateLimitHooks,
  ref,
  type GhRelease,
} from "../src/sources/github.ts";

function rel(tag_name: string, opts: { draft?: boolean; prerelease?: boolean } = {}): GhRelease {
  return { tag_name, name: tag_name, body: "", draft: opts.draft ?? false, prerelease: opts.prerelease ?? false };
}

test("pickBaseRelease: previous release in a plain chain", () => {
  assert.equal(pickBaseRelease([rel("v2"), rel("v1"), rel("v0")], "v2"), "v1");
  assert.equal(pickBaseRelease([rel("v2"), rel("v1"), rel("v0")], "v1"), "v0");
});

test("pickBaseRelease: stable skips prereleases back to the previous stable", () => {
  const releases = [rel("v2.0.0"), rel("v2.0.0-rc1", { prerelease: true }), rel("v1.0.0")];
  assert.equal(pickBaseRelease(releases, "v2.0.0"), "v1.0.0");
  // A prerelease target may diff against the previous prerelease.
  const rcs = [rel("v2.0.0-rc2", { prerelease: true }), rel("v2.0.0-rc1", { prerelease: true })];
  assert.equal(pickBaseRelease(rcs, "v2.0.0-rc2"), "v2.0.0-rc1");
});

test("pickBaseRelease: first-release shapes return null (full-history fallback)", () => {
  // Nothing older at all.
  assert.equal(pickBaseRelease([rel("v0.1.0")], "v0.1.0"), null);
  // Only drafts older — never published, so effectively the first release.
  assert.equal(pickBaseRelease([rel("v0.1.0"), rel("draft", { draft: true })], "v0.1.0"), null);
  // First stable after only prereleases — its notes cover everything.
  assert.equal(
    pickBaseRelease([rel("v1.0.0"), rel("v1.0.0-rc1", { prerelease: true })], "v1.0.0"),
    null,
  );
});

test("pickBaseRelease: a full 100-page must not be mistaken for a first release", () => {
  // Target is the oldest entry of a full page — older releases may exist
  // beyond it, so claiming "first release" would diff against the root
  // commit and produce a garbage score (watchdog would false-alert).
  const releases = Array.from({ length: 100 }, (_, i) => rel(`v${100 - i}`));
  assert.throws(() => pickBaseRelease(releases, "v1"), /--base/);
});

test("pickBaseRelease: unknown tag is an error, not a fallback", () => {
  assert.throws(() => pickBaseRelease([rel("v1")], "v9"), /not found/);
});

test("pickBaseRelease: monorepo product tags diff against the same product", () => {
  // bitwarden/clients shape: four products released back-to-back — the
  // release right before cli-v2026.7.0 is a different product, and that
  // diff was 1 commit for 328 claims (seen live).
  const releases = [
    rel("cli-v2026.7.0"),
    rel("browser-v2026.7.0"),
    rel("desktop-v2026.7.0"),
    rel("web-v2026.7.0"),
    rel("cli-v2026.6.1"),
  ];
  assert.equal(pickBaseRelease(releases, "cli-v2026.7.0"), "cli-v2026.6.1");
});

test("pickBaseRelease: parallel maintenance lines diff within the same major", () => {
  // traefik shape: v2.11.x security backports land between v3.x releases.
  const releases = [rel("v3.7.9"), rel("v2.11.53"), rel("v3.7.8"), rel("v2.11.52")];
  assert.equal(pickBaseRelease(releases, "v3.7.9"), "v3.7.8");
});

test("pickBaseRelease: a line's first release falls back to the previous line", () => {
  const releases = [rel("v3.0.0"), rel("v2.9.1"), rel("v2.9.0")];
  assert.equal(pickBaseRelease(releases, "v3.0.0"), "v2.9.1");
});

test("pickBaseRelease: same-prefix candidates beyond a full page still resolve", () => {
  // A same-line base exists nowhere on the page but a same-prefix one does:
  // prefer returning it over the pass-the-page error.
  const releases = [rel("v3.0.0"), ...Array.from({ length: 99 }, (_, i) => rel(`v2.${99 - i}.0`))];
  assert.equal(pickBaseRelease(releases, "v3.0.0"), "v2.99.0");
});

test("API paths cannot be walked out of the repo they name", () => {
  // `gh api "repos/cli/cli/releases/tags/../../../../../user"` returns the
  // authenticated user — the path is concatenated, so whatever lands in it
  // picks the endpoint. Refs cannot contain ".." (git forbids it), so this
  // needs a hostile --base/--tag or a shared watch.json; the request still
  // goes out under the caller's own token.
  assert.throws(() => ref("../../../../../user"), /would walk the API path/);
  assert.throws(() => ref("v1/./x"), /would walk the API path/);
  assert.throws(() => assertRepoSlug("cli/cli/../.."), /owner\/repo slug/);
  assert.throws(() => assertRepoSlug("../../etc"), /owner\/repo slug/);
  assert.throws(() => assertRepoSlug("no-slash"), /owner\/repo slug/);
  assert.throws(() => assertRepoSlug("a/b?x=1"), /owner\/repo slug/);

  // Ordinary refs survive unchanged; slashes stay, the rest is encoded.
  assert.equal(ref("v1.2.3"), "v1.2.3");
  assert.equal(ref("release/1.0"), "release/1.0");
  assert.equal(ref("cli-v2026.7.0"), "cli-v2026.7.0");
  assert.equal(ref("v1 rc?x"), "v1%20rc%3Fx");
  assert.equal(assertRepoSlug("cli/cli"), "cli/cli");
  assert.equal(assertRepoSlug("zen-browser/desktop"), "zen-browser/desktop");
  assert.equal(assertRepoSlug("user/repo.js"), "user/repo.js");
});

test("extractPrNumbers reads the merge dialect of whichever forge cut the commit", () => {
  // GitHub, Gitea and Forgejo.
  assert.deepEqual(extractPrNumbers("Add rotate support (#426)"), [426]);
  assert.deepEqual(extractPrNumbers("Merge pull request #91 from dev/topic"), [91]);
  // GitLab squashes to `(!123)`, optionally namespaced, and its merge commits
  // put the reference in the body. `--repo-url` reads commits straight from a
  // clone, so this is the only place the forge still shows through.
  assert.deepEqual(extractPrNumbers("Resolve export deadlock (!4821)"), [4821]);
  assert.deepEqual(extractPrNumbers("Bump deps (platform/backend!4877)"), [4877]);
  assert.deepEqual(
    extractPrNumbers("Merge branch 'fix' into 'main'\n\nSee merge request platform/backend!4903"),
    [4903],
  );
  assert.deepEqual(extractPrNumbers("See merge request !77"), [77]);
  // A version in parentheses is not a review reference.
  assert.deepEqual(extractPrNumbers("Release (1.2.0)"), []);
  assert.deepEqual(extractPrNumbers("Fix the thing"), []);
});

test("a rate limit is waited out, not answered with partial data", async () => {
  // A rate limit is the same request answerable N seconds later, not a
  // missing resource. Answering it with a load failure is what let a
  // partially-read release outscore a fully-read one, so ghApi retries once
  // after the reset — and when the reset is too far out it fails saying so
  // rather than handing back a hole. The fake `gh` fails the first data call
  // and succeeds after; `rate_limit` reports a window that has just reset.
  const dir = await mkdtemp(join(tmpdir(), "crii-gh-"));
  const marker = join(dir, "called");
  const reset = Math.floor(Date.now() / 1000) + 1;
  await writeFile(
    join(dir, "gh"),
    `#!/usr/bin/env bash
if [ "$2" = "rate_limit" ]; then
  echo '{"resources":{"core":{"remaining":0,"limit":5000,"reset":${reset}}}}'
  exit 0
fi
if [ -f "${marker}" ]; then echo '{"ok":true}'; exit 0; fi
touch "${marker}"
echo "gh: API rate limit exceeded for user ID 1" >&2
exit 1
`,
    { mode: 0o755 },
  );
  const previousPath = process.env.PATH;
  process.env.PATH = `${dir}:${previousPath}`;
  const slept: number[] = [];
  const realSleep = rateLimitHooks.sleep;
  rateLimitHooks.sleep = async (ms: number) => {
    slept.push(ms);
  };
  try {
    const got = await ghApi<{ ok: boolean }>("repos/o/r/releases/tags/v1");
    assert.deepEqual(got, { ok: true }, "the retry after the reset is what answers");
    assert.equal(slept.length, 1, "it waited exactly once");
  } finally {
    rateLimitHooks.sleep = realSleep;
    process.env.PATH = previousPath;
  }
});

test("a rate limit resetting beyond the cap fails naming the wait", async () => {
  const dir = await mkdtemp(join(tmpdir(), "crii-gh-"));
  const reset = Math.floor(Date.now() / 1000) + 3600;
  await writeFile(
    join(dir, "gh"),
    `#!/usr/bin/env bash
if [ "$2" = "rate_limit" ]; then
  echo '{"resources":{"core":{"remaining":0,"limit":5000,"reset":${reset}}}}'
  exit 0
fi
echo "gh: API rate limit exceeded for user ID 1" >&2
exit 1
`,
    { mode: 0o755 },
  );
  const previousPath = process.env.PATH;
  process.env.PATH = `${dir}:${previousPath}`;
  try {
    await assert.rejects(
      () => ghApi("repos/o/r/releases/tags/v1"),
      // The message has to carry both halves: how long, and that nothing was
      // scored on what did come back.
      (err: Error) =>
        /rate limit/i.test(err.message) &&
        /resets in ~\d+ min/.test(err.message) &&
        /partial data/.test(err.message),
    );
  } finally {
    process.env.PATH = previousPath;
  }
});

test("a refusal the rate_limit endpoint does not admit is the secondary limit", async () => {
  // The case that actually happened: twelve parallel workers tripped GitHub's
  // anti-abuse limit while `rate_limit` still reported core at 5000/5000.
  // There is no reset to read, so a run that only trusts the endpoint would
  // give up — but this limit clears in under a minute, so one short wait is
  // the right answer and a hole in the data never is.
  const dir = await mkdtemp(join(tmpdir(), "crii-gh-"));
  const marker = join(dir, "called");
  await writeFile(
    join(dir, "gh"),
    `#!/usr/bin/env bash
if [ "$2" = "rate_limit" ]; then
  echo '{"resources":{"core":{"remaining":5000,"limit":5000,"reset":0}}}'
  exit 0
fi
if [ -f "${marker}" ]; then echo '{"ok":true}'; exit 0; fi
touch "${marker}"
echo "gh: You have exceeded a secondary rate limit" >&2
exit 1
`,
    { mode: 0o755 },
  );
  const previousPath = process.env.PATH;
  process.env.PATH = `${dir}:${previousPath}`;
  const slept: number[] = [];
  const realSleep = rateLimitHooks.sleep;
  rateLimitHooks.sleep = async (ms: number) => {
    slept.push(ms);
  };
  try {
    assert.deepEqual(await ghApi<{ ok: boolean }>("repos/o/r/releases/tags/v1"), { ok: true });
    assert.equal(slept.length, 1);
    assert.ok(slept[0] > 0 && slept[0] <= 60_000, `waited ${slept[0]}ms, expected a short bounded wait`);
  } finally {
    rateLimitHooks.sleep = realSleep;
    process.env.PATH = previousPath;
  }
});
