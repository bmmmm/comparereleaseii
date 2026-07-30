// SPDX-License-Identifier: GPL-3.0-or-later
// Reading dependency manifests out of a diff: which packages a release added,
// where a lockfile now pulls from, and when a vendored blob changed without a
// readable source. Ecosystem-specific text parsing (Cargo.toml, package.json,
// lockfiles) that knows nothing about scoring — buildFlags asks it questions
// and turns the answers into flags.
import type { DiffFile } from "./types.ts";

/** Files that declare what a project depends on. */
export const DEP_MANIFEST =
  /(^|\/)(Cargo\.(toml|lock)|package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|go\.(mod|sum)|requirements[^/]*\.txt|pyproject\.toml|Pipfile(\.lock)?|Gemfile(\.lock)?|composer\.(json|lock)|pom\.xml|build\.gradle(\.kts)?)$/;

/** Binaries a reviewer cannot read but which carry no supply-chain weight. */
export const BENIGN_BINARY = /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|eot|pdf)$/i;

/** Binaries whose contents no reviewer can read — the ones worth a flag when
 * they change without a note. */
const OPAQUE_BINARY = /\.(bin|exe|so|dylib|dll|jar|wasm|class|pyc|o|a|zip|gz|tgz|tar|7z)$/i;

function addedLines(patch: string): string[] {
  // "+++ " (with a space) is the file header; the space-less guard also
  // dropped added lines whose content starts with "++".
  return patch
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++ "))
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
 * A git source resolved to a full commit id. Cargo and npm both append the
 * resolved sha as the URL fragment, so this is the lockfile saying "and this
 * is the exact tree I got".
 */
const PINNED_COMMIT = /#[0-9a-f]{40}(?![0-9a-f])/i;

/**
 * Resolution sources a lockfile introduces that are not a package registry:
 * a tarball on someone's own host, a git or filesystem reference.
 *
 * newDependencies() skips lockfiles on purpose — their names only restate the
 * manifest's. But a resolution hijack does not change a name: the manifest
 * keeps asking for an ordinary package and the lockfile points the download
 * somewhere else, which left the deterministic supply-chain check blind to
 * the shape it exists for.
 *
 * A git source carrying its resolved commit is not that shape. What the flag
 * is looking for is a source whose *content can change after review* — a
 * branch, a moving tag, a tarball URL. A 40-hex commit is the content, so the
 * only thing left to notice is a new supplier, which is `newDependencies()`'s
 * job. Vendoring a forked crate pinned by rev is ordinary in Rust and Tauri
 * projects, and flagging it cost cjpais/Handy v0.9.4 ten risk points for
 * `git+https://github.com/cjpais/tao?rev=…`, one of its own repositories.
 */
export function lockfileSources(file: DiffFile): string[] {
  if (!file.patch || !LOCKFILE.test(file.path)) return [];
  const found = new Set<string>();
  for (const line of addedLines(file.patch)) {
    if (line.includes(CARGO_INDEX)) continue;
    const proto = line.match(/\b(git\+[a-z]+|git|ssh|file|link|portal):(\/\/)?[^\s"',;)}\]]+/i);
    if (proto && !/^https?:$/i.test(proto[1])) {
      if (!PINNED_COMMIT.test(proto[0])) found.add(proto[0].slice(0, 80));
      continue;
    }
    for (const m of line.matchAll(/https?:\/\/([^/\s"',;)}\]]+)[^\s"',;)}\]]*/gi)) {
      if (!KNOWN_REGISTRY.test(m[1]) && !PINNED_COMMIT.test(m[0])) found.add(m[0].slice(0, 80));
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
