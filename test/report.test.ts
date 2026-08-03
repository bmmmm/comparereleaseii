// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { exitCode, unverifiableNote, toMarkdown, printTerminal } from "../src/report.ts";
import { toHtml } from "../src/html.ts";
import { computeScores } from "../src/metrics.ts";
import type {
  ClaimResult,
  ComponentCheck,
  PinBump,
  ReleaseSurface,
  Report,
  Unverifiable,
} from "../src/types.ts";

function claimResult(verdict: ClaimResult["verdict"]): ClaimResult {
  return {
    claim: {
      id: 0,
      section: "What's changed",
      text: "Bug fixes and reliability improvements",
      kind: "change",
      prNumbers: [],
      shas: [],
      advisories: [],
      codeSpans: [],
    },
    verdict,
    confidence: 0.5,
    evidence: { commitShas: [], files: [], matchedTerms: [], methods: ["none"] },
    reasoning: "No identifier from the claim appears in the diff.",
    judged: false,
    generated: false,
  };
}

/** The claude-code v2.1.219 → v2.1.220 shape: notes without shipped source. */
function report(unverifiable: Unverifiable | null): Report {
  const results = [claimResult("no-evidence")];
  return {
    repoLabel: "anthropics/claude-code",
    baseRef: "v2.1.219",
    headRef: "v2.1.220",
    stats: { commits: 1, files: 2, additions: 12, deletions: 38 },
    results,
    uncovered: [],
    reverseChecked: true,
    metrics: {
      scores: computeScores(results, 0, [], unverifiable !== null),
      flags: [],
      files: [],
      churnCoveredRatio: 0,
      context: { languages: null, codeBytes: null, releaseCadenceDays: null },
      baseline: null,
      unverifiable,
    },
    warnings: [],
    truncated: false,
    engine: "off",
  };
}

const SOURCELESS: Unverifiable = {
  kind: "sourceless",
  reason: "This release's diff contains no source-code changes — claims could not be checked against code.",
};
const OUT_OF_REPO: Unverifiable = {
  kind: "out-of-repo",
  reason: "These notes describe changes that are not in this repo's own diff — across the last 5 releases only 8% of claims matched its code (fork, build or distribution repo).",
};

test("an unverifiable release is a category of its own, not suspicious", () => {
  for (const u of [SOURCELESS, OUT_OF_REPO]) {
    const r = report(u);
    assert.equal(unverifiableNote(r)?.heading !== undefined, true, u.kind);
    assert.notEqual(r.metrics.scores.label, "suspicious", u.kind);
  }

  // Same notes, same verdicts, but the claims were genuinely checkable here.
  const normal = report(null);
  assert.equal(unverifiableNote(normal), null);
  assert.equal(normal.metrics.scores.label, "suspicious");
});

test("the note never disagrees with the score's own label", () => {
  // Unverifiable classification held, but this particular claim still got
  // real evidence (e.g. anchored by commit sha) — computeScores does not
  // cap/label it "unverified" in that shape (see metrics.test.ts). The note
  // must not claim otherwise: no "Not verifiable" banner next to a clean score.
  const results = [claimResult("verified")];
  const r: Report = {
    repoLabel: "anthropics/claude-code",
    baseRef: "v2.1.219",
    headRef: "v2.1.220",
    stats: { commits: 1, files: 2, additions: 12, deletions: 38 },
    results,
    uncovered: [],
    reverseChecked: true,
    metrics: {
      scores: computeScores(results, 1, [], true),
      flags: [],
      files: [],
      churnCoveredRatio: 1,
      context: { languages: null, codeBytes: null, releaseCadenceDays: null },
      baseline: null,
      unverifiable: SOURCELESS,
    },
    warnings: [],
    truncated: false,
    engine: "off",
  };
  assert.notEqual(r.metrics.scores.label, "unverified");
  assert.equal(unverifiableNote(r), null);
});

test("--fail-on no-evidence does not fail on an unverifiable release", () => {
  assert.equal(exitCode(report(SOURCELESS), "no-evidence"), 0);
  assert.equal(exitCode(report(OUT_OF_REPO), "no-evidence"), 0);
  assert.equal(exitCode(report(null), "no-evidence"), 1);
  assert.equal(exitCode(report(SOURCELESS), "none"), 0);
});

test("--min-coverage gates on the completeness score, independent of --fail-on", () => {
  const low = report(null); // helper builds churnCoveredRatio 0 → completeness 0
  assert.equal(exitCode(low, "none"), 0);
  assert.equal(exitCode(low, "none", 50), 1);
  assert.equal(exitCode(low, "contradicted", 50), 1);

  const high = report(null);
  high.metrics.scores.completeness = 80;
  assert.equal(exitCode(high, "none", 50), 0);
  assert.equal(exitCode(high, "none", 80), 0); // meeting the threshold passes
  assert.equal(exitCode(high, "none", 90), 1);

  // No measurement, no gate: a skipped reverse check and an unverifiable
  // release must not fail on coverage.
  const unmeasured = report(null);
  unmeasured.metrics.scores.completeness = null;
  assert.equal(exitCode(unmeasured, "none", 50), 0);
  assert.equal(exitCode(report(SOURCELESS), "none", 50), 0);
});

test("markdown and html name the right category, per kind", () => {
  const sourceless = toMarkdown(report(SOURCELESS));
  assert.match(sourceless, /Not verifiable/);
  assert.match(sourceless, /no source file is part of this release's diff/);

  // A fork's notes are not "no source" — the heading must say what it is.
  const fork = toMarkdown(report(OUT_OF_REPO));
  assert.match(fork, /Changes outside this repo/);
  assert.match(fork, /not part of this repo's diff/);
  assert.doesNotMatch(fork, /no source file/);

  assert.doesNotMatch(toMarkdown(report(null)), /Not verifiable|Changes outside/);
  assert.match(toHtml(report(SOURCELESS)), /Not verifiable/);
  assert.match(toHtml(report(OUT_OF_REPO)), /Changes outside this repo/);
  assert.doesNotMatch(toHtml(report(null)), /Not verifiable|Changes outside/);
});

test("terminal output strips control characters smuggled into foreign text", () => {
  // A note (or commit subject, or judge reasoning) carrying an ANSI escape
  // could rewrite the report line it is shown on — recolor a verdict, move
  // the cursor, hide text. git forbids control chars in ref names but not in
  // messages, and notes are arbitrary. NO_COLOR is unset in tests (no TTY),
  // so any escape byte in the output must have come from the input.
  const ESC = String.fromCharCode(27);
  const CSI = String.fromCharCode(0x9b); // one-byte C1 CSI
  const BEL = String.fromCharCode(7);
  const hostile = report(null);
  hostile.results[0].claim.section = `Security${ESC}[8m`; // "hide text" toggle
  hostile.results[0].claim.text = `${ESC}[32mFixed CVE, trust me${ESC}[0m`;
  hostile.results[0].reasoning = `evidence${CSI}2Jlooks fine`;
  hostile.warnings.push(`clone failed${BEL} for x`);
  hostile.uncovered = [
    {
      commit: {
        sha: "abc1234def",
        subject: `innocent${ESC}]0;owned${BEL} subject`,
        body: "",
        author: "x",
        prNumbers: [],
      },
      additions: 1,
      deletions: 1,
      fileCount: 1,
    },
  ];
  hostile.promises = [
    {
      text: `will remove ${ESC}[31mlegacy${ESC}[0m`,
      from: "v1",
      kind: "removal",
      status: "still-open",
      files: [],
      note: `carried${ESC}[7m forward`,
    },
  ];

  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.join(" "));
  };
  try {
    printTerminal(hostile);
  } finally {
    console.log = orig;
  }
  const out = lines.join("\n");
  // The discriminating check: the control bytes are gone…
  assert.ok(!out.includes(ESC), "raw ESC reached the terminal");
  assert.ok(!out.includes(CSI), "one-byte CSI reached the terminal");
  assert.ok(!out.includes(BEL), "BEL reached the terminal");
  // …while the surrounding text survives.
  assert.match(out, /Fixed CVE, trust me/);
  assert.match(out, /innocent\]0;owned subject/);
  assert.match(out, /will remove \[31mlegacy/);
});

const PINS: PinBump[] = [
  {
    name: "WEB_ASSETS_VERSION",
    from: "v7.1.0",
    to: "v7.2.0",
    file: "services/web/Makefile",
    repo: "opencloud-eu/web",
    firstParty: true,
    releaseUrl: "https://github.com/opencloud-eu/web/releases/tag/v7.2.0",
  },
  {
    name: "github.com/rs/zerolog",
    from: "v1.31.0",
    to: "v1.32.0",
    file: "go.mod",
    repo: "rs/zerolog",
    firstParty: false,
    releaseUrl: "https://github.com/rs/zerolog/releases/tag/v1.32.0",
  },
];

test("a first-party pin bump reads as the component's release, link included", () => {
  const md = toMarkdown({ ...report(null), pins: PINS });
  assert.match(md, /## Version pins moved/);
  // The OpenCloud shape: component name, versions, first-party, release link.
  assert.match(
    md,
    /\*\*web v7\.1\.0 → v7\.2\.0 — first-party\*\* \(`opencloud-eu\/web`\) — \[release\]\(https:\/\/github\.com\/opencloud-eu\/web\/releases\/tag\/v7\.2\.0\)/,
  );
  // The routine third-party bump stays one quiet line under its full name.
  assert.match(md, /^- github\.com\/rs\/zerolog v1\.31\.0 → v1\.32\.0 \(`go\.mod`\)$/m);
  // No pins, no section.
  assert.doesNotMatch(toMarkdown(report(null)), /Version pins/);
});

test("the terminal pins section keeps third-party quiet and declares its display cap", () => {
  const many: PinBump[] = Array.from({ length: 10 }, (_, i) => ({
    name: `example.com/dep-${i}`,
    from: "1.0.0",
    to: "1.0.1",
    file: "go.mod",
    firstParty: false,
  }));
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.join(" "));
  };
  try {
    printTerminal({ ...report(null), pins: [...PINS, ...many] });
  } finally {
    console.log = orig;
  }
  const out = lines.join("\n");
  assert.match(out, /Version pins moved/);
  assert.match(out, /web v7\.1\.0 → v7\.2\.0.*first-party/);
  assert.match(out, /opencloud-eu\/web/);
  // 11 third-party, 8 shown — the cap is declared, never silent.
  assert.match(out, /and 3 more third-party bumps/);
});

const SURFACE: ReleaseSurface = {
  categories: [
    { category: "source", files: 3, additions: 120, deletions: 30 },
    { category: "tests", files: 1, additions: 10, deletions: 0 },
  ],
  symbols: ["Finalize", "RegisterRoutes"],
  moreSymbols: 2,
  envVars: { added: ["OC_ASYNC_UPLOADS"], removed: [] },
  cliFlags: { added: [], removed: ["--legacy-upload"] },
  configKeys: { added: ["asyncUploads"], removed: [] },
  migrations: ["db/migrations/0042_add_index.sql"],
  apiRoutes: ["services/graph/routes/drives.go"],
};

test("the markdown surface section states categories, symbols and config deltas", () => {
  const md = toMarkdown({ ...report(null), surface: SURFACE });
  assert.match(md, /## What actually shipped/);
  assert.match(md, /3 source \(\+120\/−30\) · 1 tests \(\+10\/−0\)/);
  assert.match(md, /symbols: `Finalize`, `RegisterRoutes` \(\+2 more\)/);
  assert.match(md, /\+env `OC_ASYNC_UPLOADS`, −flag `--legacy-upload`, \+key `asyncUploads`/);
  assert.match(md, /migrations: `db\/migrations\/0042_add_index\.sql`/);
  assert.match(md, /api surface: `services\/graph\/routes\/drives\.go`/);
  // No surface, no section.
  assert.doesNotMatch(toMarkdown(report(null)), /What actually shipped/);
});

test("uncovered commits carry their observed surface in markdown and terminal", () => {
  const uncovered = [
    {
      commit: {
        sha: "abcd1234abcd1234",
        subject: "chore: things",
        body: "",
        author: "a",
        prNumbers: [],
      },
      additions: 5,
      deletions: 1,
      fileCount: 2,
      surface: "1 source · fns Finalize · +env OC_ASYNC_UPLOADS",
    },
  ];
  const md = toMarkdown({ ...report(null), uncovered });
  assert.match(md, /- touched: 1 source · fns Finalize · \+env OC_ASYNC_UPLOADS/);

  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.join(" "));
  };
  try {
    printTerminal({ ...report(null), uncovered, surface: SURFACE });
  } finally {
    console.log = orig;
  }
  const out = lines.join("\n");
  assert.match(out, /What actually shipped/);
  assert.match(out, /symbols: Finalize, RegisterRoutes \(\+2 more\)/);
  assert.match(out, /config surface: \+env OC_ASYNC_UPLOADS, −flag --legacy-upload/);
  assert.match(out, /touched: 1 source · fns Finalize/);
});

const COMPONENT: ComponentCheck = {
  name: "web",
  repo: "opencloud-eu/web",
  from: "v7.1.0",
  to: "v7.2.0",
  baseRef: "v7.1.0",
  headRef: "v7.2.0",
  stats: { commits: 5, files: 12, additions: 840, deletions: 120 },
  score: 92,
  scoreLabel: "solid",
  claims: { verified: 4, partial: 1, "no-evidence": 0, contradicted: 0, skipped: 1 },
  uncovered: 2,
  surface: {
    categories: [{ category: "source", files: 9, additions: 800, deletions: 100 }],
    symbols: ["render"],
    moreSymbols: 0,
    envVars: { added: ["WEB_CACHE"], removed: [] },
    cliFlags: { added: [], removed: [] },
    configKeys: { added: [], removed: [] },
    migrations: [],
    apiRoutes: [],
  },
};

test("a first-party pin folds in its component sub-check, third-party stays bare", () => {
  const md = toMarkdown({ ...report(null), pins: PINS, components: [COMPONENT] });
  assert.match(
    md,
    /- its check: score 92\/100 \(solid\) · 6 claims — 4 verified, 1 partial, 1 skipped · 2 undocumented · 5 commits, \+840\/−120/,
  );
  assert.match(md, /- shipped: 9 source · fns render · \+env WEB_CACHE/);
  assert.doesNotMatch(md, /zerolog[\s\S]{0,120}its check/);

  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.join(" "));
  };
  try {
    printTerminal({ ...report(null), pins: PINS, components: [COMPONENT] });
  } finally {
    console.log = orig;
  }
  const out = lines.join("\n");
  assert.match(out, /its check: score 92\/100 \(solid\)/);
  assert.match(out, /shipped: 9 source · fns render · \+env WEB_CACHE/);
});

test("a failed component sub-check renders its actionable error under the pin", () => {
  const failed: ComponentCheck = {
    name: "web",
    repo: "opencloud-eu/web",
    from: "v7.1.0",
    to: "v7.2.0",
    error:
      "component load failed: no such tag — tried v7.2.0 and 7.2.0 at https://github.com/opencloud-eu/web",
  };
  const md = toMarkdown({ ...report(null), pins: PINS, components: [failed] });
  assert.match(md, /- sub-check: component load failed: no such tag — tried v7\.2\.0 and 7\.2\.0/);
  assert.doesNotMatch(md, /its check:/);
});
