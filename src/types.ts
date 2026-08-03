// SPDX-License-Identifier: GPL-3.0-or-later

export interface Commit {
  sha: string;
  subject: string;
  body: string;
  author: string;
  /**
   * Git-header email — the cross-source identity key. Names and API logins
   * never match across sources; noreply addresses are per-account stable.
   */
  email?: string;
  /**
   * Forge account the commit is attributed to. Only API sources can answer:
   * a login string, or null when the forge maps the email to no account.
   * Clone sources leave it undefined — no attribution exists there. The
   * email is attacker-chosen while the login is not, so "known email, no
   * known login" is the spoofing signature baselineFlags warns about.
   */
  login?: string | null;
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
  /**
   * The base release's own notes, when the source can supply them. Notes that
   * repeat their predecessor verbatim describe the product, not this release.
   */
  baseNotes?: string;
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

/** A forward-looking commitment in release notes — checked against LATER releases. */
export interface ClaimPromise {
  kind: "removal" | "addition";
  /** Release the promise names ("v2.0"), or "next" for "the next release". */
  target?: string;
}

/** One promise from an earlier release, checked against this release's diff. */
export interface PromiseCheck {
  text: string;
  /** Tag whose notes made the promise. */
  from: string;
  kind: ClaimPromise["kind"];
  target?: string;
  /** `stale`: carried unresolved for so long the ledger stops tracking it. */
  status: "kept" | "broken" | "still-open" | "stale";
  /**
   * Releases this promise has been carried across without resolving. A
   * target-less promise can never break, so without this it would ride the
   * watch ledger forever.
   */
  carriedFor?: number;
  /** Files whose diff decided a kept verdict. */
  files: string[];
  note: string;
}

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
  /**
   * Tag of the earlier release whose notes already carried this exact text —
   * a standing product description, not an assertion about this release.
   */
  carriedOverFrom?: string;
  /** Set when the claim commits to a FUTURE change ("will be removed in 2.0"). */
  promise?: ClaimPromise;
}

export type Verdict =
  | "verified"
  | "partial"
  | "no-evidence"
  | "contradicted"
  | "skipped";

/**
 * What a judge can actually answer. `skipped` is bookkeeping the pipeline
 * assigns itself — meta claims, text carried over from an earlier release —
 * and no judge ever produces it, so the vote-resolution code must not have
 * to pretend it might.
 */
export type JudgedVerdict = Exclude<Verdict, "skipped">;

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
  /**
   * The judge was asked and could not answer (transport error, or output
   * that is not a verdict). The result then falls back to the deterministic
   * reading, which is by construction the milder one — so this has to be
   * visible in the report, not only in the reasoning string.
   */
  judgeFailed?: boolean;
  /** Auto-generated notes entry (PR-list boilerplate), down-weighted in scoring. */
  generated: boolean;
  /** Changes hidden behind a vague claim (reverse-direction audit). */
  surplus?: SurplusItem[];
}

/**
 * One version pin this release moves: a dependency-manifest entry, a
 * Makefile variable, a Dockerfile tag, a versioned download URL. For a
 * third-party dependency a bump is routine; for a first-party component the
 * bump IS a release whose substance lives in the pinned repo, not in this
 * diff. Informational, never scored.
 */
export interface PinBump {
  /** The pin's own spelling: module path, image path, variable name, owner/repo. */
  name: string;
  from: string;
  to: string;
  file: string;
  /** owner/repo the pin demonstrably points at — its own path/URL, or the
   * components config. Absent when the pin names no repository (a crate, a
   * pypi package, a bare variable without a config entry). */
  repo?: string;
  /** The pinned repo shares the checked repo's owner, or the components
   * config lists this pin as part of the product. */
  firstParty: boolean;
  /** Web page of the bumped-to version. Built only when the repo is known
   * and the host's URL shape is — github.com, or the checked repo's own
   * forge. Never guessed for foreign hosts. */
  releaseUrl?: string;
  /**
   * Where the pinned repo's releases can be loaded from — set only when the
   * host is certain: github.com, the checked repo's own forge, or the URL
   * the components config spelled out. A registry path (docker hub, npm)
   * names no forge, so it never gets one. This is what first-party
   * expansion checks out.
   */
  repoUrl?: string;
}

/**
 * Depth-1 sub-check of a first-party component whose pin this release
 * bumps: the same pipeline over the component's own (from, to) range,
 * summarized. The component's pins are listed in its own report but never
 * expanded further. Informational — the parent score never reads it.
 */
export interface ComponentCheck {
  /** Repo short name when known, else the pin's own spelling. */
  name: string;
  /** owner/repo slug of the component. */
  repo: string;
  from: string;
  to: string;
  /** Refs the child load actually resolved (tag-prefix retry may normalize). */
  baseRef?: string;
  headRef?: string;
  stats?: { commits: number; files: number; additions: number; deletions: number };
  score?: number;
  scoreLabel?: string;
  claims?: Record<Verdict, number>;
  uncovered?: number;
  surface?: ReleaseSurface;
  /** The child diff was incomplete — its surface understates the release. */
  truncated?: boolean;
  /** The child release carried no checkable notes — surface only. */
  noNotes?: boolean;
  /** Load or check failure; the pin line stands, this explains the gap. */
  error?: string;
}

export interface UncoveredCommit {
  commit: Commit;
  additions: number;
  deletions: number;
  fileCount: number;
  /** LLM-drafted release-note line for this commit (--suggest). */
  suggestedNote?: string;
  /**
   * Observed surface of the commit's own diff — symbols, config deltas,
   * category counts — so a silent change is described by what it touched,
   * not only by the subject line it chose for itself.
   */
  surface?: string;
}

/** Churn of one file category in the release diff. */
export interface CategoryChurn {
  category: string;
  files: number;
  additions: number;
  deletions: number;
}

/** Names one side of the diff introduced or dropped; moved lines cancel. */
export interface ConfigDelta {
  added: string[];
  removed: string[];
}

/**
 * What actually shipped, read deterministically off the diff — no LLM, no
 * scoring. The category rollup is total (every file lands in one bucket);
 * the config surface is extracted from changed lines only, so an unchanged
 * setting never appears here.
 */
export interface ReleaseSurface {
  categories: CategoryChurn[];
  /** Changed symbols from hunk headers, highest-churn files first. */
  symbols: string[];
  /** Distinct symbols beyond the cap — the cut is declared, never silent. */
  moreSymbols: number;
  /** Environment variables the code reads (os.Getenv/process.env/…). */
  envVars: ConfigDelta;
  /** `--flag` literals in source lines. */
  cliFlags: ConfigDelta;
  /** Keys in config-category files (yaml/toml/ini). */
  configKeys: ConfigDelta;
  /** Migration files touched. */
  migrations: string[];
  /** Route/handler/API-spec files touched. */
  apiRoutes: string[];
}

export type FindingKind = "breaking" | "security" | "behavior" | "feature" | "internal";

/** A repo's audience profile — who decides updates there (the S4a walk). */
export type Audience = "operator" | "integrator" | "user";

/**
 * Who a finding affects. `everyone` is the security audience: a security
 * finding renders under every lens — filing it under one role would hide
 * from the other lenses exactly the finding they most need to see.
 */
export type FindingAudience = Audience | "everyone";

/**
 * One typed observation of what the release diff ships, produced by the
 * judge engine reading the diff alone — blind to commit messages and notes
 * by construction: feeding it the message anchors it on the claim
 * (changelog circularity, generalized). Informational, never scored.
 */
export interface Finding {
  kind: FindingKind;
  audience: FindingAudience;
  /** One concrete sentence — what changed, observed, never intent. */
  text: string;
  /** Paths carrying the change. */
  files: string[];
  /** Subsystem whose diff pass produced it. */
  subsystem: string;
}

/** What the findings pass read vs. skipped — the declared remainder. */
export interface FindingsBudget {
  maxChars: number;
  usedChars: number;
  subsystemsRead: number;
  subsystemsTotal: number;
  filesRead: number;
  filesTotal: number;
}

export interface FindingsSection {
  findings: Finding[];
  /** Release-level rollup, synthesized from the findings alone. */
  summary?: string;
  budget: FindingsBudget;
  /** Subsystem passes that failed — their findings are missing, not empty. */
  errors?: string[];
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
    /** Oldest→newest, for trend rendering — medians alone hide the shape. */
    snapshots: Array<{ tag: string; churn: number; coverage: number }>;
  } | null;
}

/**
 * One identity's activity within a single release — facts only, stated
 * neutrally. This never carries a judgement: "trusted contributor" is
 * exactly the false comfort the xz backdoor exploited, and "suspicious"
 * is an accusation built from heuristics. The reader gets numbers.
 */
export interface AuthorActivity {
  /** Cross-source identity key — lowercased git-header email, name fallback. */
  key: string;
  /** Display name from the git header (latest spelling). */
  name: string;
  /**
   * Distinct forge attributions seen in this release. Absent when the
   * source carries no attribution at all (clone); `null` inside the list
   * means the forge explicitly mapped the email to no account.
   */
  logins?: Array<string | null>;
  commits: number;
  /** Commits touching at least one sensitive path (deps, CI, auth/crypto). */
  sensitiveCommits: number;
  /** Commits changing opaque binary files. */
  binaryCommits: number;
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
  /** URL path dialect: GitLab spells commit/compare routes with a `/-/`. */
  linkStyle?: "github" | "gitlab";
  /** Earlier releases' promises checked against this diff — informational, never scored. */
  promises?: PromiseCheck[];
  /** Per-identity activity in this release — informational, never scored. */
  authors?: AuthorActivity[];
  /** Version pins this release moves, first-party components first — informational, never scored. */
  pins?: PinBump[];
  /** What actually shipped, read deterministically off the diff — informational, never scored. */
  surface?: ReleaseSurface;
  /** Depth-1 sub-checks of first-party pin bumps — informational, never scored. */
  components?: ComponentCheck[];
  /** Typed findings the judge engine read off the diff — informational, never scored. */
  findings?: FindingsSection;
  /**
   * The repo's default lens (per-repo `audience:` config, or --lens): which
   * audience's findings render first. A view property — the findings list
   * itself always carries every audience.
   */
  audience?: Audience;
}
