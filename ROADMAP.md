# Roadmap

> **Status 2026-08-04:** the corpus (80 releases, `docs/corpus.md`) supplied
> the facts the bump question was waiting for, and it is now the one planned
> block below. Everything else is on `main` — the three
> original phases (distribution, watchdog, judge trust), iterations 2–4,
> the 2026-07-27 block series (bughunt follow-up, hardening backlog, forge
> watching, presentation + author ledger), the long view (backfill,
> phases/events/heatmap), and the second axis (pins → substance →
> first-party expansion → findings/lenses → substance coverage; shipped
> as v0.7.0 on 2026-08-03), and the reconciliation layer (claims meet
> findings — landed 2026-08-03, rides the next release). This file
> carries only what is open. The landed
> plans and their dated landed notes live in this file's git history (up
> to `039460a`); durable outcomes live where they belong — CHANGELOG
> (what shipped), SCORING.md (score semantics), AGENTS.md (working
> rules), docs/ (operations).

## Open (2026-08-04): the bump block

The complete list — anything not here is landed or settled below.

**The trigger fired.** The demand-driven condition on the identifier-anchor
question was "bump claims dominate the unsupported line, or a score is
demonstrably wrong because of it". The corpus answers both, harder than
expected:

| | Bump claims | Every other claim |
|---|---:|---:|
| Claims | 32 (1.1 %) | 2,879 |
| `contradicted` | 8 | 4 |
| Contradicted rate | **25 %** | **0.14 %** |

A bump claim is ~180× more likely to be called contradicted than any other
kind, and only 10 of the 32 come through as plain `verified`. Two releases
in the corpus sit at 35/100 ("suspicious") on the strength of one patch
digit in a dependency note. Hand-classifying all twelve contradictions:
six are not disagreements at all — the note correctly quotes its own PR
("bump `actions/cache` from 5.0.3 to 5.0.4") while the release aggregates
several bumps of the same pin, so the diff reads 4.3.0 → 5.0.5. Claim and
evidence are cut at different granularities. Nobody wrote anything false.

**The seam already exists on both sides.** `pinBumps()` in `src/pins.ts`
extracts `{name, from, to, file, repo}` from the diff and `src/check.ts`
already calls it; the claims carry the same versions as text. Nothing here
needs a new subsystem — the two halves have never been joined.

Order matters below: measure, then resolve deterministically, then remove
the source of the bad verdicts, then show it. Scoring is last and only if
still needed.

### 1. Name the class and count it — nothing changes yet

A deterministic bump-claim classifier (a pin name plus a version, one side
or two), surfaced as a claim trait and counted separately by
`pnpm corpus-stats`. No routing, no verdict and no score moves in this
block. It exists so every later claim of "fixed" is measurable against a
number that predates the fix. DoD: test + a `scripts/mutate.ts` entry.

### 2. Join claims against pins in the reconciliation — display-only

`src/reconcile.ts` is already the late, deterministic, never-scored meeting
of claims and observations; the pin join belongs there. Per bump claim:

- **confirmed** — the diff moves that pin and lands on the claimed version.
- **overtaken** — the diff moves that pin past the claimed version. This is
  the six-case group above, and naming it is the whole point: the note
  describes a slice of a bump the release aggregated. It is not a
  contradiction and must never read as one.
- **contradicted** — the pin moves the other way, or to a version the claim
  excludes.
- **unmatched** — no pin in the diff carries that name; the claim stands as
  it was judged.

Deterministic, re-runs bit-identical, `--judge off` output unchanged. DoD:
test + mutant + golden cases for confirmed/overtaken/contradicted.

### 3. Take resolved bump claims off the judge route

A new anchor stage in `src/verify.ts`, ahead of LLM escalation: a bump claim
the pin join resolves is never sent to a judge. That removes the source of
the false contradictions rather than post-processing them, and it saves the
25 judge calls this corpus spent on the class. This block *moves rulings* —
it needs `test/eval/golden.json` cases and `pnpm eval` before and after, and
the README validation table re-measured in the same commit if any of the
five listed releases shifts.

### 4. Make it visible

Bump claims read as one class instead of scattered through the verdict
stream — terminal, Markdown, HTML and an additive `reconciliation` field in
the JSON: *"12 dependency bumps — 9 confirmed, 2 overtaken by the release,
1 unmatched"*. An overtaken line shows both numbers, the note's and the
diff's, because that difference is the finding a reader wants. Additive
only: the `--json` contract does not break.

### 5. Scoring — conditional, and only after 1–4

Re-run the corpus and ask whether any bump case still lands in the
contradicted bucket. If the answer is no, the hard-cap problem dissolved
without touching the score and this question closes with zero A/B debt —
the intended outcome of doing it score-neutral first. Only if bump cases
survive there does the cap semantics itself come up for debate, and then
under the full discipline: A/B against the golden set, the README table
re-measured, the calibration drift checked.

Widening the shared identifier bar to v-prefixed versions (`v7.1.4`, the
original OpenCloud observation) stays a separate, later question. Blocks 1–4
address bump claims through their own channel, which is the narrower fix; the
bar governs every claim type and faces the same A/B discipline on its own.

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
- **Action PR-comment variant: rejected until real demand** (2026-08-04):
  the tool checks release notes against a diff, and a PR has no release
  notes — the claims-based PR intake already covers this repo's own PRs.
  Reopens only via a user issue carrying a concrete use case.
