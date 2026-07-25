// SPDX-License-Identifier: GPL-3.0-or-later
import type { Claim, Commit, DiffFile } from "./types.ts";

const STOPWORDS = new Set(
  `a an and are as at be but by for from has have if in into is it its no not
  now of on or so some such that the their then there these this to via was we
  when will with you your fix fixed fixes fixing add added adds adding update
  updated updates support supported remove removed improve improved improvement
  improvements change changed changes new old more less other misc small minor
  instead use using used make made allow allows also only`.split(/\s+/),
);

/** Split camelCase / snake_case / kebab-case / dotted tokens into subtokens. */
function subtokens(word: string): string[] {
  return word
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean);
}

export function tokenize(text: string): string[] {
  const out = new Set<string>();
  for (const raw of text.split(/[^\w.\-]+/)) {
    if (!raw) continue;
    const lower = raw.toLowerCase();
    if (lower.length >= 2 && !STOPWORDS.has(lower)) out.add(lower);
    for (const sub of subtokens(raw)) {
      const s = sub.toLowerCase();
      if (s.length >= 3 && !STOPWORDS.has(s)) out.add(s);
    }
  }
  return [...out];
}

/** Terms that look like code identifiers — the high-signal part of a claim. */
export function extractIdentifiers(claim: Claim): string[] {
  const ids = new Set<string>(claim.codeSpans.map((s) => s.trim()));
  const wordRe = /[A-Za-z0-9_.\-]{3,}/g;
  for (const m of claim.text.matchAll(wordRe)) {
    const w = m[0];
    const isIdent =
      /_/.test(w) ||
      /^--/.test(w) ||
      /^[A-Z0-9_]+$/.test(w) && /_/.test(w) ||
      /[a-z][A-Z]/.test(w) ||
      /^[\w-]+\.[a-z]{1,4}$/.test(w) ||
      // Two-dot versions only: "2026.7.0" is a real anchor, "5.3" (CVSS score,
      // generic version) matches half the diff by accident.
      /^\d+\.\d+\.\d+/.test(w);
    if (isIdent && !STOPWORDS.has(w.toLowerCase())) ids.add(w);
  }
  return [...ids];
}

export interface AnchorMatch {
  commits: Commit[];
  viaPr: number[];
  viaSha: string[];
}

export function anchorMatch(claim: Claim, commits: Commit[]): AnchorMatch {
  const matched = new Map<string, Commit>();
  const viaPr: number[] = [];
  const viaSha: string[] = [];
  for (const pr of claim.prNumbers) {
    for (const commit of commits) {
      if (commit.prNumbers.includes(pr)) {
        matched.set(commit.sha, commit);
        viaPr.push(pr);
      }
    }
  }
  for (const sha of claim.shas) {
    for (const commit of commits) {
      if (commit.sha.startsWith(sha)) {
        matched.set(commit.sha, commit);
        viaSha.push(sha);
      }
    }
  }
  return { commits: [...matched.values()], viaPr: [...new Set(viaPr)], viaSha };
}

export interface LexicalMatch {
  files: DiffFile[];
  matchedTerms: string[];
  /** Weighted score: exact code-span hits count 3, other identifiers 2. */
  score: number;
}

/**
 * Function context from unified-diff hunk headers ("@@ … @@ pub fn foo(…)").
 * Git and the GitHub API both emit the enclosing declaration there — free
 * symbol-level labels for what a change touched.
 */
export function hunkFunctions(patch: string): string[] {
  const KEYWORDS = new Set(["func", "function", "if", "for", "while", "switch", "return", "type", "const", "let", "var"]);
  const out = new Set<string>();
  for (const m of patch.matchAll(/^@@[^@\n]*@@[ \t]+(.+)$/gm)) {
    const ctx = m[1].trim();
    const named =
      // Go first: method receivers ("func (s *Server) Name(") hide the name.
      ctx.match(/func\s+(?:\([^)]*\)\s+)?([\w$.]+)/)?.[1] ??
      ctx.match(/(?:fn|def|function|class|impl|trait|interface|struct)\s+([\w:.$]+)/)?.[1] ??
      ctx.match(/([\w$.]+)\s*(?:\(|=\s*(?:async\s*)?\()/)?.[1];
    if (named && named.length >= 2 && !KEYWORDS.has(named)) {
      out.add(named.replace(/[:.]+$/, ""));
    }
  }
  return [...out];
}

/** Aggregate touched functions across files, capped for display. */
export function functionsOf(files: DiffFile[], cap = 8): string[] {
  const out = new Set<string>();
  for (const f of files) {
    if (!f.patch) continue;
    for (const fn of hunkFunctions(f.patch)) {
      out.add(fn);
      if (out.size >= cap) return [...out];
    }
  }
  return [...out];
}

function changedLines(patch: string): string {
  return patch
    .split("\n")
    .filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l))
    .join("\n");
}

export function lexicalMatch(claim: Claim, files: DiffFile[]): LexicalMatch {
  const identifiers = extractIdentifiers(claim);
  if (!identifiers.length) return { files: [], matchedTerms: [], score: 0 };
  const hitFiles = new Map<string, DiffFile>();
  const terms = new Set<string>();
  let score = 0;
  for (const file of files) {
    const haystack = file.patch ? changedLines(file.patch) : "";
    for (const ident of identifiers) {
      const inPatch = haystack.includes(ident);
      const inPath = file.path.includes(ident);
      if (inPatch || inPath) {
        hitFiles.set(file.path, file);
        if (!terms.has(ident)) {
          terms.add(ident);
          score += claim.codeSpans.includes(ident) ? 3 : 2;
        }
      }
    }
  }
  return { files: [...hitFiles.values()], matchedTerms: [...terms], score };
}

export interface RankedHunk {
  path: string;
  hunk: string;
  score: number;
}

/** Rank all diff hunks against a claim by token overlap (tiny tf-idf). */
export function rankHunks(claim: Claim, files: DiffFile[], topK = 6): RankedHunk[] {
  const claimTokens = tokenize(claim.text + " " + claim.codeSpans.join(" "));
  if (!claimTokens.length) return [];

  interface HunkEntry {
    path: string;
    hunk: string;
    tokens: Set<string>;
  }
  const entries: HunkEntry[] = [];
  for (const file of files) {
    if (!file.patch) continue;
    const parts = file.patch.split(/^(?=@@)/m).filter((h) => h.startsWith("@@"));
    for (const hunk of parts) {
      // Include hunk-header function context: a claim naming a function should
      // rank its hunks even when the changed lines never repeat the name.
      entries.push({
        path: file.path,
        hunk,
        tokens: new Set(tokenize(changedLines(hunk) + " " + hunkFunctions(hunk).join(" "))),
      });
    }
  }
  if (!entries.length) return [];

  const df = new Map<string, number>();
  for (const t of claimTokens) {
    let n = 0;
    for (const e of entries) if (e.tokens.has(t)) n++;
    df.set(t, n);
  }

  const ranked = entries
    .map((e) => {
      let score = 0;
      for (const t of claimTokens) {
        const d = df.get(t) ?? 0;
        if (d > 0 && e.tokens.has(t)) score += Math.log(1 + entries.length / d);
        // Path hits outrank content hits: "icon endpoint" should surface
        // icons.rs hunks even when the hunk text never says "icon".
        if (e.path.toLowerCase().includes(t)) score += 3;
      }
      return { path: e.path, hunk: e.hunk, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);

  return ranked.slice(0, topK);
}
