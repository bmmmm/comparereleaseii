// SPDX-License-Identifier: GPL-3.0-or-later
//
// Threshold sweep — a tool, never automation.
//
// The bars this tool judges by are hand-set numbers: the lexical bar of 5, the
// 0.5 file majority in coverage, the 0.25 weight a generated entry carries.
// Three of them were changed by feel and measured afterwards, which is the
// wrong order. This runs the order forwards: sweep a dial over its plausible
// range, measure the three things that actually trade off against each other,
// and print the Pareto front.
//
//   detection    fabricated releases the deterministic stages catch
//                (`scripts/mutate-notes.ts`, the frozen instrument)
//   fidelity     golden cases the judge-free ladder answers within `expected`,
//                and — the one that must never rise — the ones it rubber-stamps
//                as `verified` where `expected` says otherwise
//   cost         claims the deterministic pass leaves for a model
//
// It REPORTS. It does not write a constant, and it must not grow the ability
// to: a threshold that moves by itself makes every score incomparable with
// every other and turns the frozen references into decoration. A person reads
// the front, picks a point, and edits the source with the measurement in the
// comment — which is how `>= 5` and the 0.5 majority got their comments.
//
// Mechanics follow `scripts/mutate.ts`: the dial IS the literal in the source,
// so a value is applied by patching the file and restored afterwards, on the
// way out of a signal too. Measurements run in child processes because Node
// caches modules — an in-process sweep would measure the first value four times.
//
// Out of scope, stated rather than skipped: `MATCH_BAR` (`src/reconcile.ts`)
// is the fourth hand-set bar, and none of the three axes above can see it. It
// gates which findings a claim is said to describe, in a layer that is
// informational and never scored, and that layer only exists when the findings
// pass ran — which needs a judge. Sweeping it needs a fourth axis and a judged
// corpus; this script would report three zeros and call it a front.
import { readFile, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { loadGoldenCases } from "../src/calibrate.ts";
import { parseClaims } from "../src/claims.ts";
import { pinBumps } from "../src/pins.ts";
import { resolveBumpClaims } from "../src/reconcile.ts";
import { verifyClaims } from "../src/verify.ts";
import type { ClaimResult, ReleaseData } from "../src/types.ts";

/** One site the dial's number lives at. All sites move together — they are
 * one decision written down more than once. */
export interface Site {
  file: string;
  /** `%` is the placeholder the value is substituted into. */
  pattern: string;
}

export interface Dial {
  name: string;
  what: string;
  /** The value in the source right now — the front marks it. */
  current: string;
  values: string[];
  sites: Site[];
}

export const DIALS: Dial[] = [
  {
    name: "lexical-bar",
    what:
      "how many identifier hits make a claim's lexical match strong enough to " +
      "settle it without a judge — and to let a commit count as documented",
    current: "5",
    values: ["3", "4", "5", "6", "7", "8"],
    sites: [
      // Three sites in the ladder and coverage, plus the harness's own mirror
      // of the coverage rule: it uses the bar to decide which claims cover the
      // commit it hides, so leaving it behind would make an omission look
      // missed for a reason that has nothing to do with the bar.
      { file: "src/verify.ts", pattern: "lex.score >= %" },
      { file: "src/verify.ts", pattern: "lexicalMatch(claim, files).score >= %" },
      { file: "scripts/mutate-notes.ts", pattern: "lexicalMatch(cl, files).score >= %" },
    ],
  },
  {
    name: "file-majority",
    what:
      "the share of a commit's files that must already be cited as evidence " +
      "before the commit counts as documented",
    current: "1",
    values: ["0.34", "0.5", "0.67", "0.8", "1"],
    sites: [{ file: "src/verify.ts", pattern: "hit / files.length >= %" }],
  },
  {
    name: "generated-weight",
    what:
      "what an auto-generated PR-list entry is worth against a handwritten " +
      "claim in the correctness score",
    current: "0.25",
    values: ["0", "0.1", "0.25", "0.5", "1"],
    sites: [{ file: "src/metrics.ts", pattern: "(r.generated ? % : 1)" }],
  },
];

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const asJson = args.includes("--json");

// ---------------------------------------------------------------------------
// Child mode: the golden-set half of the measurement, in a fresh process so it
// reads the patched source.
// ---------------------------------------------------------------------------

interface GoldenMeasurement {
  cases: number;
  /** Cases the judge-free ladder answers within `expected`. */
  agree: number;
  /**
   * Cases it answers `verified` where `expected` does not allow it. The axis
   * that must never rise: every one of these is a fabrication the tool would
   * wave through before a model ever sees it.
   */
  rubberStamps: number;
  /** Cases left for a judge — the golden set's own share of the cost axis. */
  wouldJudge: number;
}

function wouldReachJudge(r: ClaimResult): boolean {
  return (
    r.verdict !== "skipped" &&
    r.verdict !== "verified" &&
    !r.evidence.methods.includes("pin-anchor")
  );
}

/** The same wiring `test/deterministic.test.ts` pins, measured instead of pinned. */
async function measureGolden(): Promise<GoldenMeasurement> {
  const cases = await loadGoldenCases();
  let agree = 0;
  let rubberStamps = 0;
  let wouldJudge = 0;
  for (const gc of cases) {
    const notes = `## ${gc.section}\n\n- ${gc.claim}\n`;
    const claims = parseClaims(notes);
    if (claims.length !== 1) continue;
    const data: ReleaseData = {
      repoLabel: "eval/fixture",
      baseRef: "v1.0.0",
      headRef: "v1.1.0",
      notes,
      commits: [],
      files: gc.hunks.map((h) => ({
        path: h.path,
        status: "modified",
        additions: 1,
        deletions: 0,
        patch: h.hunk,
      })),
      commitFiles: async () => [],
      warnings: [],
    };
    const pins = pinBumps(data.files, { repoLabel: data.repoLabel });
    const bumps = new Map(
      resolveBumpClaims(claims, pins)
        .filter((b) => b.observed)
        .map((b) => [claims[b.claim].id, b]),
    );
    const [res] = await verifyClaims(data, claims, {
      judgeMode: "off",
      engine: null,
      escalateEngine: null,
      concurrency: 4,
      maxHunks: 6,
      maxEvidenceChars: 20000,
      bumps,
    });
    if (gc.expected.includes(res.verdict)) agree++;
    if (res.verdict === "verified" && !gc.expected.includes("verified")) rubberStamps++;
    if (wouldReachJudge(res)) wouldJudge++;
  }
  return { cases: cases.length, agree, rubberStamps, wouldJudge };
}

// This is what `measureGoldenChild` below spawns: a fresh process that reads
// the patched source, measures, prints one JSON line and exits.
if (import.meta.main && process.env.SWEEP_MEASURE_GOLDEN) {
  console.log(JSON.stringify(await measureGolden()));
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Parent mode: patch, measure, restore.
//
// Everything below is a declaration; `main()` at the end is what runs, and it
// runs only when this file IS the entry point. The test imports the module to
// assert that every dial's pattern is still in the source it claims to patch —
// importing an unguarded runner would start a corpus sweep inside `pnpm test`.
// ---------------------------------------------------------------------------

const site = (s: Site, value: string): string => s.pattern.replace("%", value);

/**
 * Apply one value to every site of a dial; returns the originals to restore.
 *
 * Grouped by FILE, not by site. Two sites of the same dial live in
 * `src/verify.ts`, and reading per site meant the second one recorded the
 * already-patched text as its "original" — the restore then wrote that back
 * and left half the patch on disk, where the next `git add -u` would have
 * committed it. Found by running this, not by reading it.
 */
async function apply(
  dial: Dial,
  value: string,
  /** Filled as files are read, so a throw mid-apply still knows what to undo. */
  originals: Array<{ file: string; source: string }>,
): Promise<void> {
  const byFile = new Map<string, Site[]>();
  for (const s of dial.sites) byFile.set(s.file, [...(byFile.get(s.file) ?? []), s]);

  for (const [file, sites] of byFile) {
    const source = await readFile(file, "utf8");
    originals.push({ file, source });
    let patched = source;
    for (const s of sites) {
      const find = site(s, dial.current);
      if (!patched.includes(find)) {
        // A pattern that no longer matches would sweep nothing and print a
        // flat front — the most convincing possible way to be wrong.
        throw new Error(
          `STALE: ${file} no longer contains "${find}" — the ${dial.name} dial has drifted from the source.`,
        );
      }
      patched = patched.split(find).join(site(s, value));
    }
    await writeFile(file, patched);
  }
}

/**
 * Put every swept file back and prove it. The whole script edits tracked
 * source, so "the restore ran" is not the same claim as "the file is what it
 * was" — and the difference is a patched constant sitting in someone's next
 * commit.
 */
async function restore(originals: Array<{ file: string; source: string }>): Promise<void> {
  for (const o of originals) {
    await writeFile(o.file, o.source);
    if ((await readFile(o.file, "utf8")) !== o.source) {
      throw new Error(
        `RESTORE FAILED for ${o.file} — it still differs from what the sweep read. Check \`git diff\` before committing anything.`,
      );
    }
  }
}

export interface Point {
  value: string;
  detection: { applicable: number; detected: number; rate: number };
  perClass: Record<string, { applicable: number; detected: number }>;
  golden: GoldenMeasurement;
  corpus: { claims: number; wouldJudge: number };
  /**
   * What the dial did to the corpus's own scores. Reported, deliberately NOT
   * a front axis: higher is not better here, and a sweep that ranked points by
   * the scores they produce would be the tuning loop this whole file refuses
   * to be. It is here so a person can see that a bar moves scores, and decide
   * whether that movement is right on the semantics.
   */
  scores: { correctness: number | null; completeness: number | null; overall: number | null };
  failed?: string;
}

function measureDetection(
  reportsDir: string,
  cases: string,
): {
  summary: Array<{ mutation: string; applicable: number; detected: number }>;
  cost: { claims: number; wouldJudge: number };
  scores: Point["scores"];
} {
  const res = spawnSync(
    "node",
    ["scripts/mutate-notes.ts", reportsDir, "--json", "--cases", cases],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  // Exit 1 means "worse than the frozen reference", which is the normal
  // outcome for most of a sweep and not an error.
  if (!res.stdout) throw new Error(`mutate-notes produced nothing: ${res.stderr?.slice(0, 300)}`);
  return JSON.parse(res.stdout) as ReturnType<typeof measureDetection>;
}

function measureGoldenChild(): GoldenMeasurement {
  const res = spawnSync("node", ["scripts/sweep.ts"], {
    encoding: "utf8",
    env: { ...process.env, SWEEP_MEASURE_GOLDEN: "1" },
  });
  if (!res.stdout) throw new Error(`golden measurement produced nothing: ${res.stderr?.slice(0, 300)}`);
  return JSON.parse(res.stdout) as GoldenMeasurement;
}

// A signal mid-sweep would leave a patched source on disk, where the next
// `git add -u` commits it. Same guard `scripts/mutate.ts` grew after that
// happened once.
let active: Array<{ file: string; source: string }> = [];
const restoreSync = (signal: NodeJS.Signals) => {
  for (const o of active) writeFileSync(o.file, o.source);
  process.stderr.write(`\n${signal}: swept source restored.\n`);
  process.exit(130);
};

async function main(): Promise<number> {
  process.on("SIGINT", restoreSync);
  process.on("SIGTERM", restoreSync);

  const dialName = flag("dial");
  const selected = dialName ? DIALS.filter((d) => d.name === dialName) : DIALS;
  if (!selected.length) {
    console.error(
      `No dial named "${dialName}". Dials:\n${DIALS.map((d) => `  ${d.name} — ${d.what}`).join("\n")}`,
    );
    return 2;
  }
  const override = flag("values");
  if (override && selected.length !== 1) {
    console.error("--values needs exactly one --dial; a value list means nothing across dials.");
    return 2;
  }
  const reportsDir = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
  if (!reportsDir) {
    console.error(
      "Point this at a watch home's reports directory: pnpm sweep ~/release-watch/reports [--dial <name>] [--values a,b,c]",
    );
    return 2;
  }
  const cases = flag("cases") ?? "12";

const results: Array<{ dial: Dial; points: Point[] }> = [];

for (const dial of selected) {
  const values = override ? override.split(",").map((v) => v.trim()) : dial.values;
  const points: Point[] = [];
  for (const value of values) {
    if (!asJson) process.stderr.write(`${dial.name} = ${value} … `);
    // Applying is itself a write, so its own failure has to restore what it
    // already changed — the stale-pattern throw used to escape the try below
    // and leave the first file patched.
    const originals: Array<{ file: string; source: string }> = [];
    active = originals;
    try {
      await apply(dial, value, originals);
    } catch (err) {
      await restore(originals);
      active = [];
      throw err;
    }
    try {
      const detection = measureDetection(reportsDir, cases);
      const golden = measureGoldenChild();
      const applicable = detection.summary.reduce((n, s) => n + s.applicable, 0);
      const detected = detection.summary.reduce((n, s) => n + s.detected, 0);
      points.push({
        value,
        detection: { applicable, detected, rate: applicable ? detected / applicable : 0 },
        perClass: Object.fromEntries(
          detection.summary.map((s) => [s.mutation, { applicable: s.applicable, detected: s.detected }]),
        ),
        golden,
        corpus: detection.cost,
        scores: detection.scores,
      });
      if (!asJson) {
        process.stderr.write(
          `detection ${detected}/${applicable} · golden ${golden.agree}/${golden.cases}` +
            ` (${golden.rubberStamps} stamped) · judge ${detection.cost.wouldJudge}/${detection.cost.claims}` +
            ` · median overall ${detection.scores.overall ?? "—"}\n`,
        );
      }
    } catch (err) {
      points.push({
        value,
        detection: { applicable: 0, detected: 0, rate: 0 },
        perClass: {},
        golden: { cases: 0, agree: 0, rubberStamps: 0, wouldJudge: 0 },
        corpus: { claims: 0, wouldJudge: 0 },
        scores: { correctness: null, completeness: null, overall: null },
        failed: (err as Error).message.slice(0, 200),
      });
      if (!asJson) process.stderr.write(`FAILED — ${(err as Error).message.slice(0, 120)}\n`);
    } finally {
      await restore(originals);
      active = [];
    }
  }
  results.push({ dial, points });
}
  return render(results);
}

/**
 * The points nothing else beats on all three axes at once. Detection up,
 * fidelity up, rubber-stamps down, cost down — a point another point matches
 * or beats everywhere, and beats somewhere, is dominated and drops out.
 *
 * Rubber-stamps are treated as their own axis rather than folded into
 * fidelity: waving a fabrication through is not one wrong answer among
 * others, and a point that buys two agreements with one stamp must not be
 * able to look like an improvement.
 */
export function paretoFront(points: Point[]): Point[] {
  const live = points.filter((p) => !p.failed);
  const better = (a: Point, b: Point): boolean => {
    const axes: Array<[number, number]> = [
      [a.detection.rate, b.detection.rate],
      [a.golden.agree, b.golden.agree],
      [-a.golden.rubberStamps, -b.golden.rubberStamps],
      [-a.corpus.wouldJudge, -b.corpus.wouldJudge],
    ];
    return axes.every(([x, y]) => x >= y) && axes.some(([x, y]) => x > y);
  };
  return live.filter((p) => !live.some((q) => q !== p && better(q, p)));
}

const pct = (n: number) => `${(n * 100).toFixed(1)} %`;

function render(results: Array<{ dial: Dial; points: Point[] }>): number {
if (asJson) {
  console.log(
    JSON.stringify(
      results.map(({ dial, points }) => ({
        dial: dial.name,
        current: dial.current,
        points,
        front: paretoFront(points).map((p) => p.value),
      })),
      null,
      2,
    ),
  );
  return 0;
}

for (const { dial, points } of results) {
  const front = new Set(paretoFront(points).map((p) => p.value));
  console.log(`\n## ${dial.name}\n`);
  console.log(`${dial.what}.\n`);
  console.log(
    `  value      detection      golden        stamped   judge cost   front   median c/c/o`,
  );
  for (const p of points) {
    if (p.failed) {
      console.log(`  ${p.value.padEnd(10)} FAILED — ${p.failed}`);
      continue;
    }
    const mark = `${p.value}${p.value === dial.current ? " *" : ""}`;
    const s = p.scores;
    console.log(
      `  ${mark.padEnd(10)} ${`${p.detection.detected}/${p.detection.applicable}`.padEnd(9)}` +
        `${pct(p.detection.rate).padStart(6)}  ${`${p.golden.agree}/${p.golden.cases}`.padEnd(9)}` +
        `${String(p.golden.rubberStamps).padStart(6)}   ` +
        `${`${p.corpus.wouldJudge}/${p.corpus.claims}`.padStart(10)}   ` +
        `${(front.has(p.value) ? "◆" : "").padEnd(7)} ` +
        `${s.correctness ?? "—"}/${s.completeness ?? "—"}/${s.overall ?? "—"}`,
    );
  }
  console.log(
    `\n  * the value in the source now · ◆ on the Pareto front` +
      `\n  median c/c/o = the corpus's own median correctness/completeness/overall.` +
      `\n  Reported, NOT ranked: higher is not better, and a sweep that picked the` +
      `\n  point with the best scores would be the tuning loop this script refuses` +
      `\n  to be. It is here so a bar that moves scores cannot do it unnoticed.`,
  );
  // Every component, not just `overall`: a dial can swing median correctness
  // by 39 points while the hard caps hold `overall` flat, and calling that
  // "scores did not move" is exactly the blind spot the generation marker
  // exists for.
  const live2 = points.filter((p) => !p.failed);
  const movedScores = (["correctness", "completeness", "overall"] as const).some(
    (k) => new Set(live2.map((p) => p.scores[k])).size > 1,
  );
  if (movedScores) {
    console.log(
      `\n  This dial MOVES the corpus's scores. Changing it makes every score` +
        `\n  recorded under the old value incomparable with every score after —` +
        `\n  bump SCORING_GENERATION in src/metrics.ts in the same commit.`,
    );
  }
  // An axis that never moved did not hold — it was not measuring this dial.
  // Without saying so, a flat golden column reads as "fidelity checked and
  // fine", which is the same mistake as a green test that cannot go red.
  const live = points.filter((p) => !p.failed);
  const flat: string[] = [];
  const constant = (of: (p: Point) => number) => new Set(live.map(of)).size <= 1;
  if (live.length > 1) {
    if (constant((p) => p.detection.detected)) flat.push("detection");
    if (constant((p) => p.golden.agree) && constant((p) => p.golden.rubberStamps)) {
      flat.push("golden fidelity");
    }
    if (constant((p) => p.corpus.wouldJudge)) flat.push("judge cost");
  }
  if (flat.length === 3) {
    console.log(
      `\n  Nothing this script measures responded to this dial over ${live.length} value(s) and\n` +
        `  ${points[0]?.corpus.claims ?? 0} claims. The front above is every point tied, which is not advice — either\n` +
        `  the route rarely binds at this corpus size (raise --cases) or these three axes\n` +
        `  cannot see it at all. Do not read a flat sweep as "the current value is fine".`,
    );
  } else if (flat.length) {
    const named =
      flat.length === 2 ? flat.join(" and ") : `${flat.slice(0, -1).join(", ")} and ${flat.at(-1)}`;
    console.log(
      `\n  ${named} did not move anywhere across this dial — ${flat.length === 1 ? "that axis is" : "those axes are"} not\n` +
        `  measuring it, so the front above rests on the rest alone.`,
    );
  }
}

console.log(
  `\nThis reports; it does not decide. Pick a point, edit the constant in the` +
    `\nsource, and put the measurement in its comment — a threshold that moves` +
    `\nby itself makes every score incomparable with every other one.`,
);
  return 0;
}

if (import.meta.main) process.exit(await main());
