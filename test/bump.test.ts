// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { bumpKind, bumpMismatchFlags, isBreaking, parseSemverTag } from "../src/bump.ts";
import type { Commit } from "../src/types.ts";

function commit(subject: string, body = "", sha = "abc1234"): Commit {
  return { sha, subject, body, author: "a", prNumbers: [] };
}

test("parseSemverTag reads prefixed, plain and annotated tags", () => {
  assert.deepEqual(parseSemverTag("v1.2.3"), {
    prefix: "v",
    major: 1,
    minor: 2,
    patch: 3,
    prerelease: null,
  });
  assert.equal(parseSemverTag("app-2.0.10")?.prefix, "app-");
  assert.equal(parseSemverTag("1.2.3-rc.1+build5")?.prerelease, "rc.1");
  assert.equal(parseSemverTag("2026.08"), null); // two-part: no semver claim
  assert.equal(parseSemverTag("nightly-20260803"), null);
});

test("bumpKind: forward bumps only, same tag line only, CalVer excluded", () => {
  const t = (s: string) => parseSemverTag(s)!;
  assert.equal(bumpKind(t("v1.2.3"), t("v1.2.4")), "patch");
  assert.equal(bumpKind(t("v1.2.3"), t("v1.3.0")), "minor");
  assert.equal(bumpKind(t("v1.2.3"), t("v2.0.0")), "major");
  assert.equal(bumpKind(t("v1.2.3"), t("v1.2.3")), null);
  assert.equal(bumpKind(t("v1.2.4"), t("v1.2.3")), null); // downgrade
  assert.equal(bumpKind(t("app-1.2.3"), t("web-1.2.4")), null); // other line
  assert.equal(bumpKind(t("2026.07.1"), t("2026.07.2")), null); // CalVer
});

test("isBreaking: conventional bang subject and BREAKING CHANGE footer", () => {
  assert.equal(isBreaking(commit("feat!: drop node 18")), true);
  assert.equal(isBreaking(commit("fix(api)!: rename field")), true);
  assert.equal(isBreaking(commit("feat: add field", "BREAKING CHANGE: renamed")), true);
  assert.equal(isBreaking(commit("feat: add field", "BREAKING-CHANGE: renamed")), true);
  assert.equal(isBreaking(commit("feat: add field")), false);
  assert.equal(isBreaking(commit("fix: breaking change in docs prose")), false);
});

test("a patch bump with a BREAKING marker earns the warn", () => {
  const flags = bumpMismatchFlags("v1.2.3", "v1.2.4", [
    commit("fix: null check"),
    commit("refactor!: new config format", "", "d3adb33f"),
  ]);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].kind, "bump-mismatch");
  assert.equal(flags[0].severity, "warn");
  assert.deepEqual(flags[0].commitShas, ["d3adb33f"]);
  assert.match(flags[0].message, /patch bump/);
});

test("a 0.x minor may break; a 1.x minor may not", () => {
  const breaking = [commit("feat!: new engine")];
  assert.equal(bumpMismatchFlags("v0.4.0", "v0.5.0", breaking).length, 0);
  const flagged = bumpMismatchFlags("v1.4.0", "v1.5.0", breaking);
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].severity, "warn");
});

test("feat commits in a patch bump: info, and only in a conventional repo", () => {
  const conventional = [
    commit("feat: sparkline", "", "f001"),
    commit("fix: off-by-one"),
    commit("chore: bump deps"),
  ];
  const flags = bumpMismatchFlags("v1.2.3", "v1.2.4", conventional);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].kind, "bump-mismatch-feat");
  assert.equal(flags[0].severity, "info");
  assert.deepEqual(flags[0].commitShas, ["f001"]);

  // A repo that does not speak conventional commits made no vocabulary
  // promise — one stray "feat:" among prose subjects is not a signal.
  const freeform = [
    commit("feat: sparkline"),
    commit("Fixed the thing from yesterday"),
    commit("More work on the parser"),
    commit("wip"),
    commit("Update README"),
  ];
  assert.equal(bumpMismatchFlags("v1.2.3", "v1.2.4", freeform).length, 0);
});

test("review hardening: four-part tags, merge bodies, prose subjects", () => {
  // A four-part tag is a build-number scheme, not a semver claim.
  assert.equal(parseSemverTag("1.2.3.4"), null);
  assert.equal(parseSemverTag("v1.2.3.4"), null);

  // A merge commit quoting the PR's BREAKING footer is not its own marker.
  const merge = commit("Merge pull request #7 from x/y", "BREAKING CHANGE: quoted from the PR");
  assert.equal(bumpMismatchFlags("v1.2.3", "v1.2.4", [merge]).length, 0);

  // Prose "Word:" subjects must not vote the repo over the conventional bar.
  const prose = [
    commit("feat: sparkline"),
    commit("Note: see the wiki"),
    commit("Fixed: the flaky test"),
    commit("Update: readme"),
    commit("Cleanup: old code"),
  ];
  assert.equal(bumpMismatchFlags("v1.2.3", "v1.2.4", prose).length, 0);
});

test("out of scope: prereleases, major bumps, non-semver tags", () => {
  const breaking = [commit("feat!: anything")];
  assert.equal(bumpMismatchFlags("v1.2.3", "v1.2.4-rc.1", breaking).length, 0);
  assert.equal(bumpMismatchFlags("v1.2.3", "v2.0.0", breaking).length, 0);
  assert.equal(bumpMismatchFlags("release-a", "release-b", breaking).length, 0);
  assert.equal(bumpMismatchFlags("2026.07.1", "2026.07.2", breaking).length, 0);
});
