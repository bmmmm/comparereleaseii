// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { exitCode, unverifiableNote, toMarkdown, printTerminal } from "../src/report.ts";
import { toHtml } from "../src/html.ts";
import { computeScores } from "../src/metrics.ts";
import type {
  ClaimResult,
  ComponentCheck,
  Finding,
  PinBump,
  Reconciliation,
  ReleaseSurface,
  Report,
  UncoveredCommit,
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

// ---------- the bump class ----------

const BUMP_PINS: PinBump[] = [
  {
    name: "actions/cache",
    from: "4.3.0",
    to: "5.0.5",
    file: ".github/workflows/build.yml",
    firstParty: false,
  },
  {
    name: "actions/checkout",
    from: "6.0.2",
    to: "6.0.3",
    file: ".github/workflows/build.yml",
    firstParty: false,
  },
];

const BUMP_RECONCILIATION: Reconciliation = {
  confirmed: [],
  undocumented: [],
  unsupported: [],
  bumps: [
    {
      claim: 0,
      status: "overtaken",
      claimed: { name: "actions/cache", from: "5.0.3", to: "5.0.4" },
      observed: { from: "4.3.0", to: "5.0.5", file: ".github/workflows/build.yml" },
    },
    {
      claim: 1,
      status: "confirmed",
      claimed: { name: "actions/checkout", from: "6.0.2", to: "6.0.3" },
      observed: { from: "6.0.2", to: "6.0.3", file: ".github/workflows/build.yml" },
    },
    { claim: 2, status: "unmatched", claimed: { name: "serde", to: "1.0.200" } },
  ],
};

test("bump claims read as one class, and an overtaken line shows both numbers", () => {
  const r = { ...report(null), pins: BUMP_PINS, reconciliation: BUMP_RECONCILIATION };

  const md = toMarkdown(r);
  assert.match(md, /## Dependency bumps/);
  assert.match(md, /3 bump claim\(s\).*1 confirmed, 1 overtaken by the release, 1 no pin of that name/);
  // The finding a reader wants: what the note said next to what the release did.
  assert.match(
    md,
    /\*\*actions\/cache\*\* — the note says 5\.0\.3 → 5\.0\.4, the diff moves it 4\.3\.0 → 5\.0\.5/,
  );
  // A confirmed bump is carried by the count alone — no line of its own.
  assert.doesNotMatch(md, /actions\/checkout — the note says/);

  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.join(" "));
  };
  try {
    printTerminal(r);
  } finally {
    console.log = orig;
  }
  const out = lines.join("\n");
  assert.match(out, /Dependency bumps/);
  assert.match(out, /actions\/cache — the note says 5\.0\.3 → 5\.0\.4, the diff moves it 4\.3\.0 → 5\.0\.5/);
  assert.match(out, /serde — the note says 1\.0\.200/);

  const html = toHtml(r);
  assert.match(html, /<h2>Dependency bumps/);
  assert.match(html, /4\.3\.0 → 5\.0\.5/);
  assert.match(html, /overtaken/);

  // No bump claims, no section anywhere.
  assert.doesNotMatch(toMarkdown(report(null)), /Dependency bumps/);
  assert.doesNotMatch(toHtml(report(null)), /Dependency bumps/);
});

// ---------- decisions all three renderers share ----------

/** Capture what printTerminal writes, so the terminal can be asserted on
 * next to the Markdown and HTML built from the same report. */
function terminalOf(r: Report): string {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.join(" "));
  };
  try {
    printTerminal(r);
  } finally {
    console.log = orig;
  }
  return lines.join("\n");
}

function uncoveredCommit(sha: string, subject: string): UncoveredCommit {
  return {
    commit: { sha, subject, body: "", author: "dev", prNumbers: [] },
    additions: 1,
    deletions: 0,
    fileCount: 1,
  };
}

// Reconciliation puts the commits that share files with an undocumented
// finding first, because that is the one a reader should look at. Every
// renderer applied the permutation with its own copy of the same two lines,
// and nothing checked that any of them still did — all three could have gone
// back to raw order and the suite would not have noticed.
test("undocumented commits keep the order reconciliation chose, in all three renderers", () => {
  const uncovered = [
    uncoveredCommit("aaaaaaaa11", "routine chore"),
    uncoveredCommit("bbbbbbbb22", "another chore"),
    uncoveredCommit("cccccccc33", "touches the finding's files"),
  ];
  const r: Report = {
    ...report(null),
    uncovered,
    reconciliation: { confirmed: [], undocumented: [], unsupported: [], uncoveredOrder: [2, 0, 1] },
  };

  const positions = (text: string): number[] =>
    ["cccccccc", "aaaaaaaa", "bbbbbbbb"].map((sha) => text.indexOf(sha));
  for (const [label, text] of [
    ["terminal", terminalOf(r)],
    ["markdown", toMarkdown(r)],
    ["html", toHtml(r)],
  ] as Array<[string, string]>) {
    const [first, second, third] = positions(text);
    assert.ok(first >= 0 && second >= 0 && third >= 0, `${label} dropped a commit`);
    assert.ok(first < second && second < third, `${label} ignored uncoveredOrder`);
    assert.match(text, /ordered: commits sharing files with an undocumented finding first/i, label);
  }

  // Without a permutation nobody is told about an ordering that did not happen.
  const plain: Report = { ...report(null), uncovered };
  assert.doesNotMatch(terminalOf(plain), /ordered: commits sharing/i);
  assert.doesNotMatch(toMarkdown(plain), /ordered: commits sharing/i);
  assert.doesNotMatch(toHtml(plain), /ordered: commits sharing/i);
});

// "· claimed" and "· never claimed" are the whole point of reconciling
// findings against notes: they say which observed change the notes actually
// mention. Three renderers each rebuilt those two index sets by hand, and no
// test read the resulting tag — every tag could have vanished silently.
test("a finding says whether a note claims it, in all three renderers", () => {
  const finding = (text: string): Finding => ({
    kind: "feature",
    audience: "user",
    text,
    files: ["src/a.ts"],
    subsystem: "src",
  });
  const r: Report = {
    ...report(null),
    findings: {
      findings: [finding("claimed by a note"), finding("neither"), finding("nobody wrote this down")],
      budget: {
        maxChars: 1000,
        usedChars: 10,
        subsystemsRead: 1,
        subsystemsTotal: 1,
        filesRead: 1,
        filesTotal: 1,
      },
    },
    reconciliation: {
      confirmed: [{ finding: 0, claims: [0] }],
      undocumented: [2],
      unsupported: [],
    },
  };

  for (const [label, text, claimed, never] of [
    ["terminal", terminalOf(r), "· claimed", "· never claimed"],
    ["markdown", toMarkdown(r), "*claimed*", "**never claimed**"],
    ["html", toHtml(r), "· claimed", "· never claimed"],
  ] as Array<[string, string, string, string]>) {
    const at = (needle: string): number => text.indexOf(needle);
    assert.ok(at("claimed by a note") >= 0, `${label} dropped the confirmed finding`);
    assert.ok(at("nobody wrote this down") >= 0, `${label} dropped the undocumented finding`);
    // The tag follows its own finding's text, before the next finding starts.
    const confirmedTag = text.indexOf(claimed, at("claimed by a note"));
    assert.ok(
      confirmedTag > 0 && confirmedTag < at("neither"),
      `${label} does not mark the confirmed finding as claimed`,
    );
    const undocumentedTag = text.indexOf(never, at("nobody wrote this down"));
    assert.ok(undocumentedTag > 0, `${label} does not mark the undocumented finding`);
    // The middle finding is neither — it must carry no tag at all.
    const middle = text.slice(at("neither"), at("nobody wrote this down"));
    assert.ok(!middle.includes("claimed"), `${label} tagged a finding that is neither: ${middle}`);
  }
});

// The baseline and the repo context answer "is this normal for this repo?" —
// without them a churn number has nothing to be big or small against. Both
// reached the terminal and the HTML page; the Markdown file silently dropped
// them, which is the one artifact a reader keeps, pastes into an issue, or
// gets out of a watch run. toMarkdown's own comment says a report on disk
// must not lose anything, so this holds every renderer to it.
test("the baseline and the repo context reach all three renderers", () => {
  const r: Report = {
    ...report(null),
    metrics: {
      ...report(null).metrics,
      context: {
        languages: { TypeScript: 650_000, HTML: 340_000, Shell: 10_000 },
        codeBytes: 1_000_000,
        releaseCadenceDays: 7,
      },
      baseline: {
        releases: 5,
        medianChurn: 2172,
        medianAnchoredCoverage: 0.42,
        snapshots: [{ tag: "v1", churn: 100, coverage: 0.4 }],
      },
    },
  };

  for (const [label, text] of [
    ["terminal", terminalOf(r)],
    ["markdown", toMarkdown(r)],
    ["html", toHtml(r)],
  ] as Array<[string, string]>) {
    assert.match(text, /5 releases|5 rel\./, `${label} drops how many releases the baseline saw`);
    assert.match(text, /median churn ±2172/, `${label} drops the baseline churn`);
    assert.match(text, /42\s*%/, `${label} drops the baseline note coverage`);
    assert.match(text, /TypeScript 65\s*%/, `${label} drops the repo's languages`);
    assert.match(text, /release cadence ~7 d/, `${label} drops the release cadence`);
  }

  // A repo with neither says nothing about either — no empty "Baseline ():".
  const bare = report(null);
  for (const [label, text] of [
    ["terminal", terminalOf(bare)],
    ["markdown", toMarkdown(bare)],
  ] as Array<[string, string]>) {
    assert.doesNotMatch(text, /Baseline \(/, `${label} printed an empty baseline`);
    assert.doesNotMatch(text, /^Repo: /m, `${label} printed an empty repo line`);
  }
});

// A score is only comparable with a score the same rules produced. Two
// reports side by side are the ordinary way that comparison happens, and
// without the generation on the page the reader has no way back to which
// rules made which number — the report file outlives the release that wrote it.
test("the scoring generation reaches all three renderers", () => {
  const r: Report = { ...report(null), scoringGeneration: 7 };
  for (const [label, text] of [
    ["terminal", terminalOf(r)],
    ["markdown", toMarkdown(r)],
    ["html", toHtml(r)],
  ] as Array<[string, string]>) {
    assert.match(text, /scoring generation 7/, `${label} drops the scoring generation`);
  }

  // A report from before the marker existed claims no generation rather than
  // inventing one — "generation 0" would be a fact nobody recorded.
  const old = report(null);
  assert.equal(old.scoringGeneration, undefined);
  for (const [label, text] of [
    ["terminal", terminalOf(old)],
    ["markdown", toMarkdown(old)],
    ["html", toHtml(old)],
  ] as Array<[string, string]>) {
    assert.doesNotMatch(text, /scoring generation/, `${label} invented a generation`);
  }
});
