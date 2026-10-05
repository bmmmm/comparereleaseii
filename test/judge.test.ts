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
  resolveEngines,
} from "../src/judge.ts";
import { calibrateModels } from "../src/calibrate.ts";

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

const localOptions = {
  judgeMode: "auto", engine: "openai", openaiUrl: "http://x/v1",
  escalate: "off", cache: false,
} as const;

test("Laya cannot be a text judge, including a reviewer or a calibration shortlist", async (t) => {
  const requests = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("No inference should be attempted");
  });
  for (const model of ["laya", "convaiinnovations/laya-multilingual", "aac6fef/laya-multilingual-mlx", "Laya-typed-decisions:latest", "local/laya_multilingual.Q4"]) {
    assert.throws(() => makeOpenAiEngine(model, "http://x/v1"), /Laya.*typed-decision.*--model/);
    await assert.rejects(resolveEngines({ ...localOptions, model }), /Laya.*typed-decision/);
  }
  await assert.rejects(resolveEngines({
    ...localOptions, model: "qwen3:8b", escalate: "openai", escalateModel: "laya-multilingual",
  }), /Laya.*typed-decision/);
  await assert.rejects(calibrateModels(["qwen3:8b", "laya-multilingual"], {
    baseUrl: "http://x/v1", cache: false,
  }), /Laya.*typed-decision/);
  assert.equal(requests.mock.callCount(), 0);
});

test("local discovery skips Laya and sends the judge request to the next model", async (t) => {
  const messages: string[] = [];
  t.mock.method(console, "error", (message: string) => messages.push(message));
  let sentModel: string | undefined;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    if (!init?.body) return Response.json({ data: [
      { id: "aac6fef/laya-multilingual-mlx" }, { id: "laya-ai/qwen3" }, { id: "malaya" },
    ] });
    sentModel = JSON.parse(String(init.body)).model;
    return Response.json({ choices: [{ message: { content: "judged" } }] });
  });
  const { engine } = await resolveEngines(localOptions);
  assert.equal(await engine!.judge("claim and diff"), "judged");
  assert.equal(sentModel, "laya-ai/qwen3", "the provider name does not define model capabilities");
  assert.ok(messages.some((m) => m.includes("also available: malaya")));
  assert.ok(messages.every((m) => !m.includes("laya-multilingual")));
  assert.equal(makeOpenAiEngine("malaya", "http://x/v1").name, "openai/malaya@4096");
  assert.equal(makeOpenAiEngine("layabout", "http://x/v1").name, "openai/layabout@4096");
});

test("a Laya-only server explains the missing text judge; judge off never probes it", async (t) => {
  const requests = t.mock.method(globalThis, "fetch", async () => Response.json({
    data: [{ id: "laya-multilingual" }],
  }));
  await assert.rejects(resolveEngines(localOptions), /No text-generating judge.*Laya/s);
  assert.deepEqual(await resolveEngines({ ...localOptions, judgeMode: "off", model: "laya" }), {
    engine: null, escalate: null,
  });
  assert.equal(requests.mock.callCount(), 1);
});

test("missing Claude falls back past Laya, or stays deterministic on a Laya-only server", async (t) => {
  const originalPath = process.env.PATH;
  const originalKey = process.env.ANTHROPIC_API_KEY;
  process.env.PATH = "";
  delete process.env.ANTHROPIC_API_KEY;
  t.after(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
  });
  const messages: string[] = [];
  t.mock.method(console, "error", (message: string) => messages.push(message));
  let models = ["laya-multilingual", "qwen3:8b"];
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: models.map((id) => ({ id })) }));
  const opts = { ...localOptions, engine: "claude-cli" } as const;
  assert.equal((await resolveEngines(opts)).engine!.name, "openai/qwen3:8b@4096");
  models = ["laya-multilingual"];
  assert.deepEqual(await resolveEngines(opts), { engine: null, escalate: null });
  assert.ok(messages.some((m) => /deterministic-only/.test(m) && /Laya.*typed-decision/.test(m)));
  models = Array.from({ length: 21 }, (_, i) => `laya-${i}`);
  await assert.rejects(resolveEngines(localOptions), /aggregator/);
  assert.deepEqual(await resolveEngines(opts), { engine: null, escalate: null });
  assert.ok(messages.some((m) => /21 models.*aggregator/.test(m)));
});
