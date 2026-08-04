// SPDX-License-Identifier: GPL-3.0-or-later
//
// Does the detector catch a release that lies?
//
// `scripts/mutate.ts` mutates this tool's own source and asks whether the test
// suite notices — that measures test coverage. Nothing measured whether the
// *detector* notices a fabricated release, which is the one thing the product
// claims to do. SCORING.md asserts that "a fabricated release cannot look good
// by being good at averages"; the only fabricated release in the repo is a
// four-line fixture no test loads.
//
// So this harness mutates the *notes* of real releases and holds the result
// against what the tool must then say. Four classes, each with an expectation
// that is a property of the diff, not of a model's opinion:
//
//   omission        drop the notes covering the highest-churn commit
//                   → that commit must show up as undocumented
//   bump-overshoot  restate a settled dependency bump as a version the
//                   release did not reach → the pin join must contradict it
//   bump-undershoot restate it as a version the pin never held at all
//                   → it must at least not come out verified
//   foreign-claim   paste in a claim from a different release of the same repo
//                   → it must not come out verified here
//   backtick-noise  fabricate a claim padded with identifiers the diff happens
//                   to contain → it must not come out verified either
//
// It runs with the judge off. Every expectation above is settled by the
// deterministic stages, so the harness is keyless and reproducible — the same
// reason `scripts/mutate.ts` can run nightly without a secret. What it
// measures is therefore the deterministic floor: if a class is missed here, no
// model is involved in the miss.
//
// Diffs come from the clone cache and notes are rebuilt from the claims the
// stored reports carry, so a run needs no network. The rebuild normalises
// headings and bullet syntax; control and mutant are built the same way, so
// that costs interpretability against the original markdown, not validity of
// the comparison.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { analyzeRelease, type CheckSettings } from "../src/check.ts";
import { cloneDirFor } from "../src/paths.ts";
import { loadLocalRange, localRepoContext } from "../src/sources/local.ts";
import { lexicalMatch, tokenize } from "../src/match.ts";
import { run } from "../src/util.ts";
import type { Claim, ClaimResult, DiffFile, Report } from "../src/types.ts";
import { dedupeReports } from "./corpus-aggregate.ts";
import {
  anchorsTo,
  fabricatedClaim,
  noiseTokens,
  OVERSHOOT_VERSION,
  renderNotes,
  restateBumpTarget,
  UNDERSHOOT_VERSION,
} from "./notes-mutations.ts";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const onlyRepo = flag("repo");
const limit = Number(flag("cases") ?? "12");
// Coverage reads every commit's own diff, and each release is analysed five
// times, so a 3,000-commit range costs more wall clock than the rest of a
// watch home together. The bound is named in the output rather than applied
// quietly: a release skipped for size is not a release that passed.
const maxCommits = Number(flag("max-commits") ?? "1200");
const reportsDir = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--repo" && args[args.indexOf(a) - 1] !== "--cases");

const MUTATION_CLASSES = [
  "omission",
  "bump-overshoot",
  "bump-undershoot",
  "foreign-claim",
  "backtick-noise",
] as const;
type MutationClass = (typeof MUTATION_CLASSES)[number];

interface Case {
  repoLabel: string;
  headRef: string;
  mutation: MutationClass;
  /** Not every release offers every class — a release with no dependency bump
   * cannot have one inverted, and skipping is not the same as passing. */
  applicable: boolean;
  detected?: boolean;
  detail: string;
}

/** Churn of a commit, merges excluded — the same rule completeness applies. */
async function commitChurn(
  files: (sha: string) => Promise<DiffFile[]>,
  sha: string,
): Promise<number> {
  try {
    const list = await files(sha);
    return list.reduce((n, f) => n + f.additions + f.deletions, 0);
  } catch {
    return 0;
  }
}

const settings: CheckSettings = {
  judgeMode: "off",
  engine: null,
  escalateEngine: null,
  concurrency: 4,
  reverse: true,
  baseline: 0,
  history: null,
  findings: false,
};

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

const dir = reportsDir ?? "reports";
const parsed: Report[] = [];
for (const f of await findReports(dir)) {
  try {
    const r = JSON.parse(await readFile(f, "utf8")) as Report;
    if (r?.repoLabel && r.headRef && r.metrics && r.baseRef) parsed.push(r);
  } catch {
    // an unreadable report is not a case
  }
}
const reports = dedupeReports(parsed).filter((r) => !onlyRepo || r.repoLabel === onlyRepo);
if (!reports.length) {
  console.error(
    `No usable report JSON under ${dir}. Point this at a watch home's reports directory, e.g. ~/release-watch/reports.`,
  );
  process.exit(2);
}

/** Other releases of the same repo, for the foreign-claim donor. */
const byRepo = new Map<string, Report[]>();
for (const r of reports) byRepo.set(r.repoLabel, [...(byRepo.get(r.repoLabel) ?? []), r]);

const cases: Case[] = [];
const skipped: string[] = [];
let analysed = 0;

for (const report of reports) {
  if (analysed >= limit) break;
  const cloneUrl = report.linkBase ?? `https://github.com/${report.repoLabel}`;
  const clone = await cloneDirFor(cloneUrl);
  if (!clone) {
    skipped.push(`${report.repoLabel}@${report.headRef}: no cache directory`);
    continue;
  }
  // A clone that does not carry both ends of the range answers nothing, and a
  // fetch here would make the harness depend on a network it must not need.
  try {
    await run("git", ["-C", clone, "rev-parse", "--verify", `${report.baseRef}^{commit}`]);
    await run("git", ["-C", clone, "rev-parse", "--verify", `${report.headRef}^{commit}`]);
  } catch {
    skipped.push(`${report.repoLabel}@${report.headRef}: refs not in the local clone`);
    continue;
  }

  const range = await loadLocalRange(clone, report.baseRef, report.headRef);
  if (range.commits.length > maxCommits) {
    skipped.push(
      `${report.repoLabel}@${report.headRef}: ${range.commits.length} commits over the --max-commits ${maxCommits} bound`,
    );
    continue;
  }
  const context = await localRepoContext(clone, report.headRef);
  const claims = report.results.map((r) => r.claim);
  const base = {
    repoLabel: report.repoLabel,
    baseRef: report.baseRef,
    headRef: report.headRef,
    ...range,
  };
  const analyse = (notes: string) =>
    analyzeRelease({ ...base, notes, warnings: [] }, context, null, settings);

  let control: Report;
  try {
    control = await analyse(renderNotes(claims));
  } catch (err) {
    skipped.push(`${report.repoLabel}@${report.headRef}: ${(err as Error).message.slice(0, 80)}`);
    continue;
  }
  analysed++;
  const label = `${report.repoLabel}@${report.headRef}`;
  const add = (mutation: MutationClass, applicable: boolean, detected: boolean | undefined, detail: string) =>
    cases.push({ repoLabel: report.repoLabel, headRef: report.headRef, mutation, applicable, detected, detail });

  // ---- omission ---------------------------------------------------------
  // The whole point of the completeness component: hide the biggest thing
  // that shipped and the tool has to say so. Which claims are hiding it has
  // to be decided by the same two routes coverage itself grants — the anchor
  // and the lexical bar — or the mutation removes the wrong lines and the
  // commit stays covered for a reason that has nothing to do with the notes.
  {
    const uncovered = new Set((control.uncovered ?? []).map((u) => u.commit.sha));
    const ranked = (
      await Promise.all(
        range.commits
          .filter((c) => !uncovered.has(c.sha))
          .map(async (c) => ({ c, churn: await commitChurn(range.commitFiles, c.sha) })),
      )
    ).sort((a, b) => b.churn - a.churn);
    let hidden: { churn: number; sha: string; covering: Claim[] } | null = null;
    for (const { c, churn } of ranked.slice(0, 8)) {
      const files = await range.commitFiles(c.sha).catch(() => [] as DiffFile[]);
      const covering = claims.filter(
        (cl) => anchorsTo(cl, c.sha, c.prNumbers) || lexicalMatch(cl, files).score >= 5,
      );
      // A zero-churn commit hides nothing, and a release already at
      // completeness 0 has no room to lose any — neither is a detector
      // failure, and counting them as one would flatter the harness in the
      // other direction.
      if (churn > 0 && covering.length && covering.length < claims.length) {
        hidden = { churn, sha: c.sha, covering };
        break;
      }
    }
    if (!hidden || !control.metrics.scores.completeness) {
      add(
        "omission",
        false,
        undefined,
        hidden ? "release documents nothing to begin with" : "no covered commit whose covering claims can be removed",
      );
    } else {
      const kept = claims.filter((cl) => !hidden.covering.includes(cl));
      const mutant = await analyse(renderNotes(kept));
      const nowUncovered = mutant.uncovered?.some((u) => u.commit.sha === hidden.sha) ?? false;
      add(
        "omission",
        true,
        nowUncovered,
        `${hidden.churn} lines hidden behind ${hidden.covering.length} claim(s); completeness ` +
          `${control.metrics.scores.completeness} → ${mutant.metrics.scores.completeness}`,
      );
    }
  }

  // ---- bump-overshoot / bump-undershoot ---------------------------------
  // A version the diff can settle without any model. The candidate is read
  // off the claim's own verdict, not off `reconciliation.bumps`: that block
  // only exists when the findings pass produced something, and the findings
  // pass needs a judge — so the deterministic join's own output is invisible
  // in a judge-free run even though the join ran and decided the verdict.
  {
    const settled = control.results.find(
      (r: ClaimResult) =>
        r.claim.bump &&
        r.verdict === "verified" &&
        r.evidence.methods.includes("pin-anchor") &&
        r.claim.text.includes(r.claim.bump.to),
    );
    if (!settled?.claim.bump) {
      add("bump-overshoot", false, undefined, "no bump claim the pins settled");
      add("bump-undershoot", false, undefined, "no bump claim the pins settled");
    } else {
      const target = settled.claim;
      const restate = async (version: string) => {
        const text = restateBumpTarget(target.text, target.bump!.to, version);
        const mutant = await analyse(
          renderNotes(claims.map((cl) => (cl.id === target.id ? { ...cl, text } : cl))),
        );
        return mutant.results.find((r: ClaimResult) => r.claim.text === text);
      };
      const over = await restate(OVERSHOOT_VERSION);
      add(
        "bump-overshoot",
        true,
        over?.verdict === "contradicted",
        `${target.bump.name} → ${OVERSHOOT_VERSION} (release lands short); verdict ${over?.verdict ?? "not parsed"}`,
      );
      const under = await restate(UNDERSHOOT_VERSION);
      add(
        "bump-undershoot",
        true,
        under ? under.verdict !== "verified" : undefined,
        `${target.bump.name} → ${UNDERSHOOT_VERSION} (a version the pin never held); verdict ${under?.verdict ?? "not parsed"}`,
      );
    }
  }

  // ---- foreign-claim ----------------------------------------------------
  // Someone else's true statement is still false here. The donor is taken
  // from the most distant release of the same repo, because the neighbouring
  // one plausibly touches the same code and would make this a coin flip.
  {
    const line = byRepo.get(report.repoLabel) ?? [];
    const here = line.indexOf(report);
    // Farthest sibling in the repo's own release order: the neighbouring
    // release plausibly touches the same code, which would make a miss
    // indistinguishable from an honest match.
    const farthest = here * 2 >= line.length ? line[0] : line[line.length - 1];
    const donor = (farthest === report ? undefined : farthest)?.results
      .filter((x) => x.claim.kind === "change" && x.verdict === "verified")
      .filter((x) => tokenize(x.claim.text).length >= 4)
      .at(0);
    if (!donor) {
      add("foreign-claim", false, undefined, "no donor claim in a sibling release");
    } else {
      const planted: Claim = { ...donor.claim, id: -1 };
      const mutant = await analyse(renderNotes([...claims, planted]));
      const landed = mutant.results.find((r: ClaimResult) => r.claim.text === planted.text);
      add(
        "foreign-claim",
        true,
        landed ? landed.verdict !== "verified" : undefined,
        `planted "${planted.text.slice(0, 48)}" → ${landed?.verdict ?? "not parsed"}`,
      );
    }
  }

  // ---- backtick-noise ---------------------------------------------------
  // A claim nobody wrote, asserting something the diff does not say, padded
  // with two identifiers the diff does contain. Two backticked hits clear the
  // lexical bar, and clearing it settles the claim without a judge.
  {
    const picks = noiseTokens(range.files, claims, 2);
    if (picks.length < 2) {
      add("backtick-noise", false, undefined, "diff carries too few identifiers to pad with");
    } else {
      const planted = fabricatedClaim(picks);
      const mutant = await analyse(renderNotes([...claims, planted]));
      const landed = mutant.results.find((r: ClaimResult) => r.claim.text === planted.text);
      add(
        "backtick-noise",
        true,
        landed ? landed.verdict !== "verified" : undefined,
        `fabricated with \`${picks[0]}\`/\`${picks[1]}\` → ${landed?.verdict ?? "not parsed"}`,
      );
    }
  }

  if (!asJson) console.error(`  checked ${label}`);
}

const summary = MUTATION_CLASSES.map((mutation) => {
  const mine = cases.filter((c) => c.mutation === mutation);
  const applicable = mine.filter((c) => c.applicable);
  return {
    mutation,
    applicable: applicable.length,
    detected: applicable.filter((c) => c.detected === true).length,
    missed: applicable.filter((c) => c.detected === false).length,
    inconclusive: applicable.filter((c) => c.detected === undefined).length,
    skipped: mine.length - applicable.length,
  };
});

// The reference is a yardstick, not a CI gate: this harness needs a watch
// home, and CI has none. It exists so that a change to matching, coverage or
// the pin join cannot quietly move a detection rate without someone deciding
// that it should move.
const REFERENCE = "test/eval/reference-detection.json";
if (args.includes("--freeze")) {
  const frozen = {
    date: new Date().toISOString().slice(0, 10),
    releases: analysed,
    engine: "off (deterministic only)",
    classes: Object.fromEntries(
      summary.map((s) => [s.mutation, { applicable: s.applicable, detected: s.detected }]),
    ),
  };
  await writeFile(REFERENCE, `${JSON.stringify(frozen, null, 2)}\n`);
  console.error(`Frozen: ${analysed} releases → ${REFERENCE}`);
}

const regressed: string[] = [];
try {
  const ref = JSON.parse(await readFile(REFERENCE, "utf8")) as {
    releases: number;
    classes: Record<string, { applicable: number; detected: number }>;
  };
  for (const s of summary) {
    const was = ref.classes[s.mutation];
    if (!was || !was.applicable || !s.applicable) continue;
    const before = was.detected / was.applicable;
    const now = s.detected / s.applicable;
    if (now < before - 0.001) {
      regressed.push(
        `${s.mutation}: ${s.detected}/${s.applicable} now, ${was.detected}/${was.applicable} frozen`,
      );
    }
  }
} catch {
  // No reference yet — --freeze writes the first one.
}

if (asJson) {
  console.log(JSON.stringify({ releases: analysed, summary, cases, skipped, regressed }, null, 2));
  process.exit(regressed.length ? 1 : 0);
}

console.log(`\nadversarial notes — ${analysed} releases, judge off (deterministic stages only)\n`);
console.log("  class            applicable  detected  missed  n/a");
for (const s of summary) {
  console.log(
    `  ${s.mutation.padEnd(17)}${String(s.applicable).padStart(10)}${String(s.detected).padStart(10)}` +
      `${String(s.missed + s.inconclusive).padStart(8)}${String(s.skipped).padStart(5)}`,
  );
}
const misses = cases.filter((c) => c.applicable && c.detected !== true);
if (misses.length) {
  console.log("\nmissed:");
  for (const m of misses) {
    console.log(`  ${m.mutation.padEnd(16)} ${m.repoLabel}@${m.headRef} — ${m.detail}`);
  }
}
if (skipped.length) {
  console.log(`\n${skipped.length} release(s) skipped:`);
  for (const s of skipped.slice(0, 8)) console.log(`  ${s}`);
  if (skipped.length > 8) console.log(`  … and ${skipped.length - 8} more (--json lists all)`);
}
if (regressed.length) {
  console.log(`\nworse than ${REFERENCE}:`);
  for (const r of regressed) console.log(`  ${r}`);
  process.exit(1);
}
