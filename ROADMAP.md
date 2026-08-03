# Roadmap

> **Status 2026-08-03:** everything planned so far is on `main` — the three
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

## Open (2026-08-03)

The complete list — anything not here is landed or settled below.

- **Demand-driven only** (no schedule, deliberately not in the plan): the
  F23 maxBuffer decision; the Action PR-comment variant; v-prefixed
  versions as identifier anchors.

## Demand-driven only (no schedule)

- **v-prefixed versions as identifier anchors:** `v7.1.4` in a claim text
  anchors nothing today — the identifier bar counts digit-led versions
  only, so a bump claim can sit unsupported next to the finding that
  observes the same bump (seen live on OpenCloud v7.2.2; cosmetic — no
  score or alert was wrong). Trigger: the first weeks of reconciliation
  reports show bump claims dominating the unsupported line, or a score or
  alert is demonstrably wrong because of it. Then score-neutral first — a
  claims×pins join in the reconciliation (a bump claim whose pin the diff
  demonstrably moves reads confirmed; deterministic, display-only, no A/B
  debt). Widening the shared identifier bar itself is the second step and
  faces the A/B discipline plus the README validation table.

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
