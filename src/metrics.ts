// SPDX-License-Identifier: GPL-3.0-or-later
import type {
  AuthorActivity,
  ClaimResult,
  Commit,
  DiffFile,
  FileCoverage,
  FileInsight,
  Metrics,
  ReleaseData,
  Report,
  RepoContext,
  RiskFlag,
  Scores,
  Unverifiable,
} from "./types.ts";
import type { Coverage } from "./verify.ts";
import { SCORE_MINOR, SCORE_QUESTIONABLE, SCORE_SOLID } from "./theme.ts";
import { authorKey, type Baseline } from "./history.ts";
import { bumpMismatchFlags } from "./bump.ts";
import { hunkFunctions, isChangelogPath } from "./match.ts";
import {
  BENIGN_BINARY,
  DEP_MANIFEST,
  OPAQUE_BINARY,
  lockfileSources,
  newDependencies,
  opacityIssue,
} from "./deps.ts";

/**
 * Which set of rules produced a score. Bump it by hand whenever a change can
 * move a score for input that did not change — the weights and caps here, the
 * coverage routes in `verify.ts`, the pin join in `reconcile.ts`. Records
 * carrying different generations were measured with different sticks, and the
 * consumers that would otherwise read the difference as the repo's doing
 * consult this: the long view refuses to open a `level-shift` phase across a
 * boundary, and the history page marks a series that spans one.
 *
 * Explicitly NOT `VERSION`. The cache is keyed by tool version and over-keying
 * there costs only judge calls; over-keying the record would empty the
 * baseline every release, and with `BASELINE_MIN_CHECKS = 3` each one would
 * leave three checks with no relative alert at all. Most releases change
 * nothing about scoring, and this must stay put for those.
 *
 * The baseline median, the relative alert and the drift detector deliberately
 * do NOT read it. Measured 2026-08-06 over 90 release pairs (v0.9.0 vs
 * v0.10.0): 80 were bit-identical in all three components, and the four
 * medians that moved moved by 5, 2, 1 and 1 points — far under `SCORE_DROP`
 * of 20. Nothing there can see a shift that small, so the cost of keying them
 * is real and the gain is not.
 *
 * 1 — the first generation to carry a marker at all: everything up to and
 * including the bump-claim coverage fix (a bump claim documents the commits
 * that move the pin it names). A record without the field predates the
 * marker; `GENERATION_UNRECORDED` is how the long view spells that.
 *
 * 2 — a `.woodpecker.*` pipeline file became `ci/build` instead of source
 * (`CI_BUILD` only knew the directory spelling). That reaches
 * `sensitiveCategory`, so a release that changes one without documenting it
 * now takes the `undocumented-sensitive` warn: risk −10, overall −3 for input
 * that did not change, judge off. Small, deterministic, and enough — a bucket
 * boundary sits inside that distance.
 *
 * 3 — coverage's evidence-union route asks for every file of a commit rather
 * than half of them (`computeCoverage`, where the measurement is). This is the
 * largest of the three by far: 27 of 111 corpus releases move their
 * completeness and 5 reach 0, so a generation-2 completeness and a
 * generation-3 completeness are not the same measurement of the same release.
 *
 * 4 — that route stops pooling. Every file of a commit must be cited by ONE
 * claim's evidence rather than by the union over all of them
 * (`computeCoverage` again, forge issue #8). Strictly stricter than
 * generation 3 — each claim's evidence is a subset of the union — so a
 * completeness can only fall across this boundary, never rise. It is also by
 * far the smallest of the four: of the 65 corpus releases the mutation
 * harness reports a control completeness for, two move (90 → 86, 99 → 98)
 * and the median does not. Recorded anyway, because "small" is not "none"
 * and the consumers reading this cannot tell the difference themselves.
 *
 * 5 — a matched term that names no symbol is worth 1 rather than 2
 * (`termWeight`, forge issue #12). One identifier plus one ordinary word hit
 * the `>= 5` bar exactly, and an ordinary word is what a release diff contains
 * whatever the release did, so the bar settled claims nobody wrote. This is
 * the largest generation since 3 and the one most likely to be misread as a
 * project getting worse: 11 of 111 corpus releases move a control score, both
 * medians move with them (correctness 50 → 47, completeness 51.5 → 48), and
 * the largest single move is a release whose notes carry one `change` claim
 * (78 → 27). Unlike generation 4 this is NOT strictly stricter in one
 * direction only — a claim that loses the bar reaches the judge instead of
 * settling itself, so with the judge on a score can also rise. A
 * generation-4 score and a generation-5 score are not the same measurement.
 *
 * 6 — a claim that says something is GONE is no longer settled by a diff that
 * carries its identifiers only on the lines it ADDS (`removalUnsupported` in
 * `verify.ts`, forge issue #13). Overlap has no direction: the release that
 * introduced `http_mp3_128_url` and the release that took it away put the same
 * token in their changed lines, and the bar read both as evidence. By far the
 * smallest generation recorded here — of 4,364 corpus claims 249 assert a
 * removal and exactly ONE loses the bar to this, so one release of 111 moves a
 * control score (`zed-industries/zed@v1.11.3`, correctness 52 → 51, its
 * completeness 72 and overall 41 unmoved) and no median moves at all
 * (correctness 47, completeness 48, overall 47 on both sides). Like generation
 * 5 and unlike generation 4 it is not strictly stricter in one direction: the
 * demoted claim reaches the judge instead of settling itself, so with the judge
 * on a score can also rise. Recorded for the reason generation 4 was — "small"
 * is not "none", and the consumers reading a series cannot tell the difference
 * themselves.
 */
export const SCORING_GENERATION = 6;

// Woodpecker is spelled both ways: a `.woodpecker/` directory and a single
// `.woodpecker.yml`/`.yaml`/`.star` file beside it. Only the directory form
// was here, and the two spellings landed differently: `.woodpecker.star` fell
// through to source and shipped its test-runner arguments as the product's
// CLI surface (53 corpus flag occurrences from one file), while
// `.woodpecker.yml` matched CONFIG_FILE and was merely `config` — it never
// contributed flags, it contributed YAML keys, and it stops doing that here
// exactly as `.github/workflows/*.yml` already does. Not anchored to the repo
// root: a monorepo's per-package pipeline is CI wherever it sits.
const CI_BUILD =
  /(^|\/)\.(github|gitlab|circleci|woodpecker)\/|(^|\/)(Dockerfile[^/]*|Makefile|justfile|build\.rs|setup\.py|\.pre-commit-config\.yaml|Jenkinsfile|\.woodpecker\.(?:ya?ml|star))$|\.(gradle|cmake)$/i;
// `token(?!i[sz])` keeps token/tokens/token_store but not tokenize(r) —
// every parser and LLM repo has tokenizer paths, and flagging them sensitive
// fired escalation reviews for nothing.
const AUTH_CRYPTO =
  /auth|crypto|token(?!i[sz])|password|passwd|secret|session|login|signin|permission|policy|acl|sanitiz|escape|csrf|ssrf|xss|jwt|oauth|sso|2fa|totp|webauthn|vault|key(chain|store)/i;
const DOC_FILE = /\.(md|markdown|rst|txt|adoc|org)$/i;
// TODO: `__snapshots__/` is missing from the directory list, so a Vitest/Jest
// snapshot (`X.spec.ts.snap` — the `$` anchor misses that too) reads as
// source. Measured for ROADMAP entry 6 and deliberately left: excluding it
// changes no reported flag, because the snapshot's copy of a CSS custom
// property cancels a removal instead of adding one. Whoever fixes it justifies
// it from the category rollup, not from the flag surface.
const TEST_FILE =
  /(^|\/)([\w-]*tests?|__tests__|spec|specs|testdata|fixtures)\/|_test\.[a-z0-9]+$|\.(test|spec)\.[a-z0-9]+$/i;
// SVG is markup, not a picture: it carries <script> and event handlers, and a
// site that ships one ships code. It belongs nowhere near "benign binary".
const SITE_METADATA = /(^|\/)(feed|atom|rss|sitemap)\.xml$|\.(rss|atom)$/i;
const PROJECT_META =
  /(^|\/)(LICEN[SC]E|COPYING|NOTICE|AUTHORS|CONTRIBUTORS|CODEOWNERS|VERSION)([.-][\w.]+)?$/;

/**
 * Can this file's diff carry evidence for a claim about behaviour? Docs,
 * changelogs, feeds, project metadata and images cannot — there is no code in
 * them to anchor an identifier to.
 */
export function isSourceFile(path: string): boolean {
  // A dependency manifest, CI config or install hook is shipped machinery
  // whatever its extension. requirements.txt ends in .txt and decides what
  // code runs on the next install — calling that "no source in the diff"
  // waived the check on the one file a supply-chain attack needs.
  if (sensitiveCategory(path) !== null) return true;
  return !(
    DOC_FILE.test(path) ||
    isChangelogPath(path) ||
    SITE_METADATA.test(path) ||
    PROJECT_META.test(path) ||
    BENIGN_BINARY.test(path)
  );
}

/**
 * The release's diff touches no source file at all — a docs-only bump, or a
 * repo that publishes notes without shipping the code they describe. Claims
 * then *cannot* be checked; that is a property of the release, not evidence
 * that the notes lie.
 */
export function isSourcelessDiff(files: DiffFile[]): boolean {
  return !files.some((f) => isSourceFile(f.path));
}

/**
 * Share of churn a release must document before a single missing sensitive
 * path counts as a deliberate omission rather than one gap among many.
 */
const WELL_DOCUMENTED = 0.6;

/**
 * Ceiling for a release whose claims dropped out of the correctness ratio.
 * "Nobody could have checked this" is not a pass — it is the absence of one,
 * and it must never read better than a release that was checked and had gaps.
 */
const UNVERIFIED_CAP = 65;

/** A repo whose notes habitually describe code outside its own diff. */
const OUT_OF_REPO_BASELINE = 0.25;
/**
 * …and a release that follows that pattern. A bare majority sat inside the
 * judge's own spread: zen-browser 1.21.9b produced 5 and then 6 misses out of
 * 10 checkable claims on two runs of the same tag, and the bar at one half is
 * exactly what separates those — the release read `minor gaps` once and
 * `unverified` the other time on a single verdict. This carve-out replaces
 * the whole story of a release, so it wants a clear majority, not a coin's
 * width of one, and it errs toward not claiming: "most claims miss" is also
 * what a fabricated release looks like, so a false carve-out costs more than
 * a missed one. zen-browser at 6 of 10 now reads `questionable` instead.
 *
 * The obvious way out — decide this on the deterministic `lexicalCoverage`
 * the baseline already uses, and keep the judge out of the gate entirely —
 * was measured and does not work. That number tracks note *style*, not where
 * the code lives: GyulyVGC/sniffnet scores 0.15 and dani-garcia/vaultwarden
 * 0.31 on releases that are neither forks nor distribution repos, because
 * short bullets and generated PR lists carry no identifiers to match. The
 * judge's own misses are what makes this gate mean anything.
 */
const OUT_OF_REPO_RELEASE = 2 / 3;

/**
 * Why — if at all — this release's claims could not be checked against its own
 * diff. Two shapes, both benign, both otherwise scored like a fabrication:
 *
 * - `sourceless`: the diff holds no source file. Decided from this release
 *   alone; the file set is proof enough.
 * - `out-of-repo`: the diff holds source, but the notes describe code that
 *   lives elsewhere (a fork shipping upstream features, a build or
 *   distribution repo). One release cannot prove that — a release where most
 *   claims miss is exactly what a fabricated one looks like. It takes the
 *   repo's own history: only when its previous releases show the same shape
 *   is "this is how this repo publishes" the better explanation than "these
 *   notes lie".
 *
 * Never claimed when the diff actively disagrees with the notes: a
 * contradicted claim or a critical flag is evidence *about* this release, and
 * it outranks any pattern in the history.
 */
export function classifyUnverifiable(
  data: ReleaseData,
  results: ClaimResult[],
  flags: RiskFlag[],
  baseline: Baseline | null,
): Unverifiable | null {
  // These two guards belong in front of BOTH shapes. A docs-only diff that
  // still adds a dependency, contradicts a claim or trips a critical flag is
  // not "nothing to check here" — the finding is about this release, and it
  // outranks any statement about the release's shape.
  if (results.some((r) => r.verdict === "contradicted")) return null;
  if (flags.some((f) => f.severity === "critical")) return null;

  if (isSourcelessDiff(data.files)) {
    return {
      kind: "sourceless",
      reason:
        "This release's diff contains no source-code changes — claims could not be checked against code.",
    };
  }

  const change = results.filter((r) => r.claim.kind === "change" && r.verdict !== "skipped");
  if (!change.length) return null;
  const missing = change.filter((r) => r.verdict === "no-evidence");
  if (missing.length / change.length <= OUT_OF_REPO_RELEASE) return null;
  // "This repo publishes notes about code elsewhere" is a statement about
  // routine releases. An unprovable *security* claim is never routine, and
  // the baseline that would excuse it is written by the same publisher.
  if (missing.some((r) => r.claim.advisories.length || /securit|vulnerab|cve/i.test(r.claim.section))) {
    return null;
  }

  // Same bar as the other baseline signals: fewer than 3 past releases is an
  // accident, not a pattern.
  if (!baseline || baseline.snapshots.length < 3) return null;
  if (baseline.medianLexicalCoverage > OUT_OF_REPO_BASELINE) return null;

  return {
    kind: "out-of-repo",
    reason:
      `These notes describe changes that are not in this repo's own diff — across the last ${baseline.snapshots.length} releases only ` +
      `${Math.round(baseline.medianLexicalCoverage * 100)}% of claims matched its code (fork, build or distribution repo).`,
  };
}

const MIGRATION_FILE =
  /(^|\/)(migrations?|db\/migrate|alembic\/versions)\/|(^|\/)V\d+__[^/]+\.sql$/i;
// `.json` as a whole is not config — it is data, fixtures and manifests — so
// the named tooling files that happen to use it are listed. `.mcp.json`
// declares the servers a coding agent may start, arguments and all; as source
// those arguments read as the project's own flags.
const CONFIG_FILE =
  /\.(ya?ml|toml|ini|conf|cfg|properties)$|(^|\/)(\.env\.[\w.-]+|\.mcp\.json)$/i;

/**
 * Total classification for the substance rollup — every path lands in
 * exactly one bucket. This answers "what kind of file", never "is it risky";
 * sensitivity stays sensitiveCategory's job. Priority order carries the same
 * hard-won exclusions: .github/CONTRIBUTING.md is docs before ci/build, a
 * test fixture under tests/ is tests before config or migrations.
 */
export function fileCategory(path: string): string {
  if (
    DOC_FILE.test(path) ||
    isChangelogPath(path) ||
    PROJECT_META.test(path) ||
    SITE_METADATA.test(path)
  ) {
    return "docs";
  }
  if (DEP_MANIFEST.test(path)) return "dependencies";
  if (TEST_FILE.test(path)) return "tests";
  if (CI_BUILD.test(path)) return "ci/build";
  if (MIGRATION_FILE.test(path)) return "migrations";
  if (BENIGN_BINARY.test(path) || OPAQUE_BINARY.test(path)) return "assets";
  if (CONFIG_FILE.test(path)) return "config";
  return "source";
}

/** Classify a path into a sensitivity category (checked in priority order). */
export function sensitiveCategory(path: string): string | null {
  if (DEP_MANIFEST.test(path)) return "dependencies";
  // A markdown/rst file is never executable CI config or an install hook —
  // .github/CONTRIBUTING.md flagged as ci/build in the watchdog corpus.
  if (DOC_FILE.test(path)) return null;
  // Nor is project metadata: AUTHORS matches the auth/crypto keyword list and
  // an undocumented contributor-list change then fired a critical flag.
  if (PROJECT_META.test(path) || SITE_METADATA.test(path) || isChangelogPath(path)) return null;
  if (CI_BUILD.test(path)) return "ci/build";
  // Tests about auth are not auth code (forwardauth_test.go would match the
  // keyword list and cap honest releases at "questionable" — release notes
  // never document test-only changes).
  if (TEST_FILE.test(path)) return null;
  if (AUTH_CRYPTO.test(path)) return "auth/crypto";
  return null;
}


function fileCoverageMap(data: ReleaseData, coverage: Coverage | null): Map<string, FileCoverage> {
  const map = new Map<string, FileCoverage>();
  if (!coverage) {
    for (const f of data.files) map.set(f.path, "unknown");
    return map;
  }
  const touching = new Map<string, { covered: number; uncovered: number }>();
  for (const [sha, files] of coverage.commitFiles) {
    const isCovered = coverage.coveredShas.has(sha);
    for (const f of files) {
      const t = touching.get(f.path) ?? { covered: 0, uncovered: 0 };
      if (isCovered) t.covered++;
      else t.uncovered++;
      touching.set(f.path, t);
    }
  }
  for (const f of data.files) {
    if (coverage.evidenceFiles.has(f.path)) {
      map.set(f.path, "evidence");
      continue;
    }
    const t = touching.get(f.path);
    // NOTE: a file touched by both covered and uncovered commits counts as
    // covered — an attacker could hide behind a documented commit here; the
    // uncovered commit itself still shows up in the reverse check.
    if (!t) map.set(f.path, "unknown");
    else if (t.covered === 0) map.set(f.path, "undocumented");
    else map.set(f.path, "covered");
  }
  return map;
}

/**
 * The judge was asked about this claim and could not answer, so the milder
 * deterministic reading stood in. One predicate for both consumers — the
 * release's own `judge-unavailable` flag and the watch record whose streak
 * rule reads it — because a report saying "2 unjudged" next to a record
 * counting three would make the streak detector unfalsifiable.
 */
const judgeFellBack = (r: ClaimResult): boolean => r.judgeFailed === true;

/** How many claims of this release fell back to the deterministic reading. */
export function unjudgedClaims(results: ClaimResult[]): number {
  return results.filter(judgeFellBack).length;
}

export function buildFlags(
  data: ReleaseData,
  results: ClaimResult[],
  coverage: Coverage | null,
  files: FileInsight[],
  churnCoveredRatio: number | null,
): RiskFlag[] {
  const flags: RiskFlag[] = [];
  const shasFor = (paths: string[]): string[] => {
    if (!coverage) return [];
    const shas = new Set<string>();
    for (const [sha, cfiles] of coverage.commitFiles) {
      if (cfiles.some((f) => paths.includes(f.path))) shas.add(sha);
    }
    return [...shas].slice(0, 5);
  };

  flags.push(...bumpMismatchFlags(data.baseRef, data.headRef, data.commits));

  const contradicted = results.filter((r) => r.verdict === "contradicted");
  if (contradicted.length) {
    flags.push({
      severity: "critical",
      kind: "contradicted-claim",
      message: `${contradicted.length} claim(s) contradicted by the diff: ${contradicted
        .map((r) => `"${r.claim.text.slice(0, 60)}"`)
        .join("; ")}`,
      files: [],
      commitShas: [],
    });
  }

  // A judge that cannot answer leaves the deterministic fallback standing,
  // and that fallback is by construction the milder reading. Not answering
  // must therefore never be quietly better for the release than answering:
  // say how many claims went unjudged, on the record.
  const unjudged = results.filter(judgeFellBack);
  if (unjudged.length) {
    flags.push({
      severity: "warn",
      kind: "judge-unavailable",
      message:
        `${unjudged.length} claim(s) fell back to the deterministic reading — the judge could not answer: ` +
        `${unjudged[0].reasoning.match(/LLM judge failed: ([^)]*)/)?.[1] ?? "unknown error"}`,
      files: [],
      commitShas: [],
    });
  }

  const noEvidence = results.filter(
    (r) => r.verdict === "no-evidence" && r.claim.kind === "change",
  );
  if (noEvidence.length) {
    flags.push({
      severity: "warn",
      kind: "unsupported-claim",
      message: `${noEvidence.length} claim(s) with no supporting evidence in the diff`,
      files: [],
      commitShas: [],
    });
  }

  // Reverse-direction audit results: notable changes hidden behind vague notes.
  // Only auth/crypto surplus is critical — undocumented CI tweaks and
  // dependency bumps behind a vague note are routine, not an attack signature.
  for (const r of results) {
    const notable = (r.surplus ?? []).filter((s) => s.notable);
    if (!notable.length) continue;
    const touchesAuth = notable.some((s) => sensitiveCategory(s.file) === "auth/crypto");
    flags.push({
      severity: touchesAuth ? "critical" : "warn",
      kind: "vague-claim-surplus",
      message: `Vague note "${r.claim.text.slice(0, 50)}" hides: ${notable
        .map((s) => s.description)
        .slice(0, 3)
        .join("; ")}`,
      files: [...new Set(notable.map((s) => s.file).filter(Boolean))].slice(0, 6),
      commitShas: r.evidence.commitShas.slice(0, 3),
    });
  }

  // Undocumented changes in sensitive areas — the fake-release signature.
  const byCategory = new Map<string, string[]>();
  for (const f of files) {
    if (f.coverage === "undocumented" && f.sensitive) {
      byCategory.set(f.sensitive, [...(byCategory.get(f.sensitive) ?? []), f.path]);
    }
  }
  for (const [category, paths] of byCategory) {
    // Changelogs routinely omit lockfile/CI churn (git-cliff even filters it
    // by design) — only silent auth/crypto changes are an attack signature.
    //
    // And only when the notes are otherwise complete. The signature is "the
    // notes look like a full account, but the auth change is missing" — not
    // "the notes cover a fraction of the release and auth is in the rest".
    // At 158 and 187 commits (zed, traefik) some undocumented sensitive path
    // is near-certain, so a critical there measures release size, not risk;
    // the completeness component already charges for the gap.
    const specific = churnCoveredRatio === null || churnCoveredRatio >= WELL_DOCUMENTED;
    flags.push({
      severity: category === "auth/crypto" && specific ? "critical" : "warn",
      kind: "undocumented-sensitive",
      message:
        `Undocumented changes in ${category} paths` +
        (category === "auth/crypto" && !specific
          ? ` (${Math.round(churnCoveredRatio! * 100)}% of this release is documented — read the completeness gap, not this path alone)`
          : ""),
      files: paths.slice(0, 8),
      commitShas: shasFor(paths),
    });
  }

  const coverageOf = new Map(files.map((f) => [f.path, f.coverage]));
  for (const f of data.files) {
    const deps = newDependencies(f, data.repoLabel);
    if (deps.length) {
      const documented = coverageOf.get(f.path) !== "undocumented";
      flags.push({
        severity: documented ? "info" : "critical",
        kind: "new-dependency",
        message: `New dependenc${deps.length > 1 ? "ies" : "y"} in ${f.path}: ${deps.join(", ")}${documented ? "" : " — not covered by any note"}`,
        files: [f.path],
        commitShas: shasFor([f.path]),
      });
    }
    const sources = lockfileSources(f);
    if (sources.length) {
      const documented = coverageOf.get(f.path) !== "undocumented";
      flags.push({
        severity: documented ? "warn" : "critical",
        kind: "lockfile-source",
        message: `Non-registry resolution source in ${f.path}: ${sources.join(", ")}${documented ? "" : " — not covered by any note"}`,
        files: [f.path],
        commitShas: shasFor([f.path]),
      });
    }
    const opaque = opacityIssue(f);
    if (opaque) {
      const documented = coverageOf.get(f.path) === "evidence" || coverageOf.get(f.path) === "covered";
      flags.push({
        severity: documented ? "warn" : "critical",
        kind: "opaque-change",
        message: `${opaque}: ${f.path}${documented ? "" : " — not covered by any note"}`,
        files: [f.path],
        commitShas: shasFor([f.path]),
      });
    }
  }

  const order = { critical: 0, warn: 1, info: 2 };
  return flags.sort((a, b) => order[a.severity] - order[b.severity]);
}

/**
 * Once the release's shape explains the misses, "unsupported claim" is the
 * wrong finding — it charges a risk penalty for something nobody could have
 * done better. The flag stays (the claims really are unchecked) but drops to
 * info and says why.
 */
export function demoteUnsupportedFlag(
  flags: RiskFlag[],
  unverifiable: Unverifiable | null,
): RiskFlag[] {
  if (!unverifiable) return flags;
  return flags.map((f) =>
    f.kind === "unsupported-claim"
      ? {
          ...f,
          severity: "info" as const,
          kind: "not-verifiable",
          message: f.message.replace(
            /with no supporting evidence in the diff$/,
            "not checkable against this repo's diff",
          ),
        }
      : f,
  );
}

export function computeScores(
  results: ClaimResult[],
  churnCoveredRatio: number | null,
  flags: RiskFlag[],
  unverifiable = false,
): Scores {
  // Text repeated verbatim from the base release describes the product, not
  // this release — it asserts nothing new to be right or wrong about.
  // "skipped" is the verdict for text that asserts nothing about this release
  // — informational entries, and lines carried over verbatim that anchor
  // nowhere in this range. A carried-over line that DOES anchor here was
  // checked like any other and is scored like any other.
  const all = results.filter((r) => r.claim.kind === "change" && r.verdict !== "skipped");
  // Claims nobody could have checked must not score 0 — that is the value a
  // *contradicted* claim gets, and it would rank a docs-only or fork release
  // exactly like a fabricated one. They drop out of the ratio instead.
  const change = unverifiable ? all.filter((r) => r.verdict !== "no-evidence") : all;
  // Auto-generated PR-list entries are true by construction (generated from
  // the same commits we check) — they carry little weight; handwritten claims
  // are where release notes can actually lie.
  const weightOf = (r: ClaimResult): number => (r.generated ? 0.25 : 1);
  const totalWeight = change.reduce((s, r) => s + weightOf(r), 0);
  const points = change.reduce(
    (s, r) =>
      s + weightOf(r) * (r.verdict === "verified" ? 1 : r.verdict === "partial" ? 0.5 : 0),
    0,
  );
  const correctness = totalWeight ? Math.round((points / totalWeight) * 100) : 100;
  const completeness =
    churnCoveredRatio === null ? null : Math.round(churnCoveredRatio * 100);
  const penalty = flags.reduce(
    (s, f) => s + (f.severity === "critical" ? 25 : f.severity === "warn" ? 10 : 0),
    0,
  );
  const risk = Math.max(0, 100 - penalty);

  let overall =
    completeness === null
      ? Math.round(0.6 * correctness + 0.4 * risk)
      : Math.round(0.45 * correctness + 0.25 * completeness + 0.3 * risk);
  // Hard caps: fabricated claims or critical risk must not average away.
  if (results.some((r) => r.verdict === "contradicted")) overall = Math.min(overall, 35);
  else if (flags.some((f) => f.severity === "critical")) overall = Math.min(overall, 45);

  // Claims dropped out of the ratio: correctness then means "nothing was
  // found wrong", not "the notes were checked and hold". Calling that "solid"
  // would be the mirror of the bug this carve-out fixes — the score must read
  // as unknown, not as a clean bill of health. It is also the whole prize an
  // attacker plays for: three cultivated releases with notes that miss their
  // own diff turn a 25 into a 100 without touching this release at all.
  if (unverifiable && all.length && change.length < all.length) {
    return {
      correctness,
      completeness,
      risk,
      overall: Math.min(overall, UNVERIFIED_CAP),
      label: "unverified",
    };
  }
  const label =
    overall >= SCORE_SOLID
      ? "solid"
      : overall >= SCORE_MINOR
        ? "minor gaps"
        : overall >= SCORE_QUESTIONABLE
          ? "questionable"
          : "suspicious";
  return { correctness, completeness, risk, overall, label };
}

export interface ScoreStep {
  label: string;
  /** Signed contribution; 0 for the start and final markers. */
  delta: number;
  /** Running total after this step. */
  total: number;
  kind: "start" | "component" | "cap" | "adjustment" | "final";
  detail?: string;
}

/**
 * The overall score step by step — SCORING.md as numbers: a perfect 100,
 * minus each component's weighted gap, minus the hard cap that binds.
 * Derived from the report's own stored scores and flags so the rendering
 * cannot invent numbers; if a scoring change ever breaks the
 * reconciliation, the residual surfaces as its own "adjustment" step
 * instead of silently mislabeling the bars.
 */
export function scoreBreakdown(report: Report): ScoreStep[] {
  const s = report.metrics.scores;
  const flags = report.metrics.flags;
  const wCorrectness = s.completeness === null ? 0.6 : 0.45;
  const wRisk = s.completeness === null ? 0.4 : 0.3;
  const steps: ScoreStep[] = [];
  let total = 100;
  steps.push({ label: "perfect release", delta: 0, total, kind: "start" });
  const deduct = (kind: "component" | "cap", label: string, to: number, detail?: string) => {
    const delta = to - total;
    total = to;
    steps.push({ label, delta, total, kind, ...(detail ? { detail } : {}) });
  };
  deduct(
    "component",
    `correctness ${s.correctness} × ${wCorrectness}`,
    total - wCorrectness * (100 - s.correctness),
    "weighted share of claims the diff supports",
  );
  if (s.completeness !== null) {
    deduct(
      "component",
      `completeness ${s.completeness} × 0.25`,
      total - 0.25 * (100 - s.completeness),
      "churn-weighted share of commits the notes cover",
    );
  }
  const crit = flags.filter((f) => f.severity === "critical").length;
  const warn = flags.filter((f) => f.severity === "warn").length;
  // The last component lands on computeScores' own weighted-sum expression,
  // not on another chain of subtractions: the two differ in the last ulp,
  // and at an exact x.5 that is the difference between rounding up and down.
  const weighted =
    s.completeness === null
      ? 0.6 * s.correctness + 0.4 * s.risk
      : 0.45 * s.correctness + 0.25 * s.completeness + 0.3 * s.risk;
  // The itemization is derived from the flag list, the number from the
  // stored risk — flags can be appended after scoring (check.ts does, at
  // info), so assert the ledger actually reconciles before printing it as
  // the explanation.
  const itemized = Math.max(0, 100 - (25 * crit + 10 * warn));
  deduct(
    "component",
    `risk ${s.risk} × ${wRisk}`,
    weighted,
    crit || warn
      ? itemized === s.risk
        ? `${crit} critical × −25 · ${warn} warn × −10${s.risk === 0 ? " (floored at 0)" : ""}`
        : `the flag list does not itemize the stored risk of ${s.risk} — flags recorded after scoring carry no penalty`
      : "no flag penalties",
  );
  // The caps mirror computeScores exactly: contradicted else critical, and
  // the unverified cap on top — each only when it actually binds.
  if (report.results.some((r) => r.verdict === "contradicted") && Math.round(total) > 35) {
    deduct("cap", "hard cap: contradicted claim", 35, "a claim the diff disproves caps the release at 35");
  } else if (flags.some((f) => f.severity === "critical") && Math.round(total) > 45) {
    deduct("cap", "hard cap: critical risk flag", 45, "a critical finding caps the release at 45");
  }
  if (s.label === "unverified" && Math.round(total) > 65) {
    deduct("cap", "hard cap: unverified", 65, "claims nobody could check must not read better than checked-with-gaps");
  }
  if (Math.round(total) !== s.overall) {
    const delta = s.overall - total;
    total = s.overall;
    steps.push({
      label: "unexplained adjustment",
      delta,
      total,
      kind: "adjustment",
      detail: "the derivation no longer reconciles with the reported score — please file a bug",
    });
  }
  steps.push({ label: `${s.overall}/100 ${s.label}`, delta: 0, total: s.overall, kind: "final" });
  return steps;
}

/**
 * Per-identity activity in one release, keyed like the baseline's author
 * check (email across sources). Facts for display and for the watch
 * ledger — never a score input: the flags that DO score (new-author,
 * email-spoof) live in baselineFlags and are unchanged by this.
 */
export function authorActivity(
  commits: Commit[],
  commitFiles: Map<string, DiffFile[]> | null,
): AuthorActivity[] {
  const byKey = new Map<string, AuthorActivity>();
  for (const commit of commits) {
    const key = authorKey(commit);
    let a = byKey.get(key);
    if (!a) {
      a = { key, name: commit.author, commits: 0, sensitiveCommits: 0, binaryCommits: 0 };
      byKey.set(key, a);
    }
    a.commits++;
    a.name = commit.author;
    if (commit.login !== undefined && !(a.logins ?? []).includes(commit.login)) {
      a.logins = [...(a.logins ?? []), commit.login];
    }
    const files = commitFiles?.get(commit.sha) ?? [];
    if (files.some((f) => sensitiveCategory(f.path) !== null)) a.sensitiveCommits++;
    if (files.some((f) => opacityIssue(f) === "binary file")) a.binaryCommits++;
  }
  // Busiest first; ties keep commit order — deterministic either way.
  return [...byKey.values()].sort((x, y) => y.commits - x.commits);
}

/** Anomalies relative to the repo's own release history. */
export function baselineFlags(
  data: ReleaseData,
  coverage: Coverage | null,
  baseline: Baseline,
): RiskFlag[] {
  const flags: RiskFlag[] = [];
  if (baseline.snapshots.length < 3) return flags;
  const n = baseline.snapshots.length;

  const churn = data.files.reduce((s, f) => s + f.additions + f.deletions, 0);
  if (baseline.medianChurn > 0 && churn > 3 * baseline.medianChurn) {
    flags.push({
      severity: "info",
      kind: "size-anomaly",
      message: `Release churn ±${churn} is ${(churn / baseline.medianChurn).toFixed(1)}× the median (±${baseline.medianChurn}) of the last ${n} releases`,
      files: [],
      commitShas: [],
    });
  }

  if (coverage) {
    // Identity is the git-header email (authorKey): API logins and git names
    // never match across sources, so the compare-truncation clone fallback
    // used to make every author look new. Both the compare API and a clone
    // carry the email, and a snapshot cached before emails existed retires
    // with its version stamp.
    const known = new Set(baseline.knownAuthors);
    const suspects = data.commits.filter(
      (commit) =>
        !known.has(authorKey(commit)) &&
        !known.has(commit.author) &&
        (coverage.commitFiles.get(commit.sha) ?? []).some((f) => sensitiveCategory(f.path)),
    );
    if (suspects.length) {
      const names = [...new Set(suspects.map((commit) => `@${commit.author}`))].join(", ");
      flags.push({
        severity: "warn",
        kind: "new-author-sensitive",
        message: `First-time author(s) changing sensitive paths (not seen in the last ${n} releases): ${names}`,
        files: [],
        commitShas: suspects.map((commit) => commit.sha).slice(0, 5),
      });
    }

    // The email above is attacker-chosen; the forge account is not. On API
    // sources a known email must therefore not settle identity by itself.
    // The discriminating signal is the PAIRING: an email this repo's history
    // always saw attributed to one account, now arriving attributed to a
    // different account or to none. An email that was never linked to any
    // account is an ordinary shape (authors commit with unregistered
    // addresses all the time) and stays quiet — a flat "known logins" set
    // could not tell those two apart and warned on honest maintainers.
    const spoofs = data.commits.filter((commit) => {
      if (commit.login === undefined) return false; // clone source — no attribution
      const email = commit.email?.trim().toLowerCase();
      const expected = email ? baseline.emailAccounts[email] : undefined;
      return (
        expected !== undefined &&
        commit.login !== expected &&
        (coverage.commitFiles.get(commit.sha) ?? []).some((f) => sensitiveCategory(f.path))
      );
    });
    if (spoofs.length) {
      const who = [
        ...new Set(
          spoofs.map(
            (commit) =>
              `${authorKey(commit)} (expected @${baseline.emailAccounts[commit.email!.trim().toLowerCase()]}, got ${commit.login ? `@${commit.login}` : "no account"})`,
          ),
        ),
      ].join(", ");
      flags.push({
        severity: "warn",
        kind: "author-email-spoof",
        message:
          `Commit(s) on sensitive paths carry an author email this repo's last ${n} releases ` +
          `always saw attributed to a different forge account — the git email is forgeable, ` +
          `the account is not: ${who}`,
        files: [],
        commitShas: spoofs.map((commit) => commit.sha).slice(0, 5),
      });
    }
  }

  const binaries = data.files.filter((f) => opacityIssue(f) === "binary file");
  if (binaries.length && !baseline.everBinary) {
    flags.push({
      severity: "critical",
      kind: "first-binary",
      message: `First binary artifact in the last ${n + 1} releases`,
      files: binaries.map((f) => f.path).slice(0, 6),
      commitShas: [],
    });
  }
  return flags;
}

export function computeMetrics(opts: {
  data: ReleaseData;
  results: ClaimResult[];
  coverage: Coverage | null;
  context: RepoContext;
  baseline?: Baseline | null;
}): Metrics {
  const { data, results, coverage, context } = opts;
  const covMap = fileCoverageMap(data, coverage);
  const files: FileInsight[] = data.files.map((f) => ({
    path: f.path,
    churn: f.additions + f.deletions,
    sensitive: sensitiveCategory(f.path),
    coverage: covMap.get(f.path) ?? "unknown",
    functions: f.patch ? hunkFunctions(f.patch).slice(0, 10) : undefined,
  }));

  let churnCoveredRatio: number | null = null;
  // A commit whose diff could not be fetched contributes no churn, so it
  // leaves the ratio's denominator entirely — and the fewer commits a run
  // manages to read, the better documented the release looks. That is the one
  // direction this tool must never move in, so an unreadable commit makes
  // completeness unknown instead of flattering: null takes the same route a
  // release with --no-reverse takes, where the score reads as not measured
  // rather than as measured and clean.
  if (coverage && coverage.unreadableShas.size === 0) {
    let total = 0;
    let covered = 0;
    for (const [sha, cfiles] of coverage.commitFiles) {
      if (coverage.mergeShas.has(sha)) continue;
      const churn = cfiles.reduce((s, f) => s + f.additions + f.deletions, 0);
      total += churn;
      if (coverage.coveredShas.has(sha)) covered += churn;
    }
    churnCoveredRatio = total ? covered / total : 1;
  }

  const measured = buildFlags(data, results, coverage, files, churnCoveredRatio);
  if (opts.baseline) measured.push(...baselineFlags(data, coverage, opts.baseline));
  // Classify against the flags as measured — a critical finding about THIS
  // release outranks any benign pattern in the repo's history.
  const unverifiable = classifyUnverifiable(data, results, measured, opts.baseline ?? null);
  const flags = demoteUnsupportedFlag(measured, unverifiable);
  const order = { critical: 0, warn: 1, info: 2 };
  flags.sort((a, b) => order[a.severity] - order[b.severity]);
  const scores = computeScores(results, churnCoveredRatio, flags, unverifiable !== null);

  let baseline: Metrics["baseline"] = null;
  if (opts.baseline?.snapshots.length) {
    const coverages = opts.baseline.snapshots
      .map((s) => s.anchoredCoverage)
      .sort((a, b) => a - b);
    baseline = {
      releases: opts.baseline.snapshots.length,
      medianChurn: opts.baseline.medianChurn,
      medianAnchoredCoverage: coverages[Math.floor(coverages.length / 2)],
      // buildSnapshots returns newest first; a trend reads oldest→newest.
      snapshots: [...opts.baseline.snapshots].reverse().map((s) => ({
        tag: s.tag,
        churn: s.additions + s.deletions,
        coverage: s.anchoredCoverage,
      })),
    };
  }
  return { scores, flags, files, churnCoveredRatio, context, baseline, unverifiable };
}
