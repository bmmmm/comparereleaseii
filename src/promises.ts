// SPDX-License-Identifier: GPL-3.0-or-later
// Promise tracking: release notes commit to the future ("X will be removed
// in 2.0"), and nobody ever checks release N's promises against release N+1.
// This module does, deterministically — identifiers from the promise matched
// against the right side of the diff: deletions for a removal, additions for
// an addition. Informational only, never a score component: a promise is
// about a later release, so it must not move this release's trust score.
import { parseClaims } from "./claims.ts";
import { extractIdentifiers, isChangelogPath } from "./match.ts";
import type { Claim, PromiseCheck, ReleaseData } from "./types.ts";

/** A promise carried across releases by the watch state. */
export interface CarriedPromise {
  text: string;
  from: string;
  kind: PromiseCheck["kind"];
  target?: string;
}

/**
 * Version-aware "is the named target release reached?". Tolerant of tag
 * shapes (v-prefix, suffixes); an unparseable pair answers false — a wrong
 * "broken" reads exactly like a caught lie, so the comparison stays
 * conservative. "next" is always reached: the release under check IS the
 * next one after the promise.
 */
export function targetReached(target: string | undefined, headRef: string): boolean {
  if (!target) return false;
  if (target === "next") return true;
  const parse = (s: string): number[] | null => {
    const m = s.match(/\d+(?:\.\d+)*/);
    return m ? m[0].split(".").map(Number) : null;
  };
  const want = parse(target);
  const head = parse(headRef);
  if (!want || !head) return false;
  for (let i = 0; i < Math.max(want.length, head.length); i++) {
    const w = want[i] ?? 0;
    const h = head[i] ?? 0;
    if (h > w) return true;
    if (h < w) return false;
  }
  return true;
}

/** The diff side that can prove this promise kind. */
function provingLines(patch: string, kind: PromiseCheck["kind"]): string {
  const marker = kind === "removal" ? "-" : "+";
  return patch
    .split("\n")
    .filter((l) => l.startsWith(marker) && !l.startsWith(marker.repeat(3)))
    .join("\n");
}

function checkOne(promise: CarriedPromise, identifiers: string[], data: ReleaseData): PromiseCheck {
  const base = { text: promise.text, from: promise.from, kind: promise.kind, target: promise.target };
  const verb = promise.kind === "removal" ? "removal" : "addition";

  if (!identifiers.length) {
    return {
      ...base,
      status: "still-open",
      files: [],
      note: `not mechanically checkable — the promise names no code identifier`,
    };
  }

  const files: string[] = [];
  for (const file of data.files) {
    if (isChangelogPath(file.path)) continue;
    const wholeFileCounts =
      promise.kind === "removal" ? file.status === "removed" : file.status === "added";
    const haystack = file.patch ? provingLines(file.patch, promise.kind) : "";
    if (
      identifiers.some(
        (id) => haystack.includes(id) || (wholeFileCounts && file.path.includes(id)),
      )
    ) {
      files.push(file.path);
    }
  }
  if (files.length) {
    return {
      ...base,
      status: "kept",
      files: files.slice(0, 6),
      note: `the promised ${verb} appears in this release's diff`,
    };
  }
  if (targetReached(promise.target, data.headRef)) {
    return {
      ...base,
      status: "broken",
      files: [],
      note:
        `promised for ${promise.target === "next" ? "the next release" : promise.target} — ` +
        `${data.headRef} is that release or later, and nothing in its diff shows the ${verb}`,
    };
  }
  return {
    ...base,
    status: "still-open",
    files: [],
    note: promise.target
      ? `promised for ${promise.target}, which ${data.headRef} has not reached`
      : `no target release named — carried forward until it happens`,
  };
}

/**
 * Check the base release's promises (and any carried from earlier releases,
 * via the watch state) against this release's diff. Deduplicates carried
 * promises that the base notes repeat.
 */
export function checkPromises(data: ReleaseData, carried: CarriedPromise[] = []): PromiseCheck[] {
  const fromBase: Array<{ promise: CarriedPromise; claim: Claim | null }> = data.baseNotes
    ? parseClaims(data.baseNotes)
        .filter((c) => c.promise)
        .map((c) => ({
          promise: {
            text: c.text,
            from: data.baseRef,
            kind: c.promise!.kind,
            target: c.promise!.target,
          },
          claim: c,
        }))
    : [];

  const key = (p: CarriedPromise): string => p.text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const seen = new Set(fromBase.map((e) => key(e.promise)));
  const all = [
    ...fromBase,
    ...carried.filter((p) => !seen.has(key(p))).map((promise) => ({ promise, claim: null })),
  ];

  return all.map(({ promise, claim }) => {
    const identifiers = claim
      ? extractIdentifiers(claim)
      : extractIdentifiers({
          id: 0,
          section: "",
          text: promise.text,
          kind: "change",
          prNumbers: [],
          shas: [],
          advisories: [],
          codeSpans: [...promise.text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]),
        });
    return checkOne(promise, identifiers, data);
  });
}
