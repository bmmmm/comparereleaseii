// SPDX-License-Identifier: GPL-3.0-or-later
// The version number is itself a claim: a patch bump promises "no new
// features, nothing breaking". Where the commits carry explicit markers to
// the contrary — a conventional "!" subject or a BREAKING CHANGE footer —
// that contradiction is deterministically checkable, no judge needed.
// Everything here is deliberately marker-based: it never guesses whether a
// diff "looks breaking", it only holds the tag against what the commit
// messages themselves declare.
import type { Commit, RiskFlag } from "./types.ts";

export interface SemverTag {
  prefix: string;
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

/** `v1.2.3`, `app-1.2.3`, `1.2.3-rc.1+build` — anything whose tail is a
 * three-part version. A two-part or date tag returns null: no semver claim,
 * nothing to hold the commits against. */
export function parseSemverTag(tag: string): SemverTag | null {
  const m = /^(.*?)(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(tag);
  if (!m) return null;
  // A four-part tag (1.2.3.4) would backtrack its first number into the
  // prefix and read as "2.3.4" — a build-number scheme, not a semver claim.
  if (/\d\.$/.test(m[1])) return null;
  return {
    prefix: m[1],
    major: Number(m[2]),
    minor: Number(m[3]),
    patch: Number(m[4]),
    prerelease: m[5] ?? null,
  };
}

export type BumpKind = "major" | "minor" | "patch" | null;

/** The bump the two tags claim. Null when the tags belong to different
 * lines (prefix mismatch — monorepo product tags) or do not move forward. */
export function bumpKind(base: SemverTag, head: SemverTag): BumpKind {
  if (base.prefix !== head.prefix) return null;
  // A year in the major position is CalVer wearing semver's syntax —
  // 2026.08.2 → 2026.08.3 moves the patch slot but promises nothing about
  // compatibility, so there is no claim to hold commits against.
  if (base.major >= 1000 || head.major >= 1000) return null;
  if (head.major !== base.major) return head.major > base.major ? "major" : null;
  if (head.minor !== base.minor) return head.minor > base.minor ? "minor" : null;
  if (head.patch !== base.patch) return head.patch > base.patch ? "patch" : null;
  return null;
}

// The standard type vocabulary only — a generic word-colon match would let
// prose subjects ("Note: …", "Fixed: …") vote a free-form repo over the
// conventional-commits bar that gates the feat-in-patch info.
const CONVENTIONAL_RE =
  /^(feat|fix|chore|docs|refactor|perf|test|build|ci|style|revert)(\([^)]*\))?!?:\s/;
const BREAKING_SUBJECT_RE = /^[A-Za-z]+(\([^)]*\))?!:\s/;
const FEAT_RE = /^feat(\([^)]*\))?!?:\s/;
const BREAKING_FOOTER_RE = /^BREAKING[ -]CHANGE:/m;

export function isBreaking(c: Commit): boolean {
  return BREAKING_SUBJECT_RE.test(c.subject) || BREAKING_FOOTER_RE.test(c.body);
}

/**
 * Hold the version bump against the commits' own markers.
 *
 * - patch bump with BREAKING markers → warn (always: no semver dialect
 *   allows that).
 * - minor bump with BREAKING markers → warn only from 1.0.0 on — 0.x
 *   minors are that dialect's breaking releases.
 * - patch bump with feat commits → info, and only when the repo speaks
 *   conventional commits at all (≥ 25 % of subjects parse as one) — in a
 *   free-form repo "feat" is no vocabulary and its absence no promise.
 * - prerelease tags on either end are out of scope: what `-rc.N` promises
 *   about stability is a per-project convention, not semver's.
 */
export function bumpMismatchFlags(
  baseRef: string,
  headRef: string,
  commits: Commit[],
): RiskFlag[] {
  const base = parseSemverTag(baseRef);
  const head = parseSemverTag(headRef);
  if (!base || !head || base.prerelease || head.prerelease) return [];
  const bump = bumpKind(base, head);
  if (bump === null || bump === "major") return [];

  const flags: RiskFlag[] = [];
  // Merge commits quote the PR body — including any BREAKING CHANGE footer
  // the real commit already carries. Scanning them would double-count, and
  // the churn accounting in metrics.ts excludes merges for the same reason.
  const own = commits.filter((c) => !c.subject.startsWith("Merge "));
  const breaking = own.filter(isBreaking);
  if (breaking.length && (bump === "patch" || base.major >= 1)) {
    flags.push({
      severity: "warn",
      kind: "bump-mismatch",
      message:
        `${headRef} claims a ${bump} bump over ${baseRef}, but ${breaking.length} commit(s) ` +
        `carry a BREAKING CHANGE marker — the version number understates its own commits`,
      files: [],
      commitShas: breaking.slice(0, 5).map((c) => c.sha),
    });
  }

  if (bump === "patch") {
    const conventional = own.filter((c) => CONVENTIONAL_RE.test(c.subject));
    const feats = own.filter((c) => FEAT_RE.test(c.subject) && !isBreaking(c));
    if (feats.length && own.length > 0 && conventional.length / own.length >= 0.25) {
      flags.push({
        severity: "info",
        kind: "bump-mismatch-feat",
        message:
          `${headRef} claims a patch bump, but ${feats.length} commit(s) declare themselves ` +
          `feat: — features usually warrant a minor bump`,
        files: [],
        commitShas: feats.slice(0, 5).map((c) => c.sha),
      });
    }
  }
  return flags;
}
