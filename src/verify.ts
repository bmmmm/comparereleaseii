// SPDX-License-Identifier: GPL-3.0-or-later
import { pooled, truncate } from "./util.ts";
import { anchorMatch, functionsOf, isChangelogPath, lexicalMatch, rankHunks, tokenize } from "./match.ts";
import { commitSurface } from "./substance.ts";
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
  BumpResolution,
  Claim,
  ClaimResult,
  Commit,
  DiffFile,
  Evidence,
  PinBump,
  ReleaseData,
  UncoveredCommit,
} from "./types.ts";

/** A bump claim the pin join settled, with the pin that settled it. */
export interface BumpAnchor {
  resolution: BumpResolution;
  pin: PinBump;
}

export interface VerifyOptions {
  judgeMode: "auto" | "all" | "off";
  engine: JudgeEngine | null;
  /** Stronger second engine for release-critical verdicts (local-model setups). */
  escalateEngine?: JudgeEngine | null;
  concurrency: number;
  maxHunks: number;
  maxEvidenceChars: number;
  /**
   * Bump claims the diff's own pin delta already answers, by claim id.
   * These never reach a judge — see the anchor stage in verifyClaims.
   */
  bumps?: Map<number, BumpAnchor>;
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
  "no-evidence": 2,
  contradicted: 3,
};

/**
 * Median by severity — one outlier vote cannot flip a release verdict. With
 * an even number of votes (a pass failed and did not count) the stricter of
 * the two middles wins: the whole point is that a lone lenient vote must not
 * carry, and picking the milder middle made a single one decisive — two
 * votes of [contradicted, verified] came out "verified".
 */
export function medianVerdict(votes: JudgeVerdict[]): JudgeVerdict {
  const sorted = [...votes].sort(
    (a, b) => SEVERITY[a.verdict] - SEVERITY[b.verdict],
  );
  return sorted[Math.ceil((sorted.length - 1) / 2)];
}

/**
 * The median, except that `contradicted` needs a second voter who saw the
 * same thing.
 *
 * It is the only verdict that both floors the score at 35 and raises a
 * critical flag, and the stricter-middle rule hands it to a single voice as
 * soon as one verification pass fails and leaves two votes. That is not
 * theoretical: GyulyVGC/sniffnet v1.5.1's "Persian (#1196)" came back
 * `partial`, `no-evidence` and `contradicted` across three identical runs,
 * and the third run alone dropped the release from 45 to 35. One dissenting
 * reading supports "unproven", which is what the next-strictest vote says.
 */
export function resolveVotes(votes: JudgeVerdict[]): JudgeVerdict {
  const median = medianVerdict(votes);
  if (median.verdict !== "contradicted") return median;
  const seconded = votes.filter((v) => v.verdict === "contradicted").length >= 2;
  if (seconded) return median;
  const others = votes
    .filter((v) => v.verdict !== "contradicted")
    .sort((a, b) => SEVERITY[b.verdict] - SEVERITY[a.verdict]);
  if (!others.length) return median;
  return {
    ...others[0],
    reasoning:
      `${others[0].reasoning} (One of ${votes.length} verification passes read this as contradicted, ` +
      "the rest did not — reported as the milder reading they agree on.)",
  };
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

  // Warm the source's per-commit and PR caches in parallel before the serial
  // loop below — its awaits then hit the cache (ReleaseData.commitFiles is
  // cached by contract). gh-backed sources pay one process spawn per call
  // (~0.35 s measured); paying them one claim at a time serialized the whole
  // anchor phase. Routing is untouched: same lookups, same decisions, warmed.
  const anchorShas = new Set<string>();
  const prefetchPrs = new Set<number>();
  for (const claim of claims) {
    if (claim.kind === "meta" || opts.bumps?.has(claim.id)) continue;
    const anchors = anchorMatch(claim, data.commits);
    if (anchors.commits.length) {
      for (const commit of anchors.commits) anchorShas.add(commit.sha);
    } else if (claim.prNumbers.length && data.resolvePr) {
      for (const pr of claim.prNumbers.slice(0, 5)) prefetchPrs.add(pr);
    }
  }
  if (data.resolvePr && prefetchPrs.size) {
    const resolvePr = data.resolvePr;
    const resolved = await pooled([...prefetchPrs], opts.concurrency, (n) =>
      resolvePr(n).catch(() => null),
    );
    for (const sha of resolved) {
      const commit =
        sha && data.commits.find((c) => sha.startsWith(c.sha) || c.sha.startsWith(sha));
      if (commit) anchorShas.add(commit.sha);
    }
  }
  if (anchorShas.size) {
    // Failures surface (or not) exactly where they did before — on the
    // loop's own call; the prefetch itself never kills the run.
    await pooled([...anchorShas], opts.concurrency, (sha) =>
      data.commitFiles(sha).catch(() => []),
    );
  }

  // One commit whose diff cannot be fetched must cost that claim its diff
  // evidence, not the whole run (computeCoverage already degrades this way).
  const fetchFailed = new Set<string>();
  const commitFilesOr = (sha: string): Promise<DiffFile[]> =>
    data.commitFiles(sha).catch((err: Error) => {
      if (!fetchFailed.has(sha)) {
        fetchFailed.add(sha);
        data.warnings.push(
          `Could not load the diff of ${sha.slice(0, 10)} (${err.message.split("\n")[0].slice(0, 100)}) — claims anchored to it are judged without it.`,
        );
      }
      return [];
    });

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

    // The pin anchor. A bump claim states a pin and a version, and the diff
    // carries the same pin and its own version — that is the whole question,
    // answered off the material both sides published, before any escalation
    // ladder runs. Sending it to a judge was strictly worse: it costs a call,
    // it varies between runs, and on this class it was measurably wrong.
    // Eight of the twelve contradicted claims in the corpus are bump claims,
    // and six of those are a note correctly describing one slice of a bump
    // the release aggregated.
    const bump = opts.bumps?.get(claim.id);
    if (bump) {
      const { resolution, pin } = bump;
      const moved = `the diff moves ${pin.name} ${pin.from} → ${pin.to} (${pin.file})`;
      const settled =
        resolution.status === "confirmed"
          ? { verdict: "verified" as const, confidence: 0.95, reasoning: `${moved}, the version this note names.` }
          : resolution.status === "overtaken"
            ? {
                verdict: "verified" as const,
                confidence: 0.85,
                reasoning:
                  `The note names ${resolution.claimed.to} and ${moved} — past it. ` +
                  "The release aggregates several bumps of this pin and the note describes one of them; " +
                  "the bump it states is in this diff.",
              }
            : {
                verdict: "contradicted" as const,
                confidence: 0.9,
                reasoning: `The note names ${resolution.claimed.to}, but ${moved}.`,
              };
      results.set(claim.id, {
        claim,
        ...settled,
        evidence: {
          commitShas: anchors.commits.map((c) => c.sha),
          files: [pin.file],
          matchedTerms: [resolution.claimed.name],
          methods: anchors.commits.length
            ? [anchors.viaPr.length ? "pr-anchor" : "sha-anchor", "pin-anchor"]
            : ["pin-anchor"],
        },
        judged: false,
        generated: isGeneratedEntry(claim, anchors.commits),
      });
      continue;
    }

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

    // Standing text only. A repeated line that points at a commit in THIS
    // range is an assertion about this release, and the publisher wrote both
    // sets of notes — "I said it last time too" cannot be what takes a claim
    // out of the check.
    if (claim.carriedOverFrom && !anchors.commits.length) {
      results.set(claim.id, {
        claim,
        verdict: "skipped",
        confidence: 1,
        evidence: { commitShas: [], files: [], matchedTerms: [], methods: ["none"] },
        reasoning: `Carried over verbatim from ${claim.carriedOverFrom} — describes the product, not this release.`,
        judged: false,
        generated: false,
      });
      continue;
    }

    if (anchors.commits.length) {
      const fileLists = await Promise.all(
        anchors.commits.map((c) => commitFilesOr(c.sha)),
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
        } else if (severe || riskyVerified) {
          // No escalation engine — and with the default --engine claude-cli,
          // --escalate auto builds none, so this is the common path, not the
          // fallback. It has to cover the rubber stamp too: a "verified" whose
          // evidence touches auth, crypto, dependencies or CI is the most
          // expensive verdict to get wrong, and it used to be the one verdict
          // nobody looked at twice.
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
          verdict = resolveVotes(votes);
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
          judgeFailed: true,
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
  const skipped = new Set(
    results.filter((r) => r.verdict === "skipped").map((r) => r.claim.id),
  );
  // Any anchor in any claim (incl. meta like "New Contributors") documents a
  // commit — except text carried over verbatim from the base release, which
  // by definition describes the product and not what shipped here. Letting it
  // count made a claim simultaneously "not this release's assertion" for
  // correctness and "documents this release's commit" for completeness.
  for (const claim of claims) {
    if (claim.carriedOverFrom && skipped.has(claim.id)) continue;
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
  // commit message. The retired rescue compared claim text to the commit
  // *subject* — claims describing claims, the founding thesis violated in
  // the reverse direction. Its first replacement (token overlap with the
  // commit's diff at the old 0.45 share) let fabricated notes buy coverage
  // by naming real components — measured +20 on the negative control. So
  // coverage is earned at the bar the forward direction calls strong
  // evidence: the claim's identifiers demonstrably appear in this commit's
  // own diff (lexicalMatch ≥ 5 — a code-span hit plus an identifier, or
  // three identifiers). Changelog files never count inside lexicalMatch,
  // so notes-only commits cannot cover themselves.
  const changeClaims = results
    .filter((r) => r.claim.kind === "change" && r.verdict !== "skipped")
    .map((r) => r.claim);
  const substanceCovered = (files: DiffFile[]): boolean =>
    changeClaims.some((claim) => lexicalMatch(claim, files).score >= 5);

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
    if (files.length && substanceCovered(files)) {
      covered.add(commit.sha);
      return;
    }
    uncovered.push({
      commit,
      additions: files.reduce((s, f) => s + f.additions, 0),
      deletions: files.reduce((s, f) => s + f.deletions, 0),
      fileCount: files.length,
      // What the commit's own diff touched — a silent change described by
      // observation, not only by the subject line it chose for itself.
      surface: commitSurface(files),
    });
  });
  uncovered.sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions));
  return { uncovered, coveredShas: covered, evidenceFiles, commitFiles, mergeShas };
}
