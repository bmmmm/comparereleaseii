// SPDX-License-Identifier: GPL-3.0-or-later
import { pooled, truncate } from "./util.ts";
import {
  anchorMatch,
  functionsOf,
  isChangelogPath,
  lexicalMatch,
  rankHunks,
  tokenize,
  type AnchorMatch,
} from "./match.ts";
import { commitSurface } from "./substance.ts";
import { pinBumps, sameName } from "./pins.ts";
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
  /**
   * Bump claims the diff's own pin delta already answers, by claim id.
   * These never reach a judge — see the anchor stage in verifyClaims.
   */
  bumps?: Map<number, BumpResolution>;
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

/** An entry the diff can neither confirm nor refute — recorded, not graded. */
function skipped(claim: Claim, reasoning: string): ClaimResult {
  return {
    claim,
    verdict: "skipped",
    confidence: 1,
    evidence: { commitShas: [], files: [], matchedTerms: [], methods: ["none"] },
    reasoning,
    judged: false,
    generated: false,
  };
}

/**
 * Warm the source's per-commit and PR caches in parallel before the serial
 * route loop below — its awaits then hit the cache (ReleaseData.commitFiles is
 * cached by contract). gh-backed sources pay one process spawn per call
 * (~0.35 s measured); paying them one claim at a time serialized the whole
 * anchor phase. Routing is untouched: same lookups, same decisions, warmed.
 */
async function prefetchAnchorDiffs(
  data: ReleaseData,
  claims: Claim[],
  concurrency: number,
): Promise<void> {
  const anchorShas = new Set<string>();
  const prefetchPrs = new Set<number>();
  for (const claim of claims) {
    if (claim.kind === "meta") continue;
    const anchors = anchorMatch(claim, data.commits);
    if (anchors.commits.length) {
      for (const commit of anchors.commits) anchorShas.add(commit.sha);
    } else if (claim.prNumbers.length && data.resolvePr) {
      for (const pr of claim.prNumbers.slice(0, 5)) prefetchPrs.add(pr);
    }
  }
  if (data.resolvePr && prefetchPrs.size) {
    const resolvePr = data.resolvePr;
    const resolved = await pooled([...prefetchPrs], concurrency, (n) =>
      resolvePr(n).catch(() => null),
    );
    for (const sha of resolved) {
      const commit =
        sha && data.commits.find((c) => sha.startsWith(c.sha) || c.sha.startsWith(sha));
      if (commit) anchorShas.add(commit.sha);
    }
  }
  if (!anchorShas.size) return;
  // Failures surface (or not) exactly where they did before — on the loop's
  // own call; the prefetch itself never kills the run.
  await pooled([...anchorShas], concurrency, (sha) => data.commitFiles(sha).catch(() => []));
}

/**
 * `commitFiles` that degrades instead of throwing: one commit whose diff
 * cannot be fetched must cost that claim its diff evidence, not the whole run
 * (computeCoverage already degrades this way). Each commit is warned about once.
 */
function degradingCommitFiles(data: ReleaseData): (sha: string) => Promise<DiffFile[]> {
  const reported = new Set<string>();
  return (sha) =>
    data.commitFiles(sha).catch((err: Error) => {
      if (!reported.has(sha)) {
        reported.add(sha);
        data.warnings.push(
          `Could not load the diff of ${sha.slice(0, 10)} (${err.message.split("\n")[0].slice(0, 100)}) — claims anchored to it are judged without it.`,
        );
      }
      return [];
    });
}

/**
 * Squash-without-suffix repos: the note names a PR that no commit message
 * mentions, so ask the forge which commit merged it. Extends `anchors` in
 * place — a claim that gains an anchor here takes the anchored route.
 */
async function anchorViaPr(claim: Claim, anchors: AnchorMatch, data: ReleaseData): Promise<void> {
  if (!data.resolvePr) return;
  for (const pr of claim.prNumbers.slice(0, 5)) {
    const sha = await data.resolvePr(pr);
    const commit = sha && data.commits.find((c) => sha.startsWith(c.sha) || c.sha.startsWith(sha));
    if (commit && !anchors.commits.includes(commit)) {
      anchors.commits.push(commit);
      anchors.viaPr.push(pr);
    }
  }
}

/**
 * The pin anchor. A bump claim states a pin and a version, and the diff
 * carries the same pin and its own version — that is the whole question,
 * answered off the material both sides published, before any escalation
 * ladder runs. Sending it to a judge was strictly worse: it costs a call,
 * it varies between runs, and on this class it was measurably wrong.
 * Eight of the twelve contradicted claims in the corpus are bump claims,
 * and six of those are a note correctly describing one slice of a bump
 * the release aggregated.
 *
 * Null when the diff moved no matching pin — that claim is judged like any other.
 */
function settleBump(claim: Claim, bump: BumpResolution, anchors: AnchorMatch): ClaimResult | null {
  const { claimed, observed } = bump;
  if (!observed) return null;
  const where = observed.viaCommit
    ? `the commit this note names moves ${claimed.name} ${observed.from} → ${observed.to} (${observed.file})`
    : `the diff moves ${claimed.name} ${observed.from} → ${observed.to} (${observed.file})`;
  const settled =
    bump.status === "confirmed"
      ? { verdict: "verified" as const, confidence: 0.95, reasoning: `${where}, the version this note names.` }
      : bump.status === "overtaken"
        ? {
            verdict: "verified" as const,
            confidence: 0.85,
            reasoning:
              `The note names ${claimed.to} and ${where} — past it. ` +
              "The release aggregates several bumps of this pin and the note describes one of them; " +
              "the bump it states is in this diff.",
          }
        : {
            verdict: "contradicted" as const,
            confidence: 0.9,
            reasoning: `The note names ${claimed.to}, but ${where}.`,
          };
  return {
    claim,
    ...settled,
    evidence: {
      commitShas: anchors.commits.map((c) => c.sha),
      files: [observed.file],
      matchedTerms: [claimed.name],
      methods: anchors.commits.length
        ? [anchors.viaPr.length ? "pr-anchor" : "sha-anchor", "pin-anchor"]
        : ["pin-anchor"],
    },
    judged: false,
    generated: isGeneratedEntry(claim, anchors.commits),
  };
}

/** What a route establishes on its own — the judge decides whether it stands. */
type Route = Omit<Pending, "claim" | "commits">;

/**
 * A claim that names a commit in the release range, weighed against that
 * commit's own diff.
 *
 * A note that restates its own commit subject says nothing about the diff —
 * both texts are written by the same hand, and agreeing with yourself is not
 * evidence. It anchors the claim (and raises its priority for judging), it
 * never settles it. The lexical bar is the same one the unanchored route
 * uses: a single identifier hit is a lead, not proof.
 */
function routeAnchored(claim: Claim, anchors: AnchorMatch, pool: DiffFile[]): Route {
  const generated = isGeneratedEntry(claim, anchors.commits);
  const lex = lexicalMatch(claim, pool);
  const bestSim = Math.max(...anchors.commits.map((c) => similarity(coreText(claim), c.subject)));
  const methods: Evidence["methods"] = [anchors.viaPr.length ? "pr-anchor" : "sha-anchor"];
  if (generated) methods.push("generated");
  if (lex.score > 0) methods.push("lexical");
  const anchorLabel = anchors.viaPr.length
    ? `PR #${anchors.viaPr.join(", #")}`
    : `commit ${anchors.viaSha.join(", ")}`;
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
  return {
    evidence: {
      commitShas: anchors.commits.map((c) => c.sha),
      files: lex.files.map((f) => f.path),
      matchedTerms: lex.matchedTerms,
      methods,
      functions: functionsOf(pool),
    },
    hunkPool: pool,
    generated,
    fallback: strong
      ? {
          verdict: "verified",
          confidence: 0.9,
          reasoning: `${anchorLabel} is in the release range (${anchors.commits[0].sha.slice(0, 10)}); ${detail}.`,
        }
      : {
          verdict: "partial",
          confidence: 0.6,
          reasoning: `${anchorLabel} is in the release range, but ${gap}.`,
        },
  };
}

/**
 * No usable anchor (or a referenced PR not findable in commit messages): fall
 * back to lexical evidence over the whole diff.
 */
function routeUnanchored(claim: Claim, data: ReleaseData): Route {
  const lex = lexicalMatch(claim, data.files);
  const anchorNote = claim.prNumbers.length
    ? `Referenced PR #${claim.prNumbers.join(", #")} matches no commit message in the range. `
    : "";
  return {
    evidence: {
      commitShas: [],
      files: lex.files.map((f) => f.path),
      matchedTerms: lex.matchedTerms,
      methods: lex.score > 0 ? ["lexical"] : ["none"],
      functions: functionsOf(lex.files),
    },
    hunkPool: data.files,
    generated: false,
    fallback:
      lex.score >= 5
        ? {
            verdict: "verified",
            confidence: 0.8,
            reasoning: `${anchorNote}Identifiers ${lex.matchedTerms.slice(0, 5).join(", ")} all appear in the diff (${lex.files.length} file(s)).`,
          }
        : lex.score >= 2
          ? {
              verdict: "partial",
              confidence: 0.55,
              reasoning: `${anchorNote}Some identifiers (${lex.matchedTerms.join(", ")}) appear in the diff, but the match is weak.`,
            }
          : {
              verdict: "no-evidence",
              confidence: 0.5,
              reasoning: `${anchorNote}No identifier from the claim appears in the diff.`,
            },
  };
}

type Hunks = Array<{ path: string; hunk: string }>;

/**
 * Which hunks the judge is shown for one claim. One function because
 * `--add-golden` lifts a real claim into the golden set, and a fixture built
 * from a different selection than production makes would freeze a question
 * the tool never asks.
 */
function selectHunks(
  claim: Claim,
  route: Pick<Route, "hunkPool" | "evidence">,
  opts: { maxHunks: number; maxEvidenceChars: number },
): Hunks {
  let ranked = rankHunks(claim, route.hunkPool, opts.maxHunks);
  if (!ranked.length && route.evidence.commitShas.length) {
    // Vague anchored claim ("Updates and fixes"): no token overlap to rank
    // by, but the linked commit's own diff IS the evidence — send its head.
    // Changelog files stay out: the notes restating themselves is not
    // evidence, and a changelog-only commit must not self-verify.
    ranked = route.hunkPool
      .filter((f) => f.patch && !isChangelogPath(f.path))
      .slice(0, opts.maxHunks)
      .map((f) => ({ path: f.path, hunk: f.patch!, score: 0 }));
  }
  return capHunks(ranked, opts.maxEvidenceChars);
}

/**
 * Everything the judge would be handed about one claim, without asking it
 * anything — the same routing and the same hunk selection `verifyClaims`
 * makes. The report stores verdicts, not the material they were reached on,
 * so lifting a misjudgement into the golden set has to reproduce that
 * material from the release itself.
 */
export async function claimEvidence(
  data: ReleaseData,
  claim: Claim,
  opts: { maxHunks: number; maxEvidenceChars: number },
): Promise<{ hunks: Hunks; allPaths: string[] }> {
  const anchors = anchorMatch(claim, data.commits);
  if (!anchors.commits.length && claim.prNumbers.length) await anchorViaPr(claim, anchors, data);
  const commitFilesOr = degradingCommitFiles(data);
  const route = anchors.commits.length
    ? routeAnchored(
        claim,
        anchors,
        (await Promise.all(anchors.commits.map((c) => commitFilesOr(c.sha)))).flat(),
      )
    : routeUnanchored(claim, data);
  return {
    hunks: selectHunks(claim, route, opts),
    allPaths: data.files.map((f) => f.path),
  };
}

/** Builds the judge prompt for a given evidence set — bound to one claim. */
type PromptFor = (hunks: Hunks, allowNeed: boolean, suffix?: string) => string;

/**
 * One judge call plus, at most, one bounded second retrieval round: when the
 * judge answers "I need these files", hand over exactly those full file diffs
 * and demand a verdict. A judge that keeps asking is a failed judgement.
 */
async function judgeWithRetrieval(
  engine: JudgeEngine,
  promptFor: PromptFor,
  hunks: Hunks,
  data: ReleaseData,
  maxEvidenceChars: number,
): Promise<{ verdict: JudgeVerdict; hunks: Hunks }> {
  const response = parseJudgeResponse(await engine.judge(promptFor(hunks, true)));
  if (!("need" in response)) return { verdict: response, hunks };
  const wanted = data.files.filter((f) => f.patch && response.need.includes(f.path));
  const finalHunks = capHunks(
    [...wanted.map((f) => ({ path: f.path, hunk: f.patch! })), ...hunks],
    maxEvidenceChars,
  );
  const second = parseJudgeResponse(await engine.judge(promptFor(finalHunks, false)));
  if ("need" in second) throw new Error("judge kept requesting files");
  return { verdict: second, hunks: finalHunks };
}

/**
 * A second look at the verdicts that are most expensive to get wrong. With an
 * escalation engine, a stronger second engine reviews independently and its
 * verdict wins. Without one — and with the default `--engine claude-cli`,
 * `--escalate auto` builds none, so this is the common path, not the fallback
 * — the same engine votes twice more and the median settles it.
 */
async function reviewSevere(
  engine: JudgeEngine,
  escalateEngine: JudgeEngine | null | undefined,
  promptFor: PromptFor,
  hunks: Hunks,
  verdict: JudgeVerdict,
): Promise<{ verdict: JudgeVerdict; escalated: boolean; votes: JudgeVerdict[] | null }> {
  if (escalateEngine) {
    try {
      const second = parseJudgeResponse(
        await escalateEngine.judge(
          promptFor(hunks, false, "\n(Escalation review by a second engine — judge independently.)"),
        ),
      );
      if (!("need" in second)) return { verdict: second, escalated: true, votes: null };
    } catch {
      // keep the primary verdict if escalation fails
    }
    return { verdict, escalated: false, votes: null };
  }
  const votes = [verdict];
  for (const pass of [2, 3]) {
    try {
      const vote = parseJudgeResponse(
        await engine.judge(
          promptFor(hunks, false, `\n(Independent verification pass ${pass} — judge from scratch.)`),
        ),
      );
      if (!("need" in vote)) votes.push(vote);
    } catch {
      // a failed vote simply doesn't count
    }
  }
  return { verdict: resolveVotes(votes), escalated: false, votes };
}

/**
 * Whether this verdict gets the second look. Severe verdicts always do, and so
 * does a "verified" whose evidence touches sensitive paths — install hooks,
 * dependency manifests, lockfiles, auth/crypto. A security claim can hide
 * under any section name ("Packaging cleanup"), and the rubber stamp is the
 * most expensive verdict to get wrong: it used to be the one nobody looked at
 * twice.
 */
function needsSecondLook(claim: Claim, verdict: JudgeVerdict, evidencePaths: string[]): boolean {
  if (verdict.verdict === "no-evidence" || verdict.verdict === "contradicted") return true;
  return (
    verdict.verdict === "verified" &&
    (isSecuritySensitive(claim) || evidencePaths.some((path) => sensitiveCategory(path) !== null))
  );
}

/** The commit subjects closest to an unanchored claim — context for the judge. */
function relatedCommits(claim: Claim, commits: Commit[]): Commit[] {
  return commits
    .map((c) => ({ c, s: similarity(coreText(claim), c.subject) }))
    .filter((x) => x.s > 0.3)
    .sort((a, b) => b.s - a.s)
    .slice(0, 3)
    .map((x) => x.c);
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

  await prefetchAnchorDiffs(data, claims, opts.concurrency);
  const commitFilesOr = degradingCommitFiles(data);

  for (const claim of claims) {
    if (claim.kind === "meta") {
      results.set(claim.id, skipped(claim, "Informational entry, nothing to verify against the diff."));
      continue;
    }

    const anchors = anchorMatch(claim, data.commits);
    if (!anchors.commits.length && claim.prNumbers.length) {
      await anchorViaPr(claim, anchors, data);
    }

    // Standing text only. A repeated line that points at a commit in THIS
    // range is an assertion about this release, and the publisher wrote both
    // sets of notes — "I said it last time too" cannot be what takes a claim
    // out of the check.
    if (claim.carriedOverFrom && !anchors.commits.length) {
      results.set(
        claim.id,
        skipped(
          claim,
          `Carried over verbatim from ${claim.carriedOverFrom} — describes the product, not this release.`,
        ),
      );
      continue;
    }

    const bump = opts.bumps?.get(claim.id);
    const settledBump = bump && settleBump(claim, bump, anchors);
    if (settledBump) {
      results.set(claim.id, settledBump);
      continue;
    }

    let route: Route;
    if (anchors.commits.length) {
      const fileLists = await Promise.all(anchors.commits.map((c) => commitFilesOr(c.sha)));
      const pool = fileLists.flat();
      route = routeAnchored(claim, anchors, pool);
      // Reverse-direction audit: what does this vague note hide?
      if (useJudge && isVagueClaim(claim)) surplusQueue.push({ claim, pool });
    } else {
      route = routeUnanchored(claim, data);
    }

    // Both routes share one rule: anything the diff does not settle outright
    // goes to the judge, and `--judge all` sends everything.
    if (useJudge && (opts.judgeMode === "all" || route.fallback.verdict !== "verified")) {
      pending.push({
        claim,
        ...route,
        commits: anchors.commits.length ? anchors.commits : relatedCommits(claim, data.commits),
      });
    } else {
      results.set(claim.id, {
        claim,
        ...route.fallback,
        evidence: route.evidence,
        judged: false,
        generated: route.generated,
      });
    }
  }

  if (pending.length && opts.engine) {
    const engine = opts.engine;
    await pooled(pending, opts.concurrency, async (p) => {
      const selected = selectHunks(p.claim, p, opts);
      const promptFor: PromptFor = (hunks, allowNeed, suffix = "") =>
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
      try {
        const judged = await judgeWithRetrieval(
          engine,
          promptFor,
          selected,
          data,
          opts.maxEvidenceChars,
        );
        const finalHunks = judged.hunks;
        let verdict = judged.verdict;
        let escalated = false;
        let cast: JudgeVerdict[] | null = null;
        const evidencePaths = [
          ...finalHunks.map((h) => h.path),
          ...verdict.files,
          ...p.evidence.files,
        ];
        if (needsSecondLook(p.claim, verdict, evidencePaths)) {
          const review = await reviewSevere(
            engine,
            opts.escalateEngine,
            promptFor,
            finalHunks,
            verdict,
          );
          verdict = review.verdict;
          escalated = review.escalated;
          cast = review.votes;
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
          ...(cast ? { votes: cast.map((v) => v.verdict) } : {}),
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
  /**
   * Commits whose own diff could not be fetched. They are NOT the same as
   * commits that changed nothing, and the difference decides a score: an
   * empty file list contributes zero churn, so treating a failed fetch as
   * one drops that commit out of the coverage ratio's denominator and the
   * release reads as better documented the less of it could be read. Seen
   * for real on 2026-08-06 — 14 commit diffs lost to a rate limit took
   * `GyulyVGC/sniffnet@v1.5.1` from completeness 1 to 100.
   */
  unreadableShas: Set<string>;
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

  // A bump claim's evidence is `go.mod`, `go.sum`, `modules.txt` — not because
  // the claim describes those files but because that is where the version
  // line sits. As a fingerprint it is worthless in both directions: pooled
  // into one union it covers any commit that happens to touch a manifest
  // (opencloud@v7.1.0 kept a test fix documented off a claim about
  // `golang.org/x/text`), and taken per claim it covers almost nothing,
  // because one bump claim owns one line of a file the commit changes
  // wholesale. So bump claims leave the file-majority route entirely and get
  // the route that fits them, below: the pin they name.
  const isBumpClaim = (r: ClaimResult): boolean =>
    r.claim.bump !== undefined && r.claim.kind === "change";
  const evidenceFiles = new Set(
    results
      .filter((r) => (r.verdict === "verified" || r.verdict === "partial") && !isBumpClaim(r))
      .flatMap((r) => r.evidence.files),
  );
  const bumpClaims = results.filter(
    (r) => (r.verdict === "verified" || r.verdict === "partial") && isBumpClaim(r),
  );

  const unreadableShas = new Set<string>();
  const commitFileLists = await pooled(data.commits, 6, (c) =>
    data.commitFiles(c.sha).catch(() => {
      unreadableShas.add(c.sha);
      return [] as DiffFile[];
    }),
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
  // own diff (lexicalMatch ≥ 5 — an identifier-shaped code span plus one
  // more term, or three terms; backticks around a word buy nothing here
  // either). Changelog files never count inside lexicalMatch, so notes-only
  // commits cannot cover themselves.
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
    // A bump claim documents the commits that move the pin it names — the
    // same join that settles its verdict, spent on coverage. Version numbers
    // deliberately do not have to agree: a release aggregating several bumps
    // of one dependency has a note for the last of them, and the earlier
    // commits are still the work that note describes.
    if (bumpClaims.length && files.length) {
      const pins = pinBumps(files);
      if (
        pins.length &&
        bumpClaims.some((r) => pins.some((p) => sameName(r.claim.bump!.name, p.name)))
      ) {
        covered.add(commit.sha);
        return;
      }
    }
    // A commit mostly touching files already cited as evidence counts as
    // covered. The route is claim-independent — the union grows with the
    // number of claims — and that cost 4 of 34 `omission` mutations until the
    // bump claims left it (above). Two of those four are still open
    // (`opencloud@v7.3.0`, `opencloud-eu/web@v7.0.0`), and the two repairs
    // this comment used to propose are both measured and rejected, on the
    // 55-release corpus, 2026-08-06:
    //
    //   majority inside ONE claim's evidence   omission 30/34, completeness −8
    //   discount files many commits touch      omission 30/34, completeness +9
    //   the same by file type, incl. vendor/   omission 33/34, completeness −139
    //
    // The third "works" by counting honestly documented dependency commits as
    // undocumented — opencloud@v7.1.0 falls 96 → 1, and every commit it newly
    // condemns is a bump whose note names it. Whatever closes the last two has
    // to keep that in view, and it is not a bigger number here: raising 0.5
    // was measured and rejected before any of these.
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
  return { uncovered, coveredShas: covered, evidenceFiles, commitFiles, mergeShas, unreadableShas };
}
