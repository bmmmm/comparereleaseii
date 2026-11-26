// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { privacySurface } from "../src/privacy.ts";
import { releaseSurface } from "../src/substance.ts";
import type { Claim, DiffFile } from "../src/types.ts";

function df(path: string, patch: string): DiffFile {
  return { path, status: "modified", additions: 1, deletions: 0, patch };
}

function claimOf(text: string): Claim {
  return {
    id: 0,
    section: "Changes",
    text,
    kind: "change",
    prNumbers: [],
    shas: [],
    advisories: [],
    codeSpans: [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]),
  };
}

/** pingdotgg/t3code v0.0.0-alpha.21 (ec3778bbf4), abridged: the account id
 * of another tool, hashed into an analytics identity. */
const T3_IDENTIFY = df(
  "apps/server/src/telemetry/Identify.ts",
  `@@ -0,0 +28,9 @@
+const readCodexAccountId = Effect.gen(function* () {
+  // reads ~/.codex/auth.json
+  const authJsonPath = path.join(homedir(), ".codex", "auth.json");
+  const authJson = yield* readJson(authJsonPath);
+  return authJson.tokens.account_id;
+});
+const upsertAnonymousId = Effect.gen(function* () {
+  const anonymousIdPath = path.join(homedir(), ".t3", "telemetry", "anonymous-id");
+});
`,
);
const T3_ANALYTICS = df(
  "apps/server/src/telemetry/Layers/AnalyticsService.ts",
  `@@ -20,3 +20,8 @@ const telemetryConfig = Config.all({
   flushIntervalMs: 10000,
+  posthogKey: Config.string("T3CODE_POSTHOG_KEY"),
+  posthogHost: Config.string("T3CODE_POSTHOG_HOST").pipe(
+    Config.withDefault("https://us.i.posthog.com"),
+  ),
+  enabled: Config.boolean("T3CODE_TELEMETRY_ENABLED").pipe(Config.withDefault(true)),
   batchSize: 20,
@@ -75,2 +80,3 @@ function toBatch(events) {
   return events.map((e) => ({
+    distinct_id: identifier,
   }));
`,
);

test("the T3 alpha.21 telemetry shows as credential read, sink, identifiers and switch, with lines", () => {
  const hits = privacySurface([T3_IDENTIFY, T3_ANALYTICS]);
  assert.deepEqual(
    hits.map((h) => [h.kind, h.signal, h.file, h.line, h.documented]),
    [
      ["credential", "~/.codex/auth.json", "apps/server/src/telemetry/Identify.ts", 30, false],
      ["sink", "posthog", "apps/server/src/telemetry/Layers/AnalyticsService.ts", 21, false],
      ["identifier", "anonymous id", "apps/server/src/telemetry/Identify.ts", 35, false],
      ["identifier", "distinct_id", "apps/server/src/telemetry/Layers/AnalyticsService.ts", 81, false],
      ["switch", "T3CODE_TELEMETRY_ENABLED", "apps/server/src/telemetry/Layers/AnalyticsService.ts", 25, false],
    ],
  );
  assert.equal(hits[0].snippet, 'const authJsonPath = path.join(homedir(), ".codex", "auth.json");');
  // The surface carries it, so every renderer and the JSON do too.
  assert.equal(releaseSurface([T3_IDENTIFY, T3_ANALYTICS]).privacy?.length, 5);
});

test("'anonymous telemetry' documents the sink and the switch, never the credential read", () => {
  const vague = privacySurface([T3_IDENTIFY, T3_ANALYTICS], [claimOf("Add anonymous telemetry for provider events")]);
  const byKind = Object.fromEntries(vague.map((h) => [h.signal, h.documented]));
  assert.equal(byKind["posthog"], true);
  assert.equal(byKind["T3CODE_TELEMETRY_ENABLED"], true);
  assert.equal(byKind["~/.codex/auth.json"], false);
  assert.equal(byKind["distinct_id"], false);
  const named = privacySurface([T3_IDENTIFY], [claimOf("Telemetry identifies you by the account id in `~/.codex/auth.json`")]);
  assert.equal(named.find((h) => h.kind === "credential")?.documented, true);
});

test("#1249's ~/.claude.json and a renamed ingest host are new collection; a moved line is not", () => {
  const claude = df(
    "apps/server/src/telemetry/Identify.ts",
    `@@ -45,1 +45,3 @@
+  const claudeJsonPath = path.join(homedir(), ".claude.json");
+  return claudeJson.userID;
 }
`,
  );
  assert.deepEqual(
    privacySurface([claude]).map((h) => h.signal),
    ["~/.claude.json"],
  );
  // v0.1.1-nightly.20261018.3335: the default host moves off PostHog. The
  // old vendor is only on a removed line; the new host is the hit.
  const ingest = df(
    "apps/server/src/telemetry/AnalyticsService.ts",
    `@@ -75,1 +75,1 @@
-    Config.withDefault("https://us.i.posthog.com"),
+    Config.withDefault("https://ingest.t3.codes"),
`,
  );
  assert.deepEqual(
    privacySurface([ingest]).map((h) => [h.kind, h.signal]),
    [["sink", "ingest.t3.codes"]],
  );
  // The same PostHog call moved between files cancels.
  const moved = [
    df("a/old.ts", `@@ -1,1 +0,0 @@\n-posthog.capture(event)\n`),
    df("b/new.ts", `@@ -0,0 +1,1 @@\n+posthog.capture(event)\n`),
  ];
  assert.deepEqual(privacySurface(moved), []);
  // A removed line cancels its own text only: one dropped Sentry import does
  // not hide a new Sentry.init in another file.
  const rewired = [
    df("a/old.ts", `@@ -1,1 +0,0 @@\n-import * as S from "@sentry/node";\n`),
    df("b/new.ts", `@@ -0,0 +1,1 @@\n+Sentry.init({ dsn });\n`),
  ];
  assert.deepEqual(
    privacySurface(rewired).map((h) => [h.signal, h.file]),
    [["sentry", "b/new.ts"]],
  );
});

test("an everyday word in a note does not document a vendor named by it", () => {
  const seg = df("apps/server/src/track.ts", `@@ -0,0 +1,1 @@\n+import Analytics from "@segment/analytics-node";\n`);
  const doc = (text: string) => privacySurface([seg], [claimOf(text)]).map((h) => h.documented);
  assert.deepEqual(doc("Fix URL segment parsing"), [false]);
  assert.deepEqual(doc("Send usage to segment.io"), [true]);
});

test("inside a hunk, an added '++' line is content and counts toward the line number", () => {
  const f = df("apps/web/src/a.ts", `@@ -0,0 +1,3 @@\n+++ counter;\n+x\n+posthog.capture(e)\n`);
  assert.deepEqual(privacySurface([f]).map((h) => h.line), [3]);
});

test("relay traces show through the wire header and the OTLP tracer", () => {
  const relay = df(
    "packages/shared/src/relayTracing.ts",
    `@@ -0,0 +7,3 @@
+import { OtlpSerialization, OtlpTracer } from "effect/unstable/observability";
+      Authorization: \`Bearer \${config.tracesToken}\`,
+      "X-Axiom-Dataset": config.tracesDataset,
`,
  );
  assert.deepEqual(
    privacySurface([relay]).map((h) => [h.signal, h.line]),
    [
      ["axiom", 9],
      ["otlp exporter", 7],
    ],
  );
});

test("comments, tests, vendored code, docs and look-alike words stay silent", () => {
  const traps = [
    // v0.0.10..v0.0.11 and v0.0.16..v0.0.17 in the T3 clone
    df("apps/web/src/branch.ts", `@@ -1,0 +1,4 @@\n+const token = randomUUID().slice(0, 8).toLowerCase();\n+<span className="tracking-widest uppercase">\n+message: \`Could not verify Codex authentication status: \${error.message}.\`\n+throw new Error("Failed to load server auth session state");\n`),
    // A user-set OTLP endpoint is a setting, not a vendor (v0.0.29..v0.0.30).
    df("apps/web/src/settings.ts", `@@ -1,0 +1,2 @@\n+  otlpTracesEnabled: false,\n+  otlpTracesUrl: observability?.otlpTracesUrl,\n`),
    df("apps/server/src/a.ts", `@@ -1,0 +1,2 @@\n+// send to posthog with the distinct_id\n+  # mixpanel later\n`),
    df("apps/server/src/telemetry.test.ts", `@@ -1,0 +1,1 @@\n+posthog.capture({ distinct_id: "x" })\n`),
    // fileCategory calls a mock "source"; only TEST_PATH keeps it out.
    df("apps/web/src/mocks/analytics.ts", `@@ -1,0 +1,1 @@\n+posthog.capture({ distinct_id: "x" })\n`),
    df("node_modules/posthog-node/index.js", `@@ -1,0 +1,1 @@\n+posthog.capture({ distinct_id: "x" })\n`),
    df("docs/user/telemetry.md", `@@ -1,0 +1,1 @@\n+We read ~/.codex/auth.json and send to posthog.\n`),
  ];
  assert.deepEqual(privacySurface(traps), []);
});

test("the clone sweep's false positives stay silent", () => {
  const posthog = `@@ -1,0 +1,1 @@\n+posthog.capture({ distinct_id: "x" })\n`;
  const traps = [
    // bitwarden/clients, zen-browser/desktop
    df("libs/components/src/side-nav.component.ts", `@@ -1,0 +1,1 @@\n+const style = { scrollbarWidth: "thin", mEmbedderScrollbarInset: 0 };\n`),
    // pingdotgg/t3code v0.1.10..v0.1.12
    df("patches/@cursor__sdk@1.3.1.patch", posthog),
    df(".repos/effect/packages/ai/src/client.ts", posthog),
    df("packages/ai/openrouter/src/Generated.ts", posthog),
    df("scripts/scenarios/telemetry-url.e2e.ts", posthog),
    df("evals/cases/pr-tools.ndjson", posthog),
    df("packages/issue-tracker-linear/schema/linear.graphql", `@@ -1,0 +1,2 @@\n+  """PostHog distinct ID for correlating this inquiry with anonymous analytics events."""\n+  distinctId: String\n`),
    df("apps/server/src/vcs/checkpointCaptureIndex.ts", `@@ -1,0 +1,1 @@\n+const statSignature = (fileSystem: FileSystem.FileSystem, file: string) =>\n`),
    df("apps/server/src/otel.ts", `@@ -1,0 +1,2 @@\n+const sample = { endpoint: "https://otel.example.com:4318" };\n+const dev = "http://metrics.collector.localhost/v1";\n`),
    df("apps/mobile/src/persistence/mobile-storage.ts", `@@ -1,0 +1,1 @@\n+const ANALYTICS_STORAGE_KEY = "t3code.analytics";\n`),
    // pingdotgg/t3code update-feed..v0.1.10, zed-industries/zed v1.24.2..v1.25.0-pre
    df("apps/web/src/speech/requestMicrophone.ts", `@@ -1,0 +1,2 @@\n+const constraints = { audio: { deviceId: { exact: microphoneId } } };\n+use audio::{DeviceDescription, DeviceId};\n`),
  ];
  assert.deepEqual(privacySurface(traps), []);
  // The same guards keep the true ones.
  const kept = df("apps/desktop/src/env.ts", `@@ -1,0 +1,3 @@\n+const keys = ["SRC_NO_TELEMETRY", "DO_NOT_TRACK"];\n+Rollbar.init({ host: "https://ingest.t3.codes" });\n+const KEY = "t3code.analytics.device-id";\n`);
  // openai/codex rust-v0.161.0..rust-v0.162.0
  const codex = df("codex-rs/otel/src/metrics/client.rs", `@@ -1,0 +1,1 @@\n+  OtelExporter::None | OtelExporter::Statsig => Temporality::Delta,\n`);
  assert.deepEqual(
    privacySurface([kept, codex]).map((h) => h.signal),
    ["ingest.t3.codes", "rollbar", "statsig", "device id", "DO_NOT_TRACK", "SRC_NO_TELEMETRY"],
  );
});
