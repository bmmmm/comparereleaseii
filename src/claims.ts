// SPDX-License-Identifier: GPL-3.0-or-later
import { extractIdentifiers } from "./match.ts";
import type { Claim } from "./types.ts";

const META_SECTION = /new contributors|credits|thanks|acknowledg/i;
const META_TEXT =
  /full changelog|made their first contribution|^\*\*?full|pending cve|cve assignment|update as soon as possible|these are private/i;
/** Sections whose prose paragraphs are worth verifying (not just bullets). */
const PROSE_SECTION = /note|highlight|breaking|important|upgrade|security/i;

function extract(text: string): Omit<Claim, "id" | "section" | "kind" | "text"> {
  const prNumbers = new Set<number>();
  for (const m of text.matchAll(/\/pull\/(\d+)/g)) prNumbers.add(Number(m[1]));
  for (const m of text.matchAll(/(?<![\w/])#(\d+)\b/g)) prNumbers.add(Number(m[1]));
  const shas = [...text.matchAll(/\b[0-9a-f]{7,40}\b/g)]
    .map((m) => m[0])
    .filter((s) => /[0-9]/.test(s) && /[a-f]/.test(s));
  const advisories = [
    ...new Set(
      [...text.matchAll(/GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}/g)].map((m) => m[0]),
    ),
  ];
  const codeSpans = [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
  const author = text.match(/by @([\w-]+)/)?.[1];
  return { prNumbers: [...prNumbers], shas, advisories, codeSpans, author };
}

/** Normalize a claim line for display and matching: unwrap links, drop URLs. */
export function cleanText(text: string): string {
  return text
    .replace(/\[\[?([^\]]+)\]?\]\(([^)]+)\)/g, "$1 ")
    .replace(/https?:\/\/\S*\/pull\/(\d+)/g, "#$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const SETEXT_UNDERLINE = /^[=-]{3,}\s*$/;

/** Prose left after removing HTML markup — an <img>/<p> layout line has
 * none and must not become a claim (it can only ever land no-evidence). */
function proseContent(text: string): string {
  return text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

/** Comparison key for "is this the same sentence?" — case and punctuation out. */
function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Below this a repeated line is a coincidence, not a carry-over: "Bug fixes"
 * appears in every release of every project and still asserts something about
 * each one. Only a distinctive sentence can be recognised as standing text.
 */
const MIN_CARRY_OVER_WORDS = 4;

/**
 * Mark claims whose text already stood in the base release's notes. Cumulative
 * or recap-style notes repeat their predecessor verbatim (standing intros,
 * feature lists); those lines describe the product, not this release, and
 * scoring them as unsupported assertions drowns an honest release in
 * `no-evidence`. Mutates and returns the claims for the caller's convenience.
 */
export function markCarriedOver(claims: Claim[], baseNotes: string, baseRef: string): Claim[] {
  const earlier = new Set(
    parseClaims(baseNotes)
      .map((c) => normalizeText(c.text))
      .filter((t) => t.split(" ").length >= MIN_CARRY_OVER_WORDS),
  );
  if (!earlier.size) return claims;
  for (const claim of claims) {
    if (earlier.has(normalizeText(claim.text))) claim.carriedOverFrom = baseRef;
  }
  return claims;
}

export function parseClaims(notes: string): Claim[] {
  const claims: Claim[] = [];
  let id = 0;
  let section = "Notes";
  let paragraph: string[] = [];
  /** Open list item; indented follow-up lines are part of it (its anchors often live there). */
  let bullet: string[] | null = null;

  const flushParagraph = (): void => {
    if (!paragraph.length) return;
    const raw = paragraph.join(" ");
    paragraph = [];
    const text = cleanText(raw);
    if (text.length < 15 || proseContent(text).length < 15) return;
    const claim: Claim = { id: id++, section, text, kind: "change", ...extract(raw) };
    // Prose is only verifiable when it names something concrete (identifier,
    // PR, sha, advisory) — process talk and thank-yous are informational.
    const verifiable =
      claim.prNumbers.length > 0 ||
      claim.shas.length > 0 ||
      claim.advisories.length > 0 ||
      extractIdentifiers(claim).length > 0;
    if (!PROSE_SECTION.test(section) || META_TEXT.test(text) || !verifiable) {
      claim.kind = "meta";
    }
    claims.push(claim);
  };

  const flushBullet = (): void => {
    if (!bullet) return;
    const raw = bullet.join(" ");
    bullet = null;
    const text = cleanText(raw);
    if (!text || !proseContent(text)) return;
    const isMeta = META_SECTION.test(section) || META_TEXT.test(text);
    claims.push({
      id: id++,
      section,
      text,
      kind: isMeta ? "meta" : "change",
      ...extract(raw),
    });
  };

  // Summary/Details layouts (restic-style) restate every entry twice; the
  // copy with fewer anchors would only dilute the score. Keep the richest.
  const dedupe = (): void => {
    // Group by overlapping reference numbers: the summary entry cites the
    // issue, the details entry issue + fixing PR — any shared number links them.
    const groups: Claim[][] = [];
    for (const claim of claims) {
      if (claim.kind !== "change" || !claim.prNumbers.length) continue;
      const hit = groups.find((g) =>
        g.some((other) => other.prNumbers.some((n) => claim.prNumbers.includes(n))),
      );
      if (hit) hit.push(claim);
      else groups.push([claim]);
    }
    for (const group of groups) {
      if (group.length < 2) continue;
      const ranked = [...group].sort(
        (a, b) => b.prNumbers.length - a.prNumbers.length || b.text.length - a.text.length,
      );
      for (const duplicate of ranked.slice(1)) duplicate.kind = "meta";
    }
  };

  const lines = notes.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heading = line.match(/^#{1,4}\s+(.*)/);
    if (heading) {
      flushBullet();
      flushParagraph();
      section = heading[1].trim();
      continue;
    }
    // Setext heading: a non-indented text line underlined with === or ---.
    // Indented lines stay list-item continuations even when followed by dashes.
    if (line.trim() && !/^\s{2,}/.test(line) && SETEXT_UNDERLINE.test(lines[i + 1] ?? "")) {
      flushBullet();
      flushParagraph();
      section = line.trim();
      i++;
      continue;
    }
    if (SETEXT_UNDERLINE.test(line)) continue;
    const bulletMatch = line.match(/^\s*[*+-]\s+(.*)/);
    if (bulletMatch) {
      flushBullet();
      flushParagraph();
      bullet = [bulletMatch[1]];
      continue;
    }
    if (line.trim() === "") {
      // Blank lines separate paragraphs but keep a list item open — its
      // indented description and trailing anchor links follow after them.
      flushParagraph();
      continue;
    }
    if (bullet && /^\s{2,}\S/.test(line)) {
      bullet.push(line.trim());
      continue;
    }
    flushBullet();
    paragraph.push(line.trim());
  }
  flushBullet();
  flushParagraph();
  dedupe();
  return claims;
}
