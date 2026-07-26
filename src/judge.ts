// SPDX-License-Identifier: GPL-3.0-or-later
import { tmpdir } from "node:os";
import { commandExists, run } from "./util.ts";
import { withVerdictCache } from "./cache.ts";
import type { SurplusItem, Verdict } from "./types.ts";

export interface JudgeEngine {
  name: string;
  judge(prompt: string): Promise<string>;
}

export interface JudgeVerdict {
  verdict: Verdict;
  confidence: number;
  files: string[];
  reasoning: string;
}

export function makeClaudeCliEngine(model: string): JudgeEngine {
  return {
    name: `claude-cli/${model}`,
    async judge(prompt: string): Promise<string> {
      // cwd is a temp dir so the nested claude session loads no project context.
      const { stdout } = await run(
        "claude",
        ["-p", "--model", model, "--output-format", "json"],
        { input: prompt, cwd: tmpdir() },
      );
      const outer = JSON.parse(stdout) as { result?: string; is_error?: boolean };
      if (outer.is_error || typeof outer.result !== "string") {
        throw new Error(`claude -p returned an error: ${stdout.slice(0, 300)}`);
      }
      return outer.result;
    },
  };
}

export function makeApiEngine(model: string, apiKey: string): JudgeEngine {
  return {
    name: `api/${model}`,
    async judge(prompt: string): Promise<string> {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (!res.ok) {
        throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      const data = (await res.json()) as { content: Array<{ type: string; text?: string }> };
      const text = data.content.find((b) => b.type === "text")?.text;
      if (!text) throw new Error("Anthropic API returned no text block");
      return text;
    },
  };
}

/**
 * OpenAI-compatible chat endpoint — covers Ollama, MLX servers, LM Studio,
 * vLLM and friends. Local servers usually need no API key.
 */
export function makeOpenAiEngine(model: string, baseUrl: string, apiKey?: string): JudgeEngine {
  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  // Reasoning models spend max_tokens on hidden thinking before the JSON —
  // 1024 truncated Qwen3.5 answers mid-object. Budget is part of the cache
  // identity so a budget change invalidates previously truncated responses.
  const maxTokens = 4096;
  return {
    name: `openai/${model}@${maxTokens}`,
    async judge(prompt: string): Promise<string> {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: maxTokens,
          messages: [{ role: "user", content: prompt }],
          // Reasoning models (Qwen3.x) otherwise emit <think> blocks that can
          // break strict-JSON parsing; unknown fields are ignored elsewhere.
          chat_template_kwargs: { enable_thinking: false },
        }),
      }).catch((err: Error) => {
        throw new Error(
          `Cannot reach ${url}: ${err.message}. Is the local model server running? (Ollama default: http://127.0.0.1:11434/v1 — override with --openai-url or OPENAI_BASE_URL)`,
        );
      });
      if (!res.ok) {
        throw new Error(`${url} returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const text = data.choices?.[0]?.message?.content;
      if (!text) throw new Error(`${url} returned no message content`);
      return text;
    },
  };
}

export interface LocalDiscovery {
  models: string[];
  authRequired: boolean;
}

/** Probe an OpenAI-compatible server for its model list (fast, best-effort). */
export async function discoverLocalModels(baseUrl: string): Promise<LocalDiscovery | null> {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(1500),
      headers: process.env.OPENAI_API_KEY
        ? { authorization: `Bearer ${process.env.OPENAI_API_KEY}` }
        : {},
    });
    if (res.status === 401 || res.status === 403) {
      return { models: [], authRequired: true };
    }
    if (!res.ok) return null;
    const data = (await res.json()) as { data?: Array<{ id?: string }> };
    const models = (data.data ?? []).map((m) => m.id).filter((id): id is string => !!id);
    return { models, authRequired: false };
  } catch {
    return null;
  }
}

export function selectEngine(opts: {
  engine: "claude-cli" | "api" | "openai" | "off";
  model?: string;
  openaiUrl?: string;
}): JudgeEngine | null {
  if (opts.engine === "off") return null;
  if (opts.engine === "api") {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) {
      throw new Error(
        "Engine 'api' needs ANTHROPIC_API_KEY in the environment. Use --engine claude-cli (default) to go through the claude CLI instead.",
      );
    }
    return makeApiEngine(opts.model ?? "claude-haiku-4-5-20251001", key);
  }
  if (opts.engine === "openai") {
    if (!opts.model) {
      throw new Error(
        "Engine 'openai' needs an explicit --model (e.g. --model qwen3:8b for Ollama) — local servers have no default model.",
      );
    }
    const baseUrl =
      opts.openaiUrl ?? process.env.OPENAI_BASE_URL ?? "http://127.0.0.1:11434/v1";
    return makeOpenAiEngine(opts.model, baseUrl, process.env.OPENAI_API_KEY);
  }
  return makeClaudeCliEngine(opts.model ?? "haiku");
}

export interface EngineOptions {
  judgeMode: "auto" | "all" | "off";
  engine: "claude-cli" | "api" | "openai" | "off";
  model?: string;
  /** Explicit --openai-url flag value (undefined = env/default resolution). */
  openaiUrl?: string;
  escalate: "auto" | "off" | "claude-cli" | "api" | "openai";
  escalateModel?: string;
  cache: boolean;
}

/**
 * Resolve the primary and escalation judge engines from CLI-shaped options,
 * with graceful fallbacks: a missing claude CLI falls back to the API when a
 * key is present, then to a discovered local server, then to deterministic
 * only. Prints its decisions to stderr.
 */
export async function resolveEngines(
  opts: EngineOptions,
): Promise<{ engine: JudgeEngine | null; escalate: JudgeEngine | null }> {
  if (opts.judgeMode === "off") return { engine: null, escalate: null };
  const openaiBase =
    opts.openaiUrl ?? process.env.OPENAI_BASE_URL ?? "http://127.0.0.1:11434/v1";
  let effective = opts.engine;
  let model = opts.model;

  if (effective === "claude-cli" && !(await commandExists("claude"))) {
    if (process.env.ANTHROPIC_API_KEY) {
      console.error("claude CLI not found — using the Anthropic API engine instead.");
      effective = "api";
    } else {
      const found = await discoverLocalModels(openaiBase);
      if (found && !found.authRequired && found.models.length) {
        model ??= found.models[0];
        console.error(
          `claude CLI not found — using the local model server at ${openaiBase} (model ${model}).`,
        );
        effective = "openai";
      } else {
        console.error(
          "claude CLI not found and ANTHROPIC_API_KEY is unset — running deterministic-only.\n" +
            (found?.authRequired
              ? `(A local server at ${openaiBase} responded but needs OPENAI_API_KEY.)\n`
              : "") +
            "For LLM-judged verdicts install Claude Code (https://code.claude.com), export ANTHROPIC_API_KEY, or start a local OpenAI-compatible server (Ollama/MLX).",
        );
        return { engine: null, escalate: null };
      }
    }
  }

  if (model?.includes(",")) {
    throw new Error(
      "Comma-separated model lists are only for --calibrate ranking — pick ONE model for a check run.",
    );
  }
  if (effective === "openai" && !model) {
    const found = await discoverLocalModels(openaiBase);
    if (found?.authRequired) {
      throw new Error(`${openaiBase} requires an API key — export OPENAI_API_KEY.`);
    }
    if (!found?.models.length) {
      throw new Error(
        `No model server reachable at ${openaiBase} — start one (Ollama/MLX/vLLM) or pass --openai-url / --model.`,
      );
    }
    if (found.models.length > 20) {
      throw new Error(
        `${openaiBase} offers ${found.models.length} models — that looks like an aggregator (OpenRouter?). Auto-picking would be arbitrary and possibly expensive; pass --model explicitly.`,
      );
    }
    model = found.models[0];
    console.error(
      `Local server: using model ${model}` +
        (found.models.length > 1
          ? ` (override with --model; also available: ${found.models.slice(1, 6).join(", ")})`
          : "") +
        ".",
    );
  }

  let primary = selectEngine({ engine: effective, model, openaiUrl: opts.openaiUrl });
  if (primary && opts.cache) primary = withVerdictCache(primary);

  let second: JudgeEngine | null = null;
  if (primary && opts.escalate !== "off") {
    if (opts.escalate === "auto") {
      // Only local primaries need a stronger reviewer by default.
      if (effective === "openai") {
        if (await commandExists("claude")) {
          second = selectEngine({ engine: "claude-cli", model: opts.escalateModel });
        } else if (process.env.ANTHROPIC_API_KEY) {
          second = selectEngine({ engine: "api", model: opts.escalateModel });
        }
        if (second) {
          console.error(
            `Escalation engine for release-critical verdicts: ${second.name} (disable with --escalate off).`,
          );
        }
      }
    } else {
      second = selectEngine({
        engine: opts.escalate,
        model: opts.escalateModel,
        openaiUrl: opts.openaiUrl,
      });
    }
    if (second && opts.cache) second = withVerdictCache(second);
  }
  return { engine: primary, escalate: second };
}

const VERDICTS: Record<string, Verdict> = {
  verified: "verified",
  partial: "partial",
  no_evidence: "no-evidence",
  "no-evidence": "no-evidence",
  contradicted: "contradicted",
};

export type JudgeResponse = JudgeVerdict | { need: string[] };

/**
 * Parse a JSON object out of model output, repairing unterminated tails.
 * Small models (Qwen3.5-9B) routinely emit `{"…":"…"` and then stop without
 * the closing braces — close open strings/brackets before giving up.
 */
export function extractJsonObject(raw: string): unknown {
  const start = raw.indexOf("{");
  if (start === -1) {
    throw new Error(`output contains no JSON object: ${raw.slice(0, 200)}`);
  }
  const end = raw.lastIndexOf("}");
  if (end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      // fall through to repair
    }
  }
  const fragment = raw.slice(start);
  let inString = false;
  let escaped = false;
  const stack: string[] = [];
  for (const ch of fragment) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = inString;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") stack.pop();
  }
  return JSON.parse(fragment + (inString ? '"' : "") + stack.reverse().join(""));
}

export function parseJudgeResponse(raw: string): JudgeResponse {
  const parsed = extractJsonObject(raw) as {
    verdict?: string;
    confidence?: number;
    files?: string[];
    reasoning?: string;
    need?: string[];
  };
  if (Array.isArray(parsed.need) && parsed.need.length && !parsed.verdict) {
    return { need: parsed.need.slice(0, 3).map(String) };
  }
  const verdict = VERDICTS[parsed.verdict ?? ""];
  if (!verdict) {
    throw new Error(`Judge returned unknown verdict "${parsed.verdict}"`);
  }
  return {
    verdict,
    confidence: Math.min(1, Math.max(0, parsed.confidence ?? 0.5)),
    files: Array.isArray(parsed.files) ? parsed.files.slice(0, 20) : [],
    reasoning: (parsed.reasoning ?? "").slice(0, 500),
  };
}

export function buildJudgePrompt(opts: {
  repoLabel: string;
  baseRef: string;
  headRef: string;
  section: string;
  claimText: string;
  hunks: Array<{ path: string; hunk: string }>;
  commits: Array<{ sha: string; subject: string; author: string }>;
  allPaths?: string[];
  /** Offer the one-shot "need more files" escape hatch (first round only). */
  allowNeed?: boolean;
}): string {
  const pathBlock = opts.allPaths
    ? `\nAll files changed in this release (for orientation; their diffs may not be shown):\n${opts.allPaths.slice(0, 200).join("\n")}\n`
    : "";
  const needBlock = opts.allowNeed
    ? `\nIf the shown evidence is insufficient to judge, but specific changed files from the list above would settle it, respond INSTEAD with exactly:\n{"need":["path1","path2"]}\n(max 3 paths, only from the changed-files list — you will then receive their full diffs)\nTypical case: the claim names a file or function whose diff is not shown — request that file instead of guessing from changelog or docs mentions.\n`
    : "";
  const hunkBlock = opts.hunks
    .map((h) => `--- ${h.path}\n${h.hunk}`)
    .join("\n\n");
  const commitBlock = opts.commits.length
    ? opts.commits
        .map((c) => `- ${c.sha.slice(0, 10)} ${c.subject} (by ${c.author})`)
        .join("\n")
    : "(none linked)";
  return `You are a release-notes fact checker for ${opts.repoLabel} (${opts.baseRef} -> ${opts.headRef}).
Decide whether the git diff evidence below supports one claim from the release notes.

Claim (section "${opts.section}"):
"${opts.claimText}"

Linked commits:
${commitBlock}
${pathBlock}
Candidate diff evidence (may be incomplete — it was pre-filtered by relevance):
${hunkBlock || "(no matching hunks found)"}

Rules:
- Judge ONLY against the provided evidence; never assume unshown changes exist.
- verified: the diff clearly implements what the claim states.
- partial: related changes are present but incomplete, or only part of the claim is supported.
- no_evidence: nothing in the evidence supports the claim.
- contradicted: the evidence shows the opposite of the claim — e.g. the claim
  says something was removed/disabled but the code still registers or uses it.
- A changelog or release-notes hunk restating the claim is NOT evidence —
  notes cannot prove themselves. A claim about code behavior needs code
  changes as support; docs hunks only support claims about documentation.
${needBlock}
Respond with ONLY this JSON object, no markdown fences, no extra prose:
{"verdict":"verified|partial|no_evidence|contradicted","confidence":0.0,"files":["path"],"reasoning":"1-2 sentences citing concrete evidence lines"}`;
}

export function buildSurplusPrompt(opts: {
  repoLabel: string;
  claimText: string;
  hunks: Array<{ path: string; hunk: string }>;
}): string {
  const hunkBlock = opts.hunks.map((h) => `--- ${h.path}\n${h.hunk}`).join("\n\n");
  return `You are auditing a release of ${opts.repoLabel} for changes hidden behind a vague release note.
The ONLY release-note text covering the commit diff below is:
"${opts.claimText}"

Commit diff:
${hunkBlock}

List changes in this diff that users would want explicitly documented but that this note does not convey: behavior changes, new/removed features or endpoints, new config options, security-relevant logic, added dependencies. Mark those as notable. Routine refactoring, version bumps, CI tweaks, comment/formatting changes are NOT notable.

Respond with ONLY this JSON object, no markdown fences:
{"surplus":[{"description":"…","file":"path","notable":true}],"reasoning":"1 sentence"}
Use an empty surplus array if the note adequately covers everything.`;
}

export function buildSuggestPrompt(opts: {
  repoLabel: string;
  commitSubject: string;
  hunks: Array<{ path: string; hunk: string }>;
}): string {
  const hunkBlock = opts.hunks.map((h) => `--- ${h.path}\n${h.hunk}`).join("\n\n");
  return `You are drafting a release note for ${opts.repoLabel}. This commit shipped but has no corresponding entry in the release notes:

Commit subject: "${opts.commitSubject}"

Diff:
${hunkBlock || "(no diff available)"}

Write ONE concise, user-facing release-note line for this change: plain prose, no markdown, no leading bullet, describing what changed and why a user would care — not implementation detail. If the diff is purely internal (refactor, tests, CI, formatting, dependency bump with no behavior change) with nothing a user would need to know, say so explicitly instead of inventing a claim.

Respond with ONLY this JSON object, no markdown fences:
{"suggestion":"…"}`;
}

export function parseSuggestOutput(raw: string): string {
  const parsed = extractJsonObject(raw) as { suggestion?: unknown };
  return String(parsed.suggestion ?? "").slice(0, 300).trim();
}

export function parseSurplusOutput(raw: string): SurplusItem[] {
  const parsed = extractJsonObject(raw) as { surplus?: unknown };
  if (!Array.isArray(parsed.surplus)) return [];
  return parsed.surplus
    .filter((s): s is Record<string, unknown> => typeof s === "object" && s !== null)
    .slice(0, 10)
    .map((s) => ({
      description: String(s.description ?? "").slice(0, 300),
      file: String(s.file ?? ""),
      notable: s.notable === true,
    }))
    .filter((s) => s.description);
}
