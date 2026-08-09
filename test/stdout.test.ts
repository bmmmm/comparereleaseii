// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Run a snippet in a child whose stdout is a PIPE — the case that breaks. */
function throughAPipe(body: string): { out: string; status: number | null } {
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", body], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    cwd: ROOT,
  });
  return { out: res.stdout ?? "", status: res.status };
}

// The bug this guards against reported success: `pnpm sweep` read a 130 KB
// measurement, got 65184 bytes and exit 0, and every point it measured failed
// to parse. A harness that hands back a quarter of its answer and calls it
// done is worse than one that crashes.
test("a report larger than the pipe buffer arrives whole", () => {
  const size = 200_000;
  const { out, status } = throughAPipe(
    `import { writeStdoutSync } from "./scripts/stdout.ts";
     writeStdoutSync("x".repeat(${size}) + "\\n");
     process.exit(0);`,
  );
  assert.equal(status, 0);
  assert.equal(out.length, size + 1, `truncated at ${out.length} bytes`);
});

// Multibyte matters: the loop counts BYTES, and the report is full of em
// dashes and middots. A boundary landing inside a character would corrupt it
// even when the length looks right.
test("multibyte content survives the boundary", () => {
  const { out, status } = throughAPipe(
    `import { writeStdoutSync } from "./scripts/stdout.ts";
     writeStdoutSync("üß—·".repeat(30_000) + "\\n");
     process.exit(0);`,
  );
  assert.equal(status, 0);
  assert.equal(out, "üß—·".repeat(30_000) + "\n");
});

// What the fix replaced, kept as the reason it exists — and darwin-only,
// which is the more interesting half.
//
// On macOS a pipe stdout is non-blocking, so `console.log` hands off what fits
// and `process.exit` drops the rest. On Linux the same fd blocks, the write
// completes, and nothing is lost. That is why this bug cost two full sweep
// runs on a developer machine while CI stayed green throughout: the harness
// truncating its own report at 65184 bytes was not reproducible on the
// platform that tests it. A green pipeline is not evidence that a measurement
// taken elsewhere was whole.
test("the shape this replaced does lose data — on the platform it was found on", {
  skip: process.platform !== "darwin" ? "pipe stdout blocks outside darwin" : false,
}, () => {
  const { out } = throughAPipe(`console.log("x".repeat(200_000)); process.exit(0);`);
  assert.ok(out.length < 200_000, `expected truncation, got ${out.length} bytes`);
});
