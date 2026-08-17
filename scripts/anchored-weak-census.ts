// SPDX-License-Identifier: GPL-3.0-or-later
//
// What the anchored-weak class is made of — the census behind the next
// deterministic-rule candidate.
//
// corpus-stats says the class costs 51.7 % of the judge bill (1880 calls for
// 1599 claims) and answers with the most variance (206 second looks, 26 split
// votes). An anchored-weak claim names a commit that IS in the release range,
// but not one term of its text matches that commit's diff content — the
// deterministic fallback is `partial`, so with a judge configured every one
// of these claims is asked. Before any rule is proposed, this measures what
// the class actually contains (issue #18's lesson: candidates aimed from a
// comment instead of a census all missed):
//
//   - where the calls go, by final verdict — what an eventual `verified`
//     costs against an eventual `no-evidence`,
//   - whether the second look EARNS its two extra calls: how often the
//     re-votes overturn the first vote, and on which verdicts,
//   - the claim-shape cuts a rule could bind to: kind, anchor type,
//     code spans that still failed to match, judge-found evidence files,
//   - every split-vote case verbatim, because 26 splits on one class is the
//     variance a deterministic rule cannot do worse than.
//
//   node scripts/anchored-weak-census.ts <reports dir>            # markdown
//   node scripts/anchored-weak-census.ts <reports dir> --json     # raw rows
//   node scripts/anchored-weak-census.ts <reports dir> --bodies   # + the
//     merge-body candidate, measured against the clone cache: how many of
//     these claims are auto-changelog lines whose core title sits verbatim
//     (same normalization isGeneratedEntry uses) in a BODY line of their
//     anchor commit — the merge-commit workflow's counterpart of the squash
//     subject match that already makes an entry `generated`, costing nothing.
//
// Reads stored reports; --bodies additionally reads commit messages from the
// clone cache (no network, no judge — releases without a clone are counted
// and skipped).
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { cloneDirFor } from "../src/paths.ts";
import { loadLocalRange } from "../src/sources/local.ts";
import { anchorMatch } from "../src/match.ts";
import type { Commit, Report } from "../src/types.ts";
import { claimClass, dedupeReports, judgeCalls, median } from "./corpus-aggregate.ts";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const withBodies = args.includes("--bodies");
const dir = args.find((a) => !a.startsWith("--"));
if (!dir) {
  console.error("Usage: node scripts/anchored-weak-census.ts <reports dir> [--json|--bodies]");
  process.exit(2);
}

// The candidate rule under measurement, spelled with the SAME normalization
// `isGeneratedEntry` (src/verify.ts) applies to the squash-subject case. If
// the candidate ships, this logic moves there; until then the census is its
// only home, so a drift between the two is a rule change, not an accident.
const GENERATED_TAIL = /\bby @[\w-]+\b.*#\d+\s*$/;
const coreText = (text: string): string => text.replace(/\bby @[\w-]+\b.*$/, "").trim();
const normTitle = (s: string): string =>
  s
    .toLowerCase()
    .replace(/\(#\d+\)/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

async function findReports(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(d: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith(".json")) found.push(p);
    }
  }
  await walk(root);
  return found;
}

const parsed: Report[] = [];
for (const f of await findReports(dir)) {
  try {
    const r = JSON.parse(await readFile(f, "utf8")) as Report;
    if (r?.repoLabel && r.headRef && r.metrics) parsed.push(r);
  } catch {
    /* not a report */
  }
}
const reports = dedupeReports(parsed);

interface Row {
  repo: string;
  tag: string;
  text: string;
  kind: string;
  verdict: string;
  judged: boolean;
  judgeFailed: boolean;
  calls: number;
  anchor: "pr" | "sha";
  codeSpans: number;
  prNumbers: number;
  shas: number;
  /** Files the final evidence names — for a judged claim, what the judge saw. */
  evidenceFiles: number;
  votes: string[];
  secondLook: boolean;
  split: boolean;
  /** Second look ran and the resolved verdict differs from the first vote. */
  overturned: boolean;
  escalated: boolean;
  surplus: number;
  textLength: number;
  /**
   * --bodies only: the claim's core title sits verbatim (normTitle) in a body
   * line of an anchor commit. null when no clone answered or --bodies was not
   * asked — "not measured" must never count as "no".
   */
  bodyMatch: boolean | null;
}

const rows: Row[] = [];
let clonesMissing = 0;
for (const r of reports) {
  let commits: Commit[] | null = null;
  if (withBodies && r.baseRef) {
    const clone = await cloneDirFor(r.linkBase ?? `https://github.com/${r.repoLabel}`);
    if (clone) {
      try {
        ({ commits } = await loadLocalRange(clone, r.baseRef, r.headRef));
      } catch {
        commits = null;
      }
    }
    if (!commits) clonesMissing++;
  }
  for (const res of r.results ?? []) {
    if (claimClass(res) !== "anchored-weak") continue;
    const methods = res.evidence?.methods ?? [];
    const votes = res.votes ?? [];
    let bodyMatch: boolean | null = null;
    if (commits) {
      const anchors = anchorMatch(res.claim, commits);
      const core = normTitle(coreText(res.claim.text));
      bodyMatch =
        anchors.commits.length > 0 &&
        GENERATED_TAIL.test(res.claim.text) &&
        core.length > 0 &&
        anchors.commits.some((c) => c.body.split("\n").some((line) => normTitle(line) === core));
    }
    rows.push({
      repo: r.repoLabel,
      tag: r.headRef,
      text: res.claim.text,
      kind: res.claim.kind,
      verdict: res.verdict,
      judged: res.judged,
      judgeFailed: res.judgeFailed ?? false,
      calls: judgeCalls(res),
      anchor: methods.includes("pr-anchor") ? "pr" : "sha",
      codeSpans: res.claim.codeSpans?.length ?? 0,
      prNumbers: res.claim.prNumbers?.length ?? 0,
      shas: res.claim.shas?.length ?? 0,
      evidenceFiles: res.evidence?.files?.length ?? 0,
      votes,
      secondLook: votes.length > 0,
      split: new Set(votes).size > 1,
      overturned: votes.length > 0 && votes[0] !== res.verdict,
      escalated: methods.includes("escalated"),
      surplus: res.surplus?.length ?? 0,
      textLength: res.claim.text.length,
      bodyMatch,
    });
  }
}

if (asJson) {
  console.log(JSON.stringify({ releases: reports.length, rows }, null, 1));
  process.exit(0);
}

const judgedRows = rows.filter((x) => x.judged);
const pct = (n: number, d: number) => (d === 0 ? "—" : `${((n / d) * 100).toFixed(1)} %`);
const count = <K extends string>(xs: Row[], key: (x: Row) => K): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const x of xs) out[key(x)] = (out[key(x)] ?? 0) + 1;
  return out;
};
const table = (header: string[], body: string[][]): string[] => [
  `| ${header.join(" | ")} |`,
  `|${header.map((_, i) => (i === 0 ? "---" : "---:")).join("|")}|`,
  ...body.map((cells) => `| ${cells.join(" | ")} |`),
];

const out: string[] = [];
out.push(`# Anchored-weak census`);
out.push("");
out.push(
  `${reports.length} releases; ${rows.length} anchored-weak claims, ` +
    `${judgedRows.length} judged, ${rows.reduce((s, x) => s + x.calls, 0)} calls (floor).`,
);

out.push("");
out.push(`## Where the calls go — by final verdict`);
out.push("");
const byVerdict = new Map<string, Row[]>();
for (const x of judgedRows) byVerdict.set(x.verdict, [...(byVerdict.get(x.verdict) ?? []), x]);
out.push(
  ...table(
    ["Final verdict", "Claims", "Calls", "Calls/claim", "Second look", "Overturned first vote", "Splits"],
    [...byVerdict.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([v, xs]) => {
        const calls = xs.reduce((s, x) => s + x.calls, 0);
        return [
          `\`${v}\``,
          String(xs.length),
          String(calls),
          (calls / xs.length).toFixed(2),
          String(xs.filter((x) => x.secondLook).length),
          String(xs.filter((x) => x.overturned).length),
          String(xs.filter((x) => x.split).length),
        ];
      }),
  ),
);

out.push("");
out.push(`## Does the second look earn its calls?`);
out.push("");
const looked = judgedRows.filter((x) => x.secondLook);
const overturned = looked.filter((x) => x.overturned);
out.push(
  `${looked.length} second looks (+${looked.reduce((s, x) => s + Math.max(0, x.calls - 1 - (x.surplus ? 1 : 0)), 0)} calls beyond the first vote); ` +
    `${overturned.length} overturned the first vote (${pct(overturned.length, looked.length)}); ` +
    `${looked.filter((x) => x.split).length} split.`,
);
if (overturned.length) {
  out.push("");
  out.push(
    ...table(
      ["First vote → final", "Cases"],
      Object.entries(count(overturned, (x) => `\`${x.votes[0]}\` → \`${x.verdict}\``))
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => [k, String(n)]),
    ),
  );
}

out.push("");
out.push(`## Claim shape — the cuts a rule could bind to`);
out.push("");
const dims: Array<[string, (x: Row) => string]> = [
  ["kind", (x) => x.kind],
  ["anchor", (x) => x.anchor],
  ["code spans", (x) => (x.codeSpans === 0 ? "none" : x.codeSpans === 1 ? "one" : "several")],
  ["judge-found files", (x) => (x.evidenceFiles === 0 ? "0" : x.evidenceFiles <= 2 ? "1–2" : "3+")],
];
const VERDICTS = ["verified", "partial", "no-evidence", "contradicted"];
for (const [name, key] of dims) {
  out.push(`### by ${name}`);
  out.push("");
  const groups = new Map<string, Row[]>();
  for (const x of judgedRows) groups.set(key(x), [...(groups.get(key(x)) ?? []), x]);
  out.push(
    ...table(
      [name, "Judged", ...VERDICTS.map((v) => `\`${v}\``), "Second look"],
      [...groups.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .map(([k, xs]) => [
          k,
          String(xs.length),
          ...VERDICTS.map((v) => `${xs.filter((x) => x.verdict === v).length}`),
          String(xs.filter((x) => x.secondLook).length),
        ]),
    ),
  );
  out.push("");
}

out.push(`### claim text length (judged, by final verdict)`);
out.push("");
out.push(
  ...table(
    ["Final verdict", "Median chars"],
    [...byVerdict.entries()].map(([v, xs]) => [
      `\`${v}\``,
      String(median(xs.map((x) => x.textLength)) ?? "—"),
    ]),
  ),
);

out.push("");
out.push(`## The judge could not answer`);
out.push("");
const failed = rows.filter((x) => x.judgeFailed);
out.push(
  `${failed.length} claims fell back to the deterministic \`partial\` after a failed judge ` +
    `(${failed.reduce((s, x) => s + x.calls, 0)} calls spent for nothing).`,
);

if (withBodies) {
  out.push("");
  out.push(`## The merge-body candidate`);
  out.push("");
  const measured = rows.filter((x) => x.bodyMatch !== null);
  const hit = measured.filter((x) => x.bodyMatch === true);
  out.push(
    `${measured.length} of ${rows.length} claims measured against a clone` +
      (clonesMissing ? ` (${clonesMissing} release(s) had no clone or range — run \`pnpm corpus-clones\`)` : "") +
      `; **${hit.length} (${pct(hit.length, measured.length)}) carry their core title verbatim in an anchor commit's body** — ` +
      `the merge-commit workflow's counterpart of the squash-subject match that already makes an entry \`generated\`.`,
  );
  out.push("");
  out.push(
    ...table(
      ["", "Claims", "Judged", "Calls today", "Second look", "Splits"],
      [
        ["body match", hit, hit.filter((x) => x.judged)],
        ["no match", measured.filter((x) => !x.bodyMatch), measured.filter((x) => !x.bodyMatch && x.judged)],
      ].map(([label, xs, judged]) => [
        label as string,
        String((xs as Row[]).length),
        String((judged as Row[]).length),
        String((xs as Row[]).reduce((s, x) => s + x.calls, 0)),
        String((xs as Row[]).filter((x) => x.secondLook).length),
        String((xs as Row[]).filter((x) => x.split).length),
      ]),
    ),
  );
  out.push("");
  out.push(`### What the matched claims answer today`);
  out.push("");
  out.push(
    ...table(
      ["Final verdict", "Claims"],
      Object.entries(count(hit, (x) => x.verdict))
        .sort((a, b) => b[1] - a[1])
        .map(([v, n]) => [`\`${v}\``, String(n)]),
    ),
  );
}

out.push("");
out.push(`## Every split-vote case`);
out.push("");
for (const x of rows.filter((x) => x.split)) {
  out.push(`- ${x.repo}@${x.tag} — [${x.votes.join(", ")}] → \`${x.verdict}\`${x.escalated ? " (escalated)" : ""}`);
  out.push(`  "${x.text.slice(0, 140)}"`);
}

console.log(out.join("\n"));
