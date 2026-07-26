#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Diagnose the raw response shape of an OpenAI-compatible server for a real
// judge prompt. Prints metadata only — no secrets.
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildJudgePrompt } from "../src/judge.ts";

const golden = JSON.parse(
  await readFile(
    join(dirname(fileURLToPath(import.meta.url)), "..", "test", "eval", "golden.json"),
    "utf8",
  ),
) as Array<{ section: string; claim: string; hunks: Array<{ path: string; hunk: string }> }>;

const gc = golden[0];
const prompt = buildJudgePrompt({
  repoLabel: "eval/fixture",
  baseRef: "v1.0.0",
  headRef: "v1.1.0",
  section: gc.section,
  claimText: gc.claim,
  hunks: gc.hunks,
  commits: [],
});

const baseUrl = (process.env.OPENAI_BASE_URL ?? "http://127.0.0.1:8010/v1").replace(/\/+$/, "");
const res = await fetch(`${baseUrl}/chat/completions`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    ...(process.env.OPENAI_API_KEY ? { authorization: `Bearer ${process.env.OPENAI_API_KEY}` } : {}),
  },
  body: JSON.stringify({
    model: process.env.EVAL_MODEL ?? "Qwen3.5-9B-MLX-4bit",
    temperature: 0,
    max_tokens: 4096,
    messages: [{ role: "user", content: prompt }],
    chat_template_kwargs: { enable_thinking: false },
  }),
});
console.log("http status:", res.status);
const data = (await res.json()) as {
  choices?: Array<{ finish_reason?: string; message?: { content?: unknown } }>;
  usage?: unknown;
};
const msg = data.choices?.[0];
const content = msg?.message?.content;
const asText = typeof content === "string" ? content : JSON.stringify(content);
console.log(
  JSON.stringify(
    {
      promptChars: prompt.length,
      finish: msg?.finish_reason,
      contentType: Array.isArray(content) ? "array" : typeof content,
      contentLen: asText?.length,
      head: asText?.slice(0, 120),
      tail: asText?.slice(-60),
      usage: data.usage,
    },
    null,
    1,
  ),
);
