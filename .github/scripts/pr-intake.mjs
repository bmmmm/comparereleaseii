// SPDX-License-Identifier: GPL-3.0-or-later
// Advisory PR-body check. Reads the body from $PR_BODY (never from argv or a
// shell interpolation — it is attacker-controlled text), writes a checklist to
// the job summary and extracts the self-check claims block. Never fails a build.
import { appendFile, writeFile } from "node:fs/promises";

const body = process.env.PR_BODY ?? "";
const summaryFile = process.env.GITHUB_STEP_SUMMARY;
const outputFile = process.env.GITHUB_OUTPUT;

/**
 * Text of a `## Heading` section, up to the next heading of the same level.
 * Split rather than matched: a lookahead would need an end-of-input anchor,
 * and JS has none — the last section on the page would always come back empty.
 */
function section(name) {
  for (const part of body.split(/^##[ \t]+/m).slice(1)) {
    const nl = part.indexOf("\n");
    const heading = (nl === -1 ? part : part.slice(0, nl)).trim();
    if (heading.toLowerCase() === name.toLowerCase()) {
      return (nl === -1 ? "" : part.slice(nl + 1)).trim();
    }
  }
  return "";
}

/** Strip HTML comments — template guidance must not count as filled in. */
function stripComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, "").trim();
}

const claimsBlock = body.match(/<!--\s*self-check:begin\s*-->([\s\S]*?)<!--\s*self-check:end\s*-->/i)?.[1];
const claims = (claimsBlock ?? "")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => /^[*+-]\s+\S/.test(l) && !/^[*+-]\s+\[[ x]\]/i.test(l));

const PLACEHOLDERS = [/src\/foo\.ts/, /doThing\(\)/, /--some-flag/, /parseUnifiedDiff\(\) on renames/];
// Backticks sit in the middle of the template's examples — strip them so the
// patterns match the prose rather than the markup.
const claimsArePlaceholder =
  claims.length > 0 && claims.every((c) => PLACEHOLDERS.some((p) => p.test(c.replace(/`/g, ""))));

const verification = stripComments(section("Verification"));
// The template ships the two commands; real verification adds their output.
const verificationLines = verification
  .split("\n")
  .filter((l) => l.trim() && !/^```/.test(l.trim()))
  .length;

const tests = stripComments(section("Tests"));
// `\s` would match the newline and count the *next* line as an answer, so an
// empty field would read as filled in. Match only same-line content.
const SAME_LINE = "[^\\S\\n]*\\S";
const testsAnswered =
  new RegExp(`added / changed:${SAME_LINE}`, "i").test(tests) ||
  new RegExp(`fails on \`?main\`?[^\\n]*:${SAME_LINE}`, "i").test(tests);

const contracts = section("Public contracts");
const ticked = (contracts.match(/^- \[x\]/gim) ?? []).length;
const boxes = (contracts.match(/^- \[[ x]\]/gim) ?? []).length;

const risk = stripComments(section("Risk and rollback"));
const riskAnswered = new RegExp(`:${SAME_LINE}`).test(risk);

const assistance = section("Assistance");
const assistanceTicked = (assistance.match(/^- \[x\]/gim) ?? []).length;

const whatWhy = stripComments(section("What and why"));
const linksIssue = /\b(closes|fixes|resolves)\s+#\d+/i.test(body);

const checks = [
  {
    ok: claims.length > 0 && !claimsArePlaceholder,
    name: "Claims block",
    detail:
      claimsBlock === undefined
        ? "self-check markers missing — were they deleted from the template?"
        : claimsArePlaceholder
          ? "still contains only the template's example bullets"
          : claims.length === 0
            ? "markers present but no bullets between them"
            : `${claims.length} claim${claims.length === 1 ? "" : "s"}`,
  },
  {
    ok: whatWhy.length >= 40,
    name: "What and why",
    detail: whatWhy.length ? `${whatWhy.length} characters` : "empty",
  },
  {
    ok: verificationLines > 2,
    name: "Verification output",
    detail: verificationLines > 2 ? "contains output, not just the commands" : "commands only — no output pasted",
  },
  {
    ok: testsAnswered,
    name: "Tests",
    detail: testsAnswered ? "answered" : "neither the test nor a reason for its absence is filled in",
  },
  {
    ok: boxes > 0 && ticked === boxes,
    name: "Public contracts",
    detail: boxes ? `${ticked}/${boxes} confirmed` : "section missing",
  },
  {
    ok: riskAnswered,
    name: "Risk and rollback",
    detail: riskAnswered ? "answered" : "empty",
  },
  {
    ok: assistanceTicked === 2,
    name: "Assistance",
    detail: `${assistanceTicked}/2 confirmed`,
  },
  {
    ok: linksIssue,
    name: "Linked issue",
    detail: linksIssue ? "found" : "no `Closes #N` — fine for trivial fixes",
  },
];

const missing = checks.filter((c) => !c.ok);
const lines = [
  "## PR intake",
  "",
  missing.length === 0
    ? "Everything the review needs is here."
    : `${missing.length} of ${checks.length} items still open. This check never fails a build — it is a reading aid for the reviewer.`,
  "",
  "| | Item | Notes |",
  "|---|---|---|",
  ...checks.map((c) => `| ${c.ok ? "✓" : "○"} | ${c.name} | ${c.detail} |`),
  "",
];

/**
 * Render PR-body text so it cannot forge the summary around it.
 *
 * The job summary is the third sink for text written by the party under
 * examination, next to the judge prompt and the HTML report — and the only
 * one that had no fence. A claim bullet is a single line, so it cannot open
 * a heading, but it can carry the HTML subset the summary renders and fake a
 * verdict row above the real ones. A reviewer reading "everything is here"
 * off a table the PR author wrote is precisely the self-vouching this repo
 * exists to catch.
 *
 * The fence outgrows the longest backtick run in the content, so the text
 * cannot close it either.
 */
function quoted(text) {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return [fence, text, fence];
}

if (claims.length && !claimsArePlaceholder) {
  lines.push(
    "### Claims to be checked against the diff",
    "",
    ...quoted(claims.map((c) => c.replace(/^[*+-]\s+/, "- ")).join("\n")),
    "",
  );
}

if (summaryFile) await appendFile(summaryFile, lines.join("\n"));
else console.log(lines.join("\n"));

const usable = claims.length > 0 && !claimsArePlaceholder;
if (usable) await writeFile("pr-claims.md", claims.join("\n") + "\n");
if (outputFile) await appendFile(outputFile, `has_claims=${usable}\n`);
