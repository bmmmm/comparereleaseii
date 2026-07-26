// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickBaseRelease, type GhRelease } from "../src/sources/github.ts";

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
