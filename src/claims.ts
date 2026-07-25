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

export function parseClaims(notes: string): Claim[] {
  const claims: Claim[] = [];
  let id = 0;
  let section = "Notes";
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (!paragraph.length) return;
    const raw = paragraph.join(" ");
    paragraph = [];
    const text = cleanText(raw);
    if (text.length < 15) return;
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

  for (const line of notes.split("\n")) {
    const heading = line.match(/^#{1,4}\s+(.*)/);
    if (heading) {
      flushParagraph();
      section = heading[1].trim();
      continue;
    }
    const bullet = line.match(/^\s*[*+-]\s+(.*)/);
    if (bullet) {
      flushParagraph();
      const raw = bullet[1];
      const text = cleanText(raw);
      if (!text) continue;
      const isMeta = META_SECTION.test(section) || META_TEXT.test(text);
      claims.push({
        id: id++,
        section,
        text,
        kind: isMeta ? "meta" : "change",
        ...extract(raw),
      });
      continue;
    }
    if (line.trim() === "") {
      flushParagraph();
    } else {
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  return claims;
}
