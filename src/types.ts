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

/**
 * A note line that asserts a version pin moved: "bump `actions/cache` from
 * 5.0.3 to 5.0.4", "Bump github.com/DataDog/dd-trace-go/v2 to 2.8.1". The
 * name is the pin's spelling as the note writes it, and `from` is absent
 * when the note gives only the destination — one side is enough to check.
 * Read off the text alone; nothing here has seen the diff.
 */
export interface ClaimBump {
  name: string;
  from?: string;
  to: string;
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
  /** Set when the claim states a version pin move — the class the pin join checks. */
  bump?: ClaimBump;
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
  /** The diff's own pin delta settled the claim — no judge was asked. */
  | "pin-anchor"
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
  /**
   * Every vote the independent verification passes returned, in the order
   * they came back, when that path ran at all. The default engine is the
   * `claude` CLI, which exposes no temperature or seed, so the sampling
   * variance behind a verdict cannot be pinned away — it can only be
   * recorded. Three identical passes disagreeing is the difference between a
   * finding and a coin flip, and until this field existed that difference
   * lived in one anecdote instead of in the data.
   */
  votes?: Verdict[];
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
  /**
   * Hosts the source calls over http(s). A release that starts talking to a
   * host nobody documented is a supply-chain fact; a call-site detector finds
   * nothing, because real codebases wrap their HTTP behind a client. Absent
   * in surfaces recorded before the field existed — an empty delta there
   * would claim the release added no host, which nobody measured.
   */
  hosts?: ConfigDelta;
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

/**
 * How the diff's own pin delta answers a bump claim.
 *
 * `confirmed` — the diff moves that pin and lands on the claimed version.
 * `overtaken` — the diff moves that pin PAST the claimed version. The note
 * correctly describes its own pull request while the release aggregates
 * several bumps of the same pin, so claim and evidence are cut at different
 * granularities. Nobody wrote anything false, and this must never read as a
 * contradiction.
 * `contradicted` — the pin moves the other way, or lands short of the
 * version the claim names.
 * `unmatched` — no pin of that name moved, or the two versions cannot be
 * ordered against each other; the claim stands as it was judged.
 */
export type BumpJoin = "confirmed" | "overtaken" | "contradicted" | "unmatched";

/** One bump claim held against the pin delta of the same diff. */
export interface BumpResolution {
  /** Index into report.results. */
  claim: number;
  status: BumpJoin;
  /** What the note said — the claim's own trait, repeated so a reader of
   * this list alone sees both numbers. */
  claimed: ClaimBump;
  /**
   * Where the note says the pin came FROM, against where the diff moves it
   * from. Absent when the note names no from-version, or when no pin matched.
   *
   * `exact` — the same starting point.
   * `later-hop` — inside the interval the pin traversed. The release
   * aggregates several bumps of this pin and the note describes one of them,
   * which is the documented-honest pattern: 26 of the 76 joinable
   * from-versions in the 108-release corpus, against 40 exact ones. Reading it
   * as a disagreement would flag the majority spelling of an honest note.
   * `outside` — a starting point this release neither held nor passed
   * through. The note states a move the diff does not make: a wider hop
   * (`fsnotify 1.8.0 → 1.10.1` where the release goes 1.9.0 → 1.10.1) or one
   * belonging to another release entirely. Rare — 10 of those 76, and 6 of
   * them are already contradicted on the destination alone.
   */
  fromCheck?: "exact" | "later-hop" | "outside";
  /** What the diff moved. Absent when unmatched. */
  observed?: {
    from: string;
    to: string;
    file: string;
    /**
     * The move is visible in the diff of the commit the note anchors to,
     * not in the release diff — which happens when the base already
     * carried the destination version, so the range cancels the move out.
     * The release still contains the commit that made it.
     */
    viaCommit?: boolean;
  };
}

/** One finding and the claims whose identifiers demonstrably describe it. */
export interface FindingClaimLink {
  /** Index into report.findings.findings. */
  finding: number;
  /** Indices into report.results, ascending. */
  claims: number[];
}

/**
 * The late join of claims and findings: computed after both sides exist,
 * so neither side's production ever read the other. `confirmed` findings
 * are claimed and observed; `undocumented` findings were observed but
 * never claimed — the interesting signal; `unsupported` claims are
 * asserted but no finding observes them, which reads against the declared
 * findings budget, not as a contradiction. Informational, never scored.
 */
export interface Reconciliation {
  confirmed: FindingClaimLink[];
  /** Indices into report.findings.findings no claim describes. */
  undocumented: number[];
  /** Indices into report.results (change-kind, not skipped) no finding observes. */
  unsupported: number[];
  /**
   * Bump claims held against the diff's own pin delta. Deterministic and
   * score-neutral like the rest of this layer, but computed early enough
   * that the verification ladder can read it — a claim the pins settle
   * needs no judge.
   */
  bumps?: BumpResolution[];
  /**
   * Display order for report.uncovered: commits sharing a file with an
   * undocumented finding first. Present only when it differs from the
   * stored order — a view property, the list itself is untouched.
   */
  uncoveredOrder?: number[];
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
  /**
   * Which set of scoring rules produced these numbers (`SCORING_GENERATION`
   * in `src/metrics.ts`). Absent in reports written before the marker existed
   * — a score from one generation is not comparable with a score from
   * another, and without this nobody can tell which is which after the fact.
   */
  scoringGeneration?: number;
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
  /** Claims joined against findings, late — informational, never scored. */
  reconciliation?: Reconciliation;
}
