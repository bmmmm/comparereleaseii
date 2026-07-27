// SPDX-License-Identifier: GPL-3.0-or-later
// Mutation harness: each entry names a guard the scoring/parsing pipeline
// depends on, applies a targeted mutation to it, and expects the test suite
// to go red ("killed"). A surviving mutant means the guard has no test — add
// one before shipping changes near it. A new guard belongs in this list.
//
// Run with `pnpm mutate`. The predecessor (tmp/rt/mutate.mjs, 28/28 killed)
// lived in an ignored directory and was lost with it; this one is tracked.
import { readFile, writeFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";

interface Mutant {
  /** What the guard protects — the sentence a survivor puts in doubt. */
  guard: string;
  file: string;
  find: string;
  replace: string;
}

const MUTANTS: Mutant[] = [
  {
    guard: "a contradicted claim floors the score at 35",
    file: "src/metrics.ts",
    find: 'if (results.some((r) => r.verdict === "contradicted")) overall = Math.min(overall, 35);',
    replace: 'if (false) overall = Math.min(overall, 35);',
  },
  {
    guard: "a critical flag caps the score at 45",
    file: "src/metrics.ts",
    find: 'else if (flags.some((f) => f.severity === "critical")) overall = Math.min(overall, 45);',
    replace: "else if (false) overall = Math.min(overall, 45);",
  },
  {
    guard: "an unverifiable release is capped and labeled, never 'solid'",
    file: "src/metrics.ts",
    find: "overall: Math.min(overall, UNVERIFIED_CAP),",
    replace: "overall,",
  },
  {
    guard: "markdown files are never classified as ci/build or auth code",
    file: "src/metrics.ts",
    find: "if (DOC_FILE.test(path)) return null;",
    replace: "",
  },
  {
    guard: "test files are not auth code (forwardauth_test.go class)",
    file: "src/metrics.ts",
    find: "if (TEST_FILE.test(path)) return null;",
    replace: "",
  },
  {
    guard: "author identity is keyed by email across sources",
    file: "src/history.ts",
    find: "return email || commit.author;",
    replace: "return commit.author;",
  },
  {
    guard: "commit records are NUL-framed; body separators cannot desync them",
    file: "src/sources/local.ts",
    find: "const [sha, author, email, subject = \"\", body = \"\"] = splitFields(entry, 4);",
    replace: "const [sha, author, email, subject = \"\", body = \"\"] = entry.split(\"\\x1f\");",
  },
  {
    guard: "contradicted needs a second concordant voter",
    file: "src/verify.ts",
    find: 'const seconded = votes.filter((v) => v.verdict === "contradicted").length >= 2;',
    replace: 'const seconded = votes.filter((v) => v.verdict === "contradicted").length >= 1;',
  },
  {
    guard: "a local primary's verified on sensitive evidence paths escalates",
    file: "src/verify.ts",
    find: "evidencePaths.some((path) => sensitiveCategory(path) !== null));",
    replace: "false);",
  },
  {
    guard: "fenced code blocks never become claims",
    file: "src/claims.ts",
    find: "if (inFence) continue;",
    replace: "",
  },
  {
    guard: "markup-only lines never become claims",
    file: "src/claims.ts",
    find: 'return text.replace(/<[^>]*>/g, " ").replace(/\\s+/g, " ").trim();',
    replace: "return text.trim();",
  },
  {
    guard: "a forged marker inside untrusted text is defused",
    file: "src/judge.ts",
    find: 'const body = text.replace(MARKER, (m) => m.replace(/-/g, "–"));',
    replace: "const body = text;",
  },
  {
    guard: "the verdict cache key carries the tool version",
    file: "src/cache.ts",
    find: ".update(`${VERSION}\\0${engineName}\\0${prompt}`)",
    replace: ".update(`${engineName}\\0${prompt}`)",
  },
  {
    guard: "snapshot cache entries from another tool version are rebuilt",
    file: "src/history.ts",
    find: 'if (version === VERSION && typeof cached.lexicalCoverage === "number") return cached;',
    replace: 'if (typeof cached.lexicalCoverage === "number") return cached;',
  },
  {
    guard: "added lines starting with ++ are counted (`++i;` arrives as `+++i;`)",
    file: "src/sources/local.ts",
    find: 'if (line.startsWith("+")) additions++;',
    replace: 'if (line.startsWith("+") && !line.startsWith("++")) additions++;',
  },
  {
    guard: "a stable head is never diffed against its own release candidate",
    file: "src/sources/local.ts",
    find: "while (PRERELEASE_TAG.test(base)) {",
    replace: "while (false) {",
  },
  {
    guard: "HTML output escapes hostile refs and claim text",
    file: "src/html.ts",
    find: '.replaceAll("<", "&lt;")',
    replace: '.replaceAll("<", "<​")',
  },
  {
    guard: "GitLab reports use the /-/ route dialect",
    file: "src/html.ts",
    find: 'const route = style === "gitlab" ? "/-/commit/" : "/commit/";',
    replace: 'const route = "/commit/";',
  },
  {
    guard: "a served need is graded on its final verdict, not on asking",
    file: "src/calibrate.ts",
    find: 'const finalExpected = gc.finalExpected ?? gc.expected.filter((e) => e !== "need");',
    replace:
      'return { ...common, got: "need", pass: gc.expected.includes("need"), overVerified: false, formatIssue: meta.repaired, reasoning: "round 1 only", ms: performance.now() - t0 };\n        const finalExpected = gc.finalExpected ?? gc.expected.filter((e) => e !== "need");',
  },
  {
    guard: "an obeyed injection case disqualifies a judge",
    file: "src/calibrate.ts",
    find: "if (injectionFails.length) {",
    replace: "if (false) {",
  },
  {
    guard: "a security rubber-stamp disqualifies a judge",
    file: "src/calibrate.ts",
    find: "if (stamps.length) {",
    replace: "if (false) {",
  },
  {
    guard: "a broken email-to-account pairing raises the spoof warn",
    file: "src/metrics.ts",
    find: "commit.login !== expected &&",
    replace: "false &&",
  },
  {
    guard: "a formed baseline replaces the absolute alert bar",
    file: "src/watch.ts",
    find: "if (baseline !== null) return score <= baseline - SCORE_DROP;",
    replace: "",
  },
  {
    guard: "a promise is broken only once its target release is reached",
    file: "src/promises.ts",
    find: "if (targetReached(promise.target, data.headRef)) {",
    replace: "if (true) {",
  },
  {
    guard: "a removal promise is proven by deletions, not additions",
    file: "src/promises.ts",
    find: 'const marker = kind === "removal" ? "-" : "+";',
    replace: 'const marker = "+";',
  },
  {
    guard: "foreign text is stripped of control characters before the terminal",
    file: "src/util.ts",
    find: 'return s.replace(CONTROL_CHARS, "");',
    replace: "return s;",
  },
  {
    guard: "a still-open promise ages out as stale after STALE_AFTER carries",
    file: "src/promises.ts",
    find: 'if (res.status === "still-open" && (res.carriedFor ?? 0) >= STALE_AFTER) {',
    replace: "if (false) {",
  },
  {
    guard: "stale promises are not re-carried (that would undo the aging)",
    file: "src/watch.ts",
    find: '.filter((p) => p.status === "still-open")\n    .map((p) => ({',
    replace: '.filter((p) => p.status === "still-open" || p.status === "stale")\n    .map((p) => ({',
  },
  {
    guard: "the ledger cap prefers still-open entries over resolved ones",
    file: "src/watch.ts",
    find: "return [...open, ...resolved].slice(0, MAX_PROMISE_LEDGER);",
    replace: "return promises.slice(0, MAX_PROMISE_LEDGER);",
  },
];

// Same file set as `pnpm test` — a bare `--test test/` would also pick up
// fixtures and fail on them.
const testFiles = (await readdir("test")).filter((f) => f.endsWith(".test.ts")).map((f) => `test/${f}`);

function runSuite(): boolean {
  const res = spawnSync("node", ["--test", ...testFiles], { encoding: "utf8" });
  return res.status === 0;
}

const only = process.argv[2];
const selected = only ? MUTANTS.filter((m) => m.guard.includes(only)) : MUTANTS;
if (!selected.length) {
  console.error(`No mutant matches "${only}" — guards:\n${MUTANTS.map((m) => `  ${m.guard}`).join("\n")}`);
  process.exit(2);
}

console.error("Checking the suite is green before mutating…");
if (!runSuite()) {
  console.error("Baseline suite is red — fix the tests before measuring mutants.");
  process.exit(1);
}

let killed = 0;
const survivors: Mutant[] = [];
for (const [i, m] of selected.entries()) {
  const source = await readFile(m.file, "utf8");
  const occurrences = source.split(m.find).length - 1;
  if (occurrences !== 1) {
    console.error(
      `STALE ${m.file}: pattern for "${m.guard}" matches ${occurrences}× — update the mutant.`,
    );
    process.exit(1);
  }
  process.stderr.write(`[${i + 1}/${selected.length}] ${m.guard} … `);
  await writeFile(m.file, source.replace(m.find, m.replace));
  try {
    const green = runSuite();
    if (green) {
      survivors.push(m);
      console.error("SURVIVED — no test catches this");
    } else {
      killed++;
      console.error("killed");
    }
  } finally {
    await writeFile(m.file, source);
  }
}

console.error(`\n${killed}/${selected.length} mutants killed.`);
if (survivors.length) {
  console.error("Survivors (each needs a test):");
  for (const m of survivors) console.error(`  - ${m.guard} (${m.file})`);
  process.exit(1);
}
