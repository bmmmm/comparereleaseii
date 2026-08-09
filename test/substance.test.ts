// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { commitSurface, releaseSurface } from "../src/substance.ts";
import { fileCategory } from "../src/metrics.ts";
import type { DiffFile } from "../src/types.ts";

function df(path: string, patch?: string, churn = 1): DiffFile {
  return { path, status: "modified", additions: churn, deletions: 0, patch };
}

test("every path lands in exactly one category, hard-won exclusions intact", () => {
  const expectations: Array<[string, string]> = [
    [".github/CONTRIBUTING.md", "docs"],
    ["CHANGELOG.md", "docs"],
    ["LICENSE", "docs"],
    [".github/workflows/ci.yml", "ci/build"],
    ["Dockerfile.alpine", "ci/build"],
    ["go.mod", "dependencies"],
    ["pnpm-lock.yaml", "dependencies"],
    ["services/graph/migrations/0001_init.sql", "migrations"],
    ["db/migrate/20240101_add_users.rb", "migrations"],
    ["src/db/V12__add_index.sql", "migrations"],
    ["tests/fixtures/config.yaml", "tests"],
    ["pkg/auth/token_test.go", "tests"],
    ["charts/opencloud/values.yaml", "config"],
    ["config/app.toml", "config"],
    ["docs/assets/logo.png", "assets"],
    ["vendor/blob.wasm", "assets"],
    ["services/upload/postprocessing.go", "source"],
    ["web/src/components/Preview.vue", "source"],
  ];
  for (const [path, want] of expectations) {
    assert.equal(fileCategory(path), want, path);
  }
});

const GO_UPLOAD = df(
  "services/upload/session.go",
  `@@ -10,6 +10,9 @@ func (s *Session) Finalize(ctx context.Context) error {
-	if os.Getenv("OC_LEGACY_UPLOAD") != "" {
+	if os.Getenv("OC_ASYNC_UPLOADS") != "" {
+		flags.Bool("async-uploads", false, "enable --async-uploads mode")
 	}
`,
  30,
);

const GO_MOVED_READ_OUT = df(
  "services/a/env.go",
  `@@ -1,3 +1,2 @@ func readA() {
-	_ = os.Getenv("OC_SHARED_SECRET_PATH")
 }
`,
  2,
);

const GO_MOVED_READ_IN = df(
  "services/b/env.go",
  `@@ -1,2 +1,3 @@ func readB() {
+	_ = os.Getenv("OC_SHARED_SECRET_PATH")
 }
`,
  2,
);

const VALUES_YAML = df(
  "charts/opencloud/values.yaml",
  `@@ -1,5 +1,6 @@
 image:
   tag: latest
+asyncUploads: true
-legacyUpload: false
       deeplyNestedIgnored: true
`,
  3,
);

const CSS = df(
  "web/src/theme.css",
  `@@ -1,2 +1,2 @@
-  --color-bg: #fff;
+  --color-bg: #000;
`,
  2,
);

const TEST_FILE = df(
  "services/upload/session_test.go",
  `@@ -5,3 +5,4 @@ func TestFinalize(t *testing.T) {
+	assert.True(t, ok)
`,
  4,
);

// The paths that made two thirds of the corpus's flag surface. Each is a file
// whose `--name` literals belong to somebody else: a vendored test runner, a
// stylesheet inside a component, a CI pipeline, an agent's server list.
const VENDORED_RUNNER = df(
  "vendor/github.com/onsi/ginkgo/v2/types/config.go",
  `@@ -1,2 +1,3 @@ func BuildRunCommandFlagSet() {
+	flags.Bool("--randomize-suites", false, "")
`,
  3,
);

// Both halves of a single-file component in one diff: a `<script>` block that
// really does build an argv, and the `<style>`/template spellings of a CSS
// custom property. Excluding the extension drops the first one too — that is
// the recall the measurement accepted (0 of 233 corpus occurrences), and it
// is asserted rather than described so it cannot be widened by accident.
const VUE_SFC = df(
  "packages/design-system/src/components/OcButton/OcButton.vue",
  `@@ -1,6 +1,9 @@ function buildPrinterArgs(opts) {
+  return ["--print-mode", opts.mode]
+  :style="{ '--oc-progress-pie-fill': fill }"
 <style lang="scss">
-  --oc-button-color: teal;
+  --oc-button-hover-color: navy;
`,
  4,
);

const WOODPECKER_STAR = df(
  ".woodpecker.star",
  `@@ -1,2 +1,3 @@ def e2e(ctx):
+	e2e_args = "--headless --total-parts %d" % params["totalParts"]
`,
  3,
);

const MCP_JSON = df(
  ".mcp.json",
  `@@ -1,3 +1,4 @@
+      "args": ["@playwright/mcp@latest", "--headless", "--isolated"],
`,
  3,
);

// A release that starts talking to a new host is a supply-chain fact its
// notes rarely mention. The noise that signal has to survive is licence and
// schema URIs in comments, vendored trees, and mock hosts in test doubles.
const GO_UPDATER = df(
  "services/updater/check.go",
  `@@ -10,4 +10,6 @@ func (u *Updater) Check(ctx context.Context) error {
-	req, _ := http.NewRequest("GET", "https://releases.oldvendor.io/appcast.xml", nil)
+	req, _ := http.NewRequest("GET", "https://api.github.com/repos/o/r/releases", nil)
+	// date format per https://www.w3.org/TR/xmlschema-2/
+	// staging only: https://api.acme.example/v1
`,
  20,
);

const VENDORED_CLIENT = df(
  "vendor/github.com/foo/bar/client.go",
  `@@ -1,2 +1,3 @@ func New() *Client {
+	return &Client{base: "https://telemetry.foo.io/v1"}
`,
  3,
);

const MOCK_HANDLERS = df(
  "web/src/mocks/handlers.ts",
  `@@ -1,2 +1,3 @@
+  http.get("https://mock.msw.dev/api", () => HttpResponse.json({}));
`,
  3,
);

// fileCategory's fallback bucket is "source", so a metadata dotfile lands
// there — but a contributor's profile URL is not traffic the code starts.
const CONTRIBUTORS_RC = df(
  ".all-contributorsrc",
  `@@ -1,2 +1,4 @@
+      "login": "thambaru",
+      "profile": "https://thambaru.com",
`,
  4,
);

const GO_HOST_MOVED_OUT = df(
  "services/a/client.go",
  `@@ -1,3 +1,2 @@ func dialA() {
-	_ = "https://cdn.shared.acme.io/assets"
 }
`,
  2,
);

const GO_HOST_MOVED_IN = df(
  "services/b/client.go",
  `@@ -1,2 +1,3 @@ func dialB() {
+	_ = "https://cdn.shared.acme.io/assets"
 }
`,
  2,
);

const MIGRATION = df("services/graph/migrations/0042_add_index.sql", undefined, 8);
const ROUTES = df(
  "services/graph/routes/drives.go",
  `@@ -1,3 +1,4 @@ func RegisterRoutes(r chi.Router) {
+	r.Get("/drives/{id}", h.GetDrive)
`,
  5,
);

test("releaseSurface rolls up categories, symbols, config deltas, migrations and routes", () => {
  const s = releaseSurface([
    GO_UPLOAD,
    GO_MOVED_READ_OUT,
    GO_MOVED_READ_IN,
    VALUES_YAML,
    CSS,
    TEST_FILE,
    MIGRATION,
    ROUTES,
  ]);

  const source = s.categories.find((c) => c.category === "source");
  assert.equal(source?.files, 5, "session.go, both env.go, theme.css, routes file");
  assert.equal(s.categories[0].category, "source", "largest churn first");
  assert.ok(s.categories.some((c) => c.category === "tests"));

  // Highest-churn source file's symbols lead; test symbols never appear.
  assert.equal(s.symbols[0], "Finalize");
  assert.ok(s.symbols.includes("RegisterRoutes"));
  assert.ok(!s.symbols.includes("TestFinalize"));
  assert.equal(s.moreSymbols, 0);

  // The env read that moved between files cancels; the real change stays.
  assert.deepEqual(s.envVars, { added: ["OC_ASYNC_UPLOADS"], removed: ["OC_LEGACY_UPLOAD"] });
  // The CSS custom property is not a CLI flag.
  assert.deepEqual(s.cliFlags.added, ["--async-uploads"]);
  assert.deepEqual(s.cliFlags.removed, []);
  // Config keys from the chart, shallow keys only.
  assert.deepEqual(s.configKeys, { added: ["asyncUploads"], removed: ["legacyUpload"] });

  assert.deepEqual(s.migrations, ["services/graph/migrations/0042_add_index.sql"]);
  assert.deepEqual(s.apiRoutes, ["services/graph/routes/drives.go"]);
});

test("the host delta names the traffic this release starts and stops, nothing else", () => {
  const s = releaseSurface([
    GO_UPDATER,
    VENDORED_CLIENT,
    MOCK_HANDLERS,
    CONTRIBUTORS_RC,
    GO_HOST_MOVED_OUT,
    GO_HOST_MOVED_IN,
    TEST_FILE,
    VALUES_YAML,
  ]);
  assert.deepEqual(s.hosts, {
    added: ["api.github.com"],
    removed: ["releases.oldvendor.io"],
  });
  // Named individually so a widened filter says which case it broke.
  for (const boring of ["www.w3.org", "api.acme.example"]) {
    assert.ok(!s.hosts?.added.includes(boring), `${boring} is a comment, not traffic`);
  }
  assert.ok(!s.hosts?.added.includes("telemetry.foo.io"), "vendored trees carry foreign hosts");
  assert.ok(!s.hosts?.added.includes("mock.msw.dev"), "a mock host is not product traffic");
  assert.ok(!s.hosts?.added.includes("thambaru.com"), "a metadata dotfile is not code that dials");
  assert.ok(!s.hosts?.added.includes("cdn.shared.acme.io"), "a host that moved files is not new");

  assert.match(commitSurface([GO_UPDATER])!, /\+host api\.github\.com/);
  assert.match(commitSurface([GO_UPDATER])!, /−host releases\.oldvendor\.io/);
});

// Measured on 27 corpus tag ranges: of the 805 flag-literal occurrences that
// reached the extractor, only 37% sat in a file where "is this the product's
// flag?" was even the right question. The rest were these four
// category-boundary gaps — so each one is named individually, and a widened
// filter says which case it broke.
test("the flag surface names this project's own flags, not the ones its tree carries", () => {
  const s = releaseSurface([GO_UPLOAD, VENDORED_RUNNER, VUE_SFC, WOODPECKER_STAR, MCP_JSON, CSS]);
  assert.deepEqual(s.cliFlags, { added: ["--async-uploads"], removed: [] });
  const seen = [...s.cliFlags.added, ...s.cliFlags.removed];
  assert.ok(!seen.includes("--randomize-suites"), "a vendored runner's flags are not the product's");
  assert.ok(!seen.includes("--oc-button-color"), "a Vue SFC's CSS custom properties are not flags");
  assert.ok(!seen.includes("--oc-progress-pie-fill"), "…nor is a :style binding outside <style>");
  assert.ok(!seen.includes("--total-parts"), "a CI pipeline runs tools, it does not define flags");
  assert.ok(!seen.includes("--isolated"), "an agent's server list is not the product's CLI");
  // The price of cutting at the extension, paid deliberately: a flag a
  // component's <script> block really does build goes with the stylesheet.
  assert.ok(!seen.includes("--print-mode"), "a .vue <script> flag is the accepted recall loss");

  // The two config cases are category fixes, so they hold for every field the
  // rollup feeds — not just for flags. `.vue` is not: it stays source, and
  // dropping its flags must not cost the component its symbols too.
  assert.equal(fileCategory(WOODPECKER_STAR.path), "ci/build");
  assert.equal(fileCategory(MCP_JSON.path), "config");
  assert.ok(!s.symbols.includes("e2e"), "a CI pipeline's functions are not shipped symbols");
  assert.ok(s.symbols.includes("buildPrinterArgs"), "a Vue SFC still ships its changed symbols");
});

test("a Go env struct tag lists every name it carries", () => {
  const s = releaseSurface([
    df(
      "pkg/config/log.go",
      `@@ -1,2 +1,2 @@ type Log struct {
+	Level string \`env:"OC_LOG_LEVEL;OCIS_LOG_LEVEL"\`
`,
    ),
  ]);
  assert.deepEqual(s.envVars.added, ["OCIS_LOG_LEVEL", "OC_LOG_LEVEL"]);
});

test("the symbol cap is declared, never silent", () => {
  const many = df(
    "pkg/big.go",
    Array.from(
      { length: 15 },
      (_, i) => `@@ -${i * 10},2 +${i * 10},3 @@ func Exported${i}() {\n+\tx()\n`,
    ).join(""),
    100,
  );
  const s = releaseSurface([many]);
  assert.equal(s.symbols.length, 12);
  assert.equal(s.moreSymbols, 3);
});

test("a routes.md document is docs, not API surface", () => {
  const s = releaseSurface([df("docs/routes.md", `@@ -1,1 +1,2 @@\n+new route docs\n`)]);
  assert.deepEqual(s.apiRoutes, []);
});

test("commitSurface describes a commit by observation, empty diffs stay silent", () => {
  const line = commitSurface([GO_UPLOAD, TEST_FILE, MIGRATION]);
  assert.ok(line, "a non-empty diff gets a description");
  assert.match(line!, /1 source/);
  assert.match(line!, /fns Finalize/);
  assert.match(line!, /\+env OC_ASYNC_UPLOADS/);
  assert.match(line!, /−env OC_LEGACY_UPLOAD/);
  assert.match(line!, /migration/);
  assert.equal(commitSurface([]), undefined);
});
