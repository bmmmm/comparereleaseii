# Roadmap

> **Status 2026-08-06:** v0.10.0 is out and the gh extension's pin follows
> it, so the state lock, the backtick rule and the pin-join fixes are what
> the hourly job now runs — the release block that opened this section is
> closed. Before it: the bump block landed — bump claims are settled by
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

Completeness moved by up to 50 points today through *correct* fixes. The
watch state holds records from four scoring generations side by side and
cannot tell them apart, so the baseline median, the relative alert and the
drift detection all compare across a discontinuity they cannot see. Put the
scoring generation into each `RepoState.history` entry and into every report;
have the dashboard mark a history that spans more than one, and make the
baseline refuse to average across generations. Until this exists, every
improvement quietly damages the series it is measured on — including the
repair in step 5.

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

### 5. `omission` 30/34 — coverage's fourth route (`FIXME(coverage-union)`)

Diagnosed, not repaired. Wait for step 1, then A/B — landing it in the same
release as the backtick rule would make the two effects indistinguishable.

### 6. Mutation classes nobody thought of

The harness measures five classes, and those five are the ones someone
invented. All three holes found so far were the same mistake wearing
different clothes: a route reading "similar enough" as "supported". Generate
the lies instead — plausible fabrications from a model, applied to real notes
— and see which ones survive. Self-testing, not self-tuning.

### 7. A watchdog for silent softening

22 of 101 checked releases carried `judge-unavailable`, and that fallback is
by construction the milder reading. There is a flag per release and nothing
that notices a *streak*: three runs in a row judging without a judge is an
alarm, not a score.

---

### The coverage-union finding in full

Both holes `pnpm mutate-notes` found are closed — bump-undershoot 22/22,
backtick-noise 50/55, re-frozen on 55 releases. The next one is open and
diagnosed: `omission` sits at 30/34 because coverage has a fourth route that
belongs to no claim. `evidenceFiles` is the union over every verified/partial
claim, and a commit whose files mostly land in that union counts as
documented. Hiding the notes of a 10 056-line commit in `opencloud@v7.2.0`
leaves it covered at 144/145 files against a union contributed by 108 claims,
none of which mentions it; in `v7.1.0` the union that keeps a commit covered
comes from a single dependabot bump naming `go.mod`. The union grows with the
notes, so the bigger the release, the less this route can distinguish.

Two candidate repairs, neither obviously right: require the majority to sit
in *one* claim's evidence (which does nothing for `go.mod`/`go.sum`, since
every bump touches them), or discount files that many commits in the range
touch — a manifest is not a fingerprint. Both move completeness across the
whole corpus, so this needs an A/B, not a patch. The anchor is
`FIXME(coverage-union)` in `src/verify.ts`.

## Settled — do not reopen without new facts

- **LLM calibration iterations: frozen.** Score deltas under ~10 points are
  noise; further model-ranking/golden-tuning work has poor marginal value.
  The golden-set gate was the one exception precisely because it *ends*
  the topic.
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
