// SPDX-License-Identifier: GPL-3.0-or-later
// The mechanical substance layer: what actually shipped, read off the diff
// deterministically — file-category rollup, changed symbols from hunk
// headers, config surface (env reads, CLI flags, config keys), migrations,
// API-route files. No LLM and no scoring: these are the facts a later
// summarization stage compresses, and a --judge off run carries them whole.
import { hunkFunctions } from "./match.ts";
import { fileCategory } from "./metrics.ts";
import { sideLines } from "./pins.ts";
import type { ConfigDelta, DiffFile, ReleaseSurface } from "./types.ts";

/** Environment-variable reads, per language idiom. Go struct tags carry
 * several names in one tag (`env:"OC_X;OCIS_X"`), split after matching. */
const ENV_READS = [
  /\bos\.(?:Getenv|LookupEnv)\(\s*"([A-Z][A-Z0-9_]+)"/g,
  /\bprocess\.env(?:\.([A-Z][A-Z0-9_]+)\b|\[["']([A-Z][A-Z0-9_]+)["']\])/g,
  /\benv::var(?:_os)?\(\s*"([A-Z][A-Z0-9_]+)"/g,
  /\bos\.environ(?:\.get\(\s*|\[)["']([A-Z][A-Z0-9_]+)["']/g,
  /\bos\.getenv\(\s*["']([A-Z][A-Z0-9_]+)["']/g,
  /\bENV(?:\.fetch\(\s*|\[)["']([A-Z][A-Z0-9_]+)["']/g,
  /\benv:"([A-Z][A-Z0-9_;,]+)"/g,
];

function envReads(line: string): string[] {
  const out: string[] = [];
  for (const re of ENV_READS) {
    for (const m of line.matchAll(re)) {
      const hit = m[1] ?? m[2];
      if (hit) out.push(...hit.split(/[;,]/).filter(Boolean));
    }
  }
  return out;
}

/** `--flag` literals. CSS custom properties spell the same prefix, so style
 * files are excluded at the caller. */
const FLAG_LITERAL = /(?<![\w-])--([a-z][a-z0-9]+(?:-[a-z0-9]+)*)\b/g;
const STYLE_FILE = /\.(css|scss|sass|less|styl)$/i;

function flagLiterals(line: string): string[] {
  return [...line.matchAll(FLAG_LITERAL)].map((m) => `--${m[1]}`);
}

/** Top-level-ish keys in config files. YAML wants a space after the colon;
 * a list item's key (`- name: x`) is an entry, not a setting — skipped. */
const YAML_KEY = /^\s{0,4}([A-Za-z_][\w.-]*):(\s|$)/;
const TOML_KEY = /^\s*([A-Za-z_][\w.-]*)\s*=/;
const TOML_SECTION = /^\s*\[\[?([^\]]+?)\]?\]\s*(?:#.*)?$/;

function configKeys(line: string, path: string): string[] {
  if (/\.ya?ml$/i.test(path)) {
    const m = line.match(YAML_KEY);
    return m ? [m[1]] : [];
  }
  const section = line.match(TOML_SECTION);
  if (section) return [section[1]];
  const m = line.match(TOML_KEY);
  return m ? [m[1]] : [];
}

/** Hostname out of an `http(s)://` literal. The lookahead is what ends a
 * host inside real source: a path, a closing quote, a paren, a separator. */
const URL_HOST = /https?:\/\/([a-z0-9.-]+\.[a-z]{2,})(?=[/"'`\s):,]|$)/gi;

/** Schema, licence and placeholder hosts. They sit in headers, XML
 * namespaces and doc comments of every codebase, so they fire on every
 * release and discriminate nothing. RFC 2606/6761 reserves the last three. */
const BORING_HOST =
  /^(www\.)?(w3\.org|schemas?\..*|xmlns\..*|example\.(com|org)|localhost|apache\.org|gnu\.org|opensource\.org|creativecommons\.org|json-schema\.org|purl\.org|xml\.org|ns\.adobe\.com|specifications\.freedesktop\.org|schema\.org)$|\.(example|test|invalid)$/;

/** A vendored tree is someone else's code — its hosts are not this release's. */
const VENDORED_PATH = /(^|\/)(vendor|node_modules)\//;

/** Test doubles that `fileCategory` still calls source: a mock host is not
 * product traffic, and carrying it would put msw.dev in a release report. */
const TEST_PATH =
  /(^|\/)(test|tests|__tests__|spec|e2e|testdata|fixtures?|mocks?)(\/|\.)|_test\.go$|\.test\.|\.spec\./i;

function urlHosts(line: string): string[] {
  return [...line.matchAll(URL_HOST)]
    .map((m) => m[1].toLowerCase())
    .filter((h) => !BORING_HOST.test(h));
}

const API_ROUTE_FILE =
  /(^|\/)(routes?|routers?|handlers?|controllers?|endpoints?)(\/|\.[a-z0-9]+$)|(^|\/)urls\.py$|(^|\/)openapi\.(ya?ml|json)$|swagger/i;

const churnOf = (f: DiffFile): number => f.additions + f.deletions;

/** Set difference on both sides: what one side has that the other lacks.
 * A name on both sides is a moved line, not a surface change. */
function delta(minus: Set<string>, plus: Set<string>): ConfigDelta {
  return {
    added: [...plus].filter((k) => !minus.has(k)).sort(),
    removed: [...minus].filter((k) => !plus.has(k)).sort(),
  };
}

interface Extracted {
  env: ConfigDelta;
  flags: ConfigDelta;
  keys: ConfigDelta;
  hosts: ConfigDelta;
}

/** Config surface over a set of files, moved lines cancelled per release —
 * a read relocated to another file is refactoring, not a new setting. */
function configSurface(files: DiffFile[]): Extracted {
  const env = { minus: new Set<string>(), plus: new Set<string>() };
  const flags = { minus: new Set<string>(), plus: new Set<string>() };
  const keys = { minus: new Set<string>(), plus: new Set<string>() };
  const hosts = { minus: new Set<string>(), plus: new Set<string>() };
  for (const f of files) {
    if (!f.patch) continue;
    const category = fileCategory(f.path);
    if (category !== "source" && category !== "config") continue;
    const ownTraffic =
      category === "source" && !VENDORED_PATH.test(f.path) && !TEST_PATH.test(f.path);
    for (const sign of ["-", "+"] as const) {
      const side = sign === "-" ? "minus" : "plus";
      for (const line of sideLines(f.patch, sign)) {
        if (category === "source") {
          for (const v of envReads(line)) env[side].add(v);
          if (!STYLE_FILE.test(f.path)) for (const v of flagLiterals(line)) flags[side].add(v);
          if (ownTraffic) for (const h of urlHosts(line)) hosts[side].add(h);
        } else {
          for (const k of configKeys(line, f.path)) keys[side].add(k);
        }
      }
    }
  }
  return {
    env: delta(env.minus, env.plus),
    flags: delta(flags.minus, flags.plus),
    keys: delta(keys.minus, keys.plus),
    hosts: delta(hosts.minus, hosts.plus),
  };
}

const SYMBOL_CAP = 12;

/** Changed symbols, highest-churn source files first, cap declared. */
function symbolDelta(files: DiffFile[]): { symbols: string[]; more: number } {
  const source = files
    .filter((f) => f.patch && fileCategory(f.path) === "source")
    .sort((a, b) => churnOf(b) - churnOf(a));
  const all = new Set<string>();
  const shown: string[] = [];
  for (const f of source) {
    for (const fn of hunkFunctions(f.patch!)) {
      if (all.has(fn)) continue;
      all.add(fn);
      if (shown.length < SYMBOL_CAP) shown.push(fn);
    }
  }
  return { symbols: shown, more: all.size - shown.length };
}

/**
 * What actually shipped, read deterministically off the diff. Purely
 * informational: renderers show it, the score never reads it.
 */
export function releaseSurface(files: DiffFile[]): ReleaseSurface {
  const byCategory = new Map<string, { files: number; additions: number; deletions: number }>();
  for (const f of files) {
    const cat = fileCategory(f.path);
    const t = byCategory.get(cat) ?? { files: 0, additions: 0, deletions: 0 };
    t.files++;
    t.additions += f.additions;
    t.deletions += f.deletions;
    byCategory.set(cat, t);
  }
  const categories = [...byCategory.entries()]
    .map(([category, t]) => ({ category, ...t }))
    .sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions));

  const { symbols, more } = symbolDelta(files);
  const { env, flags, keys, hosts } = configSurface(files);
  const isRoute = (f: DiffFile): boolean =>
    API_ROUTE_FILE.test(f.path) && ["source", "config"].includes(fileCategory(f.path));
  return {
    categories,
    symbols,
    moreSymbols: more,
    envVars: env,
    cliFlags: flags,
    configKeys: keys,
    hosts,
    migrations: files.filter((f) => fileCategory(f.path) === "migrations").map((f) => f.path),
    apiRoutes: files.filter(isRoute).map((f) => f.path),
  };
}

/**
 * One line describing a commit by its observed surface — what the diff
 * touched, not what the subject line chose to say. For the uncovered list:
 * a silent change gets described by observation.
 */
export function commitSurface(files: DiffFile[]): string | undefined {
  if (!files.length) return undefined;
  return surfaceLine(releaseSurface(files));
}

/** The same observation, compacted from an already-computed surface —
 * shared with the component-check summary renderers. */
export function surfaceLine(s: ReleaseSurface): string | undefined {
  const parts: string[] = [];
  const tally = s.categories
    .slice(0, 3)
    .map((c) => `${c.files} ${c.category}`)
    .join(", ");
  if (tally) parts.push(tally);
  if (s.symbols.length) {
    const shown = s.symbols.slice(0, 3).join(", ");
    const rest = s.moreSymbols + Math.max(0, s.symbols.length - 3);
    parts.push(`fns ${shown}${rest > 0 ? ` +${rest}` : ""}`);
  }
  for (const v of s.envVars.added.slice(0, 2)) parts.push(`+env ${v}`);
  for (const v of s.envVars.removed.slice(0, 2)) parts.push(`−env ${v}`);
  for (const v of s.cliFlags.added.slice(0, 2)) parts.push(`+flag ${v}`);
  for (const v of s.cliFlags.removed.slice(0, 2)) parts.push(`−flag ${v}`);
  for (const k of s.configKeys.added.slice(0, 2)) parts.push(`+key ${k}`);
  for (const k of s.configKeys.removed.slice(0, 2)) parts.push(`−key ${k}`);
  for (const h of s.hosts?.added.slice(0, 2) ?? []) parts.push(`+host ${h}`);
  for (const h of s.hosts?.removed.slice(0, 2) ?? []) parts.push(`−host ${h}`);
  if (s.migrations.length) parts.push(`migration${s.migrations.length > 1 ? "s" : ""}`);
  if (s.apiRoutes.length) parts.push("api routes");
  return parts.join(" · ") || undefined;
}
