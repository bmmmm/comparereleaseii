// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { pinBumps } from "../src/pins.ts";
import type { DiffFile } from "../src/types.ts";

function df(path: string, patch: string): DiffFile {
  return { path, status: "modified", additions: 1, deletions: 1, patch };
}

// The founding fixture: opencloud-eu/opencloud ships its whole frontend as
// one Makefile line. Patch verbatim from commit aa2f5d96 (bump to v7.1.0),
// versions set to the release the roadmap names.
const OPENCLOUD_MAKEFILE = df(
  "services/web/Makefile",
  `@@ -1,6 +1,6 @@
 SHELL := bash
 NAME := web
-WEB_ASSETS_VERSION = v7.1.0
+WEB_ASSETS_VERSION = v7.2.0
 WEB_ASSETS_BRANCH = main
 `,
);

test("a bare Makefile variable bump is captured — third-party until configured", () => {
  const pins = pinBumps([OPENCLOUD_MAKEFILE], { repoLabel: "opencloud-eu/opencloud" });
  assert.deepEqual(pins, [
    {
      name: "WEB_ASSETS_VERSION",
      from: "v7.1.0",
      to: "v7.2.0",
      file: "services/web/Makefile",
      firstParty: false,
    },
  ]);
});

test("the components config turns the OpenCloud pin into a first-party release link", () => {
  const pins = pinBumps([OPENCLOUD_MAKEFILE], {
    repoLabel: "opencloud-eu/opencloud",
    components: { WEB_ASSETS_VERSION: "opencloud-eu/web" },
    origin: "https://github.com",
    linkStyle: "github",
  });
  assert.equal(pins.length, 1);
  assert.equal(pins[0].repo, "opencloud-eu/web");
  assert.equal(pins[0].firstParty, true);
  assert.equal(pins[0].releaseUrl, "https://github.com/opencloud-eu/web/releases/tag/v7.2.0");
});

test("go.mod bumps carry (name, from, to); the module path names the owner", () => {
  const gomod = df(
    "go.mod",
    `@@ -10,3 +10,3 @@
-	github.com/rs/zerolog v1.31.0
+	github.com/rs/zerolog v1.32.0
-	github.com/opencloud-eu/reva/v2 v2.16.0
+	github.com/opencloud-eu/reva/v2 v2.17.0
 	github.com/stretchr/testify v1.9.0
`,
  );
  const pins = pinBumps([gomod], { repoLabel: "opencloud-eu/opencloud" });
  assert.equal(pins.length, 2);
  // First-party sorts first.
  assert.equal(pins[0].name, "github.com/opencloud-eu/reva/v2");
  assert.equal(pins[0].firstParty, true);
  assert.equal(pins[0].releaseUrl, "https://github.com/opencloud-eu/reva/releases/tag/v2.17.0");
  assert.equal(pins[1].name, "github.com/rs/zerolog");
  assert.equal(pins[1].firstParty, false);
  assert.deepEqual([pins[1].from, pins[1].to], ["v1.31.0", "v1.32.0"]);
  assert.equal(pins[1].releaseUrl, "https://github.com/rs/zerolog/releases/tag/v1.32.0");
});

test("a Go pseudo-version bump gets no fabricated release link", () => {
  const gomod = df(
    "go.mod",
    `@@ -1,2 +1,2 @@
-	golang.org/x/net v0.0.0-20240101120000-abcdef123456
+	golang.org/x/net v0.0.0-20240301120000-fedcba654321
`,
  );
  const pins = pinBumps([gomod]);
  assert.equal(pins.length, 1);
  assert.equal(pins[0].releaseUrl, undefined);
});

test("added or removed dependencies are not bumps", () => {
  const gomod = df(
    "go.mod",
    `@@ -1,2 +1,2 @@
+	github.com/new/dep v1.0.0
-	github.com/old/dep v2.0.0
 	github.com/kept/dep v3.0.0
`,
  );
  assert.deepEqual(pinBumps([gomod]), []);
});

test("requirements.txt: only == pins bump; ranges do not", () => {
  const req = df(
    "requirements.txt",
    `@@ -1,2 +1,2 @@
-requests==2.31.0
+requests==2.32.0
-flask>=2.0
+flask>=3.0
`,
  );
  const pins = pinBumps([req]);
  assert.equal(pins.length, 1);
  assert.deepEqual([pins[0].name, pins[0].from, pins[0].to], ["requests", "2.31.0", "2.32.0"]);
  assert.equal(pins[0].releaseUrl, undefined);
});

test("package.json bumps its dependencies, never its own version field", () => {
  const pkg = df(
    "package.json",
    `@@ -1,8 +1,8 @@
 {
   "name": "app",
-  "version": "1.4.0",
+  "version": "1.5.0",
   "dependencies": {
-    "esbuild": "^0.20.0",
+    "esbuild": "^0.21.0",
     "left-pad": "1.3.0"
   }
`,
  );
  const pins = pinBumps([pkg]);
  assert.equal(pins.length, 1);
  assert.deepEqual([pins[0].name, pins[0].from, pins[0].to], ["esbuild", "^0.20.0", "^0.21.0"]);
});

test("a scoped npm package bump under the checked org is first-party", () => {
  const pkg = df(
    "web/package.json",
    `@@ -3,3 +3,3 @@
   "dependencies": {
-    "@opencloud-eu/design-system": "1.2.0",
+    "@opencloud-eu/design-system": "1.3.0"
   }
`,
  );
  const pins = pinBumps([pkg], { repoLabel: "opencloud-eu/web" });
  assert.equal(pins[0].firstParty, true);
  // An npm name is not a repo path — no link is guessed from it.
  assert.equal(pins[0].releaseUrl, undefined);
});

test("Cargo.toml: inline and [dependencies.x] table bumps; [package] version is not a pin", () => {
  const cargo = df(
    "Cargo.toml",
    `@@ -1,12 +1,12 @@
 [package]
 name = "app"
-version = "3.1.0"
+version = "3.2.0"

 [dependencies]
-serde = "1.0.190"
+serde = "1.0.200"
-tokio = { version = "1.35", features = ["full"] }
+tokio = { version = "1.38", features = ["full"] }

 [dependencies.axum]
-version = "0.6.0"
+version = "0.7.0"
`,
  );
  const pins = pinBumps([cargo]);
  assert.deepEqual(
    pins.map((p) => [p.name, p.from, p.to]),
    [
      ["axum", "0.6.0", "0.7.0"],
      ["serde", "1.0.190", "1.0.200"],
      ["tokio", "1.35", "1.38"],
    ],
  );
});

test("Dockerfile FROM and ARG tags bump; a registry path under the org is first-party", () => {
  const docker = df(
    "Dockerfile",
    `@@ -1,4 +1,4 @@
-FROM golang:1.22.1 AS build
+FROM golang:1.22.4 AS build
-ARG ALPINE_VERSION=3.19
+ARG ALPINE_VERSION=3.20
-FROM ghcr.io/opencloud-eu/base:v1.0.0
+FROM ghcr.io/opencloud-eu/base:v1.1.0
`,
  );
  const pins = pinBumps([docker], { repoLabel: "opencloud-eu/opencloud" });
  assert.deepEqual(
    pins.map((p) => [p.name, p.from, p.to, p.firstParty]),
    [
      ["ghcr.io/opencloud-eu/base", "v1.0.0", "v1.1.0", true],
      ["ALPINE_VERSION", "3.19", "3.20", false],
      ["golang", "1.22.1", "1.22.4", false],
    ],
  );
  // ghcr.io is a registry, not a forge whose URL shape we know — no link.
  assert.equal(pins[0].releaseUrl, undefined);
});

test("assignments without a version-suggesting name or value stay silent", () => {
  const mk = df(
    "Makefile",
    `@@ -1,4 +1,4 @@
-PORT = 8080
+PORT = 9090
-VERSION_LABEL = latest
+VERSION_LABEL = stable
-RETRIES = 3
+RETRIES = 4
`,
  );
  assert.deepEqual(pinBumps([mk]), []);
});

test("a versioned download URL bump identifies the repo — even when the filename repeats the version", () => {
  const script = df(
    "scripts/fetch-web.sh",
    `@@ -1,2 +1,2 @@
-curl -sL https://github.com/opencloud-eu/web/releases/download/v7.1.0/web-v7.1.0.tar.gz | tar xz
+curl -sL https://github.com/opencloud-eu/web/releases/download/v7.2.0/web-v7.2.0.tar.gz | tar xz
`,
  );
  const pins = pinBumps([script], { repoLabel: "opencloud-eu/opencloud" });
  assert.equal(pins.length, 1);
  assert.deepEqual(
    [pins[0].name, pins[0].from, pins[0].to, pins[0].firstParty, pins[0].releaseUrl],
    [
      "opencloud-eu/web",
      "v7.1.0",
      "v7.2.0",
      true,
      "https://github.com/opencloud-eu/web/releases/tag/v7.2.0",
    ],
  );
});

test("lockfiles never produce pin bumps", () => {
  const sum = df(
    "go.sum",
    `@@ -1,2 +1,2 @@
-github.com/rs/zerolog v1.31.0 h1:abc=
+github.com/rs/zerolog v1.32.0 h1:def=
`,
  );
  const lock = df(
    "pnpm-lock.yaml",
    `@@ -1,2 +1,2 @@
-  esbuild: 0.20.0
+  esbuild: 0.21.0
`,
  );
  assert.deepEqual(pinBumps([sum, lock]), []);
});

test("components on the checked repo's own forge link through its origin and style", () => {
  const mk = df(
    "Makefile",
    `@@ -1,2 +1,2 @@
-UI_VERSION = v2.0.0
+UI_VERSION = v2.1.0
`,
  );
  const forgejo = pinBumps([mk], {
    repoLabel: "acme/server",
    components: { UI_VERSION: "acme/ui" },
    origin: "https://git.example.com",
    linkStyle: "github",
  });
  assert.equal(forgejo[0].releaseUrl, "https://git.example.com/acme/ui/releases/tag/v2.1.0");
  const gitlab = pinBumps([mk], {
    repoLabel: "acme/server",
    components: { UI_VERSION: "https://gitlab.example.com/acme/ui" },
    origin: "https://gitlab.example.com",
    linkStyle: "gitlab",
  });
  assert.equal(gitlab[0].releaseUrl, "https://gitlab.example.com/acme/ui/-/releases/v2.1.0");
});

test("a pin that merely moves in the file, version unchanged, is not a bump", () => {
  const mk = df(
    "Makefile",
    `@@ -1,4 +1,4 @@
-WEB_ASSETS_VERSION = v7.2.0
 SHELL := bash
+WEB_ASSETS_VERSION = v7.2.0
 NAME := web
`,
  );
  assert.deepEqual(pinBumps([mk]), []);
});
