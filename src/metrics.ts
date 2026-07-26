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
// SVG is markup, not a picture: it carries <script> and event handlers, and a
// site that ships one ships code. It belongs nowhere near "benign binary".
const BENIGN_BINARY = /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|eot|pdf)$/i;
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

function addedLines(patch: string): string[] {
  return patch
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1));
}

/** Dependency name in a manifest line, per file format — null if none. */
function depName(line: string, path: string): string | null {
  const trimmed = line.trim();
  if (/Cargo\.toml$/.test(path) || /package\.json$/.test(path)) {
    // Handled by cargoDeps / packageJsonDeps — both need block context, not a
    // single line: `version = "0.1.0"` under [package] is crate metadata, and
    // reading it as a dependency named "version" fires a critical flag on
    // every new crate in a workspace (seen live on zed).
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

/** `[package]`/`[workspace.package]` keys whose values look like versions. */
const CARGO_META_KEYS = new Set([
  "name", "version", "edition", "license", "license-file", "description",
  "repository", "homepage", "documentation", "readme", "keywords",
  "categories", "authors", "publish", "rust-version", "build", "links",
  "exclude", "include", "default-run", "resolver", "workspace", "path",
]);

/**
 * Cargo dependency names on one diff side. Like package.json, this needs the
 * section: a `[package]` block's `version`/`edition` keys look exactly like
 * dependency entries. Covers `[dependencies]`, `[dev-/build-dependencies]`,
 * `[workspace.dependencies]`, `[target.'cfg(…)'.dependencies]`, and the
 * single-crate form `[dependencies.serde]`.
 */
function cargoDeps(patch: string, sign: "+" | "-"): string[] {
  const names: string[] = [];
  let section: string | null = null;
  let tableDep: string | null = null;
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("@@")) {
      section = null;
      tableDep = null;
      continue;
    }
    if (!/^[+\- ]/.test(raw) || raw.startsWith("+++") || raw.startsWith("---")) continue;
    const line = raw.slice(1).trim();
    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) {
      section = header[1];
      // [dependencies.serde] names the dependency in the header itself.
      const table = section.match(/(?:^|\.)dependencies\.([\w-]+)$/);
      tableDep = table ? table[1] : null;
      if (tableDep && raw.startsWith(sign)) names.push(tableDep);
      continue;
    }
    if (tableDep || !raw.startsWith(sign)) continue;
    // `serde = "1.0"`, `serde = { version = … }`, `anyhow.workspace = true`.
    const m = line.match(/^([\w-]+)(\.[\w-]+)?\s*=\s*(.*)$/);
    if (!m) continue;
    // `anyhow.workspace = true` points at the workspace root's declaration —
    // a member crate picking up an already-declared dependency adds no
    // supplier. A genuinely new one appears in the root Cargo.toml, which is
    // then its own file in the diff (zed: 4 criticals for existing crates).
    if (m[2] === ".workspace" || /^\{[^}]*\bworkspace\s*=\s*true/.test(m[3])) continue;
    if (section !== null) {
      if (/(^|\.)dependencies$/.test(section)) names.push(m[1]);
      continue;
    }
    // Section unknown (its header fell outside the hunk's context lines):
    // fall back to the shape of the value — a version literal or a table
    // with a version key — and drop the well-known [package] keys, whose
    // values look exactly the same.
    if (CARGO_META_KEYS.has(m[1])) continue;
    if (/^"[\^~=]?\d|^\{.*version/.test(m[3])) names.push(m[1]);
  }
  return names;
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

/** Module path without its Go major suffix: "example.com/x/v5" → "example.com/x". */
function moduleRoot(name: string): string {
  return name.replace(/\/v[0-9]+$/, "");
}

/**
 * Is this name just another face of something the manifest already had? A Go
 * major bump (`lego/v4` → `lego/v5`) and a submodule of an existing dependency
 * (`gateway-api` → `gateway-api/conformance`) both add a *line*, not a
 * supplier — flagging them as a new dependency puts routine upgrades next to
 * an injected package. Both seen live on traefik.
 */
function sameSupplier(name: string, known: Set<string>): boolean {
  const root = moduleRoot(name);
  for (const k of known) {
    const kr = moduleRoot(k);
    if (kr === root || root.startsWith(`${kr}/`) || kr.startsWith(`${root}/`)) return true;
  }
  return false;
}

/**
 * Heuristic: dependency names added to a manifest in this diff.
 *
 * `repoLabel` (owner/repo) lets the check drop the project's own modules: Go
 * monorepos split packages into local modules wired with `replace … => ./path`,
 * whose code is right there in the diff — a supply-chain flag on those is
 * noise (traefik's `github.com/traefik/traefik/dynamic/ext`).
 */
export function newDependencies(file: DiffFile, repoLabel?: string): string[] {
  if (!file.patch || !DEP_MANIFEST.test(file.path)) return [];
  if (/\.(lock|sum)$|-lock\.(json|yaml)$|Pipfile\.lock$/.test(file.path)) return [];
  if (/package\.json$/.test(file.path)) {
    const removed = new Set(packageJsonDeps(file.patch, "-"));
    return [...new Set(packageJsonDeps(file.patch, "+"))].filter((n) => !removed.has(n));
  }
  if (/Cargo\.toml$/.test(file.path)) {
    const removed = new Set(cargoDeps(file.patch, "-"));
    return [...new Set(cargoDeps(file.patch, "+"))].filter((n) => !removed.has(n));
  }
  // A version bump shows the same dependency name on a removed line — parse
  // both sides with the same format-aware extractor (a substring check misses
  // go.mod's "name vX.Y.Z" layout and fabricates "new" dependencies).
  // Context lines are the manifest's untouched stock: what stood there before
  // is what tells a genuinely new supplier from a second line for an old one.
  const known = new Set<string>();
  for (const raw of file.patch.split("\n")) {
    if (!/^[- ]/.test(raw) || raw.startsWith("---")) continue;
    const name = depName(raw.slice(1), file.path);
    if (name) known.add(name);
  }
  const self = repoLabel ? `${repoLabel.split("/").slice(-2).join("/")}` : null;
  const deps: string[] = [];
  for (const line of addedLines(file.patch)) {
    const name = depName(line, file.path);
    if (!name || known.has(name)) continue;
    if (self && moduleRoot(name).includes(self)) continue;
    if (sameSupplier(name, known)) continue;
    deps.push(name);
  }
  return [...new Set(deps)];
}

const LOCKFILE = /(\.lock|\.sum)$|-lock\.(json|ya?ml)$/;

/** Hosts a lockfile is supposed to resolve from. */
const KNOWN_REGISTRY =
  /^(registry\.(npmjs\.org|yarnpkg\.com|npmmirror\.com)|(static\.)?crates\.io|(files\.)?pythonhosted\.org|pypi\.org|proxy\.golang\.org|sum\.golang\.org|rubygems\.org|packagist\.org|repo\.?1?\.?maven\.(org|apache\.org)|registry\.bower\.io)$/i;

/** Cargo names the crates.io index by its git URL — that one host is fine. */
const CARGO_INDEX = "registry+https://github.com/rust-lang/crates.io-index";

/**
 * Resolution sources a lockfile introduces that are not a package registry:
 * a tarball on someone's own host, a git or filesystem reference.
 *
 * newDependencies() skips lockfiles on purpose — their names only restate the
 * manifest's. But a resolution hijack does not change a name: the manifest
 * keeps asking for an ordinary package and the lockfile points the download
 * somewhere else, which left the deterministic supply-chain check blind to
 * the shape it exists for.
 */
export function lockfileSources(file: DiffFile): string[] {
  if (!file.patch || !LOCKFILE.test(file.path)) return [];
  const found = new Set<string>();
  for (const line of addedLines(file.patch)) {
    if (line.includes(CARGO_INDEX)) continue;
    const proto = line.match(/\b(git\+[a-z]+|git|ssh|file|link|portal):(\/\/)?[^\s"',;)}\]]+/i);
    if (proto && !/^https?:$/i.test(proto[1])) {
      found.add(proto[0].slice(0, 80));
      continue;
    }
    for (const m of line.matchAll(/https?:\/\/([^/\s"',;)}\]]+)[^\s"',;)}\]]*/gi)) {
      if (!KNOWN_REGISTRY.test(m[1])) found.add(m[0].slice(0, 80));
    }
  }
  return [...found].slice(0, 6);
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
  const unjudged = results.filter((r) => r.judgeFailed);
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
    };
  }
  return { scores, flags, files, churnCoveredRatio, context, baseline, unverifiable };
}
