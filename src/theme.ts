// SPDX-License-Identifier: GPL-3.0-or-later
// Where a score turns into a bucket, and where that bucket picks up a color.
// Three renderers and the terminal need the same boundaries; before this they
// each spelled out 85/65/45 again, so a scoring change had to be found in
// five places. Kept free of both renderers so either can import it.

/** A release whose notes check out. */
export const SCORE_SOLID = 85;
/** Below this the notes have gaps worth reading about. */
export const SCORE_MINOR = 65;
/** Below this the release is questionable rather than merely incomplete. */
export const SCORE_QUESTIONABLE = 45;

/**
 * Same buckets the index, the history page and the long view use — a capped
 * "unverified" is never a mid score. Deliberately coarser than the label:
 * these are the four visual states the pages have room for.
 */
export function scoreClass(score: number, label: string): string {
  return label === "unverified"
    ? "unverified"
    : score >= SCORE_SOLID
      ? "good"
      : score >= SCORE_MINOR
        ? "mid"
        : "bad";
}

// Status colors, shared by the index dots and the history charts; identity is
// never color-alone — every mark carries a tooltip and the tables repeat the
// numbers as text.
export const CLASS_COLOR: Record<string, string> = {
  good: "#1a7f37",
  mid: "#d4a72c",
  bad: "#cf222e",
  unverified: "#8250df",
};
