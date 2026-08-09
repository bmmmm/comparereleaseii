// SPDX-License-Identifier: GPL-3.0-or-later
// The reconciliation layer: claims meet findings late and deterministically.
// The properties everything leans on: the identifier bar decides a link (one
// code span or two identifiers — never a single stray token), meta and
// skipped claims take no part, the join never mutates its inputs, and no
// findings means no reconciliation at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { compareVersions, reconcile, resolveBumpClaims } from "../src/reconcile.ts";
import { analyzeRelease, type CheckSettings } from "../src/check.ts";
import type { JudgeEngine } from "../src/judge.ts";
import type {
  Claim,
  ClaimBump,
  ClaimResult,
  Commit,
  DiffFile,
  Finding,
  PinBump,
  ReleaseData,
  RepoContext,
  UncoveredCommit,
  Verdict,
} from "../src/types.ts";

function claim(over: Partial<Claim> = {}): Claim {
  return {
    id: 1,
    section: "Changed",
    text: "",
    kind: "change",
    prNumbers: [],
    shas: [],
    advisories: [],
    codeSpans: [],
    ...over,
  };
}

function result(c: Claim, verdict: Verdict = "verified"): ClaimResult {
  return {
    claim: c,
    verdict,
    confidence: 0.9,
    evidence: { commitShas: [], files: [], matchedTerms: [], methods: [] },
    reasoning: "",
    judged: false,
    generated: false,
  };
}

function finding(over: Partial<Finding> = {}): Finding {
  return { kind: "feature", audience: "operator", text: "", files: [], subsystem: "src", ...over };
}

function commitOf(fill: string, subject: string): Commit {
  return { sha: fill.repeat(40), subject, body: "", author: "dev", prNumbers: [] };
}

function uc(fill: string, subject: string, churn = 10): UncoveredCommit {
  return { commit: commitOf(fill, subject), additions: churn, deletions: 1, fileCount: 1 };
}

function df(path: string): DiffFile {
  return { path, status: "modified", additions: 3, deletions: 1, patch: undefined };
}

// ---------- the identifier bar ----------

test("a code-span hit alone confirms — the notes' own backtick is the strongest anchor", () => {
  const r = result(
    claim({ text: "Adds `resetJudgeStats` to the cache module", codeSpans: ["resetJudgeStats"] }),
  );
  const f = finding({ text: "Added resetJudgeStats function to reset counters" });
  const rec = reconcile([r], [f], [], null);
  assert.deepEqual(rec.confirmed, [{ finding: 0, claims: [0] }]);
  assert.deepEqual(rec.undocumented, []);
  assert.deepEqual(rec.unsupported, []);
});

test("one plain identifier is not a link — the bar wants a span or two identifiers", () => {
  const r = result(claim({ text: "improve the watchState handling" }));
  const f = finding({ text: "Reworked watchState transitions" });
  const rec = reconcile([r], [f], [], null);
  assert.deepEqual(rec.confirmed, []);
  assert.deepEqual(rec.undocumented, [0]);
  assert.deepEqual(rec.unsupported, [0]);
});

test("two identifiers clear the bar together", () => {
  const r = result(claim({ text: "rename watchState to pollCursor" }));
  const f = finding({ text: "watchState renamed to pollCursor across the state module" });
  const rec = reconcile([r], [f], [], null);
  assert.deepEqual(rec.confirmed, [{ finding: 0, claims: [0] }]);
  assert.deepEqual(rec.unsupported, []);
});

test("a finding's files carry the match like its text does", () => {
  const r = result(
    claim({ text: "split the state rules into `watch-state.ts`", codeSpans: ["watch-state.ts"] }),
  );
  const f = finding({
    text: "State transition rules extracted into a new module",
    files: ["src/watch-state.ts"],
  });
  const rec = reconcile([r], [f], [], null);
  assert.deepEqual(rec.confirmed, [{ finding: 0, claims: [0] }]);
});

// ---------- who takes part ----------

test("meta and skipped claims take no part — neither confirming nor unsupported", () => {
  const meta = result(
    claim({ id: 1, kind: "meta", text: "New Contributors did watchState and pollCursor work" }),
  );
  const carried = result(claim({ id: 2, text: "watchState becomes pollCursor" }), "skipped");
  const f = finding({ text: "watchState moved to pollCursor" });
  const rec = reconcile([meta, carried], [f], [], null);
  assert.deepEqual(rec.confirmed, []);
  assert.deepEqual(rec.undocumented, [0]);
  assert.deepEqual(rec.unsupported, []);
});

test("unsupported lists exactly the claims no finding observes", () => {
  const a = result(claim({ id: 1, text: "rename watchState to pollCursor" }));
  const b = result(claim({ id: 2, text: "add the `frobnicate` flag", codeSpans: ["frobnicate"] }));
  const f = finding({ text: "watchState renamed to pollCursor" });
  const rec = reconcile([a, b], [f], [], null);
  assert.deepEqual(rec.confirmed, [{ finding: 0, claims: [0] }]);
  assert.deepEqual(rec.unsupported, [1]);
});

// ---------- the uncovered order ----------

test("undocumented findings pull matching uncovered commits to the front — display only", () => {
  const r = result(claim({ text: "add the `frobnicate` flag", codeSpans: ["frobnicate"] }));
  const confirmedF = finding({ text: "frobnicate flag added", files: ["src/cli.ts"] });
  const undocF = finding({ text: "Silent retry loop added", files: ["src/retry.ts"] });
  const big = uc("a", "big refactor", 500);
  const silent = uc("b", "small change", 5);
  const commitFiles = new Map<string, DiffFile[]>([
    [big.commit.sha, [df("src/other.ts")]],
    [silent.commit.sha, [df("src/retry.ts")]],
  ]);
  const rec = reconcile([r], [confirmedF, undocF], [big, silent], commitFiles);
  assert.deepEqual(rec.undocumented, [1]);
  assert.deepEqual(rec.uncoveredOrder, [1, 0]);
});

test("an order that changes nothing is omitted", () => {
  const undocF = finding({ text: "Silent retry loop added", files: ["src/retry.ts"] });
  const first = uc("a", "silent retry", 500);
  const second = uc("b", "other", 5);
  const commitFiles = new Map<string, DiffFile[]>([
    [first.commit.sha, [df("src/retry.ts")]],
    [second.commit.sha, [df("src/other.ts")]],
  ]);
  const rec = reconcile([], [undocF], [first, second], commitFiles);
  assert.equal(rec.uncoveredOrder, undefined);
});

// ---------- purity ----------

test("the join is a pure view — inputs untouched, re-runs identical", () => {
  const results = [result(claim({ text: "rename watchState to pollCursor" }))];
  const findings = [finding({ text: "watchState renamed to pollCursor" })];
  const uncovered = [uc("a", "something", 10)];
  const commitFiles = new Map<string, DiffFile[]>([[uncovered[0].commit.sha, [df("src/x.ts")]]]);
  const before = structuredClone({ results, findings, uncovered });
  const one = reconcile(results, findings, uncovered, commitFiles);
  const two = reconcile(results, findings, uncovered, commitFiles);
  assert.deepEqual({ results, findings, uncovered }, before);
  assert.deepEqual(one, two);
});

// ---------- pipeline wiring ----------

const CONTEXT: RepoContext = { languages: null, codeBytes: null, releaseCadenceDays: null };

function file(path: string, patch: string | undefined, additions = 5, deletions = 2): DiffFile {
  return { path, status: "modified", additions, deletions, patch };
}

function data(over: Partial<ReleaseData> = {}): ReleaseData {
  return {
    repoLabel: "acme/app",
    baseRef: "v1.0.0",
    headRef: "v1.1.0",
    notes: "- Fixed the frobnicator\n",
    commits: [commitOf("a", "some work")],
    files: [
      file("src/server/api.go", `@@ -1,4 +1,6 @@ func Serve()\n-old route\n+new route\n`, 40, 10),
    ],
    commitFiles: async () => [],
    warnings: [],
    ...over,
  };
}

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

const stubEngine: JudgeEngine = {
  name: "stub",
  async judge(prompt: string): Promise<string> {
    if (prompt.startsWith("You are summarizing a release")) {
      return '{"summary":"Stub release summary."}';
    }
    if (prompt.startsWith("You are describing what actually shipped")) {
      return JSON.stringify({
        findings: [{ kind: "feature", audience: "user", text: "stub finding", files: [] }],
      });
    }
    return '{"verdict":"verified","confidence":0.9,"files":[],"reasoning":"stub"}';
  },
};

test("analyzeRelease joins late: reconciliation with findings, absent without — scores pinned", async () => {
  const withFindings = await analyzeRelease(data(), CONTEXT, null, settings({ engine: stubEngine }));
  assert.ok(withFindings.findings?.findings.length);
  assert.ok(withFindings.reconciliation);
  // The stub finding names nothing the note claims: everything undocumented.
  assert.deepEqual(
    withFindings.reconciliation!.undocumented,
    withFindings.findings!.findings.map((_, i) => i),
  );

  // Findings off: no reconciliation, and the metrics do not move — the
  // score-neutrality pin for the whole layer.
  const noFindings = await analyzeRelease(
    data(),
    CONTEXT,
    null,
    settings({ engine: stubEngine, findings: false }),
  );
  assert.equal(noFindings.reconciliation, undefined);
  assert.deepEqual(withFindings.metrics, noFindings.metrics);

  // --judge off degrades honestly: no findings, no reconciliation — the
  // deterministic report grows no empty scaffold.
  const judgeOff = await analyzeRelease(data(), CONTEXT, null, settings({ judgeMode: "off" }));
  assert.equal(judgeOff.findings, undefined);
  assert.equal(judgeOff.reconciliation, undefined);
});

// ---------- the pin join ----------
//
// The claim side and the diff side of the same fact, held against each
// other. Both are deterministic reads of what the release published, so
// the join is too — no judge takes part in any of this.

function pin(over: Partial<PinBump> = {}): PinBump {
  return {
    name: "actions/cache",
    from: "5.0.3",
    to: "5.0.4",
    file: ".github/workflows/build.yml",
    firstParty: false,
    ...over,
  };
}

function bumpClaim(text: string, bump: ClaimBump, over: Partial<Claim> = {}): Claim {
  return claim({ text, bump, ...over });
}

test("a bump claim the diff lands on is confirmed", () => {
  const c = bumpClaim("chore(deps): bump actions/cache from 5.0.3 to 5.0.4", {
    name: "actions/cache",
    from: "5.0.3",
    to: "5.0.4",
  });
  assert.deepEqual(resolveBumpClaims([c], [pin()]), [
    {
      claim: 0,
      status: "confirmed",
      claimed: c.bump,
      fromCheck: "exact",
      observed: { from: "5.0.3", to: "5.0.4", file: ".github/workflows/build.yml" },
    },
  ]);
});

// ---------- the from-version the note names ----------
//
// Measured over the 108-release corpus before any rule shipped: 555 bump
// claims, 216 naming a from-version, 76 of those with a pin the diff moved.
// 40 agree exactly, 26 name a later hop of an aggregated move, 10 name a
// version the release never held. That distribution is the rule: equality
// would flag the 26 honest ones, so only the 10 are a finding.

test("a from-version inside the move the pin made is one hop of it, not a disagreement", () => {
  // opencloud v7.3.0, verbatim: the release moves opa 1.15.2 → 1.18.2 and the
  // note describes the last hop, 1.18.1 → 1.18.2. The destination agrees.
  const c = bumpClaim("bump github.com/open-policy-agent/opa from 1.18.1 to 1.18.2", {
    name: "github.com/open-policy-agent/opa",
    from: "1.18.1",
    to: "1.18.2",
  });
  const resolved = resolveBumpClaims([c], [
    pin({ name: "github.com/open-policy-agent/opa", from: "v1.15.2", to: "v1.18.2" }),
  ]);
  assert.equal(resolved[0].status, "confirmed");
  assert.equal(resolved[0].fromCheck, "later-hop");
});

test("a from-version below where the pin started overstates the hop", () => {
  // opencloud v7.3.0 again, the other direction: the note says fsnotify came
  // from 1.8.0, the release starts at 1.9.0. Destination confirmed, origin
  // never on the path — three releases' worth of change credited to one.
  const c = bumpClaim("bump github.com/fsnotify/fsnotify from 1.8.0 to 1.10.1", {
    name: "github.com/fsnotify/fsnotify",
    from: "1.8.0",
    to: "1.10.1",
  });
  const resolved = resolveBumpClaims([c], [
    pin({ name: "github.com/fsnotify/fsnotify", from: "v1.9.0", to: "v1.10.1" }),
  ]);
  assert.equal(resolved[0].status, "confirmed");
  assert.equal(resolved[0].fromCheck, "outside");
});

test("a note that names no from-version is not held to one", () => {
  const c = bumpClaim("Bump github.com/DataDog/dd-trace-go/v2 to 5.0.4", {
    name: "github.com/DataDog/dd-trace-go/v2",
    to: "5.0.4",
  });
  const resolved = resolveBumpClaims([c], [
    pin({ name: "github.com/DataDog/dd-trace-go/v2", from: "4.1.0", to: "5.0.4" }),
  ]);
  assert.equal(resolved[0].status, "confirmed");
  assert.equal(resolved[0].fromCheck, undefined);
});

test("a release aggregating several bumps overtakes its own note — never a contradiction", () => {
  // The corpus case, verbatim: the note quotes its own pull request while
  // the release aggregates several bumps of the same action, so the diff
  // reads 4.3.0 → 5.0.5. Nobody wrote anything false.
  const c = bumpClaim("chore(deps): bump actions/cache from 5.0.3 to 5.0.4 by @dependabot[bot] in #9668", {
    name: "actions/cache",
    from: "5.0.3",
    to: "5.0.4",
  });
  const resolved = resolveBumpClaims([c], [pin({ from: "4.3.0", to: "5.0.5" })]);
  assert.equal(resolved[0].status, "overtaken");
  assert.deepEqual(resolved[0].observed, {
    from: "4.3.0",
    to: "5.0.5",
    file: ".github/workflows/build.yml",
  });
});

test("a pin landing short of the claimed version contradicts it", () => {
  // traefik's real one, in the direction that is genuinely wrong: the note
  // names a version the release never reached.
  const c = bumpClaim("Bump github.com/DataDog/dd-trace-go/v2 to 2.8.1", {
    name: "github.com/DataDog/dd-trace-go/v2",
    to: "2.8.1",
  });
  const short = resolveBumpClaims([c], [
    pin({ name: "github.com/DataDog/dd-trace-go/v2", from: "v2.7.0", to: "v2.8.0", file: "go.mod" }),
  ]);
  assert.equal(short[0].status, "contradicted");

  // And a pin moving backwards while the note claims a bump.
  const backwards = resolveBumpClaims([c], [
    pin({ name: "github.com/DataDog/dd-trace-go/v2", from: "v2.9.0", to: "v2.7.9", file: "go.mod" }),
  ]);
  assert.equal(backwards[0].status, "contradicted");
});

test("a note's path tail names the manifest's module", () => {
  const c = bumpClaim("Bump DataDog/dd-trace-go/v2 to 2.8.2", {
    name: "DataDog/dd-trace-go/v2",
    to: "2.8.2",
  });
  const resolved = resolveBumpClaims([c], [
    pin({ name: "github.com/DataDog/dd-trace-go/v2", from: "v2.8.1", to: "v2.8.2", file: "go.mod" }),
  ]);
  assert.equal(resolved[0].status, "confirmed");
});

test("no pin of that name, or versions that cannot be ordered — the claim stands as judged", () => {
  const c = bumpClaim("Update `serde` to 1.0.200", { name: "serde", to: "1.0.200" });
  const none = resolveBumpClaims([c], [pin()]);
  assert.deepEqual(none, [{ claim: 0, status: "unmatched", claimed: c.bump }]);
  assert.equal(none[0].observed, undefined, "an unmatched claim shows no observation");

  // `rc1` against `rc2` has no arithmetic, and guessing would be the
  // difference between "went further" and "is wrong".
  const rc = bumpClaim("Update `serde` to 1.0.0-rc2", { name: "serde", to: "1.0.0-rc2" });
  const unordered = resolveBumpClaims([rc], [
    pin({ name: "serde", from: "0.9.0", to: "1.0.0-rc1", file: "Cargo.toml" }),
  ]);
  assert.equal(unordered[0].status, "unmatched");
});

test("a bare last segment never matches — `cache` is not `actions/cache`", () => {
  const c = bumpClaim("Update `cache` to 5.0.4", { name: "cache", to: "5.0.4" });
  assert.equal(resolveBumpClaims([c], [pin()])[0].status, "unmatched");
});

test("meta and carried-over bump claims take no part", () => {
  const c = bumpClaim("bump actions/cache from 5.0.3 to 5.0.4", {
    name: "actions/cache",
    from: "5.0.3",
    to: "5.0.4",
  });
  assert.deepEqual(resolveBumpClaims([{ ...c, kind: "meta" }], [pin()]), []);
  assert.deepEqual(resolveBumpClaims([{ ...c, carriedOverFrom: "v1.0.0" }], [pin()]), []);
});

test("the file that lands on the claimed version answers the claim", () => {
  // Two workflows move the same action to different versions; the one the
  // note is about is the one that decides it.
  const c = bumpClaim("bump actions/cache from 5.0.3 to 5.0.4", {
    name: "actions/cache",
    from: "5.0.3",
    to: "5.0.4",
  });
  const resolved = resolveBumpClaims([c], [
    pin({ to: "5.0.6", file: ".github/workflows/a.yml" }),
    pin({ to: "5.0.4", file: ".github/workflows/b.yml" }),
  ]);
  assert.equal(resolved[0].status, "confirmed");
  assert.equal(resolved[0].observed?.file, ".github/workflows/b.yml");
});

test("version ordering: the spelling of a version is not its content", () => {
  assert.equal(compareVersions("v5.0.4", "5.0.4"), 0);
  assert.equal(compareVersions("1.2", "1.2.0"), 0);
  assert.equal(compareVersions("5.0.5", "5.0.4"), 1);
  assert.equal(compareVersions("2.8.0", "2.8.1"), -1);
  assert.equal(compareVersions("0.2.0-main.849", "0.2.0-main.843"), 1);
  // A prerelease sorts before the release it leads to.
  assert.equal(compareVersions("1.0.0-rc1", "1.0.0"), -1);
  assert.equal(compareVersions("1.0.0", "1.0.0-rc1"), 1);
  assert.equal(compareVersions("1.0.0-rc1", "1.0.0-rc2"), null);
  // Numeric segments compare as numbers, not as text.
  assert.equal(compareVersions("1.10.0", "1.9.0"), 1);
});

test("the pin join is a pure view — inputs untouched, re-runs identical", () => {
  const claims = [
    bumpClaim("bump actions/cache from 5.0.3 to 5.0.4", {
      name: "actions/cache",
      from: "5.0.3",
      to: "5.0.4",
    }),
  ];
  const pins = [pin({ to: "5.0.5" })];
  const before = structuredClone({ claims, pins });
  const one = resolveBumpClaims(claims, pins);
  const two = resolveBumpClaims(claims, pins);
  assert.deepEqual({ claims, pins }, before);
  assert.deepEqual(one, two);
});

test("reconcile carries the join and drops the claims it skipped", () => {
  const kept = bumpClaim("bump actions/cache from 5.0.3 to 5.0.4", {
    name: "actions/cache",
    from: "5.0.3",
    to: "5.0.4",
  });
  const dropped = bumpClaim("bump actions/stale from 1.0.0 to 1.1.0", {
    name: "actions/stale",
    from: "1.0.0",
    to: "1.1.0",
  }, { id: 2 });
  const resolved = resolveBumpClaims([kept, dropped], [pin(), pin({ name: "actions/stale", to: "1.1.0" })]);
  const rec = reconcile(
    [result(kept), result(dropped, "skipped")],
    [finding({ text: "unrelated" })],
    [],
    null,
    resolved,
  );
  assert.equal(rec.bumps?.length, 1);
  assert.equal(rec.bumps![0].claim, 0);
});

test("a bump the release diff cancels out is still answered by the commit that made it", async () => {
  // traefik v3.6.25's shape: the base already carried the destination
  // version, so go.mod reads unchanged across the range while the commit
  // inside the range moves it. Reading only the range left the release
  // capped at 35 for a note describing exactly what happened.
  const bumpCommit: Commit = {
    sha: "e".repeat(40),
    subject: "Bump github.com/acme/lib to 2.8.1",
    body: "",
    author: "dev",
    prNumbers: [13530],
  };
  const d = data({
    notes: "- **[tracing]** Bump github.com/acme/lib to 2.8.1 (#13530)\n",
    commits: [bumpCommit],
    files: [file("src/app.go", "@@ -1,2 +1,2 @@ func Serve()\n-old\n+new\n")],
    commitFiles: async () => [
      file(
        "go.mod",
        "@@ -3,3 +3,3 @@ require (\n \tgithub.com/other/dep v1.0.0\n-\tgithub.com/acme/lib v2.2.3\n+\tgithub.com/acme/lib v2.8.2\n",
      ),
    ],
  });

  const report = await analyzeRelease(d, CONTEXT, null, settings({ judgeMode: "off" }));
  const bump = report.results[0];
  assert.equal(bump.verdict, "verified", "overtaken, not contradicted");
  assert.ok(bump.evidence.methods.includes("pin-anchor"));
  assert.match(bump.reasoning, /the commit this note names moves/);
  // The release diff itself moved no pin, so the pins section stays honest.
  assert.equal(report.pins, undefined);

  // And the join says where it looked, so a reader is not left wondering
  // why the pin section is empty.
  const withFindings = await analyzeRelease(
    data({
      notes: d.notes,
      commits: [bumpCommit],
      files: d.files,
      commitFiles: d.commitFiles,
    }),
    CONTEXT,
    null,
    settings({ engine: stubEngine }),
  );
  assert.deepEqual(withFindings.reconciliation?.bumps?.[0].observed, {
    from: "v2.2.3",
    to: "v2.8.2",
    file: "go.mod",
    viaCommit: true,
  });
});

test("the commit retry never overrides what the release diff already settled", async () => {
  // The release ends at 2.5.0; a commit inside it passed through 2.8.2 and
  // something later pulled it back. What the release ships is what the note
  // is measured against — a commit mid-range must not buy back a claim the
  // release contradicts.
  const bumpCommit: Commit = {
    sha: "f".repeat(40),
    subject: "dependency work",
    body: "",
    author: "dev",
    prNumbers: [77],
  };
  const d = data({
    notes: [
      "- Bump github.com/acme/lib to 2.8.1",
      "- Bump github.com/other/dep to 3.0.0 (#77)",
      "",
    ].join("\n"),
    commits: [bumpCommit],
    files: [
      file(
        "go.mod",
        "@@ -3,3 +3,3 @@ require (\n-\tgithub.com/acme/lib v2.2.3\n+\tgithub.com/acme/lib v2.5.0\n",
      ),
    ],
    commitFiles: async () => [
      file(
        "go.mod",
        "@@ -3,4 +3,4 @@ require (\n-\tgithub.com/acme/lib v2.2.3\n+\tgithub.com/acme/lib v2.8.2\n-\tgithub.com/other/dep v2.0.0\n+\tgithub.com/other/dep v3.0.0\n",
      ),
    ],
  });

  const report = await analyzeRelease(d, CONTEXT, null, settings({ engine: stubEngine }));
  const bumps = report.reconciliation!.bumps!;
  const lib = bumps.find((b) => b.claimed.name === "github.com/acme/lib")!;
  const dep = bumps.find((b) => b.claimed.name === "github.com/other/dep")!;
  assert.equal(lib.status, "contradicted", "the release diff decides, and it says 2.5.0");
  assert.equal(lib.observed?.to, "v2.5.0");
  assert.equal(lib.observed?.viaCommit, undefined);
  // The claim the release diff says nothing about is the one the retry answers.
  assert.equal(dep.status, "confirmed");
  assert.equal(dep.observed?.viaCommit, true);
});

test("a claimed version below where the pin started is not overtaken — it is wrong", () => {
  // `overtaken` exists for a per-PR note describing one slice of a bump the
  // release aggregated, so the claimed version has to lie inside the interval
  // the pin traversed. Without that bound, any invented version below the
  // range verified: `pnpm mutate-notes` restates settled bumps as 0.0.1 and
  // caught 1 of 6 before this.
  const c = bumpClaim("Update `jest-preset-angular` to 0.0.1", {
    name: "jest-preset-angular",
    to: "0.0.1",
  });
  const below = resolveBumpClaims([c], [
    pin({ name: "jest-preset-angular", from: "10.54.0", to: "10.65.0", file: "package.json" }),
  ]);
  assert.equal(below[0].status, "contradicted", "0.0.1 is nowhere in 10.54.0 → 10.65.0");

  // The boundary itself: claiming the version the release started from
  // describes no move this release made.
  const atStart = bumpClaim("Update `foo` to 1.0.0", { name: "foo", to: "1.0.0" });
  const startCase = resolveBumpClaims([atStart], [
    pin({ name: "foo", from: "1.0.0", to: "2.0.0", file: "package.json" }),
  ]);
  assert.equal(startCase[0].status, "contradicted");

  // And the case the rule was built for still reads as overtaken: inside the
  // interval, one slice of an aggregated bump.
  const inside = bumpClaim("bump `foo` from 1.2.0 to 1.5.0", {
    name: "foo",
    from: "1.2.0",
    to: "1.5.0",
  });
  const insideCase = resolveBumpClaims([inside], [
    pin({ name: "foo", from: "1.0.0", to: "2.0.0", file: "package.json" }),
  ]);
  assert.equal(insideCase[0].status, "overtaken");
});
