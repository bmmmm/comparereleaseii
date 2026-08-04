// SPDX-License-Identifier: GPL-3.0-or-later
// The version-pin delta: changed lines that move a pinned version, as
// structured data (name, from → to, file). For a third-party dependency a
// bump is routine background; for a first-party component — the same org's
// repo pinned by a Makefile variable, an image tag or a download URL — the
// bump IS a release of the product, and its substance lives in the pinned
// repo, not in this diff (opencloud-eu/opencloud ships its entire frontend
// as one WEB_ASSETS_VERSION line). Deterministic and score-neutral: nothing
// here feeds the trust score.
import { DEP_MANIFEST, cargoDeps, depEntry, packageJsonDeps, type DepEntry } from "./deps.ts";
import type { ClaimBump, DiffFile, PinBump } from "./types.ts";

export interface PinContext {
  /** owner/repo of the checked repo — the owner match behind first-party. */
  repoLabel?: string;
  /**
   * Pin name → owner/repo (or repository URL) for pins that cannot identify
   * their target themselves — a bare WEB_ASSETS_VERSION names no repo.
   * Listing a pin declares it a component of the product: first-party.
   * Keys match the pin's `name` exactly.
   */
  components?: Record<string, string>;
  /** Web origin of the checked repo (https://host) — links components that
   * live on the same forge. */
  origin?: string;
  linkStyle?: "github" | "gitlab";
}

/** A value that names a release: v-prefixed, or dotted numeric. Bare
 * integers (ports, counts) and words are not versions. */
const VERSION_SHAPE = /^v\d[\w.+-]*$|^\d[\w-]*\.[\w.+-]+$/i;

/** Assignment variable names that plausibly hold a version pin. */
const PIN_NAME_HINT = /(VERSION|RELEASE|TAG)/i;

/** Makefile / shell / Dockerfile-ARG assignment with a single-token value. */
const ASSIGN =
  /^\s*(?:export\s+)?(?:ARG\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[:?+]?=\s*["']?([\w.+-]+)["']?\s*(?:#.*)?$/;

/** `FROM [--platform=…] image:tag [@digest] [AS stage]` — tag before any digest. */
const FROM_LINE =
  /^\s*FROM\s+(?:--platform=\S+\s+)?([^\s@]+):([\w][\w.-]*)(?:@\S+)?(?:\s+as\s+\S+)?\s*$/i;

const URL_IN_LINE = /https?:\/\/[^\s"'`<>|)\]}]+/g;

/** Suffix an URL's version segment may carry: `v1.2.3.tar.gz` pins v1.2.3. */
const ARCHIVE_EXT = /\.(tar\.(gz|bz2|xz|zst)|tgz|tbz2|zip|gz|xz)$/;

/** Files whose plain text carries pins: make, container builds, scripts. */
const PLAIN_PIN_FILE =
  /(^|\/)(GNUmakefile|[Mm]akefile(\.[\w.-]+)?|[\w.-]+\.mk|Dockerfile(\.[\w.-]+)?|Containerfile(\.[\w.-]+)?|[\w.-]+\.(dockerfile|sh|bash|zsh))$/;

const DOCKER_FILE = /(^|\/)(Dockerfile|Containerfile)(\.[\w.-]+)?$|\.dockerfile$/;

const LOCKFILE = /\.(lock|sum)$|-lock\.(json|ya?ml)$|Pipfile\.lock$/;

/** Content lines of one diff side, headers stripped. Shared with substance.ts. */
export function sideLines(patch: string, sign: "+" | "-"): string[] {
  const header = `${sign.repeat(3)} `;
  return patch
    .split("\n")
    .filter((l) => l.startsWith(sign) && !l.startsWith(header))
    .map((l) => l.slice(1));
}

/** Where a pin's path says it lives, when it says anything at all. */
interface PathCoords {
  host: string | null;
  owner: string;
  /** owner/repo — only meaningful as a forge slug when `linkable`. */
  repo: string;
  /** The path IS the repo (host/owner/repo, at most a /vN major suffix) —
   * safe to build a link from. A deeper module subpath tags differently. */
  linkable: boolean;
}

function pathCoords(name: string): PathCoords | null {
  const segs = name.split("/").filter(Boolean);
  if (segs.length >= 3 && segs[0].includes(".")) {
    const linkable = segs.length === 3 || (segs.length === 4 && /^v\d+$/.test(segs[3]));
    return { host: segs[0].toLowerCase(), owner: segs[1], repo: `${segs[1]}/${segs[2]}`, linkable };
  }
  // npm scope: @owner/pkg names the org; the package name is not a repo path.
  if (name.startsWith("@") && segs.length === 2) {
    return { host: null, owner: segs[0].slice(1), repo: name, linkable: false };
  }
  // Registry-less owner/image (docker hub): owner is real, the slug is a
  // registry name, not a forge repo — classification yes, link no.
  if (segs.length === 2 && !segs[0].includes(".") && !segs[0].includes(":")) {
    return { host: null, owner: segs[0], repo: name, linkable: false };
  }
  return null;
}

interface RawPin {
  name: string;
  from: string;
  to: string;
  coords?: PathCoords | null;
}

/** Pair one side's (name, version) entries against the other's. */
function pairEntries(before: DepEntry[], after: DepEntry[]): Array<{ name: string; from: string; to: string }> {
  const old = new Map<string, string>();
  for (const e of before) if (e.version) old.set(e.name, e.version);
  const bumps: Array<{ name: string; from: string; to: string }> = [];
  const seen = new Set<string>();
  for (const e of after) {
    if (!e.version || seen.has(e.name)) continue;
    const from = old.get(e.name);
    if (from === undefined || from === e.version) continue;
    seen.add(e.name);
    bumps.push({ name: e.name, from, to: e.version });
  }
  return bumps;
}

function manifestEntries(file: DiffFile, sign: "+" | "-"): DepEntry[] {
  if (/package\.json$/.test(file.path)) return packageJsonDeps(file.patch!, sign);
  if (/Cargo\.toml$/.test(file.path)) return cargoDeps(file.patch!, sign, { tableVersions: true });
  return sideLines(file.patch!, sign)
    .map((l) => depEntry(l, file.path))
    .filter((e): e is DepEntry => e !== null);
}

function manifestBumps(file: DiffFile): RawPin[] {
  return pairEntries(manifestEntries(file, "-"), manifestEntries(file, "+")).map((b) => ({
    ...b,
    coords: pathCoords(b.name),
  }));
}

/** Version-suggesting assignments and FROM tags on one line. */
function plainEntries(line: string, docker: boolean): DepEntry[] {
  const assign = line.match(ASSIGN);
  if (assign && PIN_NAME_HINT.test(assign[1]) && VERSION_SHAPE.test(assign[2])) {
    return [{ name: assign[1], version: assign[2] }];
  }
  if (docker) {
    const from = line.match(FROM_LINE);
    if (from && VERSION_SHAPE.test(from[2])) return [{ name: from[1], version: from[2] }];
  }
  return [];
}

interface UrlEntry extends DepEntry {
  coords: PathCoords | null;
}

/** URLs whose path carries a version segment, keyed with all digits blanked
 * — the same URL on both sides with only the version moved is a pin bump,
 * and the version usually repeats inside the asset filename
 * (…/v7.2.0/web-v7.2.0.tar.gz), so the key must survive that moving too. */
function urlEntries(line: string): Map<string, UrlEntry> {
  const found = new Map<string, UrlEntry>();
  for (const m of line.matchAll(URL_IN_LINE)) {
    const url = m[0].replace(/[.,;:]+$/, "").split(/[?#]/)[0];
    const segs = url.replace(/^https?:\/\//, "").split("/").filter(Boolean);
    const host = segs.shift()?.toLowerCase();
    if (!host || !host.includes(".")) continue;
    // The last whole-segment version is the release; an earlier one is an
    // API-path constant (/api/v2/…) that never moves.
    let version: string | null = null;
    let versionAt = -1;
    segs.forEach((seg, i) => {
      const bare = seg.replace(ARCHIVE_EXT, "");
      if (VERSION_SHAPE.test(bare)) {
        version = bare;
        versionAt = i;
      }
    });
    if (version === null) continue;
    // owner/repo are literal path segments only when the version sits deeper.
    const coords: PathCoords | null =
      versionAt >= 2
        ? { host, owner: segs[0], repo: `${segs[0]}/${segs[1]}`, linkable: true }
        : null;
    const name = coords ? (host === "github.com" ? coords.repo : `${host}/${coords.repo}`) : host;
    const key = `${host}/${segs.map((s) => s.replace(/\d+/g, "*")).join("/")}`;
    found.set(key, { name, version, coords });
  }
  return found;
}

function plainBumps(file: DiffFile): RawPin[] {
  const docker = DOCKER_FILE.test(file.path);
  const minus = sideLines(file.patch!, "-");
  const plus = sideLines(file.patch!, "+");
  const bumps = pairEntries(
    minus.flatMap((l) => plainEntries(l, docker)),
    plus.flatMap((l) => plainEntries(l, docker)),
  ).map((b): RawPin => ({ ...b, coords: docker ? pathCoords(b.name) : null }));

  const before = new Map<string, UrlEntry>();
  for (const l of minus) for (const [k, e] of urlEntries(l)) before.set(k, e);
  const seen = new Set(bumps.map((b) => b.name));
  for (const l of plus) {
    for (const [key, e] of urlEntries(l)) {
      const old = before.get(key);
      if (!old || old.version === e.version || seen.has(e.name)) continue;
      seen.add(e.name);
      bumps.push({ name: e.name, from: old.version!, to: e.version!, coords: e.coords });
    }
  }
  return bumps;
}

/** A `to` that can be a git tag: no build metadata, no Go pseudo-version. */
const TAG_SHAPE = /^v?\d[\w.-]*$/;
const PSEUDO_VERSION = /\d{14}-[0-9a-f]{7,}$/;

function releaseUrl(
  host: string | null,
  repo: string,
  to: string,
  ctx: PinContext,
): string | undefined {
  if (!TAG_SHAPE.test(to) || PSEUDO_VERSION.test(to)) return undefined;
  if (host === "github.com") return `https://github.com/${repo}/releases/tag/${to}`;
  const origin = ctx.origin?.replace(/\/+$/, "");
  const ownHost = origin?.replace(/^https?:\/\//, "").toLowerCase();
  if (!origin || !ownHost) return undefined;
  if (host !== null && host !== ownHost) return undefined;
  return ctx.linkStyle === "gitlab"
    ? `${origin}/${repo}/-/releases/${to}`
    : `${origin}/${repo}/releases/tag/${to}`;
}

/** `owner/repo` or a repository URL from the components config. */
function parseComponent(value: string): { host: string | null; repo: string } | null {
  const m = value.match(/^https?:\/\/([^/]+)\/([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  if (m) return { host: m[1].toLowerCase(), repo: m[2] };
  if (/^[\w.-]+\/[\w.-]+$/.test(value)) return { host: null, repo: value };
  return null;
}

/**
 * Where the component's releases can be loaded from — only when the host is
 * certain: github.com, or the checked repo's own forge. A bare slug (host
 * null, from the components config) lives on the same forge as the repo
 * that pins it; anything else stays unloadable rather than guessed.
 */
function sourceUrl(host: string | null, repo: string, ctx: PinContext): string | undefined {
  if (host === "github.com") return `https://github.com/${repo}`;
  const origin = ctx.origin?.replace(/\/+$/, "");
  if (!origin) return undefined;
  const ownHost = origin.replace(/^https?:\/\//, "").toLowerCase();
  if (host === null || host === ownHost) return `${origin}/${repo}`;
  return undefined;
}

function classify(pin: RawPin, file: string, ctx: PinContext): PinBump {
  const bump: PinBump = { name: pin.name, from: pin.from, to: pin.to, file, firstParty: false };
  const configured = ctx.components?.[pin.name];
  if (configured) {
    const target = parseComponent(configured);
    if (target) {
      bump.firstParty = true;
      bump.repo = target.repo;
      bump.releaseUrl = releaseUrl(target.host, target.repo, pin.to, ctx);
      // A config URL is the declared source verbatim; a slug defers to the
      // checked repo's own forge.
      bump.repoUrl = target.host
        ? configured.replace(/\.git\/?$/, "").replace(/\/+$/, "")
        : sourceUrl(null, target.repo, ctx);
      return bump;
    }
  }
  const owner = ctx.repoLabel?.includes("/") ? ctx.repoLabel.split("/")[0].toLowerCase() : null;
  if (pin.coords) {
    if (owner !== null && pin.coords.owner.toLowerCase() === owner) bump.firstParty = true;
    if (pin.coords.linkable) {
      bump.repo = pin.coords.repo;
      bump.releaseUrl = releaseUrl(pin.coords.host, pin.coords.repo, pin.to, ctx);
      bump.repoUrl = sourceUrl(pin.coords.host, pin.coords.repo, ctx);
    }
  }
  return bump;
}

/**
 * Every version pin this diff moves, first-party components first. Purely
 * informational: renderers show it, the score never reads it.
 */
export function pinBumps(files: DiffFile[], ctx: PinContext = {}): PinBump[] {
  const bumps: PinBump[] = [];
  for (const file of files) {
    if (!file.patch || LOCKFILE.test(file.path)) continue;
    const raw = DEP_MANIFEST.test(file.path)
      ? manifestBumps(file)
      : PLAIN_PIN_FILE.test(file.path)
        ? plainBumps(file)
        : [];
    for (const pin of raw) bumps.push(classify(pin, file.path, ctx));
  }
  return bumps.sort(
    (a, b) =>
      Number(b.firstParty) - Number(a.firstParty) ||
      a.file.localeCompare(b.file) ||
      a.name.localeCompare(b.name),
  );
}

/**
 * The claim side of the same fact: a note line stating that a pin moved.
 * Dependabot, Renovate and hand-written dependency sections all write it the
 * same few ways — "bump `actions/cache` from 5.0.3 to 5.0.4", "Update
 * dependency @types/node to v26.1.2", "Bump github.com/x/y to 2.8.1".
 *
 * A name alone is not enough to tell a pin from prose ("update the docs to
 * 3 sections"), so the name has to look like one: a path/scope/dotted
 * spelling, a backticked span, or a noun that says what it is. That keeps
 * "Upgrade Go to 1.24" out — a real bump claim whose name no manifest pin
 * carries either, so admitting it would only add a class that can never
 * join. A line naming several bumps yields the first: one claim, one pin.
 */
const BUMP_CLAIM =
  /\b(?:bump|bumps|bumped|upgrade|upgrades|upgraded|update|updates|updated)\s+(?:the\s+)?(?:(?:go|npm|rust|python|docker|helm)\s+)?((?:dependencies|dependency|crate|module|package|action|image|plugin|gem|library)\s+)?(`?)([A-Za-z0-9@][\w@./+-]*)\2(?:\s+from\s+`?(v?\d[\w.+-]*)`?)?\s+(?:to|→|->)\s+`?(v?\d[\w.+-]*)`?/i;

/** A pin name states what it is: a path, a scope, a dotted module, a version-suffixed one. */
const PIN_NAME_SHAPE = /[@/._-]/;

export function detectBumpClaim(text: string): ClaimBump | undefined {
  const m = text.match(BUMP_CLAIM);
  if (!m) return undefined;
  const [, noun, tick, name, from, to] = m;
  if (!VERSION_SHAPE.test(to)) return undefined;
  if (from !== undefined && !VERSION_SHAPE.test(from)) return undefined;
  if (!noun && !tick && !PIN_NAME_SHAPE.test(name)) return undefined;
  return from === undefined ? { name, to } : { name, from, to };
}
