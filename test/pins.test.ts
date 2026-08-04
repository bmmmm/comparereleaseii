// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectBumpClaim, pinBumps } from "../src/pins.ts";
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

test("repoUrl marks the loadable sources — certain hosts only, never guessed", () => {
  // Config slug: defer to the checked repo's own forge (github.com here).
  const slug = pinBumps([OPENCLOUD_MAKEFILE], {
    repoLabel: "opencloud-eu/opencloud",
    components: { WEB_ASSETS_VERSION: "opencloud-eu/web" },
    origin: "https://github.com",
  });
  assert.equal(slug[0].repoUrl, "https://github.com/opencloud-eu/web");

  // Config URL: the declared source verbatim, `.git` stripped.
  const url = pinBumps([OPENCLOUD_MAKEFILE], {
    repoLabel: "opencloud-eu/opencloud",
    components: { WEB_ASSETS_VERSION: "https://git.example.com/team/web.git" },
  });
  assert.equal(url[0].repoUrl, "https://git.example.com/team/web");

  // Config slug without an origin (--local): no forge to defer to.
  const local = pinBumps([OPENCLOUD_MAKEFILE], {
    repoLabel: "opencloud-eu/opencloud",
    components: { WEB_ASSETS_VERSION: "opencloud-eu/web" },
  });
  assert.equal(local[0].repoUrl, undefined);

  // A go.mod path on github.com is loadable without any config.
  const gomod = pinBumps(
    [df("go.mod", "@@ -1,1 +1,1 @@\n-\tgithub.com/acme/lib v1.0.0\n+\tgithub.com/acme/lib v1.1.0\n")],
    { repoLabel: "acme/app" },
  );
  assert.equal(gomod[0].repoUrl, "https://github.com/acme/lib");

  // A foreign dotted host is never guessed at, owner match or not.
  const foreign = pinBumps(
    [df("go.mod", "@@ -1,1 +1,1 @@\n-\tgitlab.com/acme/lib v1.0.0\n+\tgitlab.com/acme/lib v1.1.0\n")],
    { repoLabel: "acme/app", origin: "https://github.com" },
  );
  assert.equal(foreign[0].firstParty, true, "owner still matches");
  assert.equal(foreign[0].repoUrl, undefined);
});

// ---------- the claim side: what a note says a pin did ----------
//
// Every text below is verbatim from the corpus (docs/corpus.md), which is
// also where the shapes come from: dependabot writes two sides, renovate
// writes one, hand-written dependency sections write either.

test("dependabot's two-sided form is a bump claim", () => {
  assert.deepEqual(
    detectBumpClaim("chore(deps): bump actions/cache from 5.0.3 to 5.0.4 by @dependabot[bot] in #9668"),
    { name: "actions/cache", from: "5.0.3", to: "5.0.4" },
  );
});

test("the noun never eats the pin name — `actions/cache` is not `action` plus `s/cache`", () => {
  // The noun list has to end on a word boundary: "action" is a prefix of
  // "actions", and swallowing it named the pin "s/cache" for every single
  // GitHub-Actions bump in the corpus — the largest group there is.
  const bump = detectBumpClaim("bump actions/stale from 10.1.1 to 10.2.0");
  assert.equal(bump?.name, "actions/stale");
});

test("renovate's one-sided form is a bump claim — the destination is enough", () => {
  assert.deepEqual(detectBumpClaim("[deps] Platform: Update @babel/core to v7.29.6 [SECURITY]"), {
    name: "@babel/core",
    to: "v7.29.6",
  });
  assert.deepEqual(detectBumpClaim("[deps] Platform: Update Rust crate serde_with to v3.21.0"), {
    name: "serde_with",
    to: "v3.21.0",
  });
  assert.deepEqual(
    detectBumpClaim("**[tracing]** Bump github.com/DataDog/dd-trace-go/v2 to 2.8.1 (#13530 @kevinpollet)"),
    { name: "github.com/DataDog/dd-trace-go/v2", to: "2.8.1" },
  );
});

test("a backticked name is a pin name whatever it is spelled like", () => {
  assert.deepEqual(detectBumpClaim("Bumped `tokio` from 1.2.0 to 1.3.0"), {
    name: "tokio",
    from: "1.2.0",
    to: "1.3.0",
  });
});

test("prose with a version in it is not a bump claim", () => {
  // A bare word plus a number is the shape of half of all release notes.
  // Without the pin-shape bar this class would swallow them.
  assert.equal(detectBumpClaim("Upgrade protocol to 3.1"), undefined);
  // The app's own version is not a pin, and no version is named at all.
  assert.equal(detectBumpClaim("Bump client version(s) by @github-actions in #21554"), undefined);
  // A count is not a version — one dotted number is the bar.
  assert.equal(detectBumpClaim("Update `foo` to 3"), undefined);
});

// ---------- workflow action pins ----------
//
// `uses:` refs are where the corpus's largest bump group lives: six of the
// eight contradicted bump claims in it are dependabot lines about actions.

const CI_WORKFLOW = df(
  ".github/workflows/build.yml",
  `@@ -20,7 +20,7 @@ jobs:
     steps:
-      - uses: actions/cache@v5.0.3
+      - uses: actions/cache@v5.0.5
       - uses: actions/checkout@v6.0.3
`,
);

test("a workflow's uses: ref is a pin, linked to the action's own release", () => {
  const pins = pinBumps([CI_WORKFLOW], { repoLabel: "nextcloud/desktop" });
  assert.deepEqual(pins, [
    {
      name: "actions/cache",
      from: "v5.0.3",
      to: "v5.0.5",
      file: ".github/workflows/build.yml",
      firstParty: false,
      repo: "actions/cache",
      releaseUrl: "https://github.com/actions/cache/releases/tag/v5.0.5",
      repoUrl: "https://github.com/actions/cache",
    },
  ]);
});

test("a sha-pinned ref bumps by the version in its comment, not by the sha", () => {
  // The hardened form: the sha is the pin, the comment is the version the
  // bumping bot and the release note both quote.
  const pins = pinBumps(
    [
      df(
        ".github/workflows/release.yml",
        `@@ -1,3 +1,3 @@
-      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.1.2
+      - uses: actions/checkout@08c6903cd8c0fde910a37f88322edcfb5dd907a8 # v4.2.0
`,
      ),
    ],
    { repoLabel: "acme/app" },
  );
  assert.equal(pins.length, 1);
  assert.equal(pins[0].from, "v4.1.2");
  assert.equal(pins[0].to, "v4.2.0");
});

test("a moving ref pins nothing — @main is not a version", () => {
  const pins = pinBumps(
    [
      df(
        ".github/workflows/build.yml",
        `@@ -1,2 +1,2 @@
-      - uses: acme/deploy@main
+      - uses: acme/deploy@next
`,
      ),
    ],
    { repoLabel: "acme/app" },
  );
  assert.deepEqual(pins, []);
});

test("the same action bumped across several workflows is one bump", () => {
  const second = df(".github/workflows/test.yml", CI_WORKFLOW.patch!);
  const pins = pinBumps([CI_WORKFLOW, second], { repoLabel: "nextcloud/desktop" });
  assert.equal(pins.length, 1, "one pin moving one way is one fact, not one per file");
  assert.equal(pins[0].file, ".github/workflows/build.yml");
});

test("a forge workflow classifies its pins and links none of them", () => {
  // Which forge `uses: owner/repo` resolves to is instance configuration
  // outside .github/ — first-party still follows from the owner.
  const pins = pinBumps(
    [
      df(
        ".forgejo/workflows/ci.yml",
        `@@ -1,2 +1,2 @@
-      - uses: acme/setup-tool@v1.2.0
+      - uses: acme/setup-tool@v1.3.0
`,
      ),
    ],
    { repoLabel: "acme/app", origin: "https://forge.example.com" },
  );
  assert.equal(pins[0].firstParty, true);
  assert.equal(pins[0].repo, undefined);
  assert.equal(pins[0].releaseUrl, undefined);
  assert.equal(pins[0].repoUrl, undefined);
});
