// SPDX-License-Identifier: GPL-3.0-or-later
// Privacy surface: code a release adds that reads another tool's
// credentials, ships data to a telemetry sink, builds a stable user or
// device identifier, or adds a telemetry switch. The class pingdotgg/t3code
// belongs to: v0.0.0-alpha.21 hashed `tokens.account_id` from
// `~/.codex/auth.json` into a PostHog `distinct_id` under a commit titled
// "anonymous telemetry", and nothing the tool read could say so — the
// claim check verifies notes, and the notes said nothing.
// Deterministic and never scored, like the rest of the release surface.
import { fileCategory } from "./metrics.ts";
import { namedByClaims, TEST_PATH, VENDORED_PATH } from "./substance.ts";
import type { Claim, DiffFile, PrivacyHit, PrivacyKind } from "./types.ts";

interface Signature {
  signal: string;
  test: (line: string) => boolean;
  /** Note words that document the hit; the signal itself counts too unless
   * it is `generic`. */
  terms?: string[];
  /** The signal is an everyday word ("segment", "amplitude"): a note about
   * URL segments must not clear the vendor's ⚠. */
  generic?: true;
}

const re = (r: RegExp) => (line: string) => r.test(line);
const both = (a: RegExp, b: RegExp) => (line: string) => a.test(line) && b.test(line);

/** Another tool's auth or account file. Paths are built by `path.join`
 * (`homedir(), ".codex", "auth.json"`), so the segments are matched on one
 * line, not as a path literal. */
const CREDENTIALS: Signature[] = [
  { signal: "~/.codex/auth.json", test: both(/["'`/\\]\.codex\b/, /\bauth\.json\b/), terms: ["auth.json"] },
  { signal: "~/.claude.json", test: re(/["'`/\\]\.claude\.json\b/), terms: [".claude.json"] },
  { signal: "~/.claude/.credentials.json", test: both(/["'`/\\]\.claude\b/, /\.credentials\.json\b/), terms: [".credentials.json"] },
  { signal: "~/.gemini/oauth_creds.json", test: re(/\boauth_creds\.json\b/), terms: ["oauth_creds.json"] },
  { signal: "~/.aws/credentials", test: both(/["'`/\\]\.aws\b/, /["'`/\\]credentials\b/), terms: [".aws/credentials"] },
  { signal: "gcloud application_default_credentials.json", test: re(/\bapplication_default_credentials\.json\b/), terms: ["application_default_credentials.json"] },
  { signal: "~/.docker/config.json", test: both(/["'`/\\]\.docker\b/, /\bconfig\.json\b/), terms: [".docker/config.json"] },
  { signal: "~/.kube/config", test: both(/["'`/\\]\.kube\b/, /["'`/\\]config\b/), terms: [".kube/config"] },
  { signal: "~/.netrc", test: re(/["'`/\\]\.netrc\b/), terms: [".netrc"] },
  { signal: "~/.git-credentials", test: re(/["'`/\\]\.git-credentials\b/), terms: [".git-credentials"] },
  { signal: "gh hosts.yml", test: both(/["'`/\\]gh["'`/\\]/, /\bhosts\.ya?ml\b/), terms: ["hosts.yml"] },
  { signal: "github-copilot token file", test: both(/\bgithub-copilot\b/, /\b(hosts|apps)\.json\b/), terms: ["github-copilot"] },
  { signal: "ssh private key", test: both(/["'`/\\]\.ssh\b/, /\bid_(rsa|ed25519|ecdsa)\b/), terms: ["ssh key"] },
];

const TELEMETRY_WORDS = ["telemetry", "analytics"];

/** Analytics and telemetry vendors by SDK, API host or wire header. */
const SINKS: Signature[] = [
  { signal: "posthog", test: re(/posthog/i) },
  { signal: "segment", test: re(/api\.segment\.io|@segment\/|\banalytics-node\b/), generic: true, terms: ["segment.io", "@segment/analytics-node", "analytics-node"] },
  { signal: "mixpanel", test: re(/mixpanel/i) },
  { signal: "amplitude", test: re(/@amplitude\/|amplitude\.com/i), generic: true, terms: ["amplitude.com", "amplitude analytics"] },
  { signal: "sentry", test: re(/@sentry\/|sentry\.io\b|\bSentry\.init\b|\bsentry_sdk\b|\bSentrySDK\b/) },
  { signal: "datadog", test: re(/datadoghq\.|\bdd-trace\b|@datadog\//) },
  { signal: "axiom", test: re(/axiom\.co\b|X-Axiom-Dataset|@axiomhq\//i) },
  { signal: "honeycomb", test: re(/honeycomb\.io\b/) },
  { signal: "new relic", test: re(/\bnewrelic\b/i) },
  { signal: "bugsnag", test: re(/bugsnag/i) },
  { signal: "rollbar", test: re(/\brollbar\b/i) },
  { signal: "logrocket", test: re(/logrocket/i) },
  { signal: "statsig", test: re(/\b[Ss]tatsig\b|@statsig\/|\bStatsig[A-Z]/) },
  { signal: "google analytics", test: re(/google-analytics\.com|googletagmanager\.com|\bgtag\(|firebase\/analytics|\bFirebaseAnalytics\b/) },
  { signal: "plausible", test: re(/plausible\.io\b/), generic: true, terms: ["plausible.io", "plausible analytics"] },
  { signal: "application insights", test: re(/applicationinsights|\bappinsights\b/i) },
  { signal: "otlp exporter", test: re(/\bOTLP\w*Exporter\b|\bOtlp(Tracer|Exporter|Logger)\b|["'`][^"'`\s]*\/v1\/(traces|logs)\b/), terms: ["otlp", "opentelemetry", "tracing", "traces"] },
];

/** A host whose first label says what it collects: `ingest.t3.codes`
 * replaced `us.i.posthog.com` without naming any vendor. */
const INGEST_HOST =
  /https?:\/\/((?:ingest|telemetry|analytics|events|collect|collector|track|tracking|stats|metrics|otel|otlp|beacon|logs)\.[a-z0-9.-]+\.[a-z]{2,})/gi;
/** Reserved and local names (RFC 2606/6761): a config sample, not a sink. */
const PLACEHOLDER_HOST = /(^|\.)(example\.(com|org|net)|localhost)$|\.(test|example|invalid|local)$/;

/** Stable identifiers: what turns events into a person's history. */
const IDENTIFIERS: Signature[] = [
  { signal: "distinct_id", test: re(/\bdistinct_?id\b/i), terms: ["distinct id"] },
  { signal: "anonymous id", test: re(/\banonymous[_-]?id\b/i), terms: ["anonymous_id", "anonymous-id"] },
  { signal: "install id", test: re(/\binstall(ation)?[_-]?id\b/i), terms: ["install_id", "installation id"] },
  { signal: "machine id", test: re(/\bmachine[_-]?id\b|IOPlatformUUID|\/etc\/machine-id|node-machine-id/i), terms: ["machine_id", "machine-id"] },
  // Alone, a device id is a microphone, an audio output or a push target
  // (the clone sweep: WebRTC, zed, vaultwarden); next to analytics it is a
  // person's history.
  { signal: "device id", test: both(/\bdevice[_-]?id\b/i, /analytics|telemetry|tracking/i), terms: ["device_id"] },
  { signal: "mac address", test: re(/\bmac_?address\b/i), terms: ["mac_address"] },
];

/** An env var or setting that turns telemetry on or off — whose default
 * decides whether every user is in. */
const SWITCH_ENV = /\b[A-Z0-9_]*(?:TELEMETRY|ANALYTICS|DO_NOT_TRACK)[A-Z0-9_]*\b/g;
/** The name must say on or off: `ANALYTICS_DEVICE_ID_KEY` is a storage key. */
const SWITCH_VERB = /DO_NOT_TRACK|(^|_)(NO|DISABLE[DS]?|ENABLE[DS]?|OPT_?OUT|OPT_?IN|OFF|ON)(_|$)/;
const SWITCH_KEY = /\b(?:telemetry|analytics|usage_?stats|crash_?report(?:s|ing)?)[_.-]?(?:enabled|disabled|opt_?out|opt_?in)\b/gi;
const SWITCH_TERMS = [...TELEMETRY_WORDS, "opt-out", "opt out"];

const KIND_ORDER: PrivacyKind[] = ["credential", "sink", "identifier", "switch"];

/** A line that is only a comment: it ships no behaviour. */
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*|#|--|<!--|;)/;

interface Match {
  kind: PrivacyKind;
  signal: string;
  terms: string[];
}

function matches(line: string): Match[] {
  if (COMMENT_LINE.test(line)) return [];
  const out: Match[] = [];
  const add = (kind: PrivacyKind, list: Signature[], extra: string[] = []) => {
    for (const s of list) {
      if (s.test(line)) out.push({ kind, signal: s.signal, terms: [...(s.generic ? [] : [s.signal]), ...(s.terms ?? []), ...extra] });
    }
  };
  add("credential", CREDENTIALS);
  add("sink", SINKS, TELEMETRY_WORDS);
  for (const m of line.matchAll(INGEST_HOST)) {
    const host = m[1].toLowerCase();
    if (!PLACEHOLDER_HOST.test(host)) out.push({ kind: "sink", signal: host, terms: [host, ...TELEMETRY_WORDS] });
  }
  add("identifier", IDENTIFIERS);
  for (const m of line.matchAll(SWITCH_ENV)) {
    if (SWITCH_VERB.test(m[0])) out.push({ kind: "switch", signal: m[0], terms: [m[0], ...SWITCH_TERMS] });
  }
  for (const m of line.matchAll(SWITCH_KEY)) out.push({ kind: "switch", signal: m[0], terms: [m[0], ...SWITCH_TERMS] });
  return out;
}

/** Not this release's own shipped code, though `fileCategory` says source:
 * dependency patches (pnpm `patches/`), checked-in upstream repos
 * (`.repos/`), generated clients, a vendor's GraphQL schema, `.e2e.`
 * scenarios and eval data — each fired in the clone sweep with an upstream
 * SDK's or a fixture's telemetry. */
const NOT_SHIPPED = /(^|\/)(patches|\.repos)\/|generated|\.e2e\.|\.(nd)?jsonl?$|\.g(raph)?ql$/i;

/** Own code and config only: a vendored SDK's or a test's telemetry is not
 * this release's. */
function scanned(f: DiffFile): boolean {
  if (!f.patch || VENDORED_PATH.test(f.path) || TEST_PATH.test(f.path) || NOT_SHIPPED.test(f.path)) return false;
  const category = fileCategory(f.path);
  return category === "source" || category === "config";
}

/** Changed lines with their new-side line number (removed lines carry the
 * number of the line they precede). */
function* sides(patch: string): Generator<{ sign: "+" | "-"; text: string; line: number }> {
  let line = 0;
  let inHunk = false;
  for (const raw of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      line = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    // File headers come before the first hunk only; inside one, `+++ x` is
    // an added `++ x`.
    if (!inHunk) continue;
    if (raw.startsWith("+")) yield { sign: "+", text: raw.slice(1), line: line++ };
    else if (raw.startsWith("-")) yield { sign: "-", text: raw.slice(1), line };
    else if (raw.startsWith(" ")) line++;
  }
}

const SNIPPET_CAP = 160;
const normalized = (s: string): string => s.trim().replace(/\s+/g, " ");
const snippetOf = (s: string): string => {
  const t = normalized(s);
  return t.length > SNIPPET_CAP ? `${t.slice(0, SNIPPET_CAP - 1)}…` : t;
};

export function privacySurface(files: DiffFile[], claims: Claim[] = []): PrivacyHit[] {
  const kept = files.filter(scanned);
  // An added line whose text was also removed is a moved line — a refactor
  // of telemetry that already shipped, not new collection. By text, not by
  // signal: one removed Sentry import must not hide a new Sentry.init.
  const removed = new Set<string>();
  for (const f of kept) {
    for (const l of sides(f.patch!)) if (l.sign === "-") removed.add(normalized(l.text));
  }
  const first = new Map<string, { m: Match; file: string; line: number; snippet: string }>();
  for (const f of kept) {
    for (const l of sides(f.patch!)) {
      if (l.sign === "-" || removed.has(normalized(l.text))) continue;
      for (const m of matches(l.text)) {
        const key = `${m.kind}\0${m.signal}`;
        if (!first.has(key)) first.set(key, { m, file: f.path, line: l.line, snippet: snippetOf(l.text) });
      }
    }
  }
  return [...first.values()]
    .map((h) => ({
      kind: h.m.kind,
      signal: h.m.signal,
      file: h.file,
      line: h.line,
      snippet: h.snippet,
      documented: h.m.terms.some((t) => namedByClaims(t, claims)),
    }))
    .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || (a.signal < b.signal ? -1 : a.signal > b.signal ? 1 : 0));
}
