// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * A checkout has both src/ and dist/ as soon as anyone runs `pnpm build`; the
 * published tarball has only dist/, because package.json's `files` whitelist
 * omits src/. So "both present" means "someone's working tree", and the
 * working tree is the answer — a dist/ from an older build otherwise shadows
 * every edit, silently. That happened: a checkout of the commit this test
 * arrives in ran v0.1.1's scoring rules out of a stale dist/, and the only
 * symptom was a wrong number.
 */
test("the launcher prefers the working tree over a stale build", () => {
  const dir = mkdtempSync(join(tmpdir(), "comparereleaseii-launcher-"));
  try {
    mkdirSync(join(dir, "bin"));
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "dist"));
    copyFileSync(join(ROOT, "bin/comparerelease.mjs"), join(dir, "bin/comparerelease.mjs"));
    writeFileSync(join(dir, "src/cli.ts"), 'const which: string = "src";\nconsole.log(which);\n');
    writeFileSync(join(dir, "dist/cli.js"), 'console.log("dist");\n');

    const run = () =>
      execFileSync(process.execPath, [join(dir, "bin/comparerelease.mjs")], {
        encoding: "utf8",
      }).trim();

    assert.equal(run(), "src", "both present: the working tree wins");
    rmSync(join(dir, "src"), { recursive: true });
    assert.equal(run(), "dist", "installed tarball: only dist/ exists, and it runs");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
