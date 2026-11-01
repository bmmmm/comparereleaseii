// SPDX-License-Identifier: GPL-3.0-or-later
// Run with `node test/tempdir-gate.ts`; keep this outside the suite to avoid recursion.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = await mkdtemp(join(tmpdir(), "crii-tempdir-gate-"));
try {
  console.log(`TMPDIR before: ${(await readdir(dir)).length} entries`);
  const child = spawn("pnpm", ["test"], {
    // Corepack enables a Node compile cache in TMPDIR before pnpm starts.
    env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: "1", TMPDIR: dir },
    stdio: "inherit",
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  const entries = (await readdir(dir)).sort();
  console.log(`TMPDIR after: ${entries.length} entries`);
  console.log(`$ ls -A "$TMPDIR"\n${execFileSync("ls", ["-A", dir], { encoding: "utf8" })}`);
  assert.equal(code, 0, "pnpm test failed");
  assert.equal(entries.length, 0, "pnpm test leaked temporary entries");
} finally {
  await rm(dir, { recursive: true, force: true });
}
