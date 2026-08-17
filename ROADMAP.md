# Roadmap

> **Status 2026-08-09 (night):** v0.13.0 is out (`3858243`, tagged on both
> forges, CI green, extension pin bumped) and nothing sits unreleased on
> `main` but the CI repair behind it (`b0bface`).
>
> **The release is mostly about the instruments, and that changes what every
> earlier number means.** The mutation harness had been skipping 52 of 111
> corpus releases for missing clones and reporting that as a truncated list,
> so every detection rate this repo ever published came from half a corpus:
> with all clones present the same detector reads `omission` 59/66 where it
> had read 35/36. Reference and README table re-frozen on the full corpus.
> Three instrument failures only the full basis could show — a release whose
> mutation leaves no notes took the run down, the report was truncated at the
> pipe buffer (`console.log` + `process.exit`, macOS-only, which is why CI
> never saw it), and `pnpm check` did not cover `scripts/` at all.
>
> On that basis, one scoring change: coverage's evidence union asks for every
> file of a commit rather than half, because on the full corpus that route was
> the sole cause of all seven remaining `omission` misses. The sweep put its
> only Pareto point at 1 — also the only value stating a rule rather than a
> calibrated preference. **`SCORING_GENERATION` is 3**: 27 of 111 releases
> move their completeness, so generation-2 records are not comparable.
> Validation table redrawn; the redraw separates restic 89 → 86 (this change,
> deterministic under `--judge off`) from git-cliff 90 → 87 and vaultwarden
> 84–87 → 79–82 (bit-identical under `--judge off` — judged flicker).
>
> Issues #9, #10 and #11 closed in the same release. Tools that produce these
> numbers are now tracked (`pnpm corpus-clones`, `corpus-bump-origins`,
> `diagnose-coverage`) after one of them was lost with a removed worktree, and
> the harness runs four releases at once and resumes from a build-keyed cache
> beside the clones.
>
> Everything before that is on `main` too — the three original phases, the
> 2026-07-27 block series, the long view, the second axis (shipped as v0.7.0),
> the reconciliation layer, and the "running it teaches it" instruments block.
> This file carries only what is open; the landed plans and their dated
> landed notes live in this file's git history (up to `039460a`).
>
> **Where a fresh session starts:** no forge issue is open. Cutting v0.14.0
> is user-gated and has accumulated generations 4–7, the flicker-band redraw,
> the fast mutate runner and the #17 dissent annotation. The standing
> corpus-stats lead for the next deterministic rule is the `anchored-weak`
> class — 51.7 % of the judge bill, 206 second looks, 26 split votes.
>
> Issue #18 closed on 2026-08-17 (`SCORING_GENERATION` 7): the small-commit
> end of the breadth question was where the evidence came from, not the
> file count — an unanchored claim's evidence is matched against the whole
> release diff, so claims cite paths other commits changed, and one ordinary
> word in both files of a two-file commit was "breadth". The route now
> re-asks unanchored claims of the commit's own diff at a floor of one
> span-backed identifier; anchored claims keep their pool binding (the
> 2026-08-14 measurement). Corpus, full base: omission 69/70 → **70/70 — no
> detection miss of any class remains**; canaries unmoved; 10 of 70
> releases lose 1–6 points of control completeness they never earned;
> validation row restic 86 → 82 (three identical judged draws — coverage is
> not a question the judge is asked, so unlike generation 5 nothing absorbs
> the move). A candidate floor on the commit's file count died before
> measurement: the recall fixture in `test/verify.test.ts` IS a documented
> two-file commit, and the census read 259 breadth-only commits (239 at 1–2
> files) whose biggest concentrations were evidence-vacuum claims, not
> honest collections.
>
> Issues #16 and #17 closed on 2026-08-17. #16: the mutate runner tries the
> mutated module's own test file first and pays the full suite only for
> survivors — 121/121 in 6.4 min, verdicts unchanged by construction; the 2 h
> figure did not reproduce (a red run costs a green run's ~16 s, so the old
> runner extrapolates to ~33 min here — the rest was load). #17: the proposed
> confirmation draw already existed (needsSecondLook + two re-votes; the
> outlier's votes were seconded 2-of-3), so the issue was corrected, the
> dissent now rides the reasoning into every renderer, and the flipped claim
> is a golden field case (expected partial, calibrate passes it live). The
> score-side gate (critical flag despite a dissenting vote) reopens only if
> the cliff recurs on an honest repo.
>
> Issue #8 closed on 2026-08-14: the one-claim rule was the candidate and it
> held — `omission` 63/65 → 64/65 with every other class missing the same
> releases, because a union reaches share 1.00 by adding claims rather than by
> describing the commit. Its last survivor turned out to be #12 wearing a
> different hat, which makes the lexical bar the one open finding behind both
> remaining detection holes rather than two independent ones. Issues #12 and
> #13 closed later the same day (`5d9bf17`, `a2950da`) — the lexical bar is
> generation 5, the deletion rule generation 6.
>
> Issue #15 closed on 2026-08-16: the generation-5 redraw was paid judged,
> five draws per row, and no judged value moved — the movement lives in the
> deterministic fallback that `--judge off` prints and a judged run re-asks
> (restic: 8 partial / 1 no-evidence at overall 55 judge-free; nine claims,
> nine times `verified`, in every judged draw, for the same 86 five times).
> The same run numbered the flicker band this note used to carry as open:
> three rows ≤ 4 points wide, one 52-point cliff via a partial↔contradicted
> flip that survived its own re-vote — issue #17. Numbers in README's validation
> section. Judged before/after comparisons are safer than the 2026-08-09 note
> feared, except across the contradicted boundary.

## Open (2026-08-07): what the instruments found and nobody has closed

The "running it teaches it" block is built. Six of its seven entries landed on
2026-08-06, and what those instruments then found was two things. One of them —
`inverted-claim` — was closed on 2026-08-07; the question its closing raised,
the judge arguing from commit subjects, was closed on 2026-08-09 when the rule
line shipped. Both have moved to **Settled** below. The last entry — the
coverage miss — closed on 2026-08-17 (below), which empties this block: what
remains of it is the line it drew and the instruments it built.

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

### 1. `omission` — coverage's fourth route. CLOSED 2026-08-17

Closed without a sixth candidate: the every-file bar issue #8 gave the
breadth route closes the union case by itself, and the first full-base
measurement afterwards says so. `web@v7.0.0`'s tiptap commit — the case this
entry was reduced to — is detected: its best single claim reaches 54 of the
commit's 72 files, 0.75, over the retired majority bar and under the current
one (`pnpm diagnose-coverage "opencloud-eu/web@v7.0.0"`, 2026-08-17). Corpus
on the full base, clone gap closed first (122 of 123 releases, judge off):
omission 69/70, bump-overshoot 22/22, bump-undershoot 22/22, foreign-claim
121/121, backtick-noise 119/119, canaries unmoved. The one remaining miss is
the opposite end of the same question and has its own diagnosis and issue:
at 2 files the every-file bar is trivially met (`jundot/omlx@v0.5.0`, issue
#18). The five rejected candidates, their numbers, and the harness repair
that preceded this live in this file's git history and in the comments at
the route in `src/verify.ts`.

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
