# Roadmap

> **Status 2026-08-06:** v0.10.1 is out and the gh extension's pin follows
> it, so the state lock, the backtick rule, the pin-join fixes and the
> unreadable-commit repair are what the hourly job now runs. Next release is
> 0.11.0.
>
> **Unreleased on `main`:** the bump-claim coverage fix (a scoring change), a
> cleanup round that left behaviour bit-identical, and the whole
> "running it teaches it" block below except the two entries this file still
> carries — the scoring-generation marker, `--add-golden`, the judge bill by
> claim class, `pnpm sweep`, the `inverted-claim` generator and the
> silent-softening watchdog all landed 2026-08-06. What they measured lives
> where it belongs: CHANGELOG (what shipped), SCORING.md (score semantics and
> the generation rule), docs/corpus.md (the bill and the sweep),
> docs/watchdog.md (alerting), AGENTS.md (commands).
>
> Everything before that is on `main` too — the three original phases
> (distribution, watchdog, judge trust), iterations 2–4, the 2026-07-27 block
> series (bughunt follow-up, hardening backlog, forge watching, presentation
> + author ledger), the long view (backfill, phases/events/heatmap), the
> second axis (pins → substance → first-party expansion → findings/lenses →
> substance coverage; shipped as v0.7.0 on 2026-08-03), and the
> reconciliation layer (claims meet findings — landed 2026-08-03). This file
> carries only what is open; the landed plans and their dated landed notes
> live in this file's git history (up to `039460a`).

## Open (2026-08-06): what the instruments found and nobody has closed

The "running it teaches it" block is built. Six of its seven entries landed on
2026-08-06; the two below are what those instruments then found, and neither
has a repair that survives measurement yet.

**The line that block did not cross, and this one does not either.** What
running the tool teaches is *where it is wrong* and *where it wastes work*. It
never teaches the tool to look better. Verdicts, weights and bars stay decided
by a person, changed with an A/B, and frozen afterwards — a threshold that
drifts by itself makes every score incomparable with every other and turns the
frozen references into decoration. Nothing here adjusts a number to improve a
score.

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

### 1. `omission` 32/34 — coverage's fourth route, two cases left

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

### 2. `inverted-claim` — built, and it found one on the first corpus

Built 2026-08-06 as `pnpm mutate-notes --generate`. A model rewrites a claim
the control run VERIFIED so that it asserts the opposite; the diff
demonstrably does X, so ¬X cannot hold of it either. Opt-in (it needs an
engine to write the lie and one to catch it), and deliberately outside the
frozen reference: its expectation carries one link the other five do not —
whether the model really inverted the sentence rather than rewording it — so
a survivor is a lead to read by hand, not a rate.

**The survivor it found.** `GyulyVGC/sniffnet@v1.4.1`: *"Fix support for
IPinfo's databases"* inverted to *"**Break** support for IPinfo's databases"*
comes back `verified`. The inversion keeps every identifier, the lexical bar
clears on those identifiers alone, and the claim is settled before any judge
reads the sentence — `judgeMode: auto` never asks about a claim the
deterministic pass already called verified. It is the same mistake the other
three holes were, found by a class nobody would have written.

**Half of it is closed (2026-08-07), and the half that is left moved house.**
The route is repaired: a `verified` resting on identifier overlap alone is no
longer settled deterministically, it buys the claim a judge call
(`identifierOnly` in `src/verify.ts`). Overlap cannot see negation, so it was
never entitled to end the question. Measured on the 108-release corpus: 61
claims of 5013 take that branch newly, roughly 3 % on top of 1924 judged. The
five deterministic detection rates do not move — they are measured judge-off,
where nothing routes anywhere — and `--judge off` stays bit-identical.

What that did **not** do is catch the survivor, and this is the finding:

    haiku    "Fix support…" → "Break support…"                  → verified
    sonnet   the field rename reversed (country_code → country) → verified

Both readings are now made by a model that was handed the diff, and both are
wrong. The claim's parenthetical (*"the most recent version renamed the
`country` field to `country_code`"*) describes the diff correctly whichever way
the sentence is flipped, and the judge settles on the half it can confirm. So
the open question is no longer routing or the lexical bar — the
`lexical-bar` sweep (`pnpm sweep`, 2026-08-06) already showed raising it costs
six of 28 detections — it is that **a claim is judged as a whole while its
truth lives in one clause**. Whoever picks this up starts at the prompt in
`src/judge.ts`, not at a threshold, and the cheap first probe is whether asking
about the leading assertion separately from its justification changes either
verdict above.

One correction to the entry this replaces: it priced the repair off
`anchored-strong` (5.6 % of the bill). That is the wrong class — the sniffnet
claim names no commit, so it is `unanchored-lexical` (2.7 %). The number that
actually governs is the 61 above, which spans both classes and is countable
from any watch home.

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
