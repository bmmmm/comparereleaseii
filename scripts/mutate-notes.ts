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
// Those five are the five somebody invented, and all three holes they found
// were the same mistake wearing different clothes: a route reading "similar
// enough" as "supported". `--generate` adds a sixth that nobody invented —
//
//   inverted-claim  a model rewrites a claim the control VERIFIED so it
//                   asserts the opposite → it must not come out verified
//
// — which needs an engine twice over (to write the lie, to catch it) and is
// therefore opt-in. Its expectation still rests on the diff: the diff
// demonstrably does X, and both X and ¬X cannot hold of it. What it has that
// the others do not is one more link — whether the model really inverted the
// sentence instead of rewording it — so a survivor is a lead to read by hand,
// its rate never joins the frozen reference, and the output says so.
//
// It has already earned its keep. GyulyVGC/sniffnet v1.4.1: "Fix support for
// IPinfo's databases" inverted to "Break support for IPinfo's databases" comes
// back `verified`. Every identifier survives the inversion, the lexical bar
// clears on them, and the claim is settled before the sentence is ever read —
// the same mistake again, found by a class nobody would have written.
//
// Measuring a fix to the ladder with --generate needs --no-cache, and this is
// not the usual "verify parser changes" caveat. The model tends to write the
// SAME inversion for the same claim, so the prompt — and with it the cache key
// — is identical across runs, while a change to routing or to the second look
// changes neither. On 2026-08-07 that served the pre-fix `verified` back and
// the repaired ladder read as still broken; --no-cache turned the same run
// from 0/1 detected into 1/1.
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
import { pinBumps } from "../src/pins.ts";
import { run } from "../src/util.ts";
import type { Claim, ClaimResult, DiffFile, Report, Verdict } from "../src/types.ts";
import { dedupeReports, median } from "./corpus-aggregate.ts";
import {
  anchorsTo,
  buildInversionPrompt,
  bumpCovers,
  fabricatedClaim,
  noiseTokens,
  OVERSHOOT_VERSION,
  parseInversion,
  renderNotes,
  restateBumpTarget,
  UNDERSHOOT_VERSION,
} from "./notes-mutations.ts";
import { resolveEngines, type JudgeEngine } from "../src/judge.ts";

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
  "inverted-claim",
] as const;
type MutationClass = (typeof MUTATION_CLASSES)[number];

/**
 * Classes whose expectation is a property of the diff alone, and nothing
 * else's opinion. Only these belong in the frozen reference: a rate that can
 * move because a model phrased something differently is not a regression
 * signal, it is weather.
 */
const FROZEN_CLASSES: MutationClass[] = MUTATION_CLASSES.filter(
  (m) => m !== "inverted-claim",
);

/**
 * The generated class needs an engine twice over — once to write the lie, once
 * to judge it — so it is opt-in and the rest of the harness stays keyless.
 * Under `--judge off` it would also be meaningless: an inverted claim keeps
 * the original's identifiers, so the lexical bar settles it `verified` without
 * anything reading the sentence. That is the deterministic floor's known
 * limit, not a finding.
 */
const generate = args.includes("--generate");

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

// The four deterministic classes run judge-free, always — that is what makes
// their rates reproducible without a key. The generated class needs an engine,
// and only its own analysis gets one.
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

let engine: JudgeEngine | null = null;
let judgedSettings: CheckSettings = settings;
if (generate) {
  const resolved = await resolveEngines({
    judgeMode: "auto",
    engine: (flag("engine") ?? "claude-cli") as "claude-cli" | "api" | "openai" | "off",
    model: flag("model"),
    openaiUrl: flag("openai-url"),
    escalate: "off",
    cache: !args.includes("--no-cache"),
  });
  engine = resolved.engine;
  if (!engine) {
    console.error(
      "--generate needs a judge engine — it asks a model to write the lie and then asks one to catch it. " +
        "Install the claude CLI, export ANTHROPIC_API_KEY, or point --engine openai --model <m> at a local server.",
    );
    process.exit(2);
  }
  judgedSettings = { ...settings, judgeMode: "auto", engine, findings: false };
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

/**
 * What a judge would have been asked, across the control runs. Free to count
 * here — the control analysis already ran — and it is the third axis a
 * threshold sweep needs: a bar that catches more fabrications by sending more
 * claims to a model has not made the tool better for nothing.
 *
 * The condition mirrors `verifyClaims`: a claim reaches the judge unless the
 * deterministic pass settled it as verified, the pins settled it, or it
 * asserts nothing about this release.
 */
function wouldReachJudge(r: ClaimResult): boolean {
  if (r.verdict === "skipped") return false;
  if (r.evidence.methods.includes("pin-anchor")) return false;
  if (r.verdict !== "verified") return true;
  // A `verified` the deterministic pass reached on identifier overlap alone is
  // not settled — `verifyClaims` sends it to a judge anyway (`identifierOnly`
  // there). Read off the stored result, that is a verdict nobody judged, whose
  // evidence is lexical, and which is not true by construction. Missing this
  // case does not just understate the bill: `pnpm sweep` reads this axis to
  // price a bar, so a bar that moves overlap-only claims would have looked free.
  return !r.generated && r.evidence.methods.includes("lexical");
}

const cases: Case[] = [];
const skipped: string[] = [];
let analysed = 0;
const cost = { claims: 0, wouldJudge: 0 };
/**
 * The control runs' own scores. Not a quality axis and never to be optimized —
 * the whole point of the frozen thresholds is that a number moving by itself
 * makes every score incomparable with every other. It is here so that a change
 * to a bar can be seen to move scores, and a person can decide whether that
 * movement is right. Higher is not better.
 */
const controlScores: { correctness: number[]; completeness: number[]; overall: number[] } = {
  correctness: [],
  completeness: [],
  overall: [],
};

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
  const analyse = (notes: string, s: CheckSettings = settings) =>
    analyzeRelease({ ...base, notes, warnings: [] }, context, null, s);

  let control: Report;
  try {
    control = await analyse(renderNotes(claims));
  } catch (err) {
    skipped.push(`${report.repoLabel}@${report.headRef}: ${(err as Error).message.slice(0, 80)}`);
    continue;
  }
  analysed++;
  cost.claims += control.results.length;
  cost.wouldJudge += control.results.filter(wouldReachJudge).length;
  controlScores.correctness.push(control.metrics.scores.correctness);
  controlScores.overall.push(control.metrics.scores.overall);
  if (control.metrics.scores.completeness !== null) {
    controlScores.completeness.push(control.metrics.scores.completeness);
  }
  const label = `${report.repoLabel}@${report.headRef}`;
  const add = (mutation: MutationClass, applicable: boolean, detected: boolean | undefined, detail: string) =>
    cases.push({ repoLabel: report.repoLabel, headRef: report.headRef, mutation, applicable, detected, detail });

  // ---- omission ---------------------------------------------------------
  // The whole point of the completeness component: hide the biggest thing
  // that shipped and the tool has to say so. Which claims are hiding it has
  // to be decided by the same claim-specific routes coverage itself grants —
  // the anchor, the lexical bar and the pin join — or the mutation removes the
  // wrong lines and the commit stays covered for a reason that has nothing to
  // do with the notes. The pin join was added to coverage a day after this
  // block was written and not to this list, and the omission the harness kept
  // reporting for `opencloud-eu/opencloud@v7.3.0` was that gap, not a
  // detector miss: see `bumpCovers`. The union route is deliberately absent —
  // it is claim-independent, so "the claims covering via it" is every claim
  // in the release.
  {
    const uncovered = new Set((control.uncovered ?? []).map((u) => u.commit.sha));
    // The pin join is granted per verdict, so the mutation needs the control
    // run's own. Its results are re-parsed from the rendered notes rather than
    // being these claim objects, and `renderNotes` writes the text verbatim,
    // so the text is the join; where one text occurs twice the covering
    // verdict wins, because that is the one that would have covered.
    const controlVerdict = new Map<string, Verdict>();
    for (const r of control.results) {
      const covers = r.verdict === "verified" || r.verdict === "partial";
      if (covers || !controlVerdict.has(r.claim.text)) controlVerdict.set(r.claim.text, r.verdict);
    }
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
      const pins = pinBumps(files);
      const covering = claims.filter(
        (cl) =>
          anchorsTo(cl, c.sha, c.prNumbers) ||
          lexicalMatch(cl, files).score >= 5 ||
          bumpCovers(cl, controlVerdict.get(cl.text), pins),
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

  // ---- inverted-claim (generated, opt-in) --------------------------------
  // The class nobody invented: a model writes the lie. The input is a claim
  // the control run VERIFIED against this diff, so the diff demonstrably does
  // X and the replacement asserts that it did the opposite — both cannot hold
  // of one diff. What no other class has to assume is that the model really
  // inverted the sentence instead of rewording it, which is why a survivor
  // here is a lead to read by hand and why this class never joins the frozen
  // reference.
  if (engine) {
    // The richest verified claim, not the first: a longer assertion gives the
    // model something to actually flip. Auto-generated PR-list entries are
    // deliberately IN — inverting one breaks the title/subject match that made
    // it generated, and what catches it afterwards is the lexical route, which
    // is precisely the "similar enough = supported" reading this class exists
    // to probe. Excluding them cost every applicable case on the first run.
    const verified = control.results
      .filter(
        (r: ClaimResult) =>
          r.claim.kind === "change" &&
          r.verdict === "verified" &&
          // Bump claims have two classes of their own, with a stronger
          // expectation than "not verified".
          !r.claim.bump &&
          tokenize(r.claim.text).length >= 4,
      )
      .sort((a, b) => tokenize(b.claim.text).length - tokenize(a.claim.text).length)[0];
    if (!verified) {
      add("inverted-claim", false, undefined, "no verified handwritten claim to invert");
    } else {
      let inversion = null;
      try {
        inversion = parseInversion(
          await engine.judge(buildInversionPrompt(verified.claim.section, verified.claim.text)),
          verified.claim.text,
        );
      } catch (err) {
        add("inverted-claim", false, undefined, `generating the lie failed: ${(err as Error).message.slice(0, 80)}`);
      }
      if (inversion) {
        const swapped = claims.map((cl) =>
          cl.id === verified.claim.id ? { ...cl, text: inversion!.line } : cl,
        );
        const mutant = await analyse(renderNotes(swapped), judgedSettings);
        const landed = mutant.results.find((r: ClaimResult) => r.claim.text === inversion!.line);
        add(
          "inverted-claim",
          true,
          landed ? landed.verdict !== "verified" : undefined,
          `"${verified.claim.text.slice(0, 60)}" → "${inversion.line.slice(0, 60)}"` +
            `${inversion.inverted ? ` (flipped: ${inversion.inverted})` : ""} → ${landed?.verdict ?? "not parsed"}`,
        );
      } else if (!cases.some((c) => c.headRef === report.headRef && c.mutation === "inverted-claim")) {
        add("inverted-claim", false, undefined, "the model returned no usable inversion");
      }
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
      summary
        .filter((s) => FROZEN_CLASSES.includes(s.mutation))
        .map((s) => [s.mutation, { applicable: s.applicable, detected: s.detected }]),
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
    // A generated class cannot regress against a frozen number: its rate
    // moves when a model phrases the lie differently, which is weather, not
    // a change in the detector.
    if (!FROZEN_CLASSES.includes(s.mutation)) continue;
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

const medianScores = {
  correctness: median(controlScores.correctness),
  completeness: median(controlScores.completeness),
  overall: median(controlScores.overall),
};

if (asJson) {
  console.log(
    JSON.stringify(
      { releases: analysed, summary, cost, scores: medianScores, cases, skipped, regressed },
      null,
      2,
    ),
  );
  process.exit(regressed.length ? 1 : 0);
}

console.log(
  `\nadversarial notes — ${analysed} releases, judge off (deterministic stages only)` +
    (engine ? `\ninverted-claim generated and judged by ${engine.name}` : "") +
    "\n",
);
console.log("  class            applicable  detected  missed  n/a");
for (const s of summary) {
  if (!s.applicable && !s.skipped) continue;
  console.log(
    `  ${s.mutation.padEnd(17)}${String(s.applicable).padStart(10)}${String(s.detected).padStart(10)}` +
      `${String(s.missed + s.inconclusive).padStart(8)}${String(s.skipped).padStart(5)}` +
      (FROZEN_CLASSES.includes(s.mutation) ? "" : "   generated — a lead, not a rate"),
  );
}
console.log(
  `\n  judge cost of the control runs: ${cost.wouldJudge}/${cost.claims} claim(s) the` +
    ` deterministic pass leaves for a model` +
    `\n  their median scores: correctness ${medianScores.correctness ?? "—"} ·` +
    ` completeness ${medianScores.completeness ?? "—"} · overall ${medianScores.overall ?? "—"}`,
);
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
