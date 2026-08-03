# Roadmap

> **Status 2026-08-03:** everything planned so far is on `main` — the three
> original phases (distribution, watchdog, judge trust), iterations 2–4,
> the 2026-07-27 block series (bughunt follow-up, hardening backlog, forge
> watching, presentation + author ledger), the long view (backfill,
> phases/events/heatmap), and the second axis (pins → substance →
> first-party expansion → findings/lenses → substance coverage; shipped
> as v0.7.0 on 2026-08-03). This file carries only what is open. The landed
> plans and their dated landed notes live in this file's git history (up
> to `039460a`); durable outcomes live where they belong — CHANGELOG
> (what shipped), SCORING.md (score semantics), AGENTS.md (working
> rules), docs/ (operations).

## Open (2026-08-03)

The complete list — anything not here is landed or settled below.

- **Reconciliation layer** (Block 4): design settled, build in progress.
- **Demand-driven only** (no schedule, deliberately not in the plan): the
  F23 maxBuffer decision; the Action PR-comment variant.

## Next — v0.7.0 and the axis in operation (2026-08-03)

Context: v0.7.0 shipped 2026-08-03 and the axis is in operation — the
watcher runs the released version with per-repo lenses configured, and
the watchlist is backfilled to drift depth (≥ 6 checks everywhere).
Block 4 is the remaining build block. F23 and the Action PR-comment stay
demand-driven — putting them here would schedule work no demand has
asked for.

### Block 4 — reconciliation: claims meet findings (design, then build)
Settled with the axis (2026-08-02): messages and notes join *late*,
against the findings — confirmed (claimed + observed), undocumented
(observed, never claimed — the interesting signal), unsupported (claimed,
never observed). Score-neutral until measured, like every stage before
it. Proposal, deterministic first: match claims to findings with the S5
machinery (identifier overlap against a finding's text + files), render
as per-finding tags in the findings section plus one "unsupported claims"
line; a judged matching pass only where the deterministic one stays
empty — and only as a later, separate decision. Settled at build start
(2026-08-03, user): reconciliation renders inside the findings section
(per-finding tags plus one unsupported-claims line), and `undocumented`
findings order the uncovered list — display only, anything score-touching
faces the A/B discipline.
**Done when:** a cached OpenCloud report shows all three sets from
existing data, `--judge off` degrades honestly (no findings → no
reconciliation, deterministic output unchanged), re-runs stay
bit-identical, and a score-neutrality test pins it.

## Demand-driven only (no schedule)

- **F23 maxBuffer:** first decide whether kernel-scale releases are a target
  at all. If not: a one-hour actionable error ("diff exceeds 64 MB — narrow
  with --base"). If yes: streaming diff parse + per-file patch cap with
  warning (the GitHub-API behavior downstream already handles).
- **Action PR-comment variant:** GitHub-only nice-to-have, waits for a
  concrete need.

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
