// SPDX-License-Identifier: GPL-3.0-or-later
import { pooled, truncate } from "./util.ts";
import { anchorMatch, functionsOf, lexicalMatch, rankHunks, tokenize } from "./match.ts";
import {
  buildJudgePrompt,
  buildSurplusPrompt,
  parseJudgeOutput,
  parseSurplusOutput,
  type JudgeEngine,
} from "./judge.ts";
import type {
  Claim,
  ClaimResult,
  Commit,
  DiffFile,
  Evidence,
  ReleaseData,
  UncoveredCommit,
} from "./types.ts";

export interface VerifyOptions {
  judgeMode: "auto" | "all" | "off";
  engine: JudgeEngine | null;
  concurrency: number;
  maxHunks: number;
  maxEvidenceChars: number;
}

function similarity(a: string, b: string): number {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / Math.min(ta.size, tb.size);
}

/** Claim text without the trailing attribution ("by @user in #123"). */
function coreText(claim: Claim): string {
  return claim.text.replace(/\bby @[\w-]+\b.*$/, "").trim();
}

const GENERATED_TAIL = /\bby @[\w-]+\b.*#\d+\s*$/;

function normTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/\(#\d+\)/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Auto-generated "Title by @user in #N" entry whose title equals the squash
 * commit subject. True by construction (GitHub generated it from the same
 * commits we check against), so it must not inflate the correctness score.
 */
export function isGeneratedEntry(claim: Claim, commits: Commit[]): boolean {
  if (!GENERATED_TAIL.test(claim.text)) return false;
  const core = normTitle(coreText(claim));
  return core.length > 0 && commits.some((c) => normTitle(c.subject) === core);
}

/** Claim whose text carries no verifiable content tokens ("Updates and fixes"). */
export function isVagueClaim(claim: Claim): boolean {
  return tokenize(coreText(claim)).length <= 1;
}

interface Pending {
  claim: Claim;
  evidence: Evidence;
  hunkPool: DiffFile[];
  commits: Commit[];
  generated: boolean;
  fallback: { verdict: ClaimResult["verdict"]; confidence: number; reasoning: string };
}

function capHunks(
  hunks: Array<{ path: string; hunk: string }>,
  maxChars: number,
): Array<{ path: string; hunk: string }> {
  const out: Array<{ path: string; hunk: string }> = [];
  let used = 0;
  for (const h of hunks) {
    const clipped = { path: h.path, hunk: truncate(h.hunk, maxChars - used) };
    out.push(clipped);
    used += clipped.hunk.length;
    if (used >= maxChars) break;
  }
  return out;
}

export async function verifyClaims(
  data: ReleaseData,
  claims: Claim[],
  opts: VerifyOptions,
): Promise<ClaimResult[]> {
  const results = new Map<number, ClaimResult>();
  const pending: Pending[] = [];
  const surplusQueue: Array<{ claim: Claim; pool: DiffFile[] }> = [];
  const useJudge = opts.engine !== null && opts.judgeMode !== "off";

  for (const claim of claims) {
    if (claim.kind === "meta") {
      results.set(claim.id, {
        claim,
        verdict: "skipped",
        confidence: 1,
        evidence: { commitShas: [], files: [], matchedTerms: [], methods: ["none"] },
        reasoning: "Informational entry, nothing to verify against the diff.",
        judged: false,
        generated: false,
      });
      continue;
    }

    const anchors = anchorMatch(claim, data.commits);
    if (anchors.commits.length) {
      const fileLists = await Promise.all(
        anchors.commits.map((c) => data.commitFiles(c.sha)),
      );
      const pool = fileLists.flat();
      const generated = isGeneratedEntry(claim, anchors.commits);
      const lex = lexicalMatch(claim, pool);
      const bestSim = Math.max(
        ...anchors.commits.map((c) => similarity(coreText(claim), c.subject)),
      );
      const methods: Evidence["methods"] = ["pr-anchor"];
      if (generated) methods.push("generated");
      if (lex.score > 0) methods.push("lexical");
      const evidence: Evidence = {
        commitShas: anchors.commits.map((c) => c.sha),
        files: lex.files.map((f) => f.path),
        matchedTerms: lex.matchedTerms,
        methods,
        functions: functionsOf(pool),
      };
      const anchorLabel = anchors.viaPr.length
        ? `PR #${anchors.viaPr.join(", #")}`
        : `commit ${anchors.viaSha.join(", ")}`;
      const strong = generated || bestSim >= 0.5 || lex.score >= 2;
      const detail = generated
        ? `auto-generated entry, title matches the squash commit`
        : lex.score >= 2
          ? `identifiers ${lex.matchedTerms.slice(0, 4).join(", ")} appear in its diff`
          : `commit subject matches the claim (${Math.round(bestSim * 100)}%)`;
      const fallback = strong
        ? {
            verdict: "verified" as const,
            confidence: 0.9,
            reasoning: `${anchorLabel} is in the release range (${anchors.commits[0].sha.slice(0, 10)}); ${detail}.`,
          }
        : {
            verdict: "partial" as const,
            confidence: 0.6,
            reasoning: `${anchorLabel} is in the release range, but the claim text could not be matched to its diff content.`,
          };
      if (useJudge && isVagueClaim(claim)) {
        // Reverse-direction audit: what does this vague note hide?
        surplusQueue.push({ claim, pool });
      }
      if (useJudge && (opts.judgeMode === "all" || !strong)) {
        pending.push({ claim, evidence, hunkPool: pool, commits: anchors.commits, generated, fallback });
      } else {
        results.set(claim.id, { claim, ...fallback, evidence, judged: false, generated });
      }
      continue;
    }

    // No usable anchor (or referenced PR not findable in commit messages):
    // fall back to lexical + ranked-hunk evidence over the whole diff.
    const lex = lexicalMatch(claim, data.files);
    const evidence: Evidence = {
      commitShas: [],
      files: lex.files.map((f) => f.path),
      matchedTerms: lex.matchedTerms,
      methods: lex.score > 0 ? ["lexical"] : ["none"],
      functions: functionsOf(lex.files),
    };
    const anchorNote = claim.prNumbers.length
      ? `Referenced PR #${claim.prNumbers.join(", #")} matches no commit message in the range. `
      : "";
    const fallback =
      lex.score >= 5
        ? {
            verdict: "verified" as const,
            confidence: 0.8,
            reasoning: `${anchorNote}Identifiers ${lex.matchedTerms.slice(0, 5).join(", ")} all appear in the diff (${lex.files.length} file(s)).`,
          }
        : lex.score >= 2
          ? {
              verdict: "partial" as const,
              confidence: 0.55,
              reasoning: `${anchorNote}Some identifiers (${lex.matchedTerms.join(", ")}) appear in the diff, but the match is weak.`,
            }
          : {
              verdict: "no-evidence" as const,
              confidence: 0.5,
              reasoning: `${anchorNote}No identifier from the claim appears in the diff.`,
            };
    if (useJudge && (opts.judgeMode === "all" || fallback.verdict !== "verified")) {
      const related = data.commits
        .map((c) => ({ c, s: similarity(coreText(claim), c.subject) }))
        .filter((x) => x.s > 0.3)
        .sort((a, b) => b.s - a.s)
        .slice(0, 3)
        .map((x) => x.c);
      pending.push({ claim, evidence, hunkPool: data.files, commits: related, generated: false, fallback });
    } else {
      results.set(claim.id, { claim, ...fallback, evidence, judged: false, generated: false });
    }
  }

  if (pending.length && opts.engine) {
    const engine = opts.engine;
    await pooled(pending, opts.concurrency, async (p) => {
      let ranked = rankHunks(p.claim, p.hunkPool, opts.maxHunks);
      if (!ranked.length && p.evidence.commitShas.length) {
        // Vague anchored claim ("Updates and fixes"): no token overlap to rank
        // by, but the linked commit's own diff IS the evidence — send its head.
        ranked = p.hunkPool
          .filter((f) => f.patch)
          .slice(0, opts.maxHunks)
          .map((f) => ({ path: f.path, hunk: f.patch!, score: 0 }));
      }
      const hunks = capHunks(ranked, opts.maxEvidenceChars);
      const prompt = buildJudgePrompt({
        repoLabel: data.repoLabel,
        baseRef: data.baseRef,
        headRef: data.headRef,
        section: p.claim.section,
        claimText: p.claim.text,
        hunks,
        commits: p.commits,
        allPaths: data.files.map((f) => f.path),
      });
      try {
        const verdict = parseJudgeOutput(await engine.judge(prompt));
        results.set(p.claim.id, {
          claim: p.claim,
          verdict: verdict.verdict,
          confidence: verdict.confidence,
          evidence: {
            ...p.evidence,
            files: [...new Set([...p.evidence.files, ...verdict.files])],
            methods: [...p.evidence.methods, "llm"],
          },
          reasoning: verdict.reasoning,
          judged: true,
          generated: p.generated,
        });
      } catch (err) {
        results.set(p.claim.id, {
          claim: p.claim,
          ...p.fallback,
          evidence: p.evidence,
          reasoning: `${p.fallback.reasoning} (LLM judge failed: ${(err as Error).message.slice(0, 120)})`,
          judged: false,
          generated: p.generated,
        });
      }
    });
  }

  if (surplusQueue.length && opts.engine) {
    const engine = opts.engine;
    await pooled(surplusQueue, opts.concurrency, async (q) => {
      const hunks = capHunks(
        q.pool.filter((f) => f.patch).map((f) => ({ path: f.path, hunk: f.patch! })),
        opts.maxEvidenceChars,
      );
      if (!hunks.length) return;
      const prompt = buildSurplusPrompt({
        repoLabel: data.repoLabel,
        claimText: q.claim.text,
        hunks,
      });
      try {
        const surplus = parseSurplusOutput(await engine.judge(prompt));
        if (surplus.length) {
          const r = results.get(q.claim.id);
          if (r) r.surplus = surplus;
        }
      } catch {
        // Best-effort audit; the claim's own verdict already stands.
      }
    });
  }

  return claims.map((cl) => results.get(cl.id)!);
}

export interface Coverage {
  uncovered: UncoveredCommit[];
  coveredShas: Set<string>;
  evidenceFiles: Set<string>;
  commitFiles: Map<string, DiffFile[]>;
}

/** Completeness check: which commits are not covered by any release-note claim? */
export async function computeCoverage(
  data: ReleaseData,
  claims: Claim[],
  results: ClaimResult[],
): Promise<Coverage> {
  const covered = new Set<string>();
  // Any anchor in any claim (incl. meta like "New Contributors") documents a commit.
  for (const claim of claims) {
    for (const commit of anchorMatch(claim, data.commits).commits) {
      covered.add(commit.sha);
    }
  }
  for (const r of results) {
    if (r.verdict === "verified" || r.verdict === "partial") {
      for (const sha of r.evidence.commitShas) covered.add(sha);
    }
  }

  const evidenceFiles = new Set(
    results
      .filter((r) => r.verdict === "verified" || r.verdict === "partial")
      .flatMap((r) => r.evidence.files),
  );

  const commitFileLists = await pooled(data.commits, 6, (c) =>
    data.commitFiles(c.sha).catch(() => [] as DiffFile[]),
  );
  const commitFiles = new Map<string, DiffFile[]>();
  data.commits.forEach((c, i) => commitFiles.set(c.sha, commitFileLists[i]));

  const uncovered: UncoveredCommit[] = [];
  data.commits.forEach((commit, i) => {
    if (covered.has(commit.sha)) return;
    const files = commitFileLists[i];
    // A commit mostly touching files already cited as evidence counts as covered.
    if (files.length) {
      const hit = files.filter((f) => evidenceFiles.has(f.path)).length;
      if (hit / files.length >= 0.5) {
        covered.add(commit.sha);
        return;
      }
    }
    uncovered.push({
      commit,
      additions: files.reduce((s, f) => s + f.additions, 0),
      deletions: files.reduce((s, f) => s + f.deletions, 0),
      fileCount: files.length,
    });
  });
  uncovered.sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions));
  return { uncovered, coveredShas: covered, evidenceFiles, commitFiles };
}
