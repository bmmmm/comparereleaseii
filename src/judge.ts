// SPDX-License-Identifier: GPL-3.0-or-later
import { tmpdir } from "node:os";
import { run } from "./util.ts";
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

export function selectEngine(opts: {
  engine: "claude-cli" | "api" | "off";
  model?: string;
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
  return makeClaudeCliEngine(opts.model ?? "haiku");
}

const VERDICTS: Record<string, Verdict> = {
  verified: "verified",
  partial: "partial",
  no_evidence: "no-evidence",
  "no-evidence": "no-evidence",
  contradicted: "contradicted",
};

export type JudgeResponse = JudgeVerdict | { need: string[] };

export function parseJudgeResponse(raw: string): JudgeResponse {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error(`Judge output contains no JSON object: ${raw.slice(0, 200)}`);
  }
  const parsed = JSON.parse(raw.slice(start, end + 1)) as {
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
    ? `\nIf the shown evidence is insufficient to judge, but specific changed files from the list above would settle it, respond INSTEAD with exactly:\n{"need":["path1","path2"]}\n(max 3 paths, only from the changed-files list — you will then receive their full diffs)\n`
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
- contradicted: the evidence shows the opposite of the claim.
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

export function parseSurplusOutput(raw: string): SurplusItem[] {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error(`Surplus output contains no JSON object: ${raw.slice(0, 200)}`);
  }
  const parsed = JSON.parse(raw.slice(start, end + 1)) as { surplus?: unknown };
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
