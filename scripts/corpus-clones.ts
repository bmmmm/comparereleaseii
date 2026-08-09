// SPDX-License-Identifier: GPL-3.0-or-later
//
// Is the corpus measurable, and if not, make it so.
//
// `mutate-notes` and `corpus-stats` read stored reports, but every diff they
// need comes from the clone cache — and a release whose refs the cache does
// not carry is skipped. Silently enough that it went unnoticed: on 2026-08-09
// **52 of 111** releases were being skipped for missing clones, so every
// detection rate this repo had published was measured on half its corpus, and
// `omission` read 35/36 where the full corpus says 59/66. A rate over half a
// corpus is not a smaller measurement of the same thing.
//
// So this reports the gap first and closes it second. It clones through the
// tool's own `ensureClone`, which means the same cache layout, the same
// `--filter=blob:none`, and the same directory a real check would use: nine
// repositories cost 0.4 GB and about half a minute, `zen-browser/desktop`
// (a Firefox fork, 5.7 GB of blobs) included.
//
//   node scripts/corpus-clones.ts tmp/corpus --dry-run     # what is missing
//   node scripts/corpus-clones.ts tmp/corpus               # clone/fetch it
//   node scripts/corpus-clones.ts tmp/corpus --skip a/b,c/d
//
// Run it before trusting a number out of `mutate-notes`, and after every
// corpus refresh: a watch home that gained a repository gains an unmeasurable
// release with it.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { cloneDirFor } from "../src/paths.ts";
import { ensureClone } from "../src/sources/local.ts";
import { run } from "../src/util.ts";
import { dedupeReports } from "./corpus-aggregate.ts";
import type { Report } from "../src/types.ts";

const args = process.argv.slice(2);
const root = args.find((a) => !a.startsWith("--")) ?? "tmp/corpus";
const dry = args.includes("--dry-run");
const skipArg = args[args.indexOf("--skip") + 1];
const skip = new Set(args.includes("--skip") && skipArg ? skipArg.split(",") : []);

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
    /* not a report */
  }
}
const reports = dedupeReports(parsed);

/** Releases per repo, and the clone URL they agree on. */
const byRepo = new Map<string, { url: string; releases: Report[] }>();
for (const r of reports) {
  const url = r.linkBase ?? `https://github.com/${r.repoLabel}`;
  const entry = byRepo.get(r.repoLabel) ?? { url, releases: [] };
  entry.releases.push(r);
  byRepo.set(r.repoLabel, entry);
}

async function missingRefs(dir: string, releases: Report[]): Promise<string[]> {
  const missing: string[] = [];
  for (const r of releases) {
    for (const ref of [r.baseRef, r.headRef]) {
      try {
        await run("git", ["-C", dir, "rev-parse", "--verify", `${ref}^{commit}`]);
      } catch {
        missing.push(`${r.headRef} (${ref})`);
        break;
      }
    }
  }
  return missing;
}

for (const [repoLabel, { url, releases }] of [...byRepo].sort()) {
  const dir = await cloneDirFor(url);
  if (!dir) {
    console.log(`${repoLabel}: no cache directory`);
    continue;
  }
  const before = await missingRefs(dir, releases);
  if (!before.length) {
    console.log(`${repoLabel}: ${releases.length} release(s), all refs present`);
    continue;
  }
  if (skip.has(repoLabel)) {
    console.log(`${repoLabel}: ${before.length}/${releases.length} missing — SKIPPED (${url})`);
    continue;
  }
  if (dry) {
    console.log(`${repoLabel}: ${before.length}/${releases.length} missing — would clone ${url}`);
    continue;
  }
  const started = Date.now();
  try {
    await ensureClone(url, dir);
  } catch (err) {
    console.log(`${repoLabel}: clone failed — ${(err as Error).message.split("\n")[0].slice(0, 100)}`);
    continue;
  }
  const after = await missingRefs(dir, releases);
  const secs = Math.round((Date.now() - started) / 1000);
  console.log(
    `${repoLabel}: ${before.length}/${releases.length} missing → ${after.length} after ${secs}s` +
      (after.length ? ` [${after.slice(0, 4).join(", ")}]` : ""),
  );
}
