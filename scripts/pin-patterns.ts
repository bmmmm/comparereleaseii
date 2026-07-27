// SPDX-License-Identifier: GPL-3.0-or-later
// Copy-paste recipes a reader uses verbatim pin the tool at a tag. A release
// bumps package.json, and a forgotten file keeps handing them the previous
// version — see test/docs.test.ts (which flags a stale pin) and
// scripts/release-prepare.ts (which fixes it). Both import this list so the
// two can never drift apart.
export const PIN_PATTERNS = [
  String.raw`bmmmm/comparereleaseii@(v[\d.]+)`, // composite action ref
  String.raw`ref:\s*(v[\d.]+)`, // actions/checkout ref
];
