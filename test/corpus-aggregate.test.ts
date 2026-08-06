// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ClaimResult, Report, Verdict } from "../src/types.ts";
import {
  CLAIM_CLASSES,
  aggregate,
  claimClass,
  dedupeReports,
  judgeCalls,
  median,
} from "../scripts/corpus-aggregate.ts";

interface FakeOpts {
  repo: string;
  tag: string;
  verdicts?: Verdict[];
  overall?: number;
  label?: string;
  coverage?: number | null;
  flags?: Array<{ severity: string; kind: string }>;
  reverseChecked?: boolean;
}

function report(o: FakeOpts): Report {
  return {
    repoLabel: o.repo,
    headRef: o.tag,
    baseRef: "prev",
    reverseChecked: o.reverseChecked ?? true,
    results: (o.verdicts ?? []).map((v, i) => ({ claim: { id: i }, verdict: v, judged: true })),
    metrics: {
      scores: { overall: o.overall ?? 80, label: o.label ?? "solid" },
      flags: o.flags ?? [],
      churnCoveredRatio: o.coverage === undefined ? 0.5 : o.coverage,
    },
  } as unknown as Report;
}

test("the same release under both path layouts counts once", () => {
  // A watch home written by two tool versions holds owner/repo/tag.json and
  // owner_repo/tag.json for the same release. Counting files would double
  // every claim and every flag in the corpus.
  const dup = { repo: "o/r", tag: "v1.0.0", verdicts: ["verified", "contradicted"] as Verdict[] };
  const all = dedupeReports([report(dup), report(dup), report({ repo: "o/r", tag: "v1.1.0" })]);

  assert.equal(all.length, 2);
  const s = aggregate(all);
  assert.equal(s.releases, 2);
  assert.equal(s.repos, 1);
  assert.equal(s.claims, 2, "claims of the duplicated release must not be counted twice");
  assert.equal(s.verdicts.verified, 1);
  assert.equal(s.verdicts.contradicted, 1);
});

test("dedupe keeps a stable winner and drops reports that carry no metrics", () => {
  const shaped = report({ repo: "o/r", tag: "v1", overall: 42 });
  const broken = { repoLabel: "o/r", headRef: "v2" } as unknown as Report;
  const all = dedupeReports([shaped, broken]);

  assert.deepEqual(
    all.map((r) => r.headRef),
    ["v1"],
  );
});

test("critical flags and contradictions are counted per release, not per occurrence", () => {
  const s = aggregate([
    report({
      repo: "a/a",
      tag: "v1",
      verdicts: ["contradicted", "contradicted", "verified"],
      flags: [
        { severity: "critical", kind: "opaque-change" },
        { severity: "critical", kind: "contradicted-claim" },
        { severity: "warn", kind: "opaque-change" },
      ],
    }),
    report({ repo: "b/b", tag: "v1", verdicts: ["verified"], flags: [{ severity: "warn", kind: "opaque-change" }] }),
  ]);

  assert.equal(s.releasesWithCriticalFlag, 1, "two critical flags in one release are one affected release");
  assert.equal(s.releasesWithContradictedClaim, 1);
  assert.equal(s.verdicts.contradicted, 2, "the claim tally still counts every contradiction");
  assert.equal(s.flagKinds["warn/opaque-change"], 2);
  assert.equal(s.flagKinds["critical/opaque-change"], 1);
});

test("coverage skips releases that have no ratio instead of reading them as zero", () => {
  // `--no-reverse` and unverifiable releases carry null. Treating that as 0 %
  // would invent undocumented change out of a measurement that never ran.
  const s = aggregate([
    report({ repo: "a/a", tag: "v1", coverage: 1 }),
    report({ repo: "a/a", tag: "v2", coverage: 0.5 }),
    report({ repo: "a/a", tag: "v3", coverage: null }),
  ]);

  assert.equal(s.churnCoveredRatio.releases, 2);
  assert.equal(s.churnCoveredRatio.median, 0.75);
  assert.equal(s.churnCoveredRatio.mean, 0.75);
  assert.equal(s.releases, 3);
});

test("median averages the middle pair on an even count", () => {
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([]), null);
});

/** A stored result, shaped the way a report on disk carries one. */
function result(over: Partial<ClaimResult> & { text?: string; methods?: string[] } = {}): ClaimResult {
  const { text, methods, ...rest } = over;
  return {
    claim: {
      id: 0,
      section: "What's Changed",
      text: text ?? "Rewrote the retry loop",
      kind: "change",
      prNumbers: [],
      shas: [],
      advisories: [],
      codeSpans: [],
    },
    verdict: "verified",
    confidence: 0.9,
    evidence: { commitShas: [], files: [], matchedTerms: [], methods: (methods ?? ["none"]) as never },
    reasoning: "",
    judged: false,
    generated: false,
    ...rest,
  } as ClaimResult;
}

// The classes are what a deterministic rule could be built on: what the diff
// already established before anything was asked. They must partition the
// claims, or the bill has a remainder nobody accounts for.
test("every claim lands in exactly one class, and the classes are the routes", () => {
  assert.equal(claimClass(result({ claim: { kind: "meta" } as never })), "meta");
  assert.equal(
    claimClass(result({ text: "chore(deps): bump actions/cache from 5.0.3 to 5.0.4" })),
    "bump",
  );
  // A generated entry is boilerplate true by construction — but a bump claim
  // that also reads as generated is still a bump: the pin settles it.
  assert.equal(claimClass(result({ generated: true })), "generated");
  assert.equal(
    claimClass(result({ generated: true, text: "Bump actions/cache from 5.0.3 to 5.0.4" })),
    "bump",
  );
  assert.equal(claimClass(result({ methods: ["sha-anchor", "lexical"] })), "anchored-strong");
  assert.equal(claimClass(result({ methods: ["pr-anchor"] })), "anchored-weak");
  assert.equal(claimClass(result({ methods: ["lexical"] })), "unanchored-lexical");
  assert.equal(claimClass(result({ methods: ["none"] })), "unanchored-none");
  // A report written before evidence carried methods still classifies.
  assert.equal(claimClass({ claim: { id: 0 }, verdict: "verified" } as ClaimResult), "unanchored-none");
});

// The call count is a floor and says so; a number presented as the bill when
// it is a lower bound would make an expensive class look affordable.
test("judge calls are counted from what the report actually records", () => {
  assert.equal(judgeCalls(result()), 0, "a claim the diff settled cost nothing");
  assert.equal(judgeCalls(result({ judged: true })), 1);
  assert.equal(
    judgeCalls(result({ judged: true, methods: ["sha-anchor", "llm", "escalated"] })),
    2,
    "a second engine reviewed",
  );
  assert.equal(
    judgeCalls(result({ judged: true, votes: ["no-evidence", "partial", "partial"] })),
    3,
    "the first vote IS the original judgement, the other two are extra calls",
  );
  assert.equal(
    judgeCalls(result({ judged: true, surplus: [{ description: "x", file: "a.ts", notable: true }] })),
    2,
    "the surplus audit of a vague claim is a call too",
  );
  // The judge was asked and could not answer: the call still happened.
  assert.equal(judgeCalls(result({ judged: false, judgeFailed: true })), 1);
});

test("the judge bill divides the corpus without a remainder, and names the variance", () => {
  const r = report({ repo: "o/r", tag: "v1" });
  r.results = [
    result({ text: "bump actions/cache from 5.0.3 to 5.0.4", verdict: "contradicted", judged: true }),
    result({ generated: true, verdict: "verified" }),
    result({ methods: ["sha-anchor", "lexical"], judged: true, verdict: "verified" }),
    // The expensive shape: judged, sent through the verification passes, and
    // the passes disagreed — the same engine answering the same prompt twice.
    result({
      methods: ["pr-anchor", "llm"],
      judged: true,
      verdict: "partial",
      votes: ["partial", "no-evidence", "partial"],
    }),
    result({ methods: ["pr-anchor", "llm"], judged: true, votes: ["verified", "verified"] }),
    result({ claim: { kind: "meta" } as never, verdict: "skipped" }),
  ];

  const s = aggregate([r]);
  const bill = s.judgeBill;
  const summed = Object.values(bill.byClass).reduce((n, c) => n + c.claims, 0);
  assert.equal(summed, s.claims, "the classes partition the claims");
  assert.equal(
    Object.values(bill.byClass).reduce((n, c) => n + c.calls, 0),
    bill.calls,
    "…and the per-class calls sum to the total",
  );

  assert.equal(bill.byClass["bump"].calls, 1);
  assert.equal(bill.byClass["generated"].calls, 0, "boilerplate never reached a judge");
  assert.equal(bill.byClass["meta"].calls, 0);
  const weak = bill.byClass["anchored-weak"];
  assert.equal(weak.claims, 2);
  assert.equal(weak.calls, 5, "three passes plus two");
  assert.equal(weak.secondLook, 2);
  assert.equal(weak.split, 1, "only the disagreeing one counts as variance");
  assert.deepEqual(weak.verdicts, { partial: 1, verified: 1 });

  // Every class the renderer knows is a class the aggregator can produce —
  // a name in one list and not the other prints an empty row or drops a class.
  for (const cls of Object.keys(bill.byClass)) {
    assert.ok(CLAIM_CLASSES.includes(cls as never), `${cls} is missing from CLAIM_CLASSES`);
  }
});

test("bump claims are counted apart — and read off the text when the report predates the trait", () => {
  // The whole point of the number is that it predates the fix, so a watch
  // home full of older reports (which carry no `bump` trait) has to count.
  const legacy = report({ repo: "o/r", tag: "v1.0.0", verdicts: ["contradicted", "verified"] });
  legacy.results[0].claim.text = "chore(deps): bump actions/cache from 5.0.3 to 5.0.4";
  legacy.results[1].claim.text = "Rewrote the retry loop";

  const s = aggregate([legacy]);
  assert.equal(s.bumps.claims, 1);
  assert.equal(s.bumps.verdicts.contradicted, 1);
  assert.equal(s.bumps.otherVerdicts.verified, 1);
  assert.equal(s.bumps.verdicts.verified, undefined, "a non-bump claim must not land in the class");
  // The two buckets partition the claims — a rate computed off them is honest.
  assert.equal(s.bumps.claims + (s.bumps.otherVerdicts.verified ?? 0), s.claims);
});
