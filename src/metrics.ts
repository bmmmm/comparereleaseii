// SPDX-License-Identifier: GPL-3.0-or-later
import type {
  ClaimResult,
  DiffFile,
  FileCoverage,
  FileInsight,
  Metrics,
  ReleaseData,
  RepoContext,
  RiskFlag,
  Scores,
  Unverifiable,
} from "./types.ts";
import type { Coverage } from "./verify.ts";
import type { Baseline } from "./history.ts";
import { hunkFunctions, isChangelogPath } from "./match.ts";

const DEP_MANIFEST =
  /(^|\/)(Cargo\.(toml|lock)|package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|go\.(mod|sum)|requirements[^/]*\.txt|pyproject\.toml|Pipfile(\.lock)?|Gemfile(\.lock)?|composer\.(json|lock)|pom\.xml|build\.gradle(\.kts)?)$/;
const CI_BUILD =
  /(^|\/)\.(github|gitlab|circleci|woodpecker)\/|(^|\/)(Dockerfile[^/]*|Makefile|justfile|build\.rs|setup\.py|\.pre-commit-config\.yaml|Jenkinsfile)$|\.(gradle|cmake)$/i;
const AUTH_CRYPTO =
  /auth|crypto|token|password|passwd|secret|session|login|signin|permission|policy|acl|sanitiz|escape|csrf|ssrf|xss|jwt|oauth|sso|2fa|totp|webauthn|vault|key(chain|store)/i;
const DOC_FILE = /\.(md|markdown|rst|txt|adoc|org)$/i;
const TEST_FILE =
  /(^|\/)([\w-]*tests?|__tests__|spec|specs|testdata|fixtures)\/|_test\.[a-z0-9]+$|\.(test|spec)\.[a-z0-9]+$/i;
const BENIGN_BINARY = /\.(png|jpe?g|gif|svg|ico|webp|woff2?|ttf|eot|pdf)$/i;
const OPAQUE_BINARY = /\.(bin|exe|so|dylib|dll|jar|wasm|class|pyc|o|a|zip|gz|tgz|tar|7z)$/i;
const SITE_METADATA = /(^|\/)(feed|atom|rss|sitemap)\.xml$|\.(rss|atom)$/i;
const PROJECT_META =
  /(^|\/)(LICEN[SC]E|COPYING|NOTICE|AUTHORS|CONTRIBUTORS|CODEOWNERS|VERSION)([.-][\w.]+)?$/;

/**
 * Can this file's diff carry evidence for a claim about behaviour? Docs,
 * changelogs, feeds, project metadata and images cannot — there is no code in
 * them to anchor an identifier to.
 */
export function isSourceFile(path: string): boolean {
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

/** A repo whose notes habitually describe code outside its own diff. */
const OUT_OF_REPO_BASELINE = 0.25;
/** …and a release that follows that pattern: a strict majority of misses. */
const OUT_OF_REPO_RELEASE = 0.5;

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
  if (isSourcelessDiff(data.files)) {
    return {
      kind: "sourceless",
      reason:
        "This release's diff contains no source-code changes — claims could not be checked against code.",
    };
  }
  if (results.some((r) => r.verdict === "contradicted")) return null;
  if (flags.some((f) => f.severity === "critical")) return null;

  const change = results.filter((r) => r.claim.kind === "change");
  if (!change.length) return null;
  const missing = change.filter((r) => r.verdict === "no-evidence").length;
  if (missing / change.length <= OUT_OF_REPO_RELEASE) return null;

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

/** Classify a path into a sensitivity category (checked in priority order). */
export function sensitiveCategory(path: string): string | null {
  if (DEP_MANIFEST.test(path)) return "dependencies";
  // A markdown/rst file is never executable CI config or an install hook —
  // .github/CONTRIBUTING.md flagged as ci/build in the watchdog corpus.
  if (DOC_FILE.test(path)) return null;
  if (CI_BUILD.test(path)) return "ci/build";
  // Tests about auth are not auth code (forwardauth_test.go would match the
  // keyword list and cap honest releases at "questionable" — release notes
  // never document test-only changes).
  if (TEST_FILE.test(path)) return null;
  if (AUTH_CRYPTO.test(path)) return "auth/crypto";
  return null;
}

function addedLines(patch: string): string[] {
  return patch
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1));
}

/** Dependency name in a manifest line, per file format — null if none. */
function depName(line: string, path: string): string | null {
  const trimmed = line.trim();
  if (/Cargo\.toml$/.test(path)) {
    // Value must look like a version ("1.2", "^0.3") or a table with a
    // version key — otherwise [lints.*] entries (pedantic = "warn") match.
    return trimmed.match(/^([\w-]+)\s*=\s*(?:"[\^~=]?\d|\{.*version)/)?.[1] ?? null;
  }
  if (/package\.json$/.test(path)) {
    // Handled by packageJsonDeps — needs block context, not a single line.
    return null;
  }
  if (/go\.mod$/.test(path)) {
    return trimmed.match(/^(?:require\s+)?([\w./-]+\.[\w./-]+)\s+v\d/)?.[1] ?? null;
  }
  if (/requirements[^/]*\.txt$/.test(path)) {
    return trimmed.match(/^([\w.-]+)\s*[=<>~]/)?.[1] ?? null;
  }
  return null;
}

/** Well-known top-level package.json keys whose values can look like versions. */
const PKG_JSON_META_KEYS = new Set([
  "name", "version", "description", "license", "type", "main", "module",
  "types", "browser", "packageManager", "node", "npm", "pnpm", "yarn",
  "homepage", "repository", "bugs", "author", "private", "sideEffects",
]);

/**
 * package.json dependency names on one diff side. A dependency is a line
 * inside a `*dependencies` block — tracked via the `"key": {` openers visible
 * in the hunk. In small hunks whose opener fell outside the context lines the
 * section is unknown; then any versioned `"name": "…"` line counts, minus the
 * well-known top-level keys.
 */
function packageJsonDeps(patch: string, sign: "+" | "-"): string[] {
  const names: string[] = [];
  let section: string | null = null;
  let sectionIndent = 0;
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("@@")) {
      section = null;
      continue;
    }
    if (!/^[+\- ]/.test(raw) || raw.startsWith("+++") || raw.startsWith("---")) continue;
    const line = raw.slice(1);
    const opener = line.match(/^(\s*)"([\w.-]+)"\s*:\s*[{[]\s*$/);
    if (opener) {
      section = opener[2];
      sectionIndent = opener[1].length;
      continue;
    }
    const close = line.match(/^(\s*)[}\]]/);
    if (section !== null && close && close[1].length <= sectionIndent) {
      section = null;
      continue;
    }
    if (!raw.startsWith(sign)) continue;
    const inDeps = section !== null && /dependencies$/i.test(section);
    const unknownSection = section === null;
    if (!inDeps && !unknownSection) continue;
    const m = line.trim().match(/^"((?:@[\w.-]+\/)?[\w.-]+)"\s*:\s*"[^"]*\d/);
    if (!m) continue;
    if (unknownSection && PKG_JSON_META_KEYS.has(m[1])) continue;
    names.push(m[1]);
  }
  return names;
}

/** Heuristic: dependency names added to a manifest in this diff. */
export function newDependencies(file: DiffFile): string[] {
  if (!file.patch || !DEP_MANIFEST.test(file.path)) return [];
  if (/\.(lock|sum)$|-lock\.(json|yaml)$|Pipfile\.lock$/.test(file.path)) return [];
  if (/package\.json$/.test(file.path)) {
    const removed = new Set(packageJsonDeps(file.patch, "-"));
    return [...new Set(packageJsonDeps(file.patch, "+"))].filter((n) => !removed.has(n));
  }
  // A version bump shows the same dependency name on a removed line — parse
  // both sides with the same format-aware extractor (a substring check misses
  // go.mod's "name vX.Y.Z" layout and fabricates "new" dependencies).
  const removedNames = new Set(
    file.patch
      .split("\n")
      .filter((l) => l.startsWith("-") && !l.startsWith("---"))
      .map((l) => depName(l.slice(1), file.path))
      .filter(Boolean),
  );
  const deps: string[] = [];
  for (const line of addedLines(file.patch)) {
    const name = depName(line, file.path);
    if (name && !removedNames.has(name)) deps.push(name);
  }
  return [...new Set(deps)];
}

/** Opaque changes a human cannot review: binaries and minified blobs. */
export function opacityIssue(file: DiffFile): string | null {
  if (BENIGN_BINARY.test(file.path)) return null;
  if (OPAQUE_BINARY.test(file.path)) return "binary file";
  if (!file.patch && file.status !== "renamed" && file.additions + file.deletions === 0) {
    return "no reviewable patch";
  }
  if (/\.(js|css|map)$/.test(file.path) && file.patch) {
    if (addedLines(file.patch).some((l) => l.length > 800)) return "minified content";
  }
  if (file.patch && /(pre|post)install/.test(file.patch) && /package\.json$/.test(file.path)) {
    const hooks = addedLines(file.patch).filter((l) => /(pre|post)install/.test(l));
    if (hooks.length) return "install hook changed";
  }
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

function buildFlags(
  data: ReleaseData,
  results: ClaimResult[],
  coverage: Coverage | null,
  files: FileInsight[],
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
    flags.push({
      severity: category === "auth/crypto" ? "critical" : "warn",
      kind: "undocumented-sensitive",
      message: `Undocumented changes in ${category} paths`,
      files: paths.slice(0, 8),
      commitShas: shasFor(paths),
    });
  }

  const coverageOf = new Map(files.map((f) => [f.path, f.coverage]));
  for (const f of data.files) {
    const deps = newDependencies(f);
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
  const all = results.filter((r) => r.claim.kind === "change");
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

  // Every checkable claim dropped out: correctness 100 means "nothing was
  // found wrong", not "the notes were checked and hold". Calling that "solid"
  // would be the mirror of the bug this carve-out fixes — the score must read
  // as unknown, not as a clean bill of health.
  if (unverifiable && !change.length && all.length) {
    return { correctness, completeness, risk, overall, label: "unverified" };
  }
  const label =
    overall >= 85 ? "solid" : overall >= 65 ? "minor gaps" : overall >= 45 ? "questionable" : "suspicious";
  return { correctness, completeness, risk, overall, label };
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
    const known = new Set(baseline.knownAuthors);
    const suspects = data.commits.filter(
      (commit) =>
        !known.has(commit.author) &&
        (coverage.commitFiles.get(commit.sha) ?? []).some((f) => sensitiveCategory(f.path)),
    );
    if (suspects.length) {
      flags.push({
        severity: "warn",
        kind: "new-author-sensitive",
        message: `First-time author(s) changing sensitive paths (not seen in the last ${n} releases): ${[
          ...new Set(suspects.map((commit) => `@${commit.author}`)),
        ].join(", ")}`,
        files: [],
        commitShas: suspects.map((commit) => commit.sha).slice(0, 5),
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
  if (coverage) {
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

  const measured = buildFlags(data, results, coverage, files);
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
    };
  }
  return { scores, flags, files, churnCoveredRatio, context, baseline, unverifiable };
}
