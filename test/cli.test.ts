// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
    ["--min-coverage", "abc"],
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

// The counterpart to the numeric check above, and it had none: an unrecognised
// word on a mode flag is the same class of bug — it used to pass the cast and
// become a mode nobody implements. Each rejection has to name the choices, or
// the reader is left guessing which spelling was wanted.
test("mode flags reject unknown words and name the choices", async () => {
  for (const [flag, expected] of [
    ["--judge", /auto, all or off/],
    ["--engine", /claude-cli, api, openai or off/],
    ["--fail-on", /none, contradicted or no-evidence/],
    ["--escalate", /auto, off, claude-cli, api or openai/],
    ["--lens", /operator, integrator, user or all/],
  ] as Array<[string, RegExp]>) {
    const res = await exec(process.execPath, [CLI, "owner/repo", flag, "nonsense"]).then(
      () => null,
      (err: { code?: number; stderr?: string }) => err,
    );
    assert.ok(res, `${flag} nonsense exited 0`);
    assert.equal(res.code, 2, `${flag}: exit ${res.code}`);
    assert.match(res.stderr ?? "", new RegExp(`${flag} must be`), `${flag}: ${res.stderr}`);
    assert.match(res.stderr ?? "", expected, `${flag} does not list its choices: ${res.stderr}`);
    assert.match(res.stderr ?? "", /got "nonsense"/, `${flag} does not echo the input`);
  }
});

// `cache` is a subcommand, so it never reaches the flag parser above: a typo
// there used to be the repo argument of an ordinary check, which would then
// go and talk to a forge about a repository called "gc".
test("cache reports the directory it would collect, and rejects a subcommand it has not got", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "crii-cli-cache-"));
  const env = { ...process.env, XDG_CACHE_HOME: home };
  const { stdout } = await exec(process.execPath, [CLI, "cache", "stats"], { env });
  assert.match(stdout, /verdict cache — .*verdicts/);
  assert.match(stdout, /0 entries/);

  const empty = await exec(process.execPath, [CLI, "cache", "gc"], { env });
  assert.match(empty.stdout, /Removed 0 entries.*0 kept/);

  const res = await exec(process.execPath, [CLI, "cache", "bogus"], { env }).then(
    () => null,
    (err: { code?: number; stderr?: string }) => err,
  );
  assert.ok(res, "an unknown cache subcommand exited 0");
  assert.equal(res.code, 2, `exit ${res.code}`);
  assert.match(res.stderr ?? "", /expected stats or gc/);
  t.diagnostic(`cache home ${home}`);
});

test("--min-coverage rejects values above 100", async () => {
  const res = await exec(process.execPath, [CLI, "owner/repo", "--min-coverage", "150"]).then(
    () => null,
    (err: { code?: number; stderr?: string }) => err,
  );
  assert.ok(res, "--min-coverage 150 exited 0");
  assert.equal(res.code, 2, `exit ${res.code}`);
  assert.match(res.stderr ?? "", /percentage 0–100/);
});
