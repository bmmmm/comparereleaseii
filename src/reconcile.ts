// SPDX-License-Identifier: GPL-3.0-or-later
// The reconciliation layer: claims (what the notes assert) meet findings
// (what the judge observed reading the diff blind to messages) — joined
// LATE, after both sides exist, so neither side's production anchors the
// other. Deterministic: claim identifiers against a finding's text and
// files, the same identifier currency substance coverage spends — no LLM,
// no I/O, same inputs, same join. Informational, never scored.
import { extractIdentifiers } from "./match.ts";
import type {
  ClaimResult,
  DiffFile,
  Finding,
  Reconciliation,
  UncoveredCommit,
} from "./types.ts";

/**
 * lexicalMatch's weights: a code-span hit counts 3, a plain identifier 2.
 * Substance coverage's bar (>= 5) is calibrated against a whole release
 * diff; a finding is one sentence plus a handful of paths, so the bar
 * here is one code span or two identifiers — strong enough that a single
 * stray token cannot marry a claim to a finding it never described.
 */
const MATCH_BAR = 3;

function matchScore(identifiers: string[], codeSpans: string[], finding: Finding): number {
  let score = 0;
  for (const ident of identifiers) {
    if (finding.text.includes(ident) || finding.files.some((p) => p.includes(ident))) {
      score += codeSpans.includes(ident) ? 3 : 2;
    }
  }
  return score;
}

/**
 * Join claims and findings. Only claims that assert something about THIS
 * release take part — change-kind and not skipped, the same population
 * substance coverage reads; meta text and carried-over lines can neither
 * confirm a finding nor count as unsupported. The caller gates on findings
 * existing: no findings, no reconciliation — `--judge off` output must not
 * grow an empty scaffold.
 */
export function reconcile(
  results: ClaimResult[],
  findings: Finding[],
  uncovered: UncoveredCommit[],
  commitFiles: Map<string, DiffFile[]> | null,
): Reconciliation {
  const eligible: number[] = [];
  results.forEach((r, i) => {
    if (r.claim.kind === "change" && r.verdict !== "skipped") eligible.push(i);
  });

  const identifiers = new Map<number, string[]>();
  for (const i of eligible) identifiers.set(i, extractIdentifiers(results[i].claim));

  const confirmed: Reconciliation["confirmed"] = [];
  const undocumented: number[] = [];
  const claimSeen = new Set<number>();
  findings.forEach((finding, fi) => {
    const claims = eligible.filter(
      (i) => matchScore(identifiers.get(i)!, results[i].claim.codeSpans, finding) >= MATCH_BAR,
    );
    if (claims.length) {
      confirmed.push({ finding: fi, claims });
      for (const i of claims) claimSeen.add(i);
    } else {
      undocumented.push(fi);
    }
  });

  const unsupported = eligible.filter((i) => !claimSeen.has(i));

  // Display order for the uncovered list: commits whose own diff shares a
  // file with an undocumented finding first — the silent change the judge
  // described. Emitted only when it actually reorders; the stored list
  // stays untouched (a view property, like the lens).
  let uncoveredOrder: number[] | undefined;
  if (undocumented.length && uncovered.length && commitFiles) {
    const undocFiles = new Set(undocumented.flatMap((fi) => findings[fi].files));
    const hit = uncovered.map((u) =>
      (commitFiles.get(u.commit.sha) ?? []).some((f) => undocFiles.has(f.path)),
    );
    const order = [
      ...uncovered.map((_, i) => i).filter((i) => hit[i]),
      ...uncovered.map((_, i) => i).filter((i) => !hit[i]),
    ];
    if (order.some((v, i) => v !== i)) uncoveredOrder = order;
  }

  return { confirmed, undocumented, unsupported, uncoveredOrder };
}
