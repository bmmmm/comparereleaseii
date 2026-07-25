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
} from "./types.ts";
import type { Coverage } from "./verify.ts";
import type { Baseline } from "./history.ts";
import { hunkFunctions } from "./match.ts";

const DEP_MANIFEST =
  /(^|\/)(Cargo\.(toml|lock)|package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|go\.(mod|sum)|requirements[^/]*\.txt|pyproject\.toml|Pipfile(\.lock)?|Gemfile(\.lock)?|composer\.(json|lock)|pom\.xml|build\.gradle(\.kts)?)$/;
const CI_BUILD =
  /(^|\/)\.(github|gitlab|circleci|woodpecker)\/|(^|\/)(Dockerfile[^/]*|Makefile|justfile|build\.rs|setup\.py|\.pre-commit-config\.yaml|Jenkinsfile)$|\.(gradle|cmake)$/i;
const AUTH_CRYPTO =
  /auth|crypto|token|password|passwd|secret|session|login|signin|permission|policy|acl|sanitiz|escape|csrf|ssrf|xss|jwt|oauth|sso|2fa|totp|webauthn|vault|key(chain|store)/i;
const BENIGN_BINARY = /\.(png|jpe?g|gif|svg|ico|webp|woff2?|ttf|eot|pdf)$/i;
const OPAQUE_BINARY = /\.(bin|exe|so|dylib|dll|jar|wasm|class|pyc|o|a|zip|gz|tgz|tar|7z)$/i;

/** Classify a path into a sensitivity category (checked in priority order). */
export function sensitiveCategory(path: string): string | null {
  if (DEP_MANIFEST.test(path)) return "dependencies";
  if (CI_BUILD.test(path)) return "ci/build";
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
    return trimmed.match(/^"((?:@[\w.-]+\/)?[\w.-]+)"\s*:\s*"[^"]*\d/)?.[1] ?? null;
  }
  if (/go\.mod$/.test(path)) {
    return trimmed.match(/^(?:require\s+)?([\w./-]+\.[\w./-]+)\s+v\d/)?.[1] ?? null;
  }
  if (/requirements[^/]*\.txt$/.test(path)) {
    return trimmed.match(/^([\w.-]+)\s*[=<>~]/)?.[1] ?? null;
  }
  return null;
}

/** Heuristic: dependency names added to a manifest in this diff. */
export function newDependencies(file: DiffFile): string[] {
  if (!file.patch || !DEP_MANIFEST.test(file.path)) return [];
  if (/\.(lock|sum)$|-lock\.(json|yaml)$|Pipfile\.lock$/.test(file.path)) return [];
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

export function computeScores(
  results: ClaimResult[],
  churnCoveredRatio: number | null,
  flags: RiskFlag[],
): Scores {
  const change = results.filter((r) => r.claim.kind === "change");
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

  const flags = buildFlags(data, results, coverage, files);
  if (opts.baseline) flags.push(...baselineFlags(data, coverage, opts.baseline));
  const order = { critical: 0, warn: 1, info: 2 };
  flags.sort((a, b) => order[a.severity] - order[b.severity]);
  const scores = computeScores(results, churnCoveredRatio, flags);

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
  return { scores, flags, files, churnCoveredRatio, context, baseline };
}
