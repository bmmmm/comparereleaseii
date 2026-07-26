// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const exec = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "src/cli.ts");

// `--version` is the first thing typed on a tool you were just handed. It used
// to fall through to parseArgs and exit 2 with "Unknown option '--version'",
// whose stock advice — place it after `--` as a positional — is wrong here.
// The value comes from package.json, so asserting it (not merely that
// something was printed) is what catches a version that stops tracking a bump.
test("--version prints the packaged version and exits 0", async () => {
  const { version } = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")) as {
    version: string;
  };
  // execFile rejects on a non-zero exit, so reaching the assert is the exit-0 check.
  const { stdout } = await exec(process.execPath, [CLI, "--version"]);
  assert.equal(stdout.trim(), `comparereleaseii ${version}`);
});

// The usage check treats "no repo argument" as an error, so an early return
// for --version is load-bearing: without it the flag parses fine and still
// exits 2 against an empty command line.
test("--version needs no repo argument", async () => {
  const { stdout, stderr } = await exec(process.execPath, [CLI, "--version"]);
  assert.match(stdout, /^comparereleaseii \d+\.\d+\.\d+/);
  assert.equal(stderr, "");
});

// NaN from an unvalidated numeric flag used to flow all the way into
// pooled(items, NaN, ...), which spawns zero workers and "completes" with an
// array of empty slots — silent garbage instead of an error.
test("numeric flags reject non-numbers with an actionable error", async () => {
  for (const [flag, value] of [
    ["--concurrency", "abc"],
    ["--baseline", "abc"],
    ["--suggest-limit", "x"],
    ["--history", "abc"],
  ]) {
    const res = await exec(process.execPath, [CLI, "owner/repo", flag, value]).then(
      () => null,
      (err: { code?: number; stderr?: string }) => err,
    );
    assert.ok(res, `${flag} ${value} exited 0`);
    assert.equal(res.code, 2, `${flag}: exit ${res.code}`);
    assert.match(res.stderr ?? "", new RegExp(`${flag} must be`), `${flag}: ${res.stderr}`);
  }
});
