# Roadmap

> **Status 2026-08-09 (evening):** v0.12.0 is out (`bf637f3`, tagged) and
> nothing sits unreleased on `main`. The release carries the commit-subject
> rule line in the judge prompt — a behaviour change for every judged run,
> with the reference re-frozen at 42/43 and the README validation table
> re-measured under the three-draw majority protocol behind it. It
> invalidates every verdict-cache entry by construction, so the first watch
> pass under 0.12.0 pays full price and its records open scoring
> generation 2 (undocumented single-file CI pipelines now count as
> sensitive). Also in: the flag-surface exclusions (`vendor/`, `.vue`,
> CI/tooling config — fire rate 50 % → 39.5 %) and the mutation harness's
> pin-join repair (`omission` 35/36; the one case that was never a detector
> miss). The hourly job runs the subscription block in production; the rules
> config lives in the watch home, docs/watchdog.md carries the operator side.
>
> Everything before that is on `main` too — the three original phases, the
> 2026-07-27 block series, the long view, the second axis (shipped as v0.7.0),
> the reconciliation layer, and the "running it teaches it" instruments block.
> This file carries only what is open; the landed plans and their dated
> landed notes live in this file's git history (up to `039460a`).
>
> Forge issues #9, #10 and #11 were closed on 2026-08-09 and sit unreleased
> on `main`: the verdict cache now sweeps the builds it orphaned (99.5 % of
> the measured directory) and answers `cache stats|gc`; the pin join reads a
> bump note's *from* version positionally, which the corpus decided — 26 of
> 76 joinable from-versions name a later hop of an aggregated move and are
> honest, 10 name a version the release never held and are not; and the
> `foreign-claim` donor walks the release line instead of giving up on one
> sibling, which put six releases back into its applicable count (49/49 →
> 55/55, re-frozen). No score moved in any of it.
>
> **Where a fresh session starts:** forge issue #8 (coverage's fourth route
> belongs to no claim), or entry 1 below, which needs new facts more than
> budget. Two measurement threads left over from the rule-line work: three
> before-side draws would settle whether git-cliff's 96→90 belongs to the
> rule or to flicker, and the first production release that fires a watch
> rule is the subscription feature's first real datapoint — `pnpm
> corpus-stats` against a refreshed `tmp/corpus` then names the next free
> deterministic rule. One thing the harness now states that nobody has acted
> on: 52 of the 108 corpus releases are skipped for refs missing from the
> clone cache, so every rate it reports covers half the corpus.

## Open (2026-08-07): what the instruments found and nobody has closed

The "running it teaches it" block is built. Six of its seven entries landed on
2026-08-06, and what those instruments then found was two things. One of them —
`inverted-claim` — was closed on 2026-08-07; the question its closing raised,
the judge arguing from commit subjects, was closed on 2026-08-09 when the rule
line shipped. Both have moved to **Settled** below. What is left here is one
entry: the coverage miss nobody has landed a repair for.

**The line that block did not cross, and this one does not either.** What
running the tool teaches is *where it is wrong* and *where it wastes work*. It
never teaches the tool to look better. Verdicts, weights and bars stay decided
by a person, changed with an A/B, and frozen afterwards — a threshold that
drifts by itself makes every score incomparable with every other and turns the
frozen references into decoration. Nothing here adjusts a number to improve a
score.

The counterpart, learned on 2026-08-09 (entry 1): an instrument can be the
thing that is wrong, and a frozen rate that moves because the instrument was
corrected is not the drift this paragraph forbids — provided the correction is
argued from the instrument's own contract and not from the number it produces.
The test is whether the change touches scoring at all. That one did not, and
the release it had been condemning was documented all along.

The instruments now on hand, and what each is for:

| Command | Answers |
|---|---|
| `pnpm corpus-stats <dir>` | where the judge bill goes, by claim class — the axis a free deterministic rule can be built on |
| `pnpm sweep <dir>` | what a hand-set bar costs on detection, golden fidelity and judge calls. Reports; never writes a constant |
| `pnpm mutate-notes <dir>` | do the deterministic stages catch a release that lies — five classes, frozen rates |
| `pnpm mutate-notes <dir> --generate` | …and one the model writes, whose survivors are leads to read |
| `comparerelease --add-golden` | a wrong verdict becomes a regression case, in the `field` category that never moves the frozen fitness gate |

The precedent the entry below is measured against is the bump block. It
did not start as a plan; it started as a corpus count — 8 of 12 contradicted
claims were dependency bumps — and ended as a deterministic rule that is
*both* more accurate than the judge on that class and free.

### 1. `omission` 35/36 — coverage's fourth route, one case left

Mostly closed 2026-08-06. The union was never the whole story: what covered
the commits it should not was *bump-claim evidence*, which is `go.mod` and
`go.sum` by construction and therefore no fingerprint at all. Bump claims now
document the commits that move the pin they name, and the corpus read
`omission` 32/34 with completeness up 29 points net. Five candidate repairs
were measured and rejected on the way — three move no rate whatsoever, the
file-type variant reaches 33/34 only by condemning honestly documented
dependency work (`opencloud@v7.1.0` 96 → 1), and the churn-share variant costs
exactly what switching the route off costs, which is what it was. Their
numbers live in the comment at the route in `src/verify.ts`, and the rule they
all broke is in **Settled** below: a repair that counts a documented bump as
undocumented is not a repair.

**One of the two remaining cases was never a detector miss (2026-08-09).**
Identified the way this entry has demanded since 2026-08-07 — from
`pnpm mutate-notes tmp/corpus --repo opencloud-eu/opencloud --json`, then by
instrumenting the mutant per route rather than reading this file:

- the missed commit is `04a924f7` after all — *bump
  `github.com/open-policy-agent/opa` from 1.17.1 to 1.18.1*, 29,027 lines
  across 50 files — and the route holding it is the **bump pin join**,
  measured in the mutant and not assumed: anchors 0, claim evidence 0,
  evidence-file majority **0/50**, lexical substance 0, pin join **1** (in the
  control it is 2 — see below).
- the claim holding it is not the one this entry was chasing. v7.3.0 bumps opa
  in three commits — `42987b03` 1.15.2→1.17.1 (41,505 lines), `04a924f7`
  1.17.1→1.18.1, `bce52eec` 1.18.1→1.18.2 — the range moves the pin 1.15.2 →
  1.18.2, and the notes carry **one** opa claim, for the last hop. The pin
  join covers all three commits from it, versions deliberately not having to
  agree. That is the rule that closed this class doing exactly what it says.
- so the 2026-08-06 diagnosis was right and the 2026-08-07 correction was
  wrong: the entry was aiming at the wrong **claim**, not the wrong commit.
  In the control this route covers `04a924f7` from *two* bump claims — opa's
  and `rogpeppe/go-internal`'s, since the commit moves that pin as well — and
  the path rule severs only the second, go-internal having no tree in the
  commit while opa's sits in 30 of its 50 paths. The mutation had already
  removed the go-internal claim (it scores 6 on the lexical bar), so in the
  mutant there was nothing left for the rule to sever. "Moves nothing" was an
  accurate measurement of the wrong hypothesis.
- and the `omission` was the harness's, not the detector's. The mutation
  removes the claims covering the commit by anchor and by the lexical bar —
  the routes coverage granted when that block was written on **2026-08-05**.
  The pin join joined coverage on **2026-08-06** and never joined the
  mutation, so the opa claim stayed in the mutant notes: against that commit's
  diff it scores **4** on a bar of 5, one short *because* the version it names
  is not the version that commit moves. The tool was reading a note that was
  still there, and saying so.

**Repaired in the harness, and no product code was touched.** `bumpCovers`
(`scripts/notes-mutations.ts`) is the pin-join half of coverage, and the
omission mutation now strips all three claim-specific routes; the union route
stays out, because it is claim-independent and "the claims covering via it" is
every claim in the release. `pnpm mutate-notes tmp/corpus --cases 80`, before
and after, judge off, 55 releases:

    omission                     32/34 → 35/36   (applicable rose: two traefik
                                                  releases had no mutatable
                                                  commit before)
    bump-overshoot               22/22 → 22/22
    bump-undershoot              22/22 → 22/22
    foreign-claim                49/49 → 49/49
    backtick-noise               50/55 → 50/55
    median correctness           50    → 50
    median completeness          38.5  → 38.5
    median overall               45    → 45
    per repo, omission           opencloud 8/9 → 9/9 · web 7/8 → 7/8
                                 traefik n/a → 2/2 · four others unmoved

The canary is not a measurement here, it is a construction. `src/verify.ts`
keeps every scoring number, threshold and bar, so `opencloud@v7.1.0` cannot
move — and it does not: control completeness **98 before and after**. That is
what separates this from the five rejected candidates. Each of those bought
detection with 16 points of median completeness because each was the route's
off-switch in disguise; this one costs zero because it stopped mutating a
release into a lie the notes still told the truth about. What v7.1.0's case
now hides is 58,365 lines behind two claims instead of 211 behind one, and it
is still detected.

**What is left is one case, and it is the union route.**
`opencloud-eu/web@v7.0.0`, commit `86fff671` (*feat: tiptap integration*),
5,567 lines across 72 files, held by the **evidence-file majority** at
**57/72 = 0.79** — re-confirmed 2026-08-09 with the same instrumentation: it
moves no pin, so nothing above touches it, and no claim of its own clears any
bar. Its 57 files are cited as evidence by *other* claims. That is the
claim-independent union this whole block started from, and the three repairs
measured against it on 2026-08-06 are all rejected (numbers at the route).
Whoever reopens it needs a rule that tells "these files are already spoken
for" from "this commit is spoken for" — and it still has to survive v7.1.0.

The method is the finding as much as the result: all five candidates for this
route were aimed from a comment instead of from a measurement, and all five
missed. What closed the case was not a sixth candidate — no product code
changed — but the case's own `detail` string and a per-route dump of the
mutant, which is what this entry had been asking for since 2026-08-07.

---

## Settled — do not reopen without new facts

- **The judge argued from commit subjects, and a rule line now says it may
  not — closed 2026-08-09.** The justification was 3/4. Across four
  independent `--no-cache` runs on two days,
  `commit-subject-denies-what-the-diff-shows` read `verified · verified ·
  contradicted · verified`, and the one `contradicted` said why in as many
  words — *"the commit's intent per its message is to remove strict
  enforcement"* — over a diff whose only change is deleting
  `InsecureSkipVerify: true`. `overVerified` was 0 throughout, so the failure
  direction was never the rubber-stamp the gate watches for: a stale subject
  buried a claim the diff *proves*, which is the same circularity pointed the
  other way, and a release that ships an honest fix under a misleading
  subject is exactly the release this tool exists for.

  The line that shipped sits in `buildJudgePrompt`'s rules list, directly
  after the changelog rule it generalises:

      - A commit subject is NOT evidence either — it comes from the same hand as the
        notes. The COMMITS block only orients you in the diff: a subject can neither
        support a claim the code does not show nor override one the code does show.

  Both directions on purpose — the reverse one was already enforced in code
  and unenforced in the prompt. The untrusted markers, the response contract
  and the hidden-thinking defaults are untouched, so nothing the small-model
  tolerance rests on moved.

  **After: two independent 43-case `--no-cache` runs against
  `claude-cli/haiku`** — 42/43 and 40/43, `overVerified` 0 in both. Run 1
  fails exactly one case, `bump-release-overtakes-its-own-note`, which the
  frozen reference fails too. Run 2 fails three: that same case, plus
  `commit-subject-names-a-cve-the-diff-never-mentions` and
  `rate-limit-config-vs-flood-claim`, both of them in *this after-run* and
  both to a round-1 `need` for a file they had already been shown. Run 1's
  failure set is a strict subset of run 2's, so there was no trade-off to
  shop between the two. All four commit-subject shapes pass in run 1; the CVE
  shape is the only one run 2 loses, and it failed that same way *before* the
  change (the 2026-08-09 run 1 recorded in this entry's open version), so it
  is the documented flicker rather than something the rule introduced.
  `denies-what-the-diff-shows`, the case the rule exists for, reads
  `verified` in both. Nothing failed newly and reproducibly.
  `test/eval/reference-haiku.json` is re-frozen from run 1 — not for its
  score but because it is the coherent run: its only failure is the
  documented reproducible class failure, and every flicker-prone case
  settled on a verdict.

  **Every cached verdict is invalidated by construction.** The key is
  `sha256(version + engineName + prompt)` and the prompt changed, so no entry
  written before this commit can be read again. The next `watch` pass
  re-judges every claim it reaches, at full price; this is a behaviour change
  for every judged run, not a prompt tidy-up.

  **The README validation table, re-measured judged and serially.** The rule
  the table now states about itself: a row whose score moves is drawn three
  times **on the after side** and publishes the value two of the three agree
  on. A before-side draw is attribution evidence — it answers whether the
  drift predates this rule — and is never a vote, because it is cast by
  different code.

  headscale v0.29.2 holds at 100, restic v0.19.1 at 89 and the fabricated
  negative control at 5 with exit 1; none moved, so none was redrawn.
  git-cliff v2.13.0 drew 90 · 96 · 90 and publishes **90** where the table
  said 95 — the two 90s are verdict-identical down to the same eight
  uncovered commits, so 96 is the outlier and not the mode. Both values are
  in the `solid` bucket, so no label moved.

  What separates any two draws is one or two verdicts on two-part claims
  (*"standardize on yarn and fix the invalid anchor link"* — the yarn half is
  in the diff, the anchor half is not), which is the flicker this repo
  already documents. On git-cliff that single claim also carries five
  commits' coverage with it, which is why its spread is six points rather
  than one. One run was dropped before anything counted: it lost two judge
  calls to the CLI and carried the `judge-unavailable` flag, the load warning
  the A/B trap exists for.

  **vaultwarden 1.37.0 is unresolved and the row is not being decided on a
  coin flip.** Three clean after-side draws read 87 · 84 · 85 — no two agree,
  so the majority rule produces no number and nothing here invents a
  tiebreak. What the draws do agree on is that the published 76 is stale by
  roughly ten points, and the bucket splits 2:1 for `solid` (85, 87) against
  `minor gaps` (84) across the `SCORE_SOLID` boundary that sits inside the
  spread. Attribution for *that* row is settled even though its value is not:
  the parent commit drew 83, so the drift away from 76 predates this rule.
  git-cliff's attribution is weaker and is stated as such — one before-side
  draw read 96, which is the value the after side produced as its outlier, so
  a single before-side draw cannot separate "the rule cost git-cliff the
  website claim" from the same flicker landing the other way. Whoever settles
  either row draws the before side three times too.

  **What reopens it:** judge reasoning that grounds a verdict in a commit
  subject *despite* the rule — found the way this entry was found, by reading
  the runs rather than the scores. A verdict that flips when the subject
  changes and the diff does not is still wrong in whichever direction it
  flips.

- **`checkAndRecord`'s assembly loses its untested status — closed
  2026-08-09.** The pure pieces it calls (`evaluateRules`, `alertDecision`,
  the ledgers) were already tested; the fold that builds a `CheckedRelease`
  from a finished `Report` — components, authors, verdicts, `ruleHits`,
  warnings, broken-promise and judge-fallback counts, `scoreLevel`,
  `releaseUrl`, the `backfilled` flag, and the `recordChecked` write into
  `RepoState` — was not, because nothing in the suite drove a full check
  flow; `runWatch` was only ever pushed into its validation rejections. A new
  seam, `loadAndAnalyze` on `checkAndRecord`'s own args (`src/watch.ts`),
  replaces the network load and `analyzeRelease` pass with a fabricated
  `{ report, link }`; every production caller (`runWatch`, `runBackfill`)
  leaves it undefined, which falls back to the extracted
  `loadAndAnalyzeRelease` — the same inlined code that ran before, unchanged,
  so the 505 pre-existing tests and `pnpm check` are the proof nothing about
  a live run moved. `checkAndRecord` itself went from module-private to
  exported for the same reason `writeReportFiles` already is.

  Four cases in `test/watch.test.ts` drive it: a rich release exercising
  every conditional field at once (contradicted verdict, critical flag,
  judge fallback, broken promise, author ledger, `backfilled`), a release
  that fires three rule shapes at once (path, surface, finding-kind) and
  gets `flagged` from the rule alone, an empty/clean release proving every
  optional field — `warnings`, `scoringGeneration`, `brokenPromises`,
  `unjudged`, `authors`, `ruleHits`, `backfilled` — is truly *absent*, not
  just falsy, and a rule that matches nothing proving `ruleHits` stays `[]`
  rather than disappearing (the field `staleRules` depends on). Four
  distinct assembly steps were broken in turn (a duplicated verdict filter,
  swapped `correctness`/`risk` in `components`, `ruleHits?.length` instead
  of `ruleHits` truthiness, and dropping the author-ledger write) and
  restored; each broke exactly the case that covers it and nothing else,
  which is the `safeSegment` proof this entry existed to get.

  What the harness does not reach: `loadAndAnalyzeRelease` itself (the real
  network/`gh`/clone loaders and `analyzeRelease`'s own pipeline) and the
  outer loop (`runWatch`/`runBackfill`'s retry, lock and promise-ledger
  storage) — both stay exactly as tested (or untested) as before. This
  closes the assembly gap the entry named, not the loaders around it.
- **The `cliFlags` category-boundary leak: three exclusions shipped, the
  fourth measured out — closed 2026-08-09.** Scope for every number below:
  27 corpus tag ranges whose diff the clone cache reproduces byte-identical
  against the stored report, occurrences counted per match on both diff
  sides. `scripts/flag-probe.ts` is the harness; point it at a reports
  directory and it prints its own scope, the bucketing and the fire rate.

  | after | occurrences | flags added | removed | ranges firing |
  |---|---|---|---|---|
  | — (baseline) | 805 | 137 | 94 | 14/27 (51.9%) |
  | `vendor/` | 606 (−24.7%) | 77 | 78 | 13/27 (48.1%) |
  | `.vue` | 373 (−53.7%) | 63 | 68 | 12/27 (44.4%) |
  | single-file CI/tooling config | 315 (−60.9%) | 53 | 54 | 10/27 (37.0%) |

  Corpus-wide the fire rate goes 19/38 → 15/38 (50.0% → 39.5%), the 11
  reports the clone cache cannot reproduce assumed unchanged. The residual
  315 is what the subprocess-noise entry below settled and nothing here
  touches: build and
  packaging scripts that call other binaries (`codesign --deep --options`,
  `git --no-verify`), plus sniffnet's genuine hand-rolled parser. The bucket
  the investigation called "legitimately ambiguous" did not shrink by one
  occurrence — it went from 37% of the field to 95% of it.

  **Where each cut was made, and why not one level lower.** `vendor/` and
  `.vue` are gates on the flag field alone (`ownFlags`, `src/substance.ts`),
  not on `fileCategory`: a vendored Go file *is* source and a Vue SFC *is*
  source, and telling `fileCategory` otherwise would empty a
  vendored-dependency release's rollup and cost a component its symbols.
  What those two paths violate is authorship and syntax, not file kind —
  which is the boundary the host gate already draws with the same
  `VENDORED_PATH`. The CI/tooling pair is the opposite case and goes in
  `fileCategory` proper (`src/metrics.ts`), and the two spellings got there
  from different places: `.woodpecker.star` fell through to *source* and
  shipped its test-runner arguments as flags, while `.woodpecker.yml`
  already matched `CONFIG_FILE` and was `config` — it never contributed a
  flag, it contributed YAML keys, and what it loses is that `configKeys`
  contribution, exactly as `.github/workflows/*.yml` already behaves.
  `.mcp.json` was source and is now config. Neither pattern is anchored to
  the repo root: `(^|\/)` matches at any depth, which is the right
  semantics — a monorepo's per-package pipeline is CI wherever it sits.

  **What that fix reaches, and what it does not.** The `ci/build` half
  reaches every `fileCategory` consumer — the rollup (one release moves 128
  additions out of `source`), `symbolDelta`, `findings`' reading priority —
  and through `sensitiveCategory` the escalation ladder and the risk flags.
  The `.mcp.json` half does **not**: `sensitiveCategory` never consults
  `CONFIG_FILE`, and `sensitiveCategory(".mcp.json")` is `null` before and
  after. So exactly one of the two touches the risk ladder, and that is the
  intended half — a `.woodpecker.*` pipeline was being read as *less*
  sensitive than the one file over in `.woodpecker/`.

  **That makes it a scoring change, and `SCORING_GENERATION` goes 1 → 2.**
  Judge off, input unchanged: a release that modifies a `.woodpecker.*` file
  without documenting it now takes the `undocumented-sensitive` warn — risk
  −10, overall −3, and a bucket boundary sits inside that distance. Nothing
  in the README validation table moves: none of its five releases carries a
  `.woodpecker.*`, `.mcp.json`, `.vue` or vendored path in its diff at all.

  **`.vue`: the extension, not the `<style>` block.** All 233 corpus
  occurrences in `.vue` files were CSS custom properties and none was a
  product flag, so nothing argues for the finer cut on recall. Two things
  argue against it: a unified diff arrives as hunks and cannot see where a
  `<style>` block begins, and 7 of the 233 were outside one anyway —
  `:style` bindings in the template and Tailwind's
  `font-(family-name:--oc-font-family)` spell `--name` in the `<template>`
  half. A line-shape rule (`--x:` / `var(--x)`) would catch 226 of 233 and
  is a heuristic where the file already answers cleanly. The price is a real
  one and is asserted rather than described: a flag a `<script>` block
  genuinely builds goes with the stylesheet (`test/substance.test.ts`).

  **Not shipped: `__snapshots__/*.snap` — measured, and it buys nothing.**
  After the three exclusions it is 16 of the 315 remaining occurrences: one
  file, one flag (`--oc-role-on-surface`), one release, and on *both* diff
  sides. Excluding it moves the fire rate not at all (10/27 → 10/27) and
  makes the reported surface one entry *larger* (removed 54 → 55), because
  the snapshot's copy of that property is currently cancelling a removal
  that is real. The categorisation gap is genuine — `TEST_FILE` has
  `__tests__` but not `__snapshots__`, and `X.spec.ts.snap` also slips its
  `$` anchor — so it is anchored as a TODO at the pattern; whoever fixes it
  justifies it from the category rollup, because the flag surface does not.

  **A correction to the 2026-08-08 numbers.** The 439/11 and the four
  percentages are not reproducible verbatim, and the raw file the entry
  pointed at was never committed — neither was its replica script, so both
  had to be rebuilt from scratch. That is why the harness is tracked now.
  What does reproduce exactly is the fire rate (19 of 38 surface-carrying
  reports, 50.0%) and the extractor itself (27 ranges byte-identical against
  their stored reports). The scope is recoverable too: 439 is exactly the
  `+`-side occurrence count over the 11 reports carrying the "loaded from a
  local partial clone" warning. But *that* scoping buckets
  31.0/35.3/5.9/1.8/26.0, not 46.7/20.0/6.8/3.6/22.8. The recorded
  distribution comes back only counted on both sides over an 11-range subset
  that excludes the two cross-major backfill ranges — 442 occurrences at
  46.8/19.9/7.5/3.6/22.2, every bucket within 1.1 points — so the
  measurement was faithful to a corpus that has since grown. Today's
  baseline over all 27 ranges is 28.9/24.7/7.2/2.0/37.1.

  **What was verified rather than assumed.** `--judge off` stays
  deterministic: two runs over `opencloud-eu/web@v7.1.4…v7.2.0` are
  byte-identical in all four outputs (`--json`, `--md`, `--html`, terminal).
  `fileCategory` feeds neither matching nor coverage — only
  `src/findings.ts` and `src/substance.ts` import it — and
  `pnpm mutate-notes tmp/corpus` reads identical on both sides of the
  change: 8/8, 6/6, 6/6, 12/12, 12/12 over the 12 reproducible releases.
  That run is judge-off, so it says nothing about the ladder; what it does
  say is that the deterministic detection floor did not move. The ladder
  *can* now escalate more claims — for a repo whose evidence paths include a
  `.woodpecker.*` file, which is the point of calling it sensitive, not a
  side effect. `pnpm eval` was not run because it cannot move: none of the
  43 golden cases has a `woodpecker`, `.mcp.json`, `.vue` or vendored path
  among its 46 distinct evidence paths (the one textual `node_modules/` hit
  is diff *content* inside a `package-lock.json` hunk, and every rule here
  keys on the file path).

- **`cliFlags` subprocess noise: no cheap discriminator exists — measured
  and closed 2026-08-08.** Three candidates against 439 real occurrences
  (11 corpus tag ranges, extractor replica verified byte-identical against a
  stored report). Same-line exec-call exclusion: fires on exactly 0 lines —
  idiomatic code names the binary (`exec.Command("git")`) and passes the flag
  (`.arg("--no-verify")`) on different lines, a line-level rule structurally
  cannot see the pair. Keep-only-definition-shaped-lines: wipes sniffnet's
  real hand-rolled `--help`/`--version`/`--restore-default` parser to zero
  while its two "survivors" are themselves noise (vendored ginkgo usage text;
  clap's `.arg(` and `std::process`'s `.arg(` are textually identical with
  opposite meanings). Known-binary-token exclusion: <3% reduction, hits
  coincidental. The underlying fact: which binary a flag belongs to is a
  multi-line, cross-file property, and the diff shows lines in isolation —
  anything that answers it needs AST-level call resolution or a per-repo
  allowlist, neither of which is "cheap". The field keeps its subprocess
  noise; the *volume* problem turned out to live at the category boundary
  instead — closed 2026-08-09, the entry above. Reopen only with a candidate
  that survives the sniffnet hand-rolled-parser case.

- **File- and symbol-level subscription anchors: rejected by measurement
  (2026-08-08).** Chained-report recurrence across the corpus: exact files
  22–60%, symbols ≤27% (a floor under the stored cap of 12, but the gap to
  directories' 74–98% is not a cap artifact). A subscription that goes quiet
  because the change moved to a sibling file is worse than one that fires on
  the directory — the silence reads as "nothing happened". The same numbers
  close the "watch this button" idea in its semantic form. Reopen only with a
  re-anchoring mechanism that survives a rename, and measure it the same way.

- **`inverted-claim`: closed 2026-08-07, and a single model vote is not a
  verdict.** `pnpm mutate-notes --generate --no-cache` reads `1/1`. The
  survivor (`sniffnet@v1.4.1`, *"Fix support for IPinfo's databases"* flipped
  to *"**Break** support…"*) needed two repairs, and neither was the one the
  open entry had proposed. First: a `verified` resting on identifier overlap
  alone is no longer settled deterministically — overlap cannot see negation,
  so it buys a judge call instead (`identifierOnly`, `src/verify.ts`); 61 of
  5013 corpus claims take that branch. Second, and the part worth keeping:
  routing it to a model was **not enough**. Four runs of the same prompt and
  engine answered `contradicted · contradicted · contradicted · verified`, and
  only the `verified` ended the question, because `needsSecondLook` reviewed
  severe verdicts and sensitive paths but not this. One lucky pass settled it.
  That class now gets three votes and the median.

  The generalisation, which is what binds future work: **where the
  deterministic pass knows nothing, one model vote is a coin flip, not an
  answer.** Any future route that settles a claim on a single call needs to
  say why that class is different. Cost: up to two extra calls per
  overlap-only `verified`, an upper bound of ~8 % on 1924 judged. The judge
  prompt was not touched here — what reading those runs surfaced instead is
  the commit-subject rule, settled above on 2026-08-09.

  The trap it left: measuring a ladder fix with `--generate` needs
  `--no-cache`. The model writes the same inversion for the same claim, so the
  prompt and the cache key are identical between runs while a routing or
  review change alters neither — the pre-fix `verified` came back out of the
  cache and the repaired ladder read as still broken. Noted at the top of
  `scripts/mutate-notes.ts`.

- **A repair that counts a documented bump as undocumented is not a repair**
  (2026-08-06, closing the coverage-union block). Three candidates were built
  and measured against the 55-release corpus before the one that shipped:
  requiring the covering majority to sit inside a single claim's evidence
  (`omission` unchanged at 30/34), discounting files that a quarter of the
  range's commits touch (unchanged), and excluding manifests by file type
  (33/34 — the best detection rate of the four, and rejected). The last one
  drops `opencloud@v7.1.0` from completeness 96 to 1, and every commit it
  newly condemns is a dependency bump whose own note names it. Detection rate
  is not the only axis; a rule that wins it by punishing the most cleanly
  documented class of change in the corpus loses. What shipped instead reads
  the pin a bump claim names against the pins a commit moves — 32/34, and
  completeness *up*.

- **LLM calibration iterations: frozen.** Score deltas under ~10 points are
  noise; further model-ranking/golden-tuning work has poor marginal value.
  The golden-set gate was the one exception precisely because it *ends*
  the topic.

  `--add-golden` (2026-08-06) does not reopen it, and is built so it cannot.
  A lifted case lands in the `field` category, which `--calibrate` runs and
  names but which is excluded from the gate's verdict — a case lifted this
  morning must not be able to move a judge from "sole judge" to "not
  recommended", and a set growing with unreviewed field cases would turn the
  gate into noise. Promoting one into `core` or `security` is a hand-edit.
  The distinction that keeps this closed: lifting a case is *regression
  testing against something that happened*, never *tuning a set until a
  number improves*. The moment a proposal is the latter, this entry applies
  to it unchanged.
- **`watch serve`: stays unbuilt** — the static, daemon-free index.html is
  a feature (scp-able, zero attack surface).
- **Public scan-results: stays rejected** — honest-but-weak judges are
  undetectable in CI (engine heterogeneity); revisit only via the
  Scorecard model (PRs contribute watchlist entries, scans run centrally).
- **Per-repo trust badges: rejected (2026-07-28), and the principle
  generalizes: this tool is not a wall of shame.** It informs its
  operator; it does not publish compressed judgements next to other
  people's project names. A badge is the score stripped of every nuance
  the dashboard carries (unverified vs. mid, partial data, median-relative
  reading) — and for this repo's own notes the check-release-notes
  workflow badge already covers the self-case. Any future idea whose
  value depends on publicly labeling third-party projects starts from
  this rejection.
- **Relative alerting: done** (v0.1.1/0.1.2, verified during the bug hunt).
- **No npm, no repo secrets** (2026-07-26): releasing is a local routine
  (dogfood gate, `--calibrate` drift check, tag on both forges) — no
  standing supply-chain surface for one convenience installer, no
  secret-carrying CI; the nightly keyless job covers mutants, not judges.
- **The judge never sees commit messages while reading diff substance**
  (2026-08-02): messages anchor it on the claim — changelog circularity,
  generalized. Enforced in code and mutants; reconciliation (Block 4) is
  where messages join, late.
- **Audience is pure per-repo config** (S4a, 2026-08-03): a heuristic
  reading changed files misclassifies exactly the hybrid repos, and a
  silently wrong lens hides the findings its real audience needed.
  Casual consumers are not an audience — they do not decide updates.
- **Third-party pin bumps are never expanded** (2026-08-02) — explosion;
  OSV advisory enrichment stays a possible later, separate decision.
- **Kernel-scale releases are not a target** (2026-08-04, closes the F23
  maxBuffer question): the 64 MB in-memory cap is deliberate, and
  overflowing it names the cap and the way out (`--base`) instead of
  blaming git. The streaming diff parse stays unbuilt without a real
  target — weeks of watcher operation and a full backfill never touched
  the ceiling.
- **The `contradicted` hard cap stays as it is** (2026-08-04, closes the
  bump question's block 5): the cap was suspected of punishing releases for
  a patch digit in a dependency note, and the fix turned out not to be in
  the cap. Settling bump claims off the diff's own pin delta removed all
  eight of the corpus's bump contradictions without touching a scoring
  number, which is what "score-neutral first" was for — no A/B debt, no
  re-measured README table, no calibration drift to chase. Reopening the cap
  needs a case where the verdict is right and the cap is still wrong.
- **A bump claim is checked against the release diff first, the named
  commit second** (2026-08-04): the two are not the same evidence, and
  assuming they were cost a full round of wrong diagnosis. traefik v3.6.25
  moves `dd-trace-go` v2.2.3 → v2.8.2 inside the commit its note names,
  while the same module's go.mod line is unchanged across the release range
  — the base branch already carried the destination. The judge read the
  commit diff it was handed and answered `contradicted`; the pin join read
  the range and found nothing. Neither was inventing anything. The order
  matters and stays fixed: what the release ships decides, and only a claim
  the range cannot answer at all gets to fall back on its own commit.
- **Action PR-comment variant: rejected until real demand** (2026-08-04):
  the tool checks release notes against a diff, and a PR has no release
  notes — the claims-based PR intake already covers this repo's own PRs.
  Reopens only via a user issue carrying a concrete use case.
