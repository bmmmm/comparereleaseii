// SPDX-License-Identifier: GPL-3.0-or-later
//
// How do the corpus's bump notes spell the version a pin came FROM?
//
// The pin join reads a bump claim's destination and, since 2026-08-09, its
// origin — positionally rather than for equality. That rule is only defensible
// because of the distribution this script measures, and `docs/corpus.md` and
// `SCORING.md` both quote its numbers:
//
//   555 bump claims across 108 releases, 216 naming a from-version, 76 of
//   those with a pin the diff actually moved —
//     40 name the pin's own starting point                       exact
//     26 name a later hop of a move the release aggregated       later-hop
//     10 name a version the release neither held nor passed      outside
//
// The 26 are why requiring the origins to agree is the wrong rule: one line
// per hop is how an honest Dependabot release is written. Re-run this after
// any change to `detectBumpClaim`, `resolveBumpClaims` or the corpus, and if
// the shape of the distribution moves, the rule that rests on it has to be
// argued again.
//
//   node scripts/corpus-bump-origins.ts [reports dir]   # default tmp/corpus
//
// Reads stored reports only — the pins are already in them, so this needs no
// clone, no network and no judge.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveBumpClaims } from "../src/reconcile.ts";
import { dedupeReports } from "./corpus-aggregate.ts";
import type { Report } from "../src/types.ts";

const root = process.argv[2] ?? "tmp/corpus";

async function findReports(d: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith(".json")) found.push(p);
    }
  }
  await walk(d);
  return found;
}

const parsed: Report[] = [];
for (const f of await findReports(root)) {
  try {
    const r = JSON.parse(await readFile(f, "utf8")) as Report;
    if (r?.repoLabel && r.headRef && r.metrics && r.baseRef) parsed.push(r);
  } catch {
    // not a report
  }
}
const reports = dedupeReports(parsed);
if (!reports.length) {
  console.error(`No usable report JSON under ${root}. Point this at a reports directory.`);
  process.exit(2);
}

const tally = new Map<string, number>();
const bump = (k: string): void => {
  tally.set(k, (tally.get(k) ?? 0) + 1);
};
const examples = new Map<string, string[]>();

let bumpClaims = 0;
let withFrom = 0;
let joinable = 0;

for (const r of reports) {
  const resolved = resolveBumpClaims(
    r.results.map((x) => x.claim),
    r.pins ?? [],
  );
  for (const b of resolved) {
    bumpClaims++;
    if (b.claimed.from === undefined) {
      bump("names no from-version");
      continue;
    }
    withFrom++;
    if (!b.observed) {
      bump("no pin of that name in the diff");
      continue;
    }
    joinable++;
    const check = b.fromCheck ?? "not comparable";
    bump(`${check} · ${b.status}`);
    if (check !== "exact") {
      const line = `${r.repoLabel}@${r.headRef} ${b.claimed.name}: note ${b.claimed.from} → ${b.claimed.to}, diff ${b.observed.from} → ${b.observed.to} [${b.status}]`;
      examples.set(check, [...(examples.get(check) ?? []), line]);
    }
  }
}

// The three rows the documentation quotes, kept apart from the per-status
// breakdown below: a rule was argued from these and nothing else.
const byCheck = (name: string): number =>
  [...tally].filter(([k]) => k.startsWith(`${name} ·`)).reduce((n, [, v]) => n + v, 0);

console.log(
  `${reports.length} releases · ${bumpClaims} bump claims · ${withFrom} name a from-version · ` +
    `${joinable} of those have a pin the diff moved\n`,
);
console.log(`  exact       ${String(byCheck("exact")).padStart(4)}  the pin's own starting point`);
console.log(`  later-hop   ${String(byCheck("later-hop")).padStart(4)}  inside the move the pin made`);
console.log(`  outside     ${String(byCheck("outside")).padStart(4)}  a version the release never held`);
console.log(`\nby join status:`);
for (const [k, v] of [...tally].sort()) console.log(`  ${k.padEnd(34)} ${v}`);

for (const [check, list] of examples) {
  console.log(`\n${check} (${list.length}):`);
  for (const l of list.slice(0, 30)) console.log(`  ${l}`);
  if (list.length > 30) console.log(`  … ${list.length - 30} more`);
}
