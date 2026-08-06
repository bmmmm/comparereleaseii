# Roadmap

> **Status 2026-08-06:** v0.10.1 is out and the gh extension's pin follows
> it, so the state lock, the backtick rule, the pin-join fixes and the
> unreadable-commit repair are what the hourly job now runs — the release
> block that opened this section is closed. **Unreleased on `main`:** the
> bump-claim coverage fix (a scoring change — see step 1's note on ordering)
> and a cleanup round that left behaviour bit-identical (the three renderers
> now share their decisions via `src/report.ts`, and the Markdown report no
> longer drops the baseline and repo context). Next release is 0.11.0. Before it: the bump block landed — bump claims are settled by
> the diff's own pin delta before any judge runs, and the corpus question
> that opened it closed without the score being touched. Everything else is
> on `main` — the three original phases (distribution, watchdog, judge
> trust), iterations 2–4, the 2026-07-27 block series (bughunt follow-up,
> hardening backlog, forge watching, presentation + author ledger), the long
> view (backfill, phases/events/heatmap), the second axis (pins → substance →
> first-party expansion → findings/lenses → substance coverage; shipped
> as v0.7.0 on 2026-08-03), and the reconciliation layer (claims meet
> findings — landed 2026-08-03, rides the next release). This file
> carries only what is open. The landed
> plans and their dated landed notes live in this file's git history (up
> to `039460a`); durable outcomes live where they belong — CHANGELOG
> (what shipped), SCORING.md (score semantics), AGENTS.md (working
> rules), docs/ (operations).

## Open (2026-08-06): the block that makes running this tool teach it

New work starts from a fact: an issue, a corpus number, a release that reads
wrong. Three of those turned into fixes in two days — undershoot, backtick
weight, and the coverage-union diagnosis below — and every one of them was
found by running the thing, not by reading it. That is worth building on
deliberately.

**The line this block does not cross.** What running the tool teaches is
*where it is wrong* and *where it wastes work*. It never teaches the tool to
look better. Verdicts, weights and bars stay decided by a person, changed
with an A/B, and frozen afterwards — a threshold that drifts by itself makes
every score incomparable with every other and turns the frozen references
into decoration. Nothing here adjusts a number to improve a score. The gain
is the opposite: findings the corpus already contains, and judge calls that
were never needed.

The precedent is the bump block. It did not start as a plan; it started as a
corpus count — 8 of 12 contradicted claims were dependency bumps — and ended
as a deterministic rule that is *both* more accurate than the judge on that
class and free. That is the shape to repeat: measure the corpus, find a class
the judge is being asked about needlessly or answers badly, settle it
deterministically, measure again.

### 1. Every record says which rules produced it

> **Start here — the scope is narrower than the paragraph below it.** Put an
> explicit scoring-generation constant into `CheckedRelease`
> (`src/watch-state.ts`) and into every report, and teach `segmentPhases()`
> (`src/watch-longview.ts`) not to open a `level-shift` phase across a
> generation boundary. Have the history page mark a series that spans more than
> one. **Leave the baseline out of it** — the measurement below shows it does
> not need this, and `BASELINE_MIN_CHECKS` (`src/watch-state.ts`) makes a wrong
> key there expensive: a generation tied to `VERSION` would empty the series
> every release and leave three checks with no relative alert at all. The
> constant is explicit and hand-bumped, never `VERSION`.
>
> Do this *before* the next release if the release carries a scoring change —
> the unreleased bump-claim fix is one. Records shipped without the marker
> create exactly the boundary nobody can label later, in the users' watch
> homes rather than here.

The original framing, kept because the measurement under it refutes the part
about the baseline: completeness moved by up to 50 points today through
*correct* fixes. The watch state holds records from four scoring generations
side by side and cannot tell them apart, so the baseline median, the relative
alert and the drift detection all compare across a discontinuity they cannot
see. Put the scoring generation into each `RepoState.history` entry and into
every report; have the dashboard mark a history that spans more than one, and
make the baseline refuse to average across generations. Until this exists,
every improvement quietly damages the series it is measured on — including the
repair in step 5.

**Measured 2026-08-06 — the discontinuity this entry is built on is not
there.** v0.9.0 against v0.10.0, `--judge off --baseline 0`, every release in
every watched repo's baseline window: **90 pairs, 80 bit-identical in all
three components.** Nine of the thirteen medians move by exactly 0; the four
that move go 74 → 69, 32 → 30, 31 → 30, 67 → 66. `SCORE_DROP` is 20. Nothing
in the baseline, the relative alert or the drift detector can see a shift
that small, so the premise — records from several generations dragging the
median across a break — measures as false on this corpus.

What is real: alerts go from 16 to 19, and all three additions are
`zed@v1.12.0`, `zed@v1.14.2` and `sniffnet@v1.5.0`. In each one the alert bar
is *identical* on both sides (53 → 53, 12 → 12) and only the critical-flag
count moves (0 → 1, 0 → 1, 0 → 3). They fire through `isFlagged()`'s
unconditional branch, which never consults the baseline at all — and they are
*correct*: those commits really are undocumented, and the old rule counted
them as covered because a claim said `` `tab` ``.

So the damage is not a false alert. It is that the operator reads a correct
alert against a median a different rule produced — and that `segmentPhases()`
will open a phase with reason `level-shift`, the tool asserting zed changed
its note culture on the day this repo changed its measuring stick.
`PHASE_SHIFT` is 20, the same magnitude, so the long view mislabels a
generation boundary as an event in the repo. That consumer is not in the list
above, and it is the only one that states something false rather than
comparing across a gap it cannot see. Build this for the long view first;
the baseline can wait for a rule change that actually moves a median.

One measurement note, because it cost a wrong conclusion first: the A/B's own
first pass ran twelve workers in parallel, tripped GitHub's rate limit, and
produced a `sniffnet@v1.5.1` reading of +15 that was pure artefact — the fix
in 0.10.1 is that a release the tool could not fully read now reports
completeness as unknown instead of better. Re-measured serially, that release
is bit-identical. Any future A/B here must filter runs carrying load warnings
before it counts anything.

Design note for whoever builds it: the generation must be an explicit
constant, not `VERSION`. The cache is keyed by tool version and over-keying
there costs only judge calls; over-keying the baseline is fatal — every
release would empty the series, and with `BASELINE_MIN_CHECKS = 3` each one
would leave three checks with no relative alert at all.

### 2. The golden set grows out of the watch home

Today a wrong verdict has no way back into the tool: the issue template ends
at a human, and every one of the golden cases was invented by hand. Add a way
to lift a claim out of a stored report with the verdict it *should* have had
(`--add-golden <report.json> <claim-id> <verdict> [why]`). From then on every
misjudgement anyone noticed is a regression test, and the judge calibration
runs against cases that actually occurred. The human decides what is right —
that is the point, not a limitation.

### 3. Corpus statistics as the source of efficiency

`judgeBalance()` already counts fresh and cached calls per run; nothing looks
at *what* they were spent on. A re-check of one large release cost 230 fresh
calls. Extend `pnpm corpus-stats` to break the judge bill down by claim class
(bump, generated entry, meta, anchored-and-strong, unanchored-lexical) and by
outcome, so the classes where the judge adds variance instead of evidence
become visible the way the bump class did. Each one found is a deterministic
rule that costs nothing and answers better.

### 4. Threshold search as a tool, never as automation

The bars are hand-set constants — `>= 5`, `MATCH_BAR = 3`, the 0.5 file
majority, `0.25`. Three of them were changed by feel this week and measured
afterwards. Build a script that sweeps them over the corpus and prints the
Pareto front: detection rate against golden-set fidelity against judge cost.
It reports; a person picks the point; the constant stays a constant in the
source with the measurement in its comment.

### 5. `omission` 32/34 — coverage's fourth route, two cases left

Mostly closed 2026-08-06. The union was never the whole story: what covered
the commits it should not was *bump-claim evidence*, which is `go.mod` and
`go.sum` by construction and therefore no fingerprint at all. Bump claims now
document the commits that move the pin they name, and the corpus reads
`omission` 32/34 with completeness up 29 points net. Three candidate repairs
were measured and rejected on the way — the two this file used to propose move
no rate whatsoever, and the file-type variant reaches 33/34 only by condemning
honestly documented dependency work (`opencloud@v7.1.0` 96 → 1). Their numbers
live in the comment at the route in `src/verify.ts`.

What is left is two cases — `opencloud@v7.3.0` and `opencloud-eu/web@v7.0.0` —
and no candidate that does not cost more than it buys. Whoever reopens this
starts from the rejected three, and from the rule they all broke: a repair
that counts a documented bump as undocumented is not a repair.

**Diagnosed 2026-08-06: the two are not one problem.** Both were re-measured
and instrumented per route, and they sit on different ones:

- `opencloud@v7.3.0` — commit `04a924f7`, **29,027 lines across 50 files**,
  held by the **bump pin join**. Not by the union: 0 of its 50 files are cited
  as evidence, and no claim clears the lexical bar on it. Four of the 50 files
  move a pin some note names, and that route is blind to everything else the
  commit does. The rule that closed this class is what now hides the largest
  commit in the release.
- `opencloud-eu/web@v7.0.0` — commit `86fff671`, 5,567 lines across 72 files,
  held by the **evidence-file majority** at 57/72 = 0.79. This one is the
  union route the original diagnosis named.

**A fourth candidate, measured and rejected.** Requiring the pin files to
carry at least half the commit's churn before a bump claim documents it:
`opencloud` omission 8/9 → **9/9**, median completeness 51 → 35, and
`opencloud@v7.1.0` falls from **98 to 6**. That is the canary the file-type
variant died on (96 → 1), dying the same way — a vendored dependency update
moves `go.mod` and `go.sum` while the vendor tree carries the churn, so the
most cleanly documented dependency work in the corpus reads as undocumented.
The numbers live in the comment at the route.

What that leaves for whoever reopens it: churn share cannot tell "this commit
*is* a bump" from "this commit *contains* a bump", and neither can file type.
A signal that can would have to read the pin move against the rest of the
commit's *substance* rather than its size — and it has to survive v7.1.0.

### 6. `inverted-claim` — built, and it found one on the first corpus

Built 2026-08-06 as `pnpm mutate-notes --generate`. A model rewrites a claim
the control run VERIFIED so that it asserts the opposite; the diff
demonstrably does X, so ¬X cannot hold of it either. Opt-in (it needs an
engine to write the lie and one to catch it), and deliberately outside the
frozen reference: its expectation carries one link the other five do not —
whether the model really inverted the sentence rather than rewording it — so
a survivor is a lead to read by hand, not a rate.

**The survivor it found, still open.** `GyulyVGC/sniffnet@v1.4.1`: *"Fix
support for IPinfo's databases"* inverted to *"**Break** support for IPinfo's
databases"* comes back `verified`. The inversion keeps every identifier, the
lexical bar clears on those identifiers alone, and the claim is settled before
any judge reads the sentence — `judgeMode: auto` never asks about a claim the
deterministic pass already called verified. It is the same mistake the other
three holes were, found by a class nobody would have written.

Whoever closes it starts from what that implies rather than from the bar: the
`lexical-bar` sweep (`pnpm sweep`, 2026-08-06) shows raising it costs six of
28 detections and buys three judge calls, so the number is not the fix. The
question is whether a claim whose evidence is *only* identifier overlap should
be settled deterministically at all, or should always cost a judge call — and
`pnpm corpus-stats` now prices that: `anchored-strong` is 5.6 % of the bill.

### 7. A watchdog for silent softening

22 of 101 checked releases carried `judge-unavailable`, and that fallback is
by construction the milder reading. There is a flag per release and nothing
that notices a *streak*: three runs in a row judging without a judge is an
alarm, not a score.

---

## Settled — do not reopen without new facts

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
