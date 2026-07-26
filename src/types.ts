// SPDX-License-Identifier: GPL-3.0-or-later

export interface Commit {
  sha: string;
  subject: string;
  body: string;
  author: string;
  prNumbers: number[];
}

export interface DiffFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export interface ReleaseData {
  repoLabel: string;
  baseRef: string;
  headRef: string;
  notes: string;
  commits: Commit[];
  files: DiffFile[];
  /** Lazily resolve the per-commit diff (cached by the source). */
  commitFiles(sha: string): Promise<DiffFile[]>;
  /**
   * Resolve a PR number to its merge/squash commit sha — for repos that
   * squash without a "(#N)" suffix, where message matching finds nothing.
   */
  resolvePr?(n: number): Promise<string | null>;
  warnings: string[];
  /** Diff or commit list is incomplete (API caps) — a local clone would fix it. */
  truncated?: boolean;
}

export type ClaimKind = "change" | "meta";

export interface Claim {
  id: number;
  section: string;
  text: string;
  kind: ClaimKind;
  prNumbers: number[];
  shas: string[];
  advisories: string[];
  codeSpans: string[];
  author?: string;
}

export type Verdict =
  | "verified"
  | "partial"
  | "no-evidence"
  | "contradicted"
  | "skipped";

export type MatchMethod =
  | "pr-anchor"
  | "sha-anchor"
  | "lexical"
  | "llm"
  | "escalated"
  | "generated"
  | "none";

export interface Evidence {
  commitShas: string[];
  files: string[];
  matchedTerms: string[];
  methods: MatchMethod[];
  /** Functions touched, extracted from unified-diff hunk headers. */
  functions?: string[];
}

export interface SurplusItem {
  description: string;
  file: string;
  notable: boolean;
}

export interface ClaimResult {
  claim: Claim;
  verdict: Verdict;
  confidence: number;
  evidence: Evidence;
  reasoning: string;
  judged: boolean;
  /** Auto-generated notes entry (PR-list boilerplate), down-weighted in scoring. */
  generated: boolean;
  /** Changes hidden behind a vague claim (reverse-direction audit). */
  surplus?: SurplusItem[];
}

export interface UncoveredCommit {
  commit: Commit;
  additions: number;
  deletions: number;
  fileCount: number;
  /** LLM-drafted release-note line for this commit (--suggest). */
  suggestedNote?: string;
}

export type FlagSeverity = "critical" | "warn" | "info";

export interface RiskFlag {
  severity: FlagSeverity;
  kind: string;
  message: string;
  files: string[];
  commitShas: string[];
}

export type FileCoverage = "evidence" | "covered" | "undocumented" | "unknown";

export interface FileInsight {
  path: string;
  churn: number;
  sensitive: string | null;
  coverage: FileCoverage;
  functions?: string[];
}

export interface RepoContext {
  /** Bytes per language (GitHub languages API, or by-extension for local). */
  languages: Record<string, number> | null;
  codeBytes: number | null;
  releaseCadenceDays: number | null;
}

/**
 * Why a release's claims could not be checked against its own diff.
 *
 * `sourceless` — the diff contains no source file at all (docs-only bump,
 * changelog mirror of a closed-source product).
 * `out-of-repo` — the diff has source, but the notes describe code that
 * lives elsewhere: a fork shipping upstream features, a build or
 * distribution repo. Detected from the repo's own release history, never
 * from a single release.
 */
export type UnverifiableKind = "sourceless" | "out-of-repo";

export interface Unverifiable {
  kind: UnverifiableKind;
  /** Rendered verbatim in every report format — must stand on its own. */
  reason: string;
}

export interface Scores {
  correctness: number;
  completeness: number | null;
  risk: number;
  overall: number;
  label: string;
}

export interface Metrics {
  scores: Scores;
  flags: RiskFlag[];
  files: FileInsight[];
  churnCoveredRatio: number | null;
  context: RepoContext;
  /**
   * The claims could not be checked against this repo's diff at all — set
   * only when the *shape* of the release explains it. Distinct from claims
   * that were checked and found unsupported.
   */
  unverifiable: Unverifiable | null;
  /** Medians of the repo's own recent releases, for calibration. */
  baseline: {
    releases: number;
    medianChurn: number;
    medianAnchoredCoverage: number;
  } | null;
}

export interface Report {
  repoLabel: string;
  baseRef: string;
  headRef: string;
  stats: { commits: number; files: number; additions: number; deletions: number };
  results: ClaimResult[];
  uncovered: UncoveredCommit[];
  reverseChecked: boolean;
  metrics: Metrics;
  warnings: string[];
  /** Diff was incomplete (API caps) — external consumers need not string-match warnings. */
  truncated: boolean;
  engine: string;
  /** Web URL prefix for commit links, e.g. https://github.com/o/r — optional. */
  linkBase?: string;
}
