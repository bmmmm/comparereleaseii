// SPDX-License-Identifier: GPL-3.0-or-later
//
// Default changes across a watch home's reports — the census behind the
// `defaults` surface and the Pareto input for which classes it ships.
//
// A default flipped in a few lines is the cheapest consequential change a
// release can carry, and the one the tool answered worst: the claim check
// says "true" (truth is not salience), the config-key delta cancels a value
// change as a moved line, and the findings pass spends its budget elsewhere
// (openai/codex rust-v0.157.0: `default_enabled: false → true`, read 7 of
// 1091 files, no finding). Before any class enters the report, this measures
// what each class contains over the corpus and how often the notes name it:
//
//   - class `config`: a literal changed under a key in a config-category file
//     or settings-shaped JSON;
//   - class `source`: the same in source, on a defaults/features/settings
//     path or on a line that calls itself a default;
//   - class `toggle`: a setter argument (`.promisc(false)`) — measured here,
//     NOT shipped by the surface: no key owns the value, so there is nothing
//     a note could name. It enters only if these numbers say a reviewer
//     would act on it.
//
// The extractor is `defaultCandidates` in src/substance.ts — the same code
// the surface runs, so the census cannot drift from the product. Diffs come
// from the clone cache via loadLocalRange (no network, no judge); releases
// without a clone are counted and skipped (`pnpm corpus-clones` fetches them).
//
//   node scripts/defaults-census.ts <reports dir>          # summary on stderr, rows as JSON on stdout
//   node scripts/defaults-census.ts <reports dir> --md     # the summary on stdout instead
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { cloneDirFor } from "../src/paths.ts";
import { loadLocalRange } from "../src/sources/local.ts";
import { defaultCandidates, namedByClaims, type DefaultClass } from "../src/substance.ts";
import type { Report } from "../src/types.ts";
import { dedupeReports } from "./corpus-aggregate.ts";

const args = process.argv.slice(2);
const asMarkdown = args.includes("--md");
const dir = args.find((a) => !a.startsWith("--"));
if (!dir) {
  console.error("Usage: node scripts/defaults-census.ts <reports dir> [--md]");
  process.exit(2);
}

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
  base: string;
  file: string;
  name: string;
  from: string;
  to: string;
  class: DefaultClass;
  /** Some claim names the owner (identifier or substring, case-insensitive). */
  named: boolean;
}

const CLASSES: DefaultClass[] = ["config", "source", "toggle"];
const rows: Row[] = [];
const perRelease: Array<{ key: string; files: number; byClass: Record<DefaultClass, [number, number]> }> = [];
let measured = 0;
let clonesMissing = 0;
const started = Date.now();
for (const r of reports) {
  if (!r.baseRef) continue;
  const clone = await cloneDirFor(r.linkBase ?? `https://github.com/${r.repoLabel}`);
  let files;
  try {
    ({ files } = await loadLocalRange(clone ?? "", r.baseRef, r.headRef));
  } catch {
    clonesMissing++;
    continue;
  }
  measured++;
  const claims = (r.results ?? []).map((x) => x.claim);
  const byClass: Record<DefaultClass, [number, number]> = { config: [0, 0], source: [0, 0], toggle: [0, 0] };
  for (const c of defaultCandidates(files, { toggles: true })) {
    const named = namedByClaims(c.name, claims);
    rows.push({ repo: r.repoLabel, tag: r.headRef, base: r.baseRef, ...c, named });
    byClass[c.class][0]++;
    if (!named) byClass[c.class][1]++;
  }
  perRelease.push({ key: `${r.repoLabel}@${r.headRef}`, files: files.length, byClass });
}

const pct = (n: number, d: number) => (d === 0 ? "—" : `${((n / d) * 100).toFixed(0)} %`);
const table = (header: string[], body: string[][]): string[] => [
  `| ${header.join(" | ")} |`,
  `|${header.map((_, i) => (i === 0 ? "---" : "---:")).join("|")}|`,
  ...body.map((cells) => `| ${cells.join(" | ")} |`),
];

const out: string[] = [];
out.push("# Defaults census");
out.push("");
out.push(
  `${reports.length} releases, ${measured} measured against a clone` +
    (clonesMissing ? ` (${clonesMissing} without a clone or range — run \`pnpm corpus-clones\`)` : "") +
    `, ${rows.length} candidate default changes, ${((Date.now() - started) / 1000).toFixed(0)} s.`,
);
out.push("");
out.push("## Per class");
out.push("");
out.push(
  ...table(
    ["Class", "Changes", "Unnamed in notes", "Releases with ≥1", "Median per such release"],
    CLASSES.map((cls) => {
      const xs = rows.filter((x) => x.class === cls);
      const rel = perRelease.filter((p) => p.byClass[cls][0] > 0);
      const counts = rel.map((p) => p.byClass[cls][0]).sort((a, b) => a - b);
      const med = counts.length ? counts[Math.floor(counts.length / 2)] : 0;
      return [
        `\`${cls}\``,
        String(xs.length),
        `${xs.filter((x) => !x.named).length} (${pct(xs.filter((x) => !x.named).length, xs.length)})`,
        `${rel.length} of ${measured}`,
        String(med),
      ];
    }),
  ),
);
out.push("");
out.push("## Releases carrying the most candidates");
out.push("");
out.push(
  ...table(
    ["Release", "Files", "config (unnamed)", "source (unnamed)", "toggle (unnamed)"],
    perRelease
      .map((p) => ({ ...p, total: CLASSES.reduce((s, c) => s + p.byClass[c][0], 0) }))
      .filter((p) => p.total > 0)
      .sort((a, b) => b.total - a.total || (a.key < b.key ? -1 : 1))
      .slice(0, 15)
      .map((p) => [
        p.key,
        String(p.files),
        ...CLASSES.map((c) => `${p.byClass[c][0]} (${p.byClass[c][1]})`),
      ]),
  ),
);
for (const cls of CLASSES) {
  const xs = rows.filter((x) => x.class === cls && !x.named);
  out.push("");
  out.push(`## Unnamed \`${cls}\` changes (${xs.length})`);
  out.push("");
  for (const x of xs) {
    out.push(`- ${x.repo}@${x.tag} \`${x.file}\`: \`${x.name}\` ${x.from} → ${x.to}`);
  }
}

// One write, no process.exit after it: on macOS a pipe stdout is non-blocking
// and exiting right after console.log truncates at 64 KiB (test/stdout.test.ts).
if (asMarkdown) {
  console.log(out.join("\n"));
} else {
  console.error(out.slice(0, out.findIndex((l) => l.startsWith("## Unnamed"))).join("\n"));
  console.log(JSON.stringify({ releases: reports.length, measured, clonesMissing, rows }, null, 1));
}
