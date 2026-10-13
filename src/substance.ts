// SPDX-License-Identifier: GPL-3.0-or-later
// The mechanical substance layer: what actually shipped, read off the diff
// deterministically — file-category rollup, changed symbols from hunk
// headers, config surface (env reads, CLI flags, config keys), migrations,
// API-route files. No LLM and no scoring: these are the facts a later
// summarization stage compresses, and a --judge off run carries them whole.
import { extractIdentifiers, hunkFunctions } from "./match.ts";
import { fileCategory } from "./metrics.ts";
import { sideLines } from "./pins.ts";
import type { Claim, ConfigDelta, DefaultChange, DiffFile, ReleaseSurface } from "./types.ts";

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
 * files are excluded at the caller. A Vue single-file component is one: all
 * 233 corpus occurrences in `.vue` files were custom properties, none a flag.
 * The cut is the extension and not the `<style>` block on purpose — a diff
 * arrives as hunks and cannot see where the block starts, and 7 of those 233
 * were outside it anyway (`:style` bindings, Tailwind arbitrary properties). */
const FLAG_LITERAL = /(?<![\w-])--([a-z][a-z0-9]+(?:-[a-z0-9]+)*)\b/g;
const STYLE_FILE = /\.(css|scss|sass|less|styl|vue)$/i;

function flagLiterals(line: string): string[] {
  return [...line.matchAll(FLAG_LITERAL)].map((m) => `--${m[1]}`);
}

/** Top-level-ish keys in config files. YAML wants a space after the colon;
 * a list item's key (`- name: x`) is an entry, not a setting — skipped.
 * JSON keys count at any depth: a settings file nests its sections, and
 * zed's removed `message_editor.auto_replace_emoji_shortcode` sat two in. */
const YAML_KEY = /^\s{0,4}([A-Za-z_][\w.-]*):(\s|$)/;
const TOML_KEY = /^\s*([A-Za-z_][\w.-]*)\s*=/;
const TOML_SECTION = /^\s*\[\[?([^\]]+?)\]?\]\s*(?:#.*)?$/;
const JSON_KEY = /^\s*"([^"]+)"\s*:/;

function configKeys(line: string, path: string): string[] {
  if (/\.ya?ml$/i.test(path)) {
    const m = line.match(YAML_KEY);
    return m ? [m[1]] : [];
  }
  if (JSON_FILE.test(path)) {
    const m = line.match(JSON_KEY);
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
export const VENDORED_PATH = /(^|\/)(vendor|node_modules)\//;

/** Test doubles that `fileCategory` still calls source: a mock host is not
 * product traffic, and carrying it would put msw.dev in a release report.
 * `_tests?\.<ext>$` is the Rust convention (`gateway_auth_login_tests.rs`):
 * without it that file read as auth source and took a findings slot. */
export const TEST_PATH =
  /(^|\/)(test|tests|__tests__|spec|e2e|integration|testdata|fixtures?|mocks?)(\/|\.)|_tests?\.[a-z0-9]+$|\.test\.|\.spec\./i;

/** Languages whose lines can dial out. `fileCategory`'s fallback bucket is
 * "source", so without this a metadata dotfile (.all-contributorsrc) ships
 * its contributor-profile URLs as the release's new traffic. */
const DIALING_SOURCE =
  /\.(ts|tsx|js|jsx|mjs|cjs|go|rs|py|swift|kt|java|rb|vue|c|cc|cpp|h|hpp|m|mm|cs|php|scala|ex|exs|zig|dart)$/i;

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
    // Settings-shaped JSON is a config file whatever fileCategory calls it.
    const keyFile = category === "config" || defaultsClass(f.path) === "config";
    const ownTraffic =
      category === "source" &&
      DIALING_SOURCE.test(f.path) &&
      !VENDORED_PATH.test(f.path) &&
      !TEST_PATH.test(f.path);
    // The same authorship boundary, on the field that leaked hardest: a
    // vendored test runner's `--headless` is not a flag this project's users
    // can pass. 24.7% of all corpus flag occurrences sat under vendor/.
    const ownFlags = category === "source" && !STYLE_FILE.test(f.path) && !VENDORED_PATH.test(f.path);
    for (const sign of ["-", "+"] as const) {
      const side = sign === "-" ? "minus" : "plus";
      for (const line of sideLines(f.patch, sign)) {
        if (keyFile) {
          for (const k of configKeys(line, f.path)) keys[side].add(k);
        } else {
          for (const v of envReads(line)) env[side].add(v);
          if (ownFlags) for (const v of flagLiterals(line)) flags[side].add(v);
          if (ownTraffic) for (const h of urlHosts(line)) hosts[side].add(h);
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

// ---------------------------------------------------------------------------
// Default changes: the same key, a different literal. The class openai/codex
// rust-v0.157.0 (`default_enabled: false → true`, named "background-server"
// in the notes) and OpenCloud 6.0.0 (`CleanStopWords: true → false`, named
// nowhere) belong to — a few changed characters that decide behaviour for
// every user, and that the config-key delta cancels as a moved line.

/** A literal in value position: boolean-ish word, number, quoted string. */
const VALUE_LITERAL =
  /\b(?:true|false|True|False|TRUE|FALSE|yes|no|on|off|null|nil|None)\b|(?<![\w.])-?\d+(?:\.\d+)?(?![\w.])|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;
/** A bare word after `:`/`=` that ends the value: a YAML scalar
 * (`dist: bookworm`), a Rust enum (`stage: Stage::Stable,`). */
const BARE_VALUE = /(?<=[:=]\s*)[A-Za-z_][\w:.]*(?=\s*(?:[,;)}\]]|$))/g;
/** In source a bare value must spell a constant — some segment capitalised
 * (`Stage::Stable`, `YES`, `cfg.EnableFavorites`). `response.enabled →
 * duoDetails.enabled` is a refactor's reassignment, and 13 of bitwarden
 * web-v2026.7.1's 14 source candidates were that shape. */
const CONSTANT_LIKE = /(^|::|\.)[A-Z]/;

/** Settings-shaped JSON: `fileCategory` calls every `.json` source, and
 * zed's `assets/settings/default.json` is the file a user's defaults live
 * in. The word has to sit in the basename or the parent directory —
 * `web-app-admin-settings/package.json` is a dependency manifest. */
const SETTINGS_WORD = /defaults?|settings|config|preferences|options/i;
const JSON_FILE = /\.json[c5]?$/i;
/** Compiler and linter settings are build tooling, not a product default;
 * a JSON schema describes settings without holding any (codex's
 * `config.schema.json` shipped its type names as `+key`). */
const TOOLING_JSON =
  /^(?:tsconfig|jsconfig|\.eslintrc|\.prettierrc|\.babelrc|jest\.config)[^/]*$|\.schema\.json$/i;
const LOCK_OR_SNAPSHOT =
  /(^|\/)(package-lock\.json|composer\.lock|flake\.lock)$|\.lock\.json$|(^|\/)__snapshots__\/|\.snap$/i;
const TRANSLATION_PATH = /\.lproj\/|\.strings$|(^|\/)(translations?|i18n|locales?|lang)\//i;
/** A compose file under docs/ is an example; traefik's v3.7.x releases each
 * carried six `image: traefik:v3.6 → v3.7` bumps there, none a default. */
const EXAMPLE_PATH = /(^|\/)(docs?|examples?|samples?)\//i;

/** Source paths where a literal is a default by construction (class B's
 * path arm): `codex-rs/features/src/lib.rs`, `pkg/config/defaults/`. */
export const DEFAULTS_PATH = /(^|\/)(defaults?|features?|settings|config|preferences|options)(\/|\.|_)/i;
/** Class B's line arm — the literal sits on a line that calls itself a default. */
const DEFAULT_LINE = /default|Default|DEFAULT|_enabled|Enabled|opt_?in|opt_?out/;

/** `name: literal`, `"name": literal`, `name = literal`, `name: Type = literal`,
 * `name := literal` — the identifier that owns the value. */
const OWNER_KEY =
  /["']?([A-Za-z_][\w.-]*)["']?(?:\s*:\s*[A-Za-z_][\w:<>[\]&'\s]*?)?\s*(?::=|=>|[:=])\s*$/;
/** `.promisc(literal)` — a setter call. Class C, measured and not shipped. */
const OWNER_CALL = /\.?([A-Za-z_]\w*)\s*\(\s*$/;
const CALL_NOISE =
  /^(?:new|Some|Ok|Err|Box|Rc|Arc|Cell|RefCell|Mutex|vec|assert\w*|expect|unwrap_or|then_some|from|into|of|bool|int|str|String|Number|Boolean|console|log|println|print|format|write\w*)$/;
/** The enclosing entry's key when a struct literal spells one just above —
 * `key: "daemon_auto_start"` names the flip better than `default_enabled`.
 * Only `key`: a `name:` is a display string (the codex entry's own
 * `name: "Automatically start the background server"` sat nearer). */
const ENTRY_KEY = /\bkey\s*[:=]\s*["']([^"']{1,80})["']/;
/** Eight lines reach past a removed five-line `stage: Experimental {…}` block. */
const LOOKBACK_LINES = 8;
/** Owners whose string value is prose or a pointer, never a default a user
 * sets: a schema description, a `$ref`, a button label, a log message. */
const NAME_NOISE =
  /^\$?(?:description|desc|ref|title|summary|text|message|msg|label|query|comment|help|doc|docs|example|examples|pattern|format|error|version|date|author|url|href|id|sql|template|className|class|style)$/i;

export type DefaultClass = "config" | "source" | "toggle";

export interface DefaultCandidate {
  name: string;
  from: string;
  to: string;
  file: string;
  class: DefaultClass;
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

interface Literal {
  text: string;
  start: number;
  end: number;
}

function literals(line: string, bare: "any" | "constant"): Literal[] {
  const out: Literal[] = [...line.matchAll(VALUE_LITERAL)].map((m) => ({
    text: m[0],
    start: m.index!,
    end: m.index! + m[0].length,
  }));
  for (const m of line.matchAll(BARE_VALUE)) {
    const start = m.index!;
    const end = start + m[0].length;
    if (out.some((l) => l.start < end && start < l.end)) continue;
    if (bare === "constant" && !CONSTANT_LIKE.test(m[0])) continue;
    out.push({ text: m[0], start, end });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** The line with every literal blanked — two lines pair when this is equal. */
function skeleton(line: string, lits: Literal[]): string {
  let out = "";
  let at = 0;
  for (const l of lits) {
    out += line.slice(at, l.start) + "\0";
    at = l.end;
  }
  return out + line.slice(at);
}

/** Which literal position differs between two lines of equal skeleton; -1 when
 * none or more than one does — a rewrite, not a value change. */
function singleDiff(a: Literal[], b: Literal[]): number {
  if (a.length !== b.length) return -1;
  let idx = -1;
  for (let i = 0; i < a.length; i++) {
    if (a[i].text === b[i].text) continue;
    if (idx !== -1) return -1;
    idx = i;
  }
  return idx;
}

function defaultsClass(path: string): Exclude<DefaultClass, "toggle"> | null {
  if (VENDORED_PATH.test(path) || TEST_PATH.test(path) || EXAMPLE_PATH.test(path)) return null;
  if (LOCK_OR_SNAPSHOT.test(path) || TRANSLATION_PATH.test(path)) return null;
  const category = fileCategory(path);
  if (category === "config") return "config";
  const segments = path.split("/");
  const base = segments[segments.length - 1];
  const parent = segments[segments.length - 2] ?? "";
  if (
    JSON_FILE.test(base) &&
    category !== "dependencies" &&
    !TOOLING_JSON.test(base) &&
    (SETTINGS_WORD.test(base) || SETTINGS_WORD.test(parent))
  ) {
    return "config";
  }
  if (category === "source" && DIALING_SOURCE.test(path)) return "source";
  return null;
}

/**
 * Pair each removed line with the added line that is identical except for one
 * literal, and name the value's owner. `toggles` adds class C — setter calls
 * like `.promisc(false)` — which the census measures and the surface does not
 * ship: no key owns the value there, so the notes have nothing to name.
 */
export function defaultCandidates(
  files: DiffFile[],
  opts: { toggles?: boolean } = {},
): DefaultCandidate[] {
  const out: DefaultCandidate[] = [];
  const seen = new Set<string>();
  const push = (c: DefaultCandidate): void => {
    const key = `${c.file}\0${c.name}\0${c.from}\0${c.to}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(c);
  };
  for (const f of files) {
    if (!f.patch) continue;
    const cls = defaultsClass(f.path);
    if (!cls) continue;
    const onPath = cls === "config" || DEFAULTS_PATH.test(f.path);
    const bare = cls === "config" ? "any" : "constant";
    const recent: string[] = [];
    let minus: Array<{ line: string; context: string[] }> = [];
    let plus: string[] = [];
    const flush = (): void => {
      const taken = new Set<number>();
      for (const m of minus) {
        const mlits = literals(m.line, bare);
        if (!mlits.length) continue;
        const mskel = skeleton(m.line, mlits);
        for (let i = 0; i < plus.length; i++) {
          if (taken.has(i)) continue;
          const plits = literals(plus[i], bare);
          if (skeleton(plus[i], plits) !== mskel) continue;
          const at = singleDiff(mlits, plits);
          if (at === -1) continue;
          taken.add(i);
          // A string with whitespace is prose (a description, a message),
          // not a value anyone configures — a default string is one token.
          if (/^["']/.test(mlits[at].text) && /\s/.test(mlits[at].text + plits[at].text)) break;
          const before = m.line.slice(0, mlits[at].start);
          const owner = before.match(OWNER_KEY);
          const call = owner ? null : before.match(OWNER_CALL);
          let klass: DefaultClass | null = null;
          let name = "";
          if (owner) {
            if ((onPath || DEFAULT_LINE.test(m.line)) && !NAME_NOISE.test(owner[1])) {
              klass = cls;
              name = owner[1];
              if (cls === "source") {
                const entry = [...m.context].reverse().map((l) => l.match(ENTRY_KEY)?.[1]).find(Boolean);
                if (entry) name = entry;
              }
            }
          } else if (call && opts.toggles && cls === "source" && !CALL_NOISE.test(call[1])) {
            klass = "toggle";
            name = call[1];
          }
          if (!klass) break;
          push({
            name: clip(name, 60),
            from: clip(mlits[at].text.trim(), 40),
            to: clip(plits[at].text.trim(), 40),
            file: f.path,
            class: klass,
          });
          break;
        }
      }
      minus = [];
      plus = [];
    };
    for (const raw of f.patch.split("\n")) {
      if (raw.startsWith("@@")) {
        flush();
        recent.length = 0;
        continue;
      }
      if (raw.startsWith("-") && !raw.startsWith("--- ")) {
        minus.push({ line: raw.slice(1), context: recent.slice(-LOOKBACK_LINES) });
      } else if (raw.startsWith("+") && !raw.startsWith("+++ ")) {
        plus.push(raw.slice(1));
      } else {
        flush();
      }
      recent.push(raw.slice(1));
      if (recent.length > LOOKBACK_LINES * 2) recent.splice(0, recent.length - LOOKBACK_LINES);
    }
    flush();
  }
  return out;
}

/** Whether any claim names the value's owner — by identifier, or anywhere in
 * its text once the name is long enough that a substring still means it. */
export function namedByClaims(name: string, claims: Claim[]): boolean {
  const needle = name.toLowerCase();
  for (const c of claims) {
    if (extractIdentifiers(c).some((id) => id.toLowerCase() === needle)) return true;
    if (needle.length >= 3 && c.text.toLowerCase().includes(needle)) return true;
  }
  return false;
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
 * informational: renderers show it, the score never reads it. `claims` only
 * decides whether a moved default is `documented`; without them (a
 * component without notes, an uncovered commit) nothing names anything.
 */
export function releaseSurface(files: DiffFile[], claims: Claim[] = []): ReleaseSurface {
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
  const defaults: DefaultChange[] = defaultCandidates(files).map((c) => ({
    name: c.name,
    from: c.from,
    to: c.to,
    file: c.file,
    documented: namedByClaims(c.name, claims),
  }));
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
    defaults,
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
  for (const d of s.defaults?.slice(0, 2) ?? []) parts.push(`±default ${d.name} ${d.from}→${d.to}`);
  for (const h of s.hosts?.added.slice(0, 2) ?? []) parts.push(`+host ${h}`);
  for (const h of s.hosts?.removed.slice(0, 2) ?? []) parts.push(`−host ${h}`);
  if (s.migrations.length) parts.push(`migration${s.migrations.length > 1 ? "s" : ""}`);
  if (s.apiRoutes.length) parts.push("api routes");
  return parts.join(" · ") || undefined;
}
