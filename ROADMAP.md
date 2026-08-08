# Roadmap

> **Status 2026-08-07:** v0.10.1 is out and the gh extension's pin follows
> it, so the state lock, the backtick rule, the pin-join fixes and the
> unreadable-commit repair are what the hourly job now runs. Next release is
> 0.11.0.
>
> **Unreleased on `main`:** the bump-claim coverage fix (a scoring change), a
> cleanup round that left behaviour bit-identical, the whole "running it
> teaches it" block — the scoring-generation marker, `--add-golden`, the judge
> bill by claim class, `pnpm sweep`, the `inverted-claim` generator and the
> silent-softening watchdog, all landed 2026-08-06 — and the two repairs that
> closed `inverted-claim` on 2026-08-07: overlap-only claims buy a judge call
> instead of settling, and a `verified` on that evidence is reviewed rather
> than taken on one vote. Both change what reaches a judge, so the next
> release's calibration run costs more than the last one. What they measured
> lives where it belongs: CHANGELOG (what shipped), SCORING.md (score
> semantics and the generation rule), docs/corpus.md (the bill and the sweep),
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

**A fifth candidate, and a correction to this entry (2026-08-07).** The
substance signal this entry asked for was built: require the pin a claim names
to appear in one of the commit's non-manifest *paths*, so that a commit which
*is* a bump of X (carrying `vendor/…/X/**`) is separated from one that merely
dragged X's manifest line along. Measured on `opencloud-eu/opencloud`:

    pin name must appear in a changed path    omission 8/9, completeness 51
                                              — neither number moves
    this route disabled entirely              omission 9/9, completeness 35

Two things follow, and the second matters more than the candidate.

The churn-share candidate above cost exactly the same 16 points of
completeness as switching the route off, which is what it effectively was — a
disguised off-switch, not a rule about bumps. Read the four rejections that way
and they are not four ideas, they are one: every candidate so far bought the
detection by removing the route for the honest cases too.

And **this entry has been aiming at the wrong commit.** `04a924f7` carries 36
changed files under `open-policy-agent/opa` and *zero* under
`rogpeppe/go-internal` — a path rule does separate the covering claim from the
covered commit there, and it still moves nothing. So whatever holds the
remaining miss is not that commit, and the diagnosis above ("held by the bump
pin join", the 29,027 lines) is a description of something that is no longer
the failure. Whoever reopens this identifies the missed commit **first**, from
`pnpm mutate-notes <dir> --repo <r> --json` and the case's own `detail` string.
Four of the five candidates so far were aimed from this comment instead of from
a measurement, and all four missed.

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

Three things to settle before touching it, because this is a prompt change and
those move everything:

- **Is the block load-bearing?** It is orientation for unanchored claims
  (`relatedCommits`). Removing it and measuring `pnpm eval` plus the five
  detection classes says whether it buys anything the diff does not.
- **A rule line is the cheaper probe than removal** — "commit subjects orient
  you; they are written by the same author as the claim and are never evidence
  for or against it" — and it costs no calls.
- **Whatever changes here re-measures the README validation table.** A prompt
  edit also invalidates every cache entry by construction, so the next full
  corpus run pays for itself again.

Start at `TRUST_PREAMBLE` and the rules list in `src/judge.ts:496-523`.

## Open (2026-08-08): subscriptions, and the host a release starts talking to

The reports already draw a frame around a codebase — categories, symbols,
config surface, findings. What a watcher cannot yet say is "only tell me when
*this part* moves". Before planning the feature, its shape was measured
against the corpus (109 stored reports, 38 with surface+findings;
opencloud/opencloud-web complete) and the clone cache. Four measurements
decided the design, and two of them killed ideas that read as obvious:

- **Directory anchors hold; file and symbol anchors do not.** Chaining each
  repo's reports (headRef→baseRef) and asking how often an anchor recurs
  later: depth-2 directories recur at 74–98%. Exact file paths recur at
  22–60% — half to four-fifths of paths touched early are never touched
  again. Symbols recur at 0–27%, and the stored cap of 12 making that a
  floor does not close the gap to the directories. Rules match directory
  globs; file- and symbol-level subscriptions are not offered (Settled).
- **The selective layers exist.** `migrations` fires on 8% of releases,
  security findings on 29% (median 1). Patch releases fire almost nothing,
  minors fire wide — the layers separate quiet from loud correctly.
- **`cliFlags.added` is not a subscription layer.** It fires on 50% of
  releases and the values are dominated by subprocess arguments (`--no-ff`,
  `--force`, `--dissociate` — git invocations in source), not the product's
  own flags. Entry 5.
- **A call-site detector for "new outbound request" has zero yield; a host
  detector has exactly the right yield.** `fetch(`/`http.Get(` patterns over
  five release ranges in four cached clones: zero non-test hits — real
  codebases wrap HTTP, so new traffic does not spell a new call site. New
  *host literals* in added source lines (moved lines cancelled, test paths
  tagged, schema/licence hosts filtered) yield 0–2 per release, and the hits
  are the point: nextcloud desktop v34 adds `api.github.com` inside its
  Sparkle updater. The prototype proved it can fire before its zeros were
  believed.

### 3. `surface.hosts` — the host delta as a surface field

Add `hosts: ConfigDelta` to `ReleaseSurface`: hostnames from `https?://`
literals in changed source lines, extracted in `src/substance.ts` the way
`envVars` already is — moved lines cancelled per release, vendor and lockfile
paths excluded, test paths excluded rather than carried and marked (a mock
host is not product traffic, and a `ConfigDelta` value stays a plain
hostname), a boring-list for schema/licence hosts. Deterministic,
informational, never scored. It renders
through `configSurfaceEntries` (`src/report.ts`), so all three renderers
inherit it in one move, and the "all three renderers" test extends to it.
Definition of done as AGENTS.md has it: failing test first, a mutate guard
for the extractor, `--json` stays additive.

### 4. Watch rules — "tell me when this area moves" as the fourth alert reason

`rules` on `WatchRepoConfig`, inherited via the existing
`{...defaults, ...entry}` merge — which means an entry's list *replaces* the
defaults' list, and the config docs must say so. A rule names directory
globs and/or surface layers (`migrations`, `apiRoutes`, `hosts`,
`envVar:NAME`) and/or finding kinds. Evaluation is a pure function in
`src/watch-state.ts` next to the state rules it joins, and `alertDecision()`
gains its fourth reason; hits ride on `CheckedRelease` so the index and
history page can show *why* a release was flagged, and the notify hook
carries them for free. Two lines drawn in advance: deterministic layers
trigger; finding-kind rules fire too, but the report must mark them as
resting on judge output — the vote-variance record (`votes`) exists because
that difference matters. And a rule whose globs matched nothing across many
releases gets a staleness note: directory anchors *mostly* survive, and
"mostly" is why the silent miss is a signal, not calm.

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
