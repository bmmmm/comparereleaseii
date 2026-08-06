// SPDX-License-Identifier: GPL-3.0-or-later
// The reconciliation layer: claims (what the notes assert) meet findings
// (what the judge observed reading the diff blind to messages) — joined
// LATE, after both sides exist, so neither side's production anchors the
// other. Deterministic: claim identifiers against a finding's text and
// files, the same identifier currency substance coverage spends — no LLM,
// no I/O, same inputs, same join. Informational, never scored.
import { extractIdentifiers } from "./match.ts";
import { sameName } from "./pins.ts";
import type {
  BumpJoin,
  BumpResolution,
  Claim,
  ClaimResult,
  DiffFile,
  Finding,
  PinBump,
  Reconciliation,
  UncoveredCommit,
} from "./types.ts";

/**
 * lexicalMatch's weights: a code-span hit counts 3, a plain identifier 2.
 * Substance coverage's bar (>= 5) is calibrated against a whole release
 * diff; a finding is one sentence plus a handful of paths, so the bar
 * here is one code span or two identifiers — strong enough that a single
 * stray token cannot marry a claim to a finding it never described.
 *
 * Deliberately without `termWeight`'s discount for backticked dictionary
 * words: that discount exists because a common word is background noise in a
 * diff of a thousand files, and a one-sentence finding is not that haystack.
 * Nor is there anything to defend against here — the note author writes the
 * claim, but the judge writes the finding, so no markup of theirs can
 * manufacture the other side of this join.
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

/** Segments of a version literal — the v-prefix is spelling, not content. */
function segments(v: string): string[] {
  return v.replace(/^v/i, "").split(/[.+-]/).filter(Boolean);
}

/**
 * Order two version literals, or `null` when they cannot be ordered — two
 * different non-numeric segments (`rc1` against `rc2`) have no arithmetic,
 * and guessing one would be the difference between "the release went
 * further than the note says" and "the note is wrong". A trailing run of
 * zeros adds nothing (`1.2` is `1.2.0`); anything else trailing is a
 * prerelease, which sorts before its release.
 */
export function compareVersions(a: string, b: string): number | null {
  const sa = segments(a);
  const sb = segments(b);
  for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
    const x = sa[i];
    const y = sb[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) {
      const rest = (x === undefined ? sb : sa).slice(i);
      if (rest.every((s) => /^0+$/.test(s))) continue;
      const shorterWins = !/^\d+$/.test(rest[0]);
      return (x === undefined) === shorterWins ? 1 : -1;
    }
    if (!/^\d+$/.test(x) || !/^\d+$/.test(y)) return null;
    const d = Number(x) - Number(y);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}


/**
 * Hold every bump claim against the pin delta of the same diff. Both sides
 * are deterministic reads of material the release published, so this join
 * is too: same input, same answer, no LLM and no I/O.
 *
 * Claims are indexed by position, which is the order `verifyClaims` returns
 * its results in. Carried-over text takes no part — it describes the
 * product, not this release, and gets skipped before any verdict.
 */
export function resolveBumpClaims(
  claims: Claim[],
  pins: PinBump[],
  opts: { viaCommit?: boolean } = {},
): BumpResolution[] {
  const out: BumpResolution[] = [];
  claims.forEach((claim, index) => {
    const claimed = claim.bump;
    if (!claimed || claim.kind !== "change" || claim.carriedOverFrom) return;
    const candidates = pins.filter((pin) => sameName(claimed.name, pin.name));
    if (!candidates.length) {
      out.push({ claim: index, status: "unmatched", claimed });
      return;
    }
    // Several files can move the same pin to different versions. The one
    // that lands on the claimed version answers the claim; failing that,
    // the furthest the release went does.
    const best =
      candidates.find((pin) => compareVersions(pin.to, claimed.to) === 0) ??
      candidates.reduce((a, b) => ((compareVersions(b.to, a.to) ?? 0) > 0 ? b : a));
    const order = compareVersions(best.to, claimed.to);
    if (order === null) {
      out.push({ claim: index, status: "unmatched", claimed });
      return;
    }
    let status: BumpJoin;
    if (order === 0) {
      status = "confirmed";
    } else if (order < 0) {
      status = "contradicted";
    } else {
      // The release moved the pin past the claimed version — which only reads
      // as `overtaken` when the claimed version lies inside the interval the
      // pin actually traversed. That is what a per-PR note describing one
      // slice of an aggregated bump looks like. Below where the pin started
      // there is no such reading: the release neither held that version nor
      // passed through it, so "bumped to 0.0.1" against a 10.54.0 → 10.65.0
      // move is a claim about some other release. Without this the whole
      // class was undetectable — `pnpm mutate-notes` caught 1 of 6.
      const inside = compareVersions(claimed.to, best.from);
      if (inside === null) {
        out.push({ claim: index, status: "unmatched", claimed });
        return;
      }
      status = inside > 0 ? "overtaken" : "contradicted";
    }
    out.push({
      claim: index,
      status,
      claimed,
      observed: {
        from: best.from,
        to: best.to,
        file: best.file,
        ...(opts.viaCommit ? { viaCommit: true } : {}),
      },
    });
  });
  return out;
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
  bumps: BumpResolution[] = [],
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

  // A skipped claim asserts nothing about this release, so its pin join is
  // bookkeeping nobody should read.
  const bumpsShown = bumps.filter((b) => results[b.claim]?.verdict !== "skipped");

  return {
    confirmed,
    undocumented,
    unsupported,
    uncoveredOrder,
    bumps: bumpsShown.length ? bumpsShown : undefined,
  };
}
