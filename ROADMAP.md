# Roadmap

> **Status 2026-08-09:** v0.11.0 is out (`55befd4`, tagged on both forges,
> extension pin bumped, `check-release-notes` green on the tag) and nothing
> sits unreleased on `main`. The hourly job now runs the subscription block
> in production: `surface.hosts` in every report, and watch `rules` evaluated
> against the live config — calibrated 2026-08-09 from a corpus replay
> (defaults: `new hosts` + `security findings`; `migrations` for
> opencloud/vaultwarden/bitwarden; a `credentials` path rule for
> nextcloud/desktop; auth-directory globs measured and rejected, they fired
> on every minor). The config lives in the watch home with a dated backup
> beside it; docs/watchdog.md carries the operator side.
>
> The release's validation-table check set a precedent worth reusing: the
> pinned gh extension IS the previous release, so the judge-off A/B needs no
> second checkout — four cases came out bit-identical, the one that moved
> (restic, through the circularity gate) was re-measured judged and landed on
> the same 89. Details in the release commit.
>
> Everything before that is on `main` too — the three original phases, the
> 2026-07-27 block series, the long view, the second axis (shipped as v0.7.0),
> the reconciliation layer, and the "running it teaches it" instruments block.
> This file carries only what is open; the landed plans and their dated
> landed notes live in this file's git history (up to `039460a`).
>
> **Where a fresh session starts:** entry 6 (the `cliFlags` category-boundary
> leak — `vendor/` exclusion is the measured-safe first move), forge issue #9
> (verdict-cache GC: 97.5 % of entries are dead versions nothing evicts), or
> entries 1–2 below, which need judge budget and patience. One operational
> thread needs no code: the rules are live but have never seen a real
> release — the first watched release that fires one is the feature's first
> production datapoint, and `pnpm corpus-stats` at 0.11.0 (the class-bill
> section is released now) against a refreshed `tmp/corpus` names the next
> free deterministic rule.

## Open (2026-08-07): what the instruments found and nobody has closed

The "running it teaches it" block is built. Six of its seven entries landed on
2026-08-06, and what those instruments then found was two things. One of them —
`inverted-claim` — was closed on 2026-08-07 and has moved to **Settled** below.
The two entries here are what is left: the coverage miss nobody has landed a
repair for, and a question the closing of the first one raised.

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

The precedent both entries below are measured against is the bump block. It
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

### 2. The judge argues from commit subjects, and nothing stops it

Found 2026-08-07 while closing `inverted-claim`, and deliberately not fixed in
the same breath: it moves every verdict, so it needs its own measurement.

Reading the judge's own reasoning on the caught inversions, the first thing it
reaches for is not the diff:

> "The **commit message** for 2a0103c05c states 'fix support for IPinfo's
> databases', directly contradicting the claim that support is being 'broken'."

It lands on the right verdict here, which is exactly why it is easy to miss.
But a release note and a commit message come from the same hand, and the
settled entry below — *only the diff is evidence* — is the founding thesis of
this tool. The reverse direction is already enforced: no claim may reach
`verified` because it agrees with a commit subject, and the retired coverage
rescue was removed for comparing claim text to subjects. Nothing enforces this
direction. `buildJudgePrompt` (`src/judge.ts`) puts a `COMMITS` block with full
subjects in front of the model, and the rules list says nothing about what that
block may be used for — while it *does* spell out that a changelog hunk
restating the claim is not evidence.

**First measurement, 2026-08-08: the gate could not see this at all, and now
that it can, the model passes.** Every golden case was prompted with
`commits: []` — `calibrate.ts` hard-coded it and no case carried any — so
`circularity` read 2/2 while testing only the changelog half of the axis. A
model that argued from commit subjects would never have been caught by the
gate. The set can now carry linked commits (`commits?` on `GoldenCase`), and
two cases spell out both directions:

    commit-subject-echoes-claim-diff-shows-nothing   subject confirms the claim,
                                                     diff shows nothing  → no-evidence
    commit-subject-denies-what-the-diff-shows        subject denies it,
                                                     diff proves it      → verified

Two independent `--no-cache` runs, identical both times: `need→no-evidence`
and `verified`. `circularity` 4/4. The model neither rubber-stamps on a
friendly subject nor lets a hostile one override the diff — on these two
shapes.

On that evidence the prompt change was **not** justified, and that was the
finding. What stayed open was narrower than this entry began: the reasoning
text still *cited* commit subjects (the sniffnet runs), and citing is not the
same as being swayed by one. The honest next step was more shapes rather than
an edit — a subject that supplies a detail the diff omits, and one that names
a CVE the diff never mentions, were the two the pair did not cover.

**Second measurement, 2026-08-09: the two new shapes hold, and one half of the
old pair stops holding. That is the justification this entry was waiting for.**
Both missing shapes are in the set now, both `circularity`, both carrying a
linked commit:

    commit-subject-supplies-the-detail-the-diff-omits   subject names a 30s cap
                                                        the diff never shows
    commit-subject-names-a-cve-the-diff-never-mentions  subject names the CVE,
                                                        the diff is a size limit

Two independent `--no-cache` runs against `claude-cli/haiku`, 43 cases each:

| shape | run 1 | run 2 |
|---|---|---|
| `…echoes-claim-diff-shows-nothing` | `need→no-evidence` pass | `need→no-evidence` pass |
| `…denies-what-the-diff-shows` | **`contradicted` FAIL** | `verified` pass |
| `…supplies-the-detail-the-diff-omits` | `need→partial` pass | `no-evidence` pass |
| `…names-a-cve-the-diff-never-mentions` | **`need` FAIL** (round-1 need-misuse) | `no-evidence` pass |

`circularity` 4/6 and 6/6, `overVerified` 0 in both runs.

The CVE case takes no `need`: its whole release is one file and that file is
shown, unsanitised `filepath.Join(dst, hdr.Name)` sitting in the hunk as
unchanged context, so the evidence settles the claim where it stands. Its
`expected` is the three verdicts that decline the subject's word —
`no-evidence`, `partial`, `contradicted` — which mechanically means two ways
to fail it: answer `verified`, or spend round 1 asking for a file you were
already given, the way `evidence-suffices-need-is-wrong` is failed. Run 1
found the second one. Widening the list afterwards to make that pass would be
the collapse AGENTS.md forbids, run backwards.

The new shapes are not what moved. What moved is one half of the *old* pair —
the echoes case passed both runs, and `commit-subject-denies-what-the-diff-shows`,
which answered `verified` twice on 2026-08-08, answered `contradicted` in run
1 and said why in as many words:

> "The linked **commit message** explicitly states 'drop strict TLS for
> webhooks until 2.0', directly contradicting the claim that TLS verification
> is being enforced. While the diff removes `InsecureSkipVerify: true` (which
> would enable default Go TLS verification), the commit's intent **per its
> message** is to *remove* strict enforcement, not add it."

The diff in that case does exactly one thing: it deletes
`InsecureSkipVerify: true`. The model read that, wrote it down, and then let a
commit subject — written by the same hand as the note — outrank it. Run 2 hit
the same tension and resolved it the other way, naming it out loud: *"the
linked commit message contradicts the code diff, claiming to 'drop strict
TLS', but the code evidence supports the claim"*. Across four independent runs
on two days the shape reads `verified · verified · contradicted · verified`.

So the answer to this entry is no longer "citing is not being swayed" — it is
3/4. And the direction matters: `overVerified` is 0, so this is not the
rubber-stamp the gate watches for. A stale subject buried a claim the diff
*proves*, which is the same circularity pointed the other way, and a release
that ships an honest fix under a misleading subject is exactly the release this
tool exists for.

**What that still does not license.** The prompt is unchanged here on purpose:
a rule line invalidates every cache entry by construction and forces the README
validation table to be re-measured, which is a release-sized decision rather
than a measurement. Whoever makes it starts at `TRUST_PREAMBLE` and the rules
list in `src/judge.ts:496-523`, and the rule the set can now grade is: the
`COMMITS` block orients, it does not settle — a verdict that flips when the
subject changes and the diff does not is wrong in whichever direction it flips.

**This entry closes two ways, and only two.** Either the rule line ships — by
construction that invalidates every cache entry and re-measures the README
validation table, and the entry closes with it — or ten consecutive
`--no-cache` runs all answer `verified` on the denies case, which makes run 1
sampling noise rather than a rule the model is missing and retracts the
justification above. The second measurement is not cheap today: neither
`pnpm eval` nor `--calibrate` can restrict to a case or a category, so ten
runs of four shapes cost ten runs of 43. Building that filter is not part of
this entry — it may be mooted by the first exit.

**Decided 2026-08-09: `…names-a-cve-the-diff-never-mentions` stays in
`circularity`, not `security`.** It is security material and an over-verify on
it would therefore not disqualify a judge, which reads like an under-strict
filing. Moving it changes what the frozen gate means for every judge that ever
ran against it, and nothing here forces that — the case exists to measure the
subject axis, and the axis is `circularity`.

## Open (2026-08-08): what the subscription block measured and left behind

The subscription block landed the day it was planned and shipped in v0.11.0
the day after: `surface.hosts` (the host delta as a surface field, all three
renderers, mutate-guarded) and watch `rules` (directory globs / surface
layers / finding kinds as the fourth alert reason in `alertDecision`, hits
on the record, staleness note, docs). The plans and their design
measurements live in this file's git history (entries 3 and 4, commit
`cbe5658`); the corpus numbers that decided them — directory anchors 74–98%
recurrence vs. files 22–60% and symbols ≤27%, host detector 0–2 per release
vs. call-site detector zero — are summarized in the two Settled entries
below. What stays open is what the work surfaced:

### 6. The category boundary, not the subprocess, is where `cliFlags` leaks

What the entry-5 investigation actually found (its own question is Settled
below): bucketing all 439 flag-literal occurrences across 11 corpus tag
ranges by path, only **22.8%** sit in a file where "subprocess flag or
product flag" is even the right question. The volume is elsewhere, and it is
category-boundary gaps:

- **46.7%** — `.vue` single-file components: CSS custom properties
  (`--oc-button-color: …`) inside `<style>` blocks. `STYLE_FILE` excludes
  `.css/.scss/.sass/.less/.styl` but not `.vue`, so Vue SFCs leak their CSS
  variable surface into `cliFlags`.
- **20.0%** — `vendor/` (vendored Go dependencies: docker client, ginkgo,
  go-toml). `fileCategory` has no vendored-path exclusion, so a vendored test
  runner's own flags read as the product's.
- **6.8%** — misclassified CI/tooling config: `.woodpecker.star` at the repo
  root misses `CI_BUILD`'s directory-shaped pattern; `.mcp.json` lands in no
  config category.
- **3.6%** — Jest/Vue snapshot files (`__snapshots__/*.snap`) not caught by
  the test-file pattern.

Unlike the discriminator candidates, excluding `vendor/` is unambiguously
safe — vendored code is never the checked project's own CLI surface, so
there is no recall to lose — and the `.vue` style-block case is the same
class of fix as the existing `STYLE_FILE` exclusion. Raw data:
`c-occurrences.json` from the 2026-08-08 investigation (file/line/side for
every match; regenerable from the clone cache with the entry's replica
script). Whoever picks this up re-measures the 50% fire rate after each
exclusion — the number that made entry 5 look like a subprocess problem was
mostly this.

---

## Settled — do not reopen without new facts

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
  instead (entry 6). Reopen only with a candidate that survives the sniffnet
  hand-rolled-parser case.

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
  prompt was not touched — see open entry 2 for what reading those runs
  surfaced instead.

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
