// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseClaims, cleanText, markCarriedOver } from "../src/claims.ts";

const fixture = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "fixtures", "vaultwarden-1.37.0.md"),
  "utf8",
);

test("parses all claims from the vaultwarden 1.37.0 notes", () => {
  const claims = parseClaims(fixture);
  assert.equal(claims.length, 45);
});

test("What's Changed bullets are change claims with PR anchors", () => {
  const claims = parseClaims(fixture).filter((c) => c.section === "What's Changed");
  assert.equal(claims.length, 27);
  assert.ok(claims.every((c) => c.kind === "change"));
  assert.deepEqual(claims[0].prNumbers, [6127]);
  assert.equal(claims[0].author, "txase");
});

test("New Contributors section is all meta (6 bullets + Full Changelog line)", () => {
  const claims = parseClaims(fixture).filter((c) => c.section === "New Contributors");
  assert.equal(claims.length, 7);
  assert.ok(claims.every((c) => c.kind === "meta"));
  assert.deepEqual(claims[0].prNumbers, [7061]);
});

test("GHSA advisories are extracted", () => {
  const ssrf = parseClaims(fixture).find((c) => c.text.includes("SSRF"));
  assert.ok(ssrf);
  assert.deepEqual(ssrf.advisories, ["GHSA-hw4g-2v3f-74x5", "GHSA-vh5m-fc9v-m84g"]);
  assert.equal(ssrf.kind, "change");
});

test("security-process prose is meta, the Note paragraph is a change claim", () => {
  const claims = parseClaims(fixture);
  const intro = claims.find((c) => c.text.includes("strongly advice"));
  assert.equal(intro?.kind, "meta");
  const pending = claims.find((c) => c.text.includes("pending CVE"));
  assert.equal(pending?.kind, "meta");
  const note = claims.find((c) => c.text.includes("2026.7.0"));
  assert.equal(note?.kind, "change");
  assert.equal(note?.section, "Note");
});

test("cleanText unwraps links, keeps adjacent link texts separated", () => {
  const cleaned = cleanText(
    "Import [[GHSA-f3qw-qg77-hmm4]](https://x.example/a)[[GHSA-jq2g-h4xr-4mcr]](https://x.example/b)",
  );
  assert.equal(cleaned, "Import GHSA-f3qw-qg77-hmm4 GHSA-jq2g-h4xr-4mcr");
});

test("cleanText rewrites pull URLs to #N", () => {
  assert.equal(
    cleanText("Fix foo by @bar in https://github.com/o/r/pull/123"),
    "Fix foo by @bar in #123",
  );
});

const restic = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "fixtures", "restic-0.19.1.md"),
  "utf8",
);

test("restic: setext headings become sections, underlines are not claims", () => {
  const claims = parseClaims(restic);
  const sections = new Set(claims.map((c) => c.section));
  assert.ok(sections.has("Summary"));
  assert.ok(sections.has("Details"));
  assert.ok(!claims.some((c) => /^[=-]+$/.test(c.text.replace(/\s/g, ""))));
  // The intro prose lives under the setext title heading and is informational.
  const intro = claims.find((c) => c.text.startsWith("The following sections"));
  assert.equal(intro?.kind, "meta");
});

test("restic: indented continuation lines merge into the bullet, PR anchors included", () => {
  const claims = parseClaims(restic);
  const detail = claims.find(
    (c) => c.section === "Details" && c.text.includes("Prevent mounting over the repository"),
  );
  assert.ok(detail);
  // #5234 is the issue, #5348 the fixing PR from the trailing anchor line.
  assert.ok(detail.prNumbers.includes(5234));
  assert.ok(detail.prNumbers.includes(5348), `anchors: ${detail.prNumbers.join(",")}`);
  assert.ok(detail.text.includes("deadlocking the kernel"));
  assert.equal(detail.kind, "change");
});

test("restic: details keep the nine fixes, summary duplicates are deduped", () => {
  const claims = parseClaims(restic);
  // Details entries carry more anchors (issue + fixing PR) and win the dedupe.
  assert.equal(claims.filter((c) => c.section === "Details" && c.kind === "change").length, 9);
  assert.equal(claims.filter((c) => c.section === "Summary" && c.kind === "change").length, 0);
  assert.equal(claims.filter((c) => c.section === "Summary").length, 9);
});

test("markup-only lines never become claims (omlx img-banner shape)", () => {
  const notes = [
    "## Highlights",
    "",
    '<p align=center> <img width="932" height="290" alt="0 5 2" src="https://example.com/x.png" /> </p>',
    "",
    "- <img src=banner.png>",
    "- Added `<video>` element support in the renderer",
  ].join("\n");
  const claims = parseClaims(notes);
  assert.ok(!claims.some((c) => /img|align=center/.test(c.text)), "no claim from markup-only lines");
  assert.ok(
    claims.some((c) => c.text.includes("element support")),
    "inline HTML inside real prose survives",
  );
});

test("markCarriedOver flags text repeated verbatim from the base release", () => {
  const base = `## What's new

omlx is a fast local inference server for Apple Silicon.

- Added streaming support for the completions endpoint
- Fixed a crash when the model directory is empty
`;
  const head = `## What's new

omlx is a fast local inference server for Apple Silicon.

- Added streaming support for the completions endpoint
- Added a new /v1/embeddings endpoint
`;
  const claims = markCarriedOver(parseClaims(head), base, "v0.5.2");
  const byText = new Map(claims.map((c) => [c.text, c.carriedOverFrom]));

  // Standing intro and a repeated bullet: both stood in v0.5.2 already.
  assert.equal(byText.get("omlx is a fast local inference server for Apple Silicon."), "v0.5.2");
  assert.equal(
    byText.get("Added streaming support for the completions endpoint"),
    "v0.5.2",
  );
  // The one genuinely new line must stay scorable.
  assert.equal(byText.get("Added a new /v1/embeddings endpoint"), undefined);
});

test("markCarriedOver ignores short generic lines that repeat by nature", () => {
  const claims = markCarriedOver(parseClaims("- Bug fixes\n"), "- Bug fixes\n", "v1");
  assert.equal(claims[0].carriedOverFrom, undefined);
});

test("a paragraph citing a PR is a claim under any heading", () => {
  // The heading comes from the same hand as the claim. Moving a paragraph
  // from "Security" to "Changes" used to take it out of the check while its
  // PR reference kept earning completeness credit.
  const body =
    "Add a remote maintenance endpoint for support engineers (#42), so operators\n" +
    "can trigger cache rebuilds without a redeploy.\n";
  for (const heading of ["Changes", "Security", "What's new", "Details"]) {
    const [claim] = parseClaims(`## ${heading}\n\n${body}`);
    assert.equal(claim.kind, "change", heading);
    assert.deepEqual(claim.prNumbers, [42]);
  }
  // Same for a sha and an advisory ID.
  const [sha] = parseClaims("## Changes\n\nBackported in 9f2c1ab8e4d0 for the LTS line.\n");
  assert.equal(sha.kind, "change");
  const [ghsa] = parseClaims("## Changes\n\nResolves GHSA-2222-3333-4444 in the parser.\n");
  assert.equal(ghsa.kind, "change");
});

test("prose without a hard anchor still needs a section that invites checking", () => {
  // An identifier-shaped word alone is weak evidence of an assertion — under
  // an arbitrary heading it is as likely to be prose about the project.
  const soft = "The plugin_loader has been part of the project since 1.0 and stays.\n";
  assert.equal(parseClaims(`## Changes\n\n${soft}`)[0].kind, "meta");
  assert.equal(parseClaims(`## Upgrade notes\n\n${soft}`)[0].kind, "change");
  // Thank-yous stay informational however many references they carry.
  const thanks = parseClaims("## New Contributors\n\n@someone made their first contribution in #42\n");
  assert.equal(thanks[0].kind, "meta");
});
