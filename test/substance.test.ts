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
