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
  warnings: string[];
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

export type MatchMethod = "pr-anchor" | "sha-anchor" | "lexical" | "llm" | "none";

export interface Evidence {
  commitShas: string[];
  files: string[];
  matchedTerms: string[];
  methods: MatchMethod[];
}

export interface ClaimResult {
  claim: Claim;
  verdict: Verdict;
  confidence: number;
  evidence: Evidence;
  reasoning: string;
  judged: boolean;
}

export interface UncoveredCommit {
  commit: Commit;
  additions: number;
  deletions: number;
  fileCount: number;
}

export interface Report {
  repoLabel: string;
  baseRef: string;
  headRef: string;
  stats: { commits: number; files: number; additions: number; deletions: number };
  results: ClaimResult[];
  uncovered: UncoveredCommit[];
  reverseChecked: boolean;
  warnings: string[];
  engine: string;
}
