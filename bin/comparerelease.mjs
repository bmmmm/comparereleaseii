#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Launcher: checks the Node requirement with a plain-JS file so old Node
// versions get an actionable message instead of a TypeScript syntax error.
const major = Number(process.versions.node.split(".")[0]);
if (major < 24) {
  console.error(
    `comparerelease needs Node >= 24 (runs TypeScript natively) — found ${process.versions.node}.\n` +
      "Upgrade via https://nodejs.org or your version manager (e.g. `fnm install 24`).",
  );
  process.exit(2);
}
// The published tarball ships compiled dist/ — Node refuses to strip types
// under node_modules — while a git clone runs the src/ TypeScript directly.
// src/ wins when both exist, and only a clone has both: the tarball's `files`
// whitelist has no src/. The other order let a dist/ left over from an old
// `pnpm build` shadow the working tree silently — a checkout of this commit
// answered with v0.1.1's scoring rules, and nothing said so.
const { existsSync } = await import("node:fs");
const src = new URL("../src/cli.ts", import.meta.url);
await import(existsSync(src) ? src.href : new URL("../dist/cli.js", import.meta.url).href);
