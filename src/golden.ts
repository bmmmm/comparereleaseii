// SPDX-License-Identifier: GPL-3.0-or-later
// Lifting a real misjudgement into the golden set.
//
// Every golden case used to be invented by hand, and a wrong verdict noticed
// in the field had no way back into the tool: the issue template ends at a
// human. This is the way back. The human decides what the verdict should have
// been — that is the point of the command, not a limitation of it — and from
// then on that release's claim is a regression test the judge calibration
// runs against material that actually occurred.
//
// The report stores verdicts, not the hunks they were reached on, so the
// release has to be loaded again and the evidence rebuilt through the very
// same selection production makes (`claimEvidence`). A fixture assembled any
// other way would freeze a question the tool never asks.
import { readFile, writeFile } from "node:fs/promises";
import {
  FIELD_CATEGORY,
  GOLDEN_PATH,
  GOLDEN_CATEGORIES,
  type GoldenCase,
} from "./calibrate.ts";
import { componentLoader } from "./check.ts";
import { loadLocalRelease } from "./sources/local.ts";
import { claimEvidence } from "./verify.ts";
import type { ClaimResult, JudgedVerdict, ReleaseData, Report } from "./types.ts";

/** The verdicts a person can assert about a claim. `skipped` is bookkeeping
 * the pipeline assigns itself, so nobody grades a judge on it. */
export const GOLDEN_VERDICTS: JudgedVerdict[] = [
  "verified",
  "partial",
  "no-evidence",
  "contradicted",
];

export interface AddGoldenOptions {
  /** A `--json` report written by any earlier check. */
  reportPath: string;
  claimId: number;
  verdict: string;
  /** Why this verdict is right — free text, stored with the case. */
  why?: string;
  /** Gate category. Absent means `field` — reported, never gating. */
  category?: string;
  /** Where to write. Defaults to the set `--calibrate` reads. */
  goldenFile?: string;
  /** Clone to reload the release from, for reports that name no web origin
   * (a `--local` check records no linkBase — nothing else knows where it was). */
  local?: string;
  /** Injection seam for tests; production reloads the real release. */
  load?: (report: Report) => Promise<ReleaseData>;
}

/** The same evidence budget a real check judges under — a case graded on more
 * material than production hands over measures nothing production does. */
const EVIDENCE = { maxHunks: 6, maxEvidenceChars: 20000 };

function parseReport(raw: string, path: string): Report {
  let report: unknown;
  try {
    report = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${path} is not JSON (${(err as Error).message}) — pass a --json report.`);
  }
  const r = report as Partial<Report>;
  if (!Array.isArray(r.results) || !r.headRef || !r.baseRef || !r.repoLabel) {
    throw new Error(
      `${path} is not a comparereleaseii report — it needs results, repoLabel, baseRef and headRef. Write one with --json.`,
    );
  }
  return r as Report;
}

/**
 * Reload the release the report describes. A GitHub or forge report carries
 * its own web origin and needs nothing else; a `--local` report carries none,
 * because a path on someone's disk is not a fact about the release.
 */
async function reloadRelease(report: Report, local?: string): Promise<ReleaseData> {
  if (local) {
    return loadLocalRelease({ repo: local, head: report.headRef, base: report.baseRef });
  }
  if (!report.linkBase) {
    throw new Error(
      `${report.repoLabel} ${report.headRef} was checked from a local clone, so the report names no repository to reload — pass --local <path> to the same clone.`,
    );
  }
  const { data } = await componentLoader(report.linkBase, {
    tag: report.headRef,
    base: report.baseRef,
  });
  return data;
}

/**
 * Whether this case looks like security material — printed as a suggestion,
 * never applied. Promoting a lifted case into a gate category is a decision
 * about the whole tool's fitness bar, and it stays a person's to make.
 */
export function looksLikeSecurity(result: ClaimResult): boolean {
  return (
    result.claim.advisories.length > 0 || /securit|vulnerab|cve/i.test(result.claim.section)
  );
}

/** A stable, readable case name: the release it came from and the claim in it. */
export function goldenCaseName(report: Report, claimId: number): string {
  const slug = `${report.repoLabel}-${report.headRef}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${slug}-claim${claimId}`;
}

/**
 * Add one claim of a stored report to the golden set with the verdict it
 * should have had. Returns the case and where it was written.
 */
export async function addGoldenCase(
  opts: AddGoldenOptions,
): Promise<{ case: GoldenCase; path: string; total: number; securityLooking: boolean }> {
  if (!GOLDEN_VERDICTS.includes(opts.verdict as JudgedVerdict)) {
    throw new Error(
      `"${opts.verdict}" is not a verdict — pass ${GOLDEN_VERDICTS.join(", ")}. ` +
        `("skipped" is bookkeeping the pipeline assigns itself; no judge produces it, so no judge is graded on it.)`,
    );
  }
  if (opts.category && !(GOLDEN_CATEGORIES as readonly string[]).includes(opts.category)) {
    throw new Error(
      `--category must be one of ${GOLDEN_CATEGORIES.join(", ")} (got "${opts.category}") — the gate rules are per category.`,
    );
  }

  const report = parseReport(await readFile(opts.reportPath, "utf8"), opts.reportPath);
  const result = report.results.find((r) => r.claim.id === opts.claimId);
  if (!result) {
    const ids = report.results.map((r) => r.claim.id);
    throw new Error(
      `${opts.reportPath} has no claim ${opts.claimId} — its claim ids are ${ids.join(", ") || "(none)"}.`,
    );
  }

  const goldenFile = opts.goldenFile ?? GOLDEN_PATH;
  const existing = JSON.parse(await readFile(goldenFile, "utf8")) as GoldenCase[];
  const name = goldenCaseName(report, opts.claimId);
  if (existing.some((c) => c.name === name)) {
    throw new Error(
      `${name} is already in the golden set — a claim contributes one case. Edit ${goldenFile} by hand to change its expected verdict.`,
    );
  }

  const data = opts.load ? await opts.load(report) : await reloadRelease(report, opts.local);
  const { hunks, allPaths } = await claimEvidence(data, result.claim, EVIDENCE);
  if (!hunks.length) {
    // Without the material there is no question, and a case whose hunks are
    // empty grades a model on nothing — it would pass or fail on the prompt
    // preamble alone.
    throw new Error(
      `claim ${opts.claimId} of ${report.repoLabel} ${report.headRef} reached the judge with no diff evidence at all, so there is no question to freeze. Lift a claim whose verdict rests on hunks.`,
    );
  }

  const gc: GoldenCase = {
    name,
    // `field` unless a person says otherwise: a lifted case is a regression
    // test from the day it was lifted, and the fitness gate stays where it
    // was frozen. See FIELD_CATEGORY.
    category: opts.category ?? FIELD_CATEGORY,
    section: result.claim.section,
    claim: result.claim.text,
    hunks,
    // Only when it adds something: the need protocol reads this list to see
    // which files exist beyond the hunks, and repeating the hunk paths says
    // nothing. Bounded — a 3000-file release must not become the fixture.
    ...(allPaths.length > hunks.length ? { allPaths: allPaths.slice(0, 200) } : {}),
    expected: [opts.verdict],
    lifted: {
      repo: report.repoLabel,
      tag: report.headRef,
      got: result.verdict,
      ...(opts.why ? { why: opts.why } : {}),
      added: new Date().toISOString().slice(0, 10),
    },
  };

  await writeFile(goldenFile, `${JSON.stringify([...existing, gc], null, 2)}\n`);
  return {
    case: gc,
    path: goldenFile,
    total: existing.length + 1,
    securityLooking: looksLikeSecurity(result),
  };
}
