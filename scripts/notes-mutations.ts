// SPDX-License-Identifier: GPL-3.0-or-later
//
// The mutations `scripts/mutate-notes.ts` applies, as pure functions.
//
// They live apart from the runner for the same reason `corpus-aggregate.ts`
// lives apart from `corpus-stats.ts`: a harness whose own logic is untested
// produces numbers nobody should believe. The first version of the runner
// read `uncovered[].sha` — a field that does not exist — and therefore
// reported every commit as covered and every omission as unmutatable, without
// failing once.
import { tokenize } from "../src/match.ts";
import type { Claim, DiffFile } from "../src/types.ts";

/**
 * Release notes rebuilt from parsed claims. Section headings and bullet syntax
 * are normalised; the claim texts are verbatim, because those are what the
 * mutations operate on and what the detector reads.
 */
export function renderNotes(claims: Claim[]): string {
  const lines: string[] = [];
  let section: string | null = null;
  for (const claim of claims) {
    if (claim.section !== section) {
      section = claim.section;
      lines.push(`## ${section}`, "");
    }
    lines.push(`* ${claim.text}`);
  }
  return `${lines.join("\n")}\n`;
}

/** The anchor half of coverage: does this claim point at this commit? */
export function anchorsTo(claim: Claim, sha: string, prNumbers: number[]): boolean {
  if (claim.shas.some((s) => sha.startsWith(s))) return true;
  return claim.prNumbers.some((n) => prNumbers.includes(n));
}

/**
 * Identifiers to pad a fabricated claim with: frequent in the diff, absent
 * from anything the notes actually claimed. The point of the class is that
 * the padding is the *only* thing connecting the claim to the release, so a
 * token some real claim already names would confuse the finding with an
 * honest match.
 */
export function noiseTokens(files: DiffFile[], claims: Claim[], count = 2): string[] {
  const claimed = new Set(
    claims.flatMap((cl) => [
      ...cl.codeSpans.map((s) => s.toLowerCase()),
      ...tokenize(cl.text),
    ]),
  );
  const pool = new Map<string, number>();
  for (const f of files) {
    if (!f.patch) continue;
    for (const line of f.patch.split("\n")) {
      if (!/^[+-]/.test(line) || /^(\+\+\+ |--- )/.test(line)) continue;
      for (const t of tokenize(line.slice(1))) {
        if (t.length < 4 || claimed.has(t)) continue;
        pool.set(t, (pool.get(t) ?? 0) + 1);
      }
    }
  }
  return [...pool.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, count)
    .map(([t]) => t);
}

/** The fabricated claim itself — a statement nobody wrote, padded to pass. */
export function fabricatedClaim(tokens: string[], id = -2): Claim {
  return {
    id,
    section: "Added",
    text: `Adds \`${tokens[0]}\` and \`${tokens[1]}\` support to the release pipeline`,
    kind: "change",
    prNumbers: [],
    shas: [],
    advisories: [],
    codeSpans: [tokens[0], tokens[1]],
  };
}

/**
 * Two ways to restate a dependency bump falsely, and they are not the same
 * question.
 *
 * `OVERSHOOT` names a version the release did not reach. SCORING.md calls
 * that `contradicted` — "a pin landing short of the claimed version" — and
 * nothing about it is ambiguous. No real dependency ships 9999.0.0.
 *
 * `UNDERSHOOT` names a version below where the pin *started*, so the release
 * never moved it there and never moved past it either. The join reads any
 * observed version above the claimed one as `overtaken`, which is the right
 * answer for the case it was built for — a per-PR note describing one slice
 * of an aggregated bump, where the claimed version lies inside the interval
 * the pin traversed. Below the interval there is no such reading.
 */
export const OVERSHOOT_VERSION = "9999.0.0";
export const UNDERSHOOT_VERSION = "0.0.1";

export function restateBumpTarget(text: string, claimedTo: string, target: string): string {
  return text.replace(claimedTo, target);
}
