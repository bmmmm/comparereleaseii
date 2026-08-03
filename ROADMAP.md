# Roadmap

> **Status 2026-08-03:** everything planned so far is on `main` — the three
> original phases (distribution, watchdog, judge trust), iterations 2–4,
> the 2026-07-27 block series (bughunt follow-up, hardening backlog, forge
> watching, presentation + author ledger), the long view (backfill,
> phases/events/heatmap), and the second axis (pins → substance →
> first-party expansion → findings/lenses → substance coverage; release
> pending as v0.7.0). This file carries only what is open. The landed
> plans and their dated landed notes live in this file's git history (up
> to `039460a`); durable outcomes live where they belong — CHANGELOG
> (what shipped), SCORING.md (score semantics), AGENTS.md (working
> rules), docs/ (operations).

## Open (2026-08-03)

The complete list — anything not here is landed or settled below.

- **Cut v0.7.0** (Block 1): the Unreleased CHANGELOG block, incl. the
  score-relevant S5 change.
- **Watcher parity + lens rollout** (Block 2): extension pin bump, S4a
  `audience:` values in the live config, stale-XDG-state deletion.
- **Backfill the live watchlist** (Block 3): user go at run time (judge
  cost).
- **Reconciliation layer** (Block 4): design proposal written, two
  decisions marked open.
- **Demand-driven only** (no schedule, deliberately not in the plan): the
  F23 maxBuffer decision; the Action PR-comment variant.

## Next — v0.7.0 and the axis in operation (2026-08-03)

Context: the second axis is code-complete on `main` but nobody consumes it
yet — the CHANGELOG block is unreleased, the live watcher runs v0.6.0
without lens config, and the reconciliation idea has ready inputs but no
block. Blocks 1–3 are operations (ship, deploy, use); Block 4 is the only
build block. F23 and the Action PR-comment stay demand-driven — putting
them here would schedule work no demand has asked for.

### Block 1 — release v0.7.0
The Unreleased block carries the whole second axis: four additive features
(pins, substance, first-party expansion, findings/lenses) and one
score-relevant change (S5 substance coverage) — a minor bump; no public
contract moves (exit codes, JSON additive-only, flag semantics). The local
routine applies: full suite + `pnpm mutate` (every guard) green, `pnpm
dogfood` gate on our own notes, `--calibrate` drift check,
`release:prepare` / `release:publish`, tag on both forges + GitHub
release — the moment the public mirror catches up. The README validation
table already carries the 2026-08 numbers (re-measured under S5); only
another scoring change would require a fresh run.
**Done when:** `v0.7.0` exists on both forges with the GitHub release
published and the dogfood gate scored our own notes ≥ 90.

### Block 2 — the watcher catches up: version parity + lens rollout
Operations, not code — the config lives outside this repo:
- Bump the watcher's pinned extension/checkout to `v0.7.0` (version-parity
  sweep: every deployment place moves together, none is left behind).
- Set the S4a `audience:` values in the live `watch.json` — operator:
  vaultwarden, traefik, omlx; integrator: sandbox-runtime, soundcloud/api;
  user: the seven desktop apps. Existing `components`/`expand` entries
  stay untouched.
- Housekeeping, user go at run time: delete the stale pre-2026-07-28 XDG
  state copy under `~/.local/state/comparereleaseii/`.
**Done when:** the next watch-written report renders a default lens, the
version sweep reports one version everywhere, and the stale state is gone
or explicitly kept.

### Block 3 — backfill the live watchlist (user go at run time)
The standing offer from the long-view work, now worth more: the reports
it writes carry findings and lenses. `watch backfill --releases 5` across
the watchlist — the command states the judge cost and asks before
starting; backfilled checks never alert. Runs after Block 2 so the
reports are written by the released version with lens config in place.
**Done when:** every watchlist repo has a median, drift detection and a
filled author ledger (≥ 5 checks each), or a documented skip.

### Block 4 — reconciliation: claims meet findings (design, then build)
Settled with the axis (2026-08-02): messages and notes join *late*,
against the findings — confirmed (claimed + observed), undocumented
(observed, never claimed — the interesting signal), unsupported (claimed,
never observed). Score-neutral until measured, like every stage before
it. Proposal, deterministic first: match claims to findings with the S5
machinery (identifier overlap against a finding's text + files), render
as per-finding tags in the findings section plus one "unsupported claims"
line; a judged matching pass only where the deterministic one stays
empty — and only as a later, separate decision. Open before building:
whether reconciliation renders inside the findings section or as its own;
whether `undocumented` findings should order the uncovered list (display
only — anything score-touching faces the A/B discipline).
**Done when:** a cached OpenCloud report shows all three sets from
existing data, `--judge off` degrades honestly (no findings → no
reconciliation, deterministic output unchanged), re-runs stay
bit-identical, and a score-neutrality test pins it.

Order: 1 → 2 → 3 → 4. Ship first — nothing downstream may pin an
unreleased tree; parity + lenses second — the watcher must not keep
writing reports with a version the repo has moved past; backfill third —
its reports should be the final shape; reconciliation last, as the only
block that changes code, inheriting an axis that is actually in operation
by then.

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
