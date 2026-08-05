// SPDX-License-Identifier: GPL-3.0-or-later
// Mutation harness: each entry names a guard the scoring/parsing pipeline
// depends on, applies a targeted mutation to it, and expects the test suite
// to go red ("killed"). A surviving mutant means the guard has no test — add
// one before shipping changes near it. A new guard belongs in this list.
//
// Run with `pnpm mutate`. The predecessor (tmp/rt/mutate.mjs, 28/28 killed)
// lived in an ignored directory and was lost with it; this one is tracked.
import { readFile, writeFile, readdir } from "node:fs/promises";
import { writeFileSync } from "node:fs";
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
    guard: "a 1.x minor bump with BREAKING markers warns; dropping the major gate must be caught",
    file: "src/bump.ts",
    find: 'if (breaking.length && (bump === "patch" || base.major >= 1)) {',
    replace: 'if (breaking.length && bump === "patch") {',
  },
  {
    guard: "prerelease tags make no bump claim and stay out of bump-mismatch",
    file: "src/bump.ts",
    find: "if (!base || !head || base.prerelease || head.prerelease) return [];",
    replace: "if (!base || !head) return [];",
  },
  {
    guard: "feat-in-patch only fires in repos that actually speak conventional commits",
    file: "src/bump.ts",
    find: "conventional.length / own.length >= 0.25",
    replace: "conventional.length / own.length >= 0",
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
    file: "src/util.ts",
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
    file: "src/watch-state.ts",
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
    file: "src/watch-state.ts",
    find: '.filter((p) => p.status === "still-open")\n    .map((p) => ({',
    replace: '.filter((p) => p.status === "still-open" || p.status === "stale")\n    .map((p) => ({',
  },
  {
    guard: "the ledger cap prefers still-open entries over resolved ones",
    file: "src/watch-state.ts",
    find: "return [...open, ...resolved].slice(0, MAX_PROMISE_LEDGER);",
    replace: "return promises.slice(0, MAX_PROMISE_LEDGER);",
  },
  {
    guard: "a forge watch entry links to its forge, never pinned on github.com",
    file: "src/watch-index.ts",
    find: "url ?? (repo.includes(\"/\") && !repo.includes(\"://\") ? `https://github.com/${repo}` : null);",
    replace: "repo.includes(\"/\") ? `https://github.com/${repo}` : null;",
  },
  {
    guard: "release web URLs speak GitLab's /-/ route dialect",
    file: "src/watch-state.ts",
    find: "return link.style === \"gitlab\"\n    ? `${link.base}/-/releases/${t}`\n    : `${link.base}/releases/tag/${t}`;",
    replace: "return `${link.base}/releases/tag/${t}`;",
  },
  {
    guard: "the score waterfall uses the formula's own weights and reconciles to the reported overall",
    file: "src/metrics.ts",
    find: ": 0.45 * s.correctness + 0.25 * s.completeness + 0.3 * s.risk;",
    replace: ": 0.5 * s.correctness + 0.25 * s.completeness + 0.3 * s.risk;",
  },
  {
    guard: "the waterfall mirrors the critical-flag cap instead of absorbing it as residual",
    file: "src/metrics.ts",
    find: '} else if (flags.some((f) => f.severity === "critical") && Math.round(total) > 45) {',
    replace: "} else if (false) {",
  },
  {
    guard: "an author's firstSeen is immutable once recorded",
    file: "src/watch-state.ts",
    find: "    rec.name = act.name;\n    rec.lastSeen = tag;",
    replace: "    rec.name = act.name;\n    rec.firstSeen = tag;\n    rec.lastSeen = tag;",
  },
  {
    guard: "a backfilled check never becomes 'latest' over a newer one",
    file: "src/watch-state.ts",
    find: "if (!repoState.latest || at(checked) >= at(repoState.latest)) repoState.latest = checked;",
    replace: "repoState.latest = checked;",
  },
  {
    guard: "a successful check moves the poll cursor forward only",
    file: "src/watch-state.ts",
    find: "    checked.publishedAt &&\n    (repoState.lastPublishedAt === null || checked.publishedAt > repoState.lastPublishedAt)",
    replace: "    Boolean(checked.publishedAt)",
  },
  {
    guard: "giving up on a backfilled old release keeps the poll cursor in place",
    file: "src/watch-state.ts",
    find: "    rel.publishedAt &&\n    (repoState.lastPublishedAt === null || rel.publishedAt > repoState.lastPublishedAt)",
    replace: "    Boolean(rel.publishedAt)",
  },
  {
    guard: "the baseline median reads the newest window, not the whole history",
    file: "src/watch-state.ts",
    find: "return scoreBaseline(history.slice(-BASELINE_WINDOW));",
    replace: "return scoreBaseline(history);",
  },
  {
    guard: "drift compares recent halves, not this year against the whole record",
    file: "src/watch-state.ts",
    find: "const window = history.slice(-DRIFT_WINDOW);",
    replace: "const window = history;",
  },
  {
    guard: "backfill never re-checks a release already on record",
    file: "src/watch-state.ts",
    find: "      !done.has(r.tag) &&\n",
    replace: "",
  },
  {
    guard: "backfill leaves releases newer than the poll cursor to the watch run",
    file: "src/watch-state.ts",
    find: "(repoState.lastPublishedAt === null || r.publishedAt! <= repoState.lastPublishedAt),",
    replace: "true,",
  },
  {
    guard: "a phase opens only on a score shift past the threshold",
    file: "src/watch-longview.ts",
    find: "if (Math.abs(medAhead - medCur) >= PHASE_SHIFT) {",
    replace: "if (false) {",
  },
  {
    guard: "a single outlier release never opens a phase (median look-ahead)",
    file: "src/watch-longview.ts",
    find: "const medAhead = median(ahead.map((h) => h.score))!;",
    replace: "const medAhead = ahead[0].score;",
  },
  {
    guard: "a top-author change needs the new identity to hold the window",
    file: "src/watch-longview.ts",
    find: "if (topCur && topAhead && topCur !== topAhead && aheadCount >= 2) {",
    replace: "if (topCur && topAhead && topCur !== topAhead && aheadCount >= 1) {",
  },
  {
    guard: "the long view stays off below the check threshold",
    file: "src/watch-longview.ts",
    find: "if (history.length < LONGVIEW_MIN_CHECKS) return \"\";",
    replace: "",
  },
  {
    guard: "a first appearance is an event only at a high commit share",
    file: "src/watch-longview.ts",
    find: "(h.authors?.top1Share ?? 0) >= NEW_TOP_SHARE &&",
    replace: "",
  },
  {
    guard: "the event cap keeps regime information over routine flags",
    file: "src/watch-longview.ts",
    find: ".sort((a, b) => EVENT_PRIORITY[a.kind] - EVENT_PRIORITY[b.kind] || a.idx - b.idx)",
    replace: ".sort((a, b) => a.idx - b.idx)",
  },
  {
    guard: "the atom feed never publishes backfilled checks as news",
    file: "src/watch-index.ts",
    find: "    .filter(({ h }) => !h.backfilled)\n",
    replace: "",
  },
  {
    guard: "a pin that moves in the file without changing its version is not a bump",
    file: "src/pins.ts",
    find: "if (from === undefined || from === e.version) continue;",
    replace: "if (from === undefined) continue;",
  },
  {
    guard: "first-party needs the pin's owner to match the checked repo's",
    file: "src/pins.ts",
    find: "if (owner !== null && pin.coords.owner.toLowerCase() === owner) bump.firstParty = true;",
    replace: "if (owner !== null) bump.firstParty = true;",
  },
  {
    guard: "a config read moved to another file cancels — refactoring is not new surface",
    file: "src/substance.ts",
    find: "added: [...plus].filter((k) => !minus.has(k)).sort(),",
    replace: "added: [...plus].sort(),",
  },
  {
    guard: "test symbols never enter the shipped-surface symbol list",
    file: "src/substance.ts",
    find: '.filter((f) => f.patch && fileCategory(f.path) === "source")',
    replace: ".filter((f) => Boolean(f.patch))",
  },
  {
    guard: "component expansion stays one level deep — a child never expands its own pins",
    file: "src/check.ts",
    find: "expand: undefined,",
    replace: "expand: s.expand,",
  },
  {
    guard: "only first-party pins expand — a third-party bump is never sub-checked",
    file: "src/check.ts",
    find: "(p) => p.firstParty && p.repoUrl && p.repo !== repoLabel,",
    replace: "(p) => Boolean(p.repoUrl) && p.repo !== repoLabel,",
  },
  {
    guard: "a security finding addresses everyone — it cannot hide under one role's lens",
    file: "src/judge.ts",
    find: 'f.kind === "security" ? { ...f, audience: "everyone" } : f,',
    replace: 'f.kind === "security" && false ? { ...f, audience: "everyone" } : f,',
  },
  {
    guard: "the findings budget is a hard cap — subsystems beyond it are declared, not read",
    file: "src/findings.ts",
    find: "const alloc = remaining >= MIN_CALL_CHARS ? Math.min(PER_CALL_CHARS, remaining) : 0;",
    replace: "const alloc = Math.min(PER_CALL_CHARS, Math.max(remaining, MIN_CALL_CHARS));",
  },
  {
    guard: "a lens never hides a finding addressed to everyone",
    file: "src/report.ts",
    find: '(f) => f.audience === lens || f.audience === "everyone"',
    replace: "(f) => f.audience === lens",
  },
  {
    guard: "internal findings stay folded behind a lens — they are invisible outside the codebase",
    file: "src/report.ts",
    find: 'const nonInternal = bySeverity.filter((f) => f.kind !== "internal");',
    replace: "const nonInternal = bySeverity;",
  },
  {
    guard: "a component sub-check never runs its own findings pass",
    file: "src/check.ts",
    find: "findings: false,",
    replace: "findings: s.findings,",
  },
  {
    guard: "changelog diffs are never findings evidence — the notes cannot describe themselves",
    file: "src/findings.ts",
    find: "if (isChangelogPath(f.path)) continue;",
    replace: "",
  },
  {
    guard: "coverage is earned by the commit's own diff, never by resemblance alone",
    file: "src/verify.ts",
    find: "changeClaims.some((claim) => lexicalMatch(claim, files).score >= 5);",
    replace: "changeClaims.some(() => true);",
  },
  {
    guard: "a claim confirms a finding only past the identifier bar — one span or two identifiers",
    file: "src/reconcile.ts",
    find: "const MATCH_BAR = 3;",
    replace: "const MATCH_BAR = 1;",
  },
  {
    guard: "meta and skipped claims never join the reconciliation",
    file: "src/reconcile.ts",
    find: 'if (r.claim.kind === "change" && r.verdict !== "skipped") eligible.push(i);',
    replace: "eligible.push(i);",
  },
  {
    guard: "the uncovered order is emitted only when it actually reorders",
    file: "src/reconcile.ts",
    find: "if (order.some((v, i) => v !== i)) uncoveredOrder = order;",
    replace: "uncoveredOrder = order;",
  },
  {
    guard: "a moving workflow ref pins nothing — @main is not a version",
    file: "src/pins.ts",
    find: "return VERSION_SHAPE.test(version) ? [{ name: m[1], version }] : [];",
    replace: "return [{ name: m[1], version }];",
  },
  {
    guard: "a sha-pinned action bumps by the version in its comment, not by the sha",
    file: "src/pins.ts",
    find: "const version = m[3] && VERSION_SHAPE.test(m[3]) ? m[3] : m[2];",
    replace: "const version = m[2];",
  },
  {
    guard: "one pin moving one way is one bump, however many files repeat it",
    file: "src/pins.ts",
    find: "      if (seen.has(key)) return false;\n",
    replace: "",
  },
  {
    guard: "a bump claim needs a pin-shaped name — prose with a version in it is not one",
    file: "src/pins.ts",
    find: "if (!noun && !tick && !PIN_NAME_SHAPE.test(name)) return undefined;",
    replace: "",
  },
  {
    guard: "the bump-claim noun ends on a word boundary (`actions/cache` is not `action` + `s/cache`)",
    file: "src/pins.ts",
    find: "(?:dependencies|dependency|crate|module|package|action|image|plugin|gem|library)\\s+)?",
    replace: "(?:dependencies|dependency|crate|module|package|action|image|plugin|gem|library)\\s*)?",
  },
  {
    guard: "a bump the release diff cancels out is looked for in the commit that made it",
    file: "src/check.ts",
    find: "  const second = resolveBumpClaims(claims, commitPins, { viaCommit: true });",
    replace: "  const second: BumpResolution[] = [];",
  },
  {
    guard: "the commit retry never overrides a bump the release diff already settled",
    file: "src/check.ts",
    find: '    if (b.status !== "unmatched") return b;',
    replace: "",
  },
  {
    guard: "an overtaken bump line shows both numbers — the note's and the diff's",
    file: "src/report.ts",
    find: "observed: b.observed ? `${b.observed.from} → ${b.observed.to}` : undefined,",
    replace: "observed: undefined,",
  },
  {
    guard: "a bump claim the pins settle never reaches a judge",
    file: "src/verify.ts",
    find: "    const bump = opts.bumps?.get(claim.id);\n    if (bump?.observed) {",
    replace: "    const bump = opts.bumps?.get(claim.id);\n    if (false && bump?.observed) {",
  },
  {
    guard: "an overtaken bump claim is verified, not contradicted",
    file: "src/verify.ts",
    find: 'bump.status === "overtaken"',
    replace: 'resolution.status === "unmatched"',
  },
  {
    guard: "overtaken needs the claimed version inside the interval the pin traversed",
    file: "src/reconcile.ts",
    find: 'status = inside > 0 ? "overtaken" : "contradicted";',
    replace: 'status = "overtaken";',
  },
  {
    guard: "a release overtaking its own bump note is never read as a contradiction",
    file: "src/reconcile.ts",
    find: '? "overtaken"',
    replace: '? "contradicted"',
  },
  {
    guard: "versions that cannot be ordered leave the bump claim unresolved",
    file: "src/reconcile.ts",
    find: "if (!/^\\d+$/.test(x) || !/^\\d+$/.test(y)) return null;",
    replace: "",
  },
  {
    guard: "a bare last segment never names a pin (`cache` is not `actions/cache`)",
    file: "src/reconcile.ts",
    find: 'if (a.includes("/") && b.endsWith(`/${a}`)) return true;\n  return b.includes("/") && a.endsWith(`/${b}`);',
    replace: "return a.endsWith(`/${b}`) || b.endsWith(`/${a}`);",
  },
  {
    guard: "a state file has one writer at a time",
    file: "src/watch.ts",
    find: "  const lock = await acquireStateLock(statePath);\n  if (!lock.ok) {\n    console.error(`watch: ${lock.message}`);\n    return 0;\n  }",
    replace: "  const lock = { ok: true as const, release: async () => {} };",
  },
  {
    guard: "a lock is removed by its holder, never by whoever came after",
    file: "src/watch-lock.ts",
    find: "if (holder && (holder.pid !== mine.pid || holder.startedAt !== mine.startedAt)) return;",
    replace: "if (false) return;",
  },
  {
    guard: "the lock of a process that no longer exists is taken over",
    file: "src/watch-lock.ts",
    find: "    return (err as NodeJS.ErrnoException).code === \"EPERM\";",
    replace: "    return true;",
  },
  {
    guard: "a backticked dictionary word is worth a word, not an identifier",
    file: "src/match.ts",
    find: "return codeSpans.includes(term) && looksLikeIdentifier(term) ? 3 : 2;",
    replace: "return codeSpans.includes(term) ? 3 : 2;",
  },
  {
    guard: "a span too short to discriminate is no identifier",
    file: "src/match.ts",
    find: "claim.codeSpans.map((s) => s.trim()).filter((s) => s.length >= 3),",
    replace: "claim.codeSpans.map((s) => s.trim()),",
  },
  {
    guard: "one hyphen does not make a token code (`well-known` is a word)",
    file: "src/match.ts",
    find: "/-.*-/.test(w)",
    replace: "/-/.test(w)",
  },
  {
    guard: "a release stored under both path layouts is one release, not two",
    file: "scripts/corpus-aggregate.ts",
    find: "if (!byRelease.has(key)) byRelease.set(key, r);",
    replace: "byRelease.set(`${key}|${byRelease.size}`, r);",
  },
  {
    guard: "several critical flags in one release are one affected release",
    file: "scripts/corpus-aggregate.ts",
    find: "if (critical) withCritical++;",
    replace: 'withCritical += (m.flags ?? []).filter((f) => f.severity === "critical").length;',
  },
  {
    guard: "an unmeasured coverage ratio is skipped, never read as 0 %",
    file: "scripts/corpus-aggregate.ts",
    find: 'if (typeof m.churnCoveredRatio === "number") coverage.push(m.churnCoveredRatio);',
    replace: "coverage.push(m.churnCoveredRatio ?? 0);",
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
// `finally` only covers thrown errors — a SIGINT/SIGTERM mid-mutant would
// leave the mutated source on disk, where the next `git add -u` commits it
// (which happened once: isFlagged lost its baseline branch on main). The
// restore must also run on the way out of a signal. SIGKILL still wins;
// after any hard-killed run, `git diff src/` before staging.
let active: { file: string; source: string } | null = null;
const restoreSync = (signal: NodeJS.Signals) => {
  if (active) writeFileSync(active.file, active.source);
  process.stderr.write(`\n${signal}: mutated source restored.\n`);
  process.exit(130);
};
process.on("SIGINT", restoreSync);
process.on("SIGTERM", restoreSync);

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
  active = { file: m.file, source };
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
    active = null;
  }
}

console.error(`\n${killed}/${selected.length} mutants killed.`);
if (survivors.length) {
  console.error("Survivors (each needs a test):");
  for (const m of survivors) console.error(`  - ${m.guard} (${m.file})`);
  process.exit(1);
}
