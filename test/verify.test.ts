// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { isGeneratedEntry, isVagueClaim, medianVerdict } from "../src/verify.ts";
import { hunkFunctions } from "../src/match.ts";
import {
  parseSurplusOutput,
  parseJudgeResponse,
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

test("selectEngine: openai needs an explicit model, then builds the engine", () => {
  assert.throws(() => selectEngine({ engine: "openai" }), /--model/);
  const engine = selectEngine({ engine: "openai", model: "qwen3:8b" });
  assert.equal(engine?.name, "openai/qwen3:8b");
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
