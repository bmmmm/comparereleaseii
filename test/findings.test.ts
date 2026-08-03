// SPDX-License-Identifier: GPL-3.0-or-later
// The findings pass: deterministic planning, blind prompts, budget honesty,
// lens semantics. The two properties everything else leans on: prompts are a
// pure function of the diff (cache ⇒ bit-identical re-runs), and the judge
// never sees commit messages or notes while reading substance.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_FINDINGS_BUDGET,
  planFindings,
  subsystemOf,
  summarizeShipped,
} from "../src/findings.ts";
import {
  parseFindingsOutput,
  parseFindingsSummary,
  type JudgeEngine,
} from "../src/judge.ts";
import { budgetLine, lensFindings, printTerminal, toMarkdown } from "../src/report.ts";
import { toHtml } from "../src/html.ts";
import { analyzeRelease, type CheckSettings, type ComponentLoader } from "../src/check.ts";
import { computeScores } from "../src/metrics.ts";
import type {
  Audience,
  DiffFile,
  Finding,
  ReleaseData,
  Report,
  RepoContext,
} from "../src/types.ts";

const CONTEXT: RepoContext = { languages: null, codeBytes: null, releaseCadenceDays: null };
const SUBJECT_SENTINEL = "COMMIT_SUBJECT_SENTINEL_XYZZY";
const NOTES_SENTINEL = "NOTES_SENTINEL_PLOVER";

function file(path: string, patch: string | undefined, additions = 5, deletions = 2): DiffFile {
  return { path, status: "modified", additions, deletions, patch };
}

/** Three subsystems, sentinel-marked commit subject and notes. */
function shippedData(over: Partial<ReleaseData> = {}): ReleaseData {
  return {
    repoLabel: "acme/app",
    baseRef: "v1.0.0",
    headRef: "v1.1.0",
    notes: `- Fixed the frobnicator ${NOTES_SENTINEL}\n`,
    commits: [
      { sha: "a".repeat(40), subject: SUBJECT_SENTINEL, body: "", author: "dev", prNumbers: [] },
    ],
    files: [
      file(
        "src/server/api.go",
        `@@ -1,4 +1,6 @@ func Serve()\n-old route\n+new route\n+\tmode := os.Getenv("ACME_CACHE")\n`,
        40,
        10,
      ),
      file("services/web/main.ts", `@@ -1,3 +1,4 @@ function boot()\n-init()\n+init(true)\n`, 20, 5),
      file("docs/README.md", `@@ -1,2 +1,2 @@\n-old docs\n+new docs\n`, 2, 1),
    ],
    commitFiles: async () => [],
    warnings: [],
    ...over,
  };
}

function recordingEngine(opts: { failFor?: string } = {}): {
  prompts: string[];
  engine: JudgeEngine;
} {
  const prompts: string[] = [];
  return {
    prompts,
    engine: {
      name: "stub",
      async judge(prompt: string): Promise<string> {
        prompts.push(prompt);
        if (prompt.startsWith("You are summarizing a release")) {
          return '{"summary":"Stub release summary."}';
        }
        if (prompt.startsWith("You are describing what actually shipped")) {
          const sub = prompt.match(/Subsystem under review: (\S+)/)?.[1] ?? "";
          if (opts.failFor === sub) throw new Error("boom");
          return JSON.stringify({
            findings: [{ kind: "feature", audience: "user", text: `stub finding for ${sub}`, files: [] }],
          });
        }
        return '{"verdict":"verified","confidence":0.9,"files":[],"reasoning":"stub"}';
      },
    },
  };
}

// ---------- deterministic planning ----------

test("subsystemOf names the meaningful directory level", () => {
  assert.equal(subsystemOf("README.md"), "(root)");
  assert.equal(subsystemOf("src/check.ts"), "src");
  assert.equal(subsystemOf("src/sources/github.ts"), "src/sources");
  assert.equal(subsystemOf("services/web/Makefile"), "services/web");
  assert.equal(subsystemOf("vendor/lib/x.go"), "vendor");
  assert.equal(subsystemOf("docs/guide/x.md"), "docs");
});

test("planFindings spends the budget top-priority-first and declares the rest", () => {
  const files = [
    file("docs/x.md", "@@ -1 +1 @@\n-a\n+b\n", 300, 300),
    file("src/core/a.go", "@@ -1 +1 @@\n-a\n+b\n", 200, 100),
    file("assets/logo.png", undefined, 0, 0),
  ];
  const plan = planFindings(files, 21000);
  // No patch, nothing to read: the asset never becomes a subsystem.
  assert.deepEqual(plan.map((p) => p.name), ["src/core", "docs"]);
  // Category weight beats raw churn: source outranks the bigger docs churn.
  assert.equal(plan[0].alloc, 20000);
  // 1,000 chars left is below a useful read — the budget is a hard cap,
  // the subsystem beyond it is declared unread, never silently skipped.
  assert.equal(plan[1].alloc, 0);
});

test("a mid-size remainder still buys a smaller second read", () => {
  const files = [
    file("src/core/a.go", "@@ -1 +1 @@\n-a\n+b\n", 200, 100),
    file("cmd/tool/main.go", "@@ -1 +1 @@\n-a\n+b\n", 50, 20),
  ];
  const plan = planFindings(files, 25000);
  assert.equal(plan[0].alloc, 20000);
  assert.equal(plan[1].alloc, 5000);
});

// ---------- the pass itself ----------

test("findings prompts are blind to commit messages and notes, identical across runs", async () => {
  const r1 = recordingEngine();
  const first = await summarizeShipped(shippedData(), { engine: r1.engine, concurrency: 2 });
  for (const p of r1.prompts) {
    assert.ok(!p.includes(SUBJECT_SENTINEL), "a findings prompt leaks a commit subject");
    assert.ok(!p.includes(NOTES_SENTINEL), "a findings prompt leaks the release notes");
  }
  // Same diff, different concurrency: the questions asked must be the same
  // bytes — that identity is what makes cached re-runs bit-identical.
  const r2 = recordingEngine();
  await summarizeShipped(shippedData(), { engine: r2.engine, concurrency: 1 });
  assert.deepEqual([...r1.prompts].sort(), [...r2.prompts].sort());

  assert.ok(first.findings.length >= 2);
  assert.ok(first.findings.every((f) => f.subsystem.length > 0));
  assert.equal(first.summary, "Stub release summary.");
  const b = first.budget;
  assert.equal(b.maxChars, DEFAULT_FINDINGS_BUDGET);
  assert.ok(b.usedChars > 0 && b.usedChars <= b.maxChars);
  assert.equal(b.subsystemsTotal, 3);
  assert.equal(b.subsystemsRead, 3);
  assert.equal(b.filesTotal, 3);
  assert.equal(b.filesRead, 3);
});

test("a failed subsystem read is reported; the others still land", async () => {
  const r = recordingEngine({ failFor: "src/server" });
  const s = await summarizeShipped(shippedData(), { engine: r.engine, concurrency: 2 });
  assert.equal(s.errors?.length, 1);
  assert.match(s.errors![0], /^src\/server: boom/);
  assert.ok(s.findings.some((f) => f.subsystem === "services/web"));
  assert.ok(!s.findings.some((f) => f.subsystem === "src/server"));
});

// ---------- parsing ----------

test("parseFindingsOutput enforces the enums, caps, and the security audience", () => {
  const raw = JSON.stringify({
    findings: [
      { kind: "security", audience: "operator", text: "auth check added", files: ["a.go"] },
      { kind: "bogus", audience: "user", text: "dropped", files: [] },
      { kind: "feature", audience: "martians", text: "dropped too", files: [] },
      { kind: "feature", audience: "user", text: "", files: [] },
      {
        kind: "breaking",
        audience: "operator",
        text: "x".repeat(400),
        files: Array.from({ length: 20 }, (_, i) => `f${i}`),
      },
    ],
  });
  const parsed = parseFindingsOutput(raw);
  assert.equal(parsed.length, 2);
  // A security finding filed under one role would hide from the other
  // lenses exactly the finding they most need — pierced to everyone.
  assert.equal(parsed[0].kind, "security");
  assert.equal(parsed[0].audience, "everyone");
  assert.equal(parsed[1].text.length, 300);
  assert.equal(parsed[1].files.length, 10);
  assert.deepEqual(parseFindingsOutput('{"findings":"nope"}'), []);
});

test("parseFindingsSummary trims and caps", () => {
  assert.equal(parseFindingsSummary('{"summary":"  ships things  "}'), "ships things");
  assert.equal(parseFindingsSummary(`{"summary":"${"y".repeat(700)}"}`).length, 600);
  assert.equal(parseFindingsSummary("{}"), "");
});

// ---------- lens semantics ----------

const LENS_FIXTURE: Finding[] = [
  { kind: "feature", audience: "user", text: "new button", files: [], subsystem: "ui" },
  { kind: "breaking", audience: "operator", text: "config key renamed", files: [], subsystem: "cfg" },
  { kind: "security", audience: "everyone", text: "auth fix", files: [], subsystem: "auth" },
  { kind: "internal", audience: "user", text: "refactor only", files: [], subsystem: "core" },
];

test("a lens shows its audience plus security, folds the rest, hides internal", () => {
  const v = lensFindings(LENS_FIXTURE, "operator");
  assert.deepEqual(v.shown.map((f) => f.text), ["config key renamed", "auth fix"]);
  assert.equal(v.otherAudiences, 1);
  assert.equal(v.internalHidden, 1);

  const all = lensFindings(LENS_FIXTURE, undefined);
  assert.deepEqual(
    all.shown.map((f) => f.kind),
    ["breaking", "security", "feature", "internal"],
  );
  assert.equal(all.otherAudiences, 0);
  assert.equal(all.internalHidden, 0);
});

// ---------- rendering ----------

function findingsReport(audience?: Audience): Report {
  const results = [
    {
      claim: {
        id: 0,
        section: "Changes",
        text: "Renamed a config key",
        kind: "change" as const,
        prNumbers: [],
        shas: [],
        advisories: [],
        codeSpans: [],
      },
      verdict: "verified" as const,
      confidence: 0.9,
      evidence: { commitShas: [], files: [], matchedTerms: [], methods: ["lexical" as const] },
      reasoning: "ok",
      judged: false,
      generated: false,
    },
  ];
  return {
    repoLabel: "acme/app",
    baseRef: "v1.0.0",
    headRef: "v1.1.0",
    stats: { commits: 3, files: 9, additions: 100, deletions: 40 },
    results,
    uncovered: [],
    reverseChecked: true,
    metrics: {
      scores: computeScores(results, 0, [], false),
      flags: [],
      files: [],
      churnCoveredRatio: 0,
      context: CONTEXT,
      baseline: null,
      unverifiable: null,
    },
    warnings: [],
    truncated: false,
    engine: "stub",
    findings: {
      findings: LENS_FIXTURE,
      summary: "Renames a config key and fixes auth.",
      budget: {
        maxChars: 120000,
        usedChars: 30000,
        subsystemsRead: 2,
        subsystemsTotal: 3,
        filesRead: 4,
        filesTotal: 9,
      },
    },
    audience,
  };
}

function capture(fn: () => void): string {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => lines.push(args.join(" "));
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return lines.join("\n");
}

test("the same findings read differently under operator vs user lens", () => {
  const op = capture(() => printTerminal(findingsReport("operator")));
  const user = capture(() => printTerminal(findingsReport("user")));
  assert.notEqual(op, user);
  assert.match(op, /config key renamed/);
  assert.doesNotMatch(op, /new button/);
  assert.match(user, /new button/);
  assert.doesNotMatch(user, /config key renamed/);
  // Security pierces both lenses; the fold is declared, never silent.
  assert.match(op, /auth fix/);
  assert.match(user, /auth fix/);
  assert.match(op, /1 finding\(s\) for other audiences/);
  assert.match(op, /1 internal/);
  assert.match(op, /read 2\/3 subsystems, 4\/9 files in detail \(30,000\/120,000 chars\) — 5 file\(s\) not read in detail/);
});

test("markdown and html artifacts keep every finding regardless of lens", () => {
  const md = toMarkdown(findingsReport("operator"));
  assert.match(md, /## Findings/);
  assert.match(md, /Default lens: \*\*operator\*\*/);
  assert.match(md, /new button/);
  assert.match(md, /config key renamed/);
  assert.match(md, /read 2\/3 subsystems/);

  const html = toHtml(findingsReport("operator"));
  assert.match(html, /Findings/);
  assert.match(html, /config key renamed/);
  assert.match(html, /outside the operator lens/);
  assert.match(html, /new button/);
});

test("budgetLine skips the remainder clause when everything was read", () => {
  const r = findingsReport();
  r.findings!.budget = {
    maxChars: 120000,
    usedChars: 9000,
    subsystemsRead: 3,
    subsystemsTotal: 3,
    filesRead: 9,
    filesTotal: 9,
  };
  assert.equal(budgetLine(r), "read 3/3 subsystems, 9/9 files in detail (9,000/120,000 chars)");
});

// ---------- pipeline wiring ----------

function settings(over: Partial<CheckSettings> = {}): CheckSettings {
  return {
    judgeMode: "auto",
    engine: null,
    escalateEngine: null,
    concurrency: 2,
    reverse: true,
    baseline: 0,
    ...over,
  };
}

test("analyzeRelease attaches findings with an engine — score-neutral, off without one", async () => {
  const rec = recordingEngine();
  const withFindings = await analyzeRelease(shippedData(), CONTEXT, null, settings({ engine: rec.engine }));
  assert.ok(withFindings.findings);
  assert.ok(withFindings.findings!.findings.length > 0);
  assert.ok(rec.prompts.some((p) => p.startsWith("You are describing what actually shipped")));

  const disabled = await analyzeRelease(
    shippedData(),
    CONTEXT,
    null,
    settings({ engine: recordingEngine().engine, findings: false }),
  );
  assert.equal(disabled.findings, undefined);
  assert.deepEqual(withFindings.metrics, disabled.metrics);
  assert.deepEqual(
    withFindings.results.map((r) => r.verdict),
    disabled.results.map((r) => r.verdict),
  );

  const judgeOff = await analyzeRelease(
    shippedData(),
    CONTEXT,
    null,
    settings({ judgeMode: "off" }),
  );
  assert.equal(judgeOff.findings, undefined);
});

test("first-party expansion never runs a findings pass for the child", async () => {
  const rec = recordingEngine();
  const parent = shippedData({
    files: [
      ...shippedData().files,
      file("Makefile", `@@ -1,2 +1,2 @@\n-WEB_VERSION=v2.0.0\n+WEB_VERSION=v2.1.0\n unrelated\n`, 1, 1),
    ],
  });
  const child = shippedData({
    repoLabel: "acme/web",
    baseRef: "v2.0.0",
    headRef: "v2.1.0",
    notes: "- Faster render\n",
  });
  const loader: ComponentLoader = async () => ({ data: child, context: CONTEXT });
  const report = await analyzeRelease(
    parent,
    CONTEXT,
    { base: "https://github.com/acme/app", style: "github" },
    settings({ engine: rec.engine, components: { WEB_VERSION: "acme/web" }, expand: loader }),
  );
  assert.equal(report.components?.length, 1);
  assert.equal(report.components![0].error, undefined);
  const findingsPrompts = rec.prompts.filter((p) =>
    p.startsWith("You are describing what actually shipped"),
  );
  assert.ok(findingsPrompts.length > 0, "the parent's own findings pass must run");
  assert.ok(
    findingsPrompts.every((p) => p.includes("in a release of acme/app (")),
    "the child got its own findings pass — expansion folds into one line, it must not multiply the judge bill",
  );
});
