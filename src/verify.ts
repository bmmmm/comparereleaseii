// SPDX-License-Identifier: GPL-3.0-or-later
import { pooled, truncate } from "./util.ts";
import { anchorMatch, functionsOf, isChangelogPath, lexicalMatch, rankHunks, tokenize } from "./match.ts";
import { sensitiveCategory } from "./metrics.ts";
import {
  buildJudgePrompt,
  buildSurplusPrompt,
  parseJudgeResponse,
  parseSurplusOutput,
  type JudgeEngine,
  type JudgeVerdict,
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
  /** Stronger second engine for release-critical verdicts (local-model setups). */
  escalateEngine?: JudgeEngine | null;
  concurrency: number;
  maxHunks: number;
  maxEvidenceChars: number;
}

/** Claims where a wrong "verified" is most damaging (rubber-stamp risk). */
function isSecuritySensitive(claim: Claim): boolean {
  return claim.advisories.length > 0 || /securit|vulnerab|cve|advisor/i.test(claim.section);
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
 * Auto-generated notes entry that merely restates a commit — "Title by @user
 * in #N" PR lists, or "<sha> subject" changelog lists. True by construction
 * (generated from the same commits we check against), so it must not inflate
 * the correctness score.
 */
export function isGeneratedEntry(claim: Claim, commits: Commit[]): boolean {
  const core = normTitle(coreText(claim).replace(/\b[0-9a-f]{7,40}\b/g, ""));
  if (!core) return false;
  if (GENERATED_TAIL.test(claim.text)) {
    return commits.some((c) => normTitle(c.subject) === core);
  }
  if (claim.shas.length) {
    return commits.some(
      (c) => claim.shas.some((s) => c.sha.startsWith(s)) && normTitle(c.subject) === core,
    );
  }
  return false;
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

const SEVERITY: Record<JudgeVerdict["verdict"], number> = {
  verified: 0,
  partial: 1,
  skipped: 1,
  "no-evidence": 2,
  contradicted: 3,
};

/** Median by severity — one outlier vote cannot flip a release verdict. */
export function medianVerdict(votes: JudgeVerdict[]): JudgeVerdict {
  const sorted = [...votes].sort(
    (a, b) => SEVERITY[a.verdict] - SEVERITY[b.verdict],
  );
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

export function capHunks(
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
    if (claim.kind === "meta" || claim.carriedOverFrom) {
      results.set(claim.id, {
        claim,
        verdict: "skipped",
        confidence: 1,
        evidence: { commitShas: [], files: [], matchedTerms: [], methods: ["none"] },
        reasoning: claim.carriedOverFrom
          ? `Carried over verbatim from ${claim.carriedOverFrom} — describes the product, not this release.`
          : "Informational entry, nothing to verify against the diff.",
        judged: false,
        generated: false,
      });
      continue;
    }

    const anchors = anchorMatch(claim, data.commits);
    if (!anchors.commits.length && claim.prNumbers.length && data.resolvePr) {
      // Squash-without-suffix repos: ask the forge which commit merged the PR.
      for (const pr of claim.prNumbers.slice(0, 5)) {
        const sha = await data.resolvePr(pr);
        const commit = sha && data.commits.find((c) => sha.startsWith(c.sha) || c.sha.startsWith(sha));
        if (commit && !anchors.commits.includes(commit)) {
          anchors.commits.push(commit);
          anchors.viaPr.push(pr);
        }
      }
    }
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
      const methods: Evidence["methods"] = [anchors.viaPr.length ? "pr-anchor" : "sha-anchor"];
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
      // A note that restates its own commit subject says nothing about the
      // diff — both texts are written by the same hand, and agreeing with
      // yourself is not evidence. It anchors the claim (and raises its
      // priority for judging), it never settles it. The lexical bar is the
      // same one the unanchored path uses: a single identifier hit is a lead,
      // not proof.
      const strong = generated || lex.score >= 5;
      const detail = generated
        ? `auto-generated entry, title matches the squash commit`
        : `identifiers ${lex.matchedTerms.slice(0, 4).join(", ")} appear in its diff`;
      const gap =
        lex.score >= 2
          ? `only ${lex.matchedTerms.join(", ")} could be matched to its diff content`
          : bestSim >= 0.5
            ? `the claim restates the commit subject (${Math.round(bestSim * 100)}%), which asserts nothing about the diff`
            : `the claim text could not be matched to its diff content`;
      const fallback = strong
        ? {
            verdict: "verified" as const,
            confidence: 0.9,
            reasoning: `${anchorLabel} is in the release range (${anchors.commits[0].sha.slice(0, 10)}); ${detail}.`,
          }
        : {
            verdict: "partial" as const,
            confidence: 0.6,
            reasoning: `${anchorLabel} is in the release range, but ${gap}.`,
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
        // Changelog files stay out: the notes restating themselves is not
        // evidence, and a changelog-only commit must not self-verify.
        ranked = p.hunkPool
          .filter((f) => f.patch && !isChangelogPath(f.path))
          .slice(0, opts.maxHunks)
          .map((f) => ({ path: f.path, hunk: f.patch!, score: 0 }));
      }
      const promptFor = (
        hunks: Array<{ path: string; hunk: string }>,
        allowNeed: boolean,
        suffix = "",
      ): string =>
        buildJudgePrompt({
          repoLabel: data.repoLabel,
          baseRef: data.baseRef,
          headRef: data.headRef,
          section: p.claim.section,
          claimText: p.claim.text,
          hunks,
          commits: p.commits,
          allPaths: data.files.map((f) => f.path),
          allowNeed,
        }) + suffix;
      const hunks = capHunks(ranked, opts.maxEvidenceChars);
      try {
        let finalHunks = hunks;
        let response = parseJudgeResponse(await engine.judge(promptFor(hunks, true)));
        if ("need" in response) {
          // Bounded second retrieval round: hand over exactly the requested
          // full file diffs, then demand a verdict.
          const wanted = data.files.filter(
            (f) => f.patch && (response as { need: string[] }).need.includes(f.path),
          );
          finalHunks = capHunks(
            [
              ...wanted.map((f) => ({ path: f.path, hunk: f.patch! })),
              ...hunks,
            ],
            opts.maxEvidenceChars,
          );
          response = parseJudgeResponse(await engine.judge(promptFor(finalHunks, false)));
          if ("need" in response) throw new Error("judge kept requesting files");
        }
        let verdict = response;
        let escalated = false;
        const severe = verdict.verdict === "no-evidence" || verdict.verdict === "contradicted";
        // A security claim can hide under any section name ("Packaging
        // cleanup"): a "verified" also escalates when the evidence behind it
        // touches sensitive paths — install hooks, dependency manifests,
        // lockfiles, auth/crypto — not only when the claim says "security".
        const evidencePaths = [
          ...finalHunks.map((h) => h.path),
          ...verdict.files,
          ...p.evidence.files,
        ];
        const riskyVerified =
          verdict.verdict === "verified" &&
          (isSecuritySensitive(p.claim) ||
            evidencePaths.some((path) => sensitiveCategory(path) !== null));
        if (opts.escalateEngine && (severe || riskyVerified)) {
          // Release-critical decision from a weaker primary engine: a stronger
          // second engine reviews independently and its verdict wins.
          try {
            const second = parseJudgeResponse(
              await opts.escalateEngine.judge(
                promptFor(finalHunks, false, "\n(Escalation review by a second engine — judge independently.)"),
              ),
            );
            if (!("need" in second)) {
              verdict = second;
              escalated = true;
            }
          } catch {
            // keep the primary verdict if escalation fails
          }
        } else if (severe) {
          // No escalation engine: two more independent passes; the median
          // wins, so a single outlier cannot fail a release.
          const votes = [verdict];
          for (const pass of [2, 3]) {
            try {
              const vote = parseJudgeResponse(
                await engine.judge(
                  promptFor(finalHunks, false, `\n(Independent verification pass ${pass} — judge from scratch.)`),
                ),
              );
              if (!("need" in vote)) votes.push(vote);
            } catch {
              // a failed vote simply doesn't count
            }
          }
          verdict = medianVerdict(votes);
        }
        results.set(p.claim.id, {
          claim: p.claim,
          verdict: verdict.verdict,
          confidence: verdict.confidence,
          evidence: {
            ...p.evidence,
            files: [...new Set([...p.evidence.files, ...verdict.files])],
            methods: escalated
              ? [...p.evidence.methods, "llm", "escalated"]
              : [...p.evidence.methods, "llm"],
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
  /** Merge commits — bundles of other commits, neutral for coverage math. */
  mergeShas: Set<string>;
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

  // Cherry-pick workflows (patch-release branches) lose PR references in the
  // commit message — cover commits whose subject clearly restates a claim.
  const changeClaims = results
    .filter((r) => r.claim.kind === "change")
    .map((r) => r.claim.text.replace(/\bby @[\w-]+\b.*$/, ""));
  const subjectCovered = (subject: string): boolean =>
    changeClaims.some((text) => similarity(text, subject) >= 0.45);

  // A merge commit bundles commits that are themselves in the range — counting
  // it (and its aggregate diff) again would double every miss and every line.
  const nonMerge = data.commits.filter((c) => !/^Merge (pull request|branch|remote)/i.test(c.subject));
  const mergeShas = new Set(
    nonMerge.length ? data.commits.filter((c) => !nonMerge.includes(c)).map((c) => c.sha) : [],
  );

  const uncovered: UncoveredCommit[] = [];
  data.commits.forEach((commit, i) => {
    if (covered.has(commit.sha) || mergeShas.has(commit.sha)) return;
    const files = commitFileLists[i];
    // A commit mostly touching files already cited as evidence counts as covered.
    if (files.length) {
      const hit = files.filter((f) => evidenceFiles.has(f.path)).length;
      if (hit / files.length >= 0.5) {
        covered.add(commit.sha);
        return;
      }
    }
    if (subjectCovered(commit.subject)) {
      covered.add(commit.sha);
      return;
    }
    uncovered.push({
      commit,
      additions: files.reduce((s, f) => s + f.additions, 0),
      deletions: files.reduce((s, f) => s + f.deletions, 0),
      fileCount: files.length,
    });
  });
  uncovered.sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions));
  return { uncovered, coveredShas: covered, evidenceFiles, commitFiles, mergeShas };
}
