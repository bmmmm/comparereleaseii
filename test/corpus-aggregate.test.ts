// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Report, Verdict } from "../src/types.ts";
import { aggregate, dedupeReports, median } from "../scripts/corpus-aggregate.ts";

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
