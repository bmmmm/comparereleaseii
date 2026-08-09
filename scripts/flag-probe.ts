// SPDX-License-Identifier: GPL-3.0-or-later
//
// Where does `surface.cliFlags` get its entries, and how often does it fire?
//
// This is the harness behind ROADMAP entry 6. It walks a reports directory,
// rebuilds each stored release's diff from the clone cache, and answers two
// questions the entry is measured in: how the raw `--flag` occurrences in that
// diff distribute over path shapes (vendored trees, stylesheets and Vue SFCs,
// CI/tooling config, test artifacts, everything else), and in what share of
// releases the field ends up announcing new flags at all.
//
// It deliberately duplicates none of the extractor's rules. What the field
// reports comes from `releaseSurface` itself, so the numbers cannot drift away
// from the code; the buckets are a description of the input, not a second copy
// of the filter. Where a stored report is still available the two are compared
// per range, which is the byte-identity check the 2026-08-08 investigation ran
// by hand — after an extractor change the expected result is a *difference*,
// and the script prints which flags left.
//
// The numbers are a property of what it is pointed at: a reports directory
// (argv, e.g. `tmp/corpus`) and the clone cache that happens to hold those
// repositories. A range the cache cannot produce is named and skipped, never
// silently dropped — the scope is part of the answer. Two runs against
// different corpora are not comparable, and neither is a run against a corpus
// that has grown since.
//
//   node scripts/flag-probe.ts <reports dir> [--json <occurrences.json>]
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseUnifiedDiff } from "../src/sources/local.ts";
import { cloneDirFor } from "../src/paths.ts";
import { fileCategory } from "../src/metrics.ts";
import { sideLines } from "../src/pins.ts";
import { releaseSurface } from "../src/substance.ts";
import { run } from "../src/util.ts";
import type { ConfigDelta, DiffFile } from "../src/types.ts";

/** The one thing that must match `src/substance.ts`: what counts as a `--flag`
 * in the first place. Everything downstream of this is the real code. */
const FLAG_LITERAL = /(?<![\w-])--([a-z][a-z0-9]+(?:-[a-z0-9]+)*)\b/g;

/** The path shapes entry 6 bucketed by, in priority order. A file matches the
 * first one it belongs to; `other` is the bucket the entry called
 * "legitimately ambiguous" — subprocess arguments and real parsers. */
const BUCKETS: Array<[string, RegExp]> = [
  ["vendored", /(^|\/)(vendor|node_modules)\//],
  ["stylesheet", /\.(css|scss|sass|less|styl|vue)$/i],
  ["ci/tooling", /(^|\/)\.(github|gitlab|circleci|woodpecker)\/|(^|\/)(\.woodpecker\.(?:ya?ml|star)|\.mcp\.json)$/i],
  ["test artifact", /(^|\/)(__snapshots__|__tests__|tests?|spec)\/|\.snap$/i],
];

const bucketOf = (path: string): string =>
  BUCKETS.find(([, re]) => re.test(path))?.[0] ?? "other";

interface Occurrence {
  range: string;
  path: string;
  category: string;
  bucket: string;
  side: "-" | "+";
  flag: string;
  line: string;
}

/** Every `--flag` the diff contains, before any of the extractor's gates —
 * the input the field selects from, which is what the buckets describe. */
function occurrences(files: DiffFile[], range: string): Occurrence[] {
  const out: Occurrence[] = [];
  for (const f of files) {
    if (!f.patch) continue;
    const category = fileCategory(f.path);
    const bucket = bucketOf(f.path);
    for (const side of ["-", "+"] as const) {
      for (const line of sideLines(f.patch, side)) {
        for (const m of line.matchAll(FLAG_LITERAL)) {
          out.push({ range, path: f.path, category, bucket, side, flag: `--${m[1]}`, line });
        }
      }
    }
  }
  return out;
}

interface StoredCase {
  repo: string;
  base: string;
  head: string;
  stored: ConfigDelta;
}

async function storedCases(reports: string): Promise<StoredCase[]> {
  const cases: StoredCase[] = [];
  for (const dir of await readdir(reports, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const name of await readdir(join(reports, dir.name))) {
      if (!name.endsWith(".json")) continue;
      const raw = JSON.parse(await readFile(join(reports, dir.name, name), "utf8")) as {
        repoLabel?: string;
        baseRef?: string;
        headRef?: string;
        surface?: { cliFlags?: ConfigDelta };
      };
      const cliFlags = raw.surface?.cliFlags;
      if (!raw.repoLabel || !raw.baseRef || !raw.headRef || !cliFlags) continue;
      cases.push({ repo: raw.repoLabel, base: raw.baseRef, head: raw.headRef, stored: cliFlags });
    }
  }
  return cases.sort((a, b) => (`${a.repo}${a.head}` < `${b.repo}${b.head}` ? -1 : 1));
}

const args = process.argv.slice(2);
const jsonAt = args.indexOf("--json");
const jsonOut = jsonAt === -1 ? null : args[jsonAt + 1];
const reports = args.find((a, i) => !a.startsWith("--") && (i === 0 || args[i - 1] !== "--json"));
if (!reports) {
  console.error("usage: node scripts/flag-probe.ts <reports dir> [--json <occurrences.json>]");
  process.exit(2);
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const all: Occurrence[] = [];
const skipped: string[] = [];
const differs: string[] = [];
let inScope = 0;
let firedStored = 0;
let firedLive = 0;
let storedTotal = 0;
let reportedAdded = 0;
let reportedRemoved = 0;

for (const c of await storedCases(reports)) {
  const range = `${c.repo}@${c.base}…${c.head}`;
  storedTotal++;
  if (c.stored.added.length) firedStored++;
  const dir = await cloneDirFor(`https://github.com/${c.repo}`);
  if (!dir) {
    skipped.push(`${range}: no private cache directory available`);
    continue;
  }
  let diff: string;
  try {
    diff = (await run("git", ["-C", dir, "diff", "--patch", "--no-color", `${c.base}...${c.head}`]))
      .stdout;
  } catch {
    skipped.push(`${range}: not in the clone cache`);
    continue;
  }
  const files = parseUnifiedDiff(diff);
  const live = releaseSurface(files).cliFlags;
  inScope++;
  if (live.added.length) firedLive++;
  reportedAdded += live.added.length;
  reportedRemoved += live.removed.length;
  if (!same(live, c.stored)) {
    const gone = [...c.stored.added, ...c.stored.removed].filter(
      (f) => !live.added.includes(f) && !live.removed.includes(f),
    );
    differs.push(
      `${range}: stored +${c.stored.added.length}/−${c.stored.removed.length} → ` +
        `live +${live.added.length}/−${live.removed.length}${gone.length ? ` (gone: ${gone.join(" ")})` : ""}`,
    );
  }
  all.push(...occurrences(files, range));
}

if (jsonOut) await writeFile(jsonOut, `${JSON.stringify(all, null, 1)}\n`);

const scanned = all.filter((o) => o.category === "source" || o.category === "config");
const tally = new Map<string, number>();
for (const o of scanned) tally.set(o.bucket, (tally.get(o.bucket) ?? 0) + 1);

console.log(`reports with a flag surface: ${storedTotal}`);
console.log(`ranges the clone cache reproduces: ${inScope}`);
for (const s of skipped) console.log(`  out    ${s}`);
for (const d of differs) console.log(`  moved  ${d}`);
console.log(`\nflag-literal occurrences in scanned files: ${scanned.length} (whole diff: ${all.length})`);
for (const [bucket, n] of [...tally].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${bucket.padEnd(14)} ${String(n).padStart(5)}  ${((100 * n) / scanned.length).toFixed(1)}%`);
}
console.log(`\nreported by the field: ${reportedAdded} added, ${reportedRemoved} removed`);
console.log(
  `fire rate (cliFlags.added non-empty) — stored reports ${firedStored}/${storedTotal}, ` +
    `live over the reproducible ranges ${firedLive}/${inScope}`,
);
