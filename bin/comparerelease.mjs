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
const { existsSync } = await import("node:fs");
const dist = new URL("../dist/cli.js", import.meta.url);
await import(existsSync(dist) ? dist.href : new URL("../src/cli.ts", import.meta.url).href);
