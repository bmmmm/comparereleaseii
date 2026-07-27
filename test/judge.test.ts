// SPDX-License-Identifier: GPL-3.0-or-later
// Engine-adapter tests: every network engine through a fetch mock, the
// claude CLI through a stub binary on PATH. These are the money paths that
// had no coverage — a broken adapter fails every judged claim at once.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makeClaudeCliEngine,
  makeApiEngine,
  makeOpenAiEngine,
  discoverLocalModels,
} from "../src/judge.ts";

/** Put a fake `claude` on PATH that swallows stdin and prints a canned reply. */
async function stubClaude(t: TestContext, outerJson: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "claude-stub-"));
  await writeFile(join(dir, "response.json"), outerJson);
  await writeFile(
    join(dir, "claude"),
    `#!/bin/sh\ncat >/dev/null\ncat "$(dirname "$0")/response.json"\n`,
  );
  await chmod(join(dir, "claude"), 0o755);
  const orig = process.env.PATH;
  process.env.PATH = `${dir}:${orig}`;
  t.after(() => {
    process.env.PATH = orig;
  });
}

test("claude-cli engine unwraps the outer -p JSON envelope", async (t) => {
  const inner = '{"verdict":"verified","confidence":0.9,"files":[],"reasoning":"r"}';
  await stubClaude(t, JSON.stringify({ result: inner, is_error: false }));
  const engine = makeClaudeCliEngine("haiku");
  assert.equal(await engine.judge("prompt"), inner);
});

test("claude-cli engine surfaces is_error instead of parsing the result", async (t) => {
  await stubClaude(t, JSON.stringify({ result: "Credit balance too low", is_error: true }));
  const engine = makeClaudeCliEngine("haiku");
  await assert.rejects(() => engine.judge("prompt"), /claude -p returned an error/);
});

test("api engine returns the text block and reports HTTP errors with status", async (t) => {
  const replies: Response[] = [
    new Response(JSON.stringify({ content: [{ type: "text", text: "inner" }] }), { status: 200 }),
    new Response("overloaded", { status: 529 }),
    new Response(JSON.stringify({ content: [{ type: "tool_use" }] }), { status: 200 }),
  ];
  t.mock.method(globalThis, "fetch", async () => replies.shift()!);
  const engine = makeApiEngine("m", "key");
  assert.equal(await engine.judge("p"), "inner");
  await assert.rejects(() => engine.judge("p"), /Anthropic API 529: overloaded/);
  await assert.rejects(() => engine.judge("p"), /no text block/);
});

test("openai engine: unreachable server gets an actionable error, not a bare ECONNREFUSED", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("fetch failed: ECONNREFUSED");
  });
  const engine = makeOpenAiEngine("m", "http://127.0.0.1:9/v1");
  await assert.rejects(
    () => engine.judge("p"),
    /Is the local model server running\?.*--openai-url/s,
  );
});

test("openai engine: HTTP errors carry the status, empty choices are an error", async (t) => {
  const replies: Response[] = [
    new Response("no such model", { status: 404 }),
    new Response(JSON.stringify({ choices: [] }), { status: 200 }),
    new Response(JSON.stringify({ choices: [{ message: { content: "inner" } }] }), { status: 200 }),
  ];
  t.mock.method(globalThis, "fetch", async () => replies.shift()!);
  const engine = makeOpenAiEngine("m", "http://127.0.0.1:9/v1");
  await assert.rejects(() => engine.judge("p"), /returned 404: no such model/);
  await assert.rejects(() => engine.judge("p"), /no message content/);
  assert.equal(await engine.judge("p"), "inner");
});

test("discoverLocalModels: auth wall, server error, timeout, and a model list", async (t) => {
  const script: Array<() => Promise<Response>> = [
    async () => new Response("denied", { status: 401 }),
    async () => new Response("boom", { status: 500 }),
    async () => {
      throw new DOMException("aborted", "TimeoutError");
    },
    async () =>
      new Response(JSON.stringify({ data: [{ id: "a" }, { id: "b" }, {}] }), { status: 200 }),
  ];
  t.mock.method(globalThis, "fetch", async () => script.shift()!());
  assert.deepEqual(await discoverLocalModels("http://x/v1"), { models: [], authRequired: true });
  assert.equal(await discoverLocalModels("http://x/v1"), null);
  assert.equal(await discoverLocalModels("http://x/v1"), null, "a timeout must degrade to null");
  assert.deepEqual(await discoverLocalModels("http://x/v1"), {
    models: ["a", "b"],
    authRequired: false,
  });
});
