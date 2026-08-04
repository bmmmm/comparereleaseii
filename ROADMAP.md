# Roadmap

> **Status 2026-08-04:** the bump block landed — bump claims are settled by
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

## Open (2026-08-04): a judge that cites lines it was never shown

The complete list — anything not here is landed or settled below.

**One finding survived the bump block, and it is not about bumps.**
traefik v3.6.25's notes carry "Bump `github.com/DataDog/dd-trace-go/v2` to
2.8.1". That release's diff moves the module nowhere: it appears in the
diff only inside `CHANGELOG.md`, so the pin join has nothing to join and the
claim takes the ordinary route. The judge answers `contradicted`, reasoning
that "the go.mod and go.sum diffs show it was bumped from v2.2.3 to v2.8.2"
— neither file's diff in that release contains the module at all. Two
independent passes agreed (the second-voter rule for `contradicted` was
satisfied), so the release is capped at 35, "suspicious", on evidence that
does not exist.

`no-evidence` is the honest verdict for a claim whose subject the diff never
touches. The judge reached past what it was shown and reported the reach as
a finding — and the vote rule cannot catch it, because two passes reading
the same prompt invent the same plausible thing.

What is NOT yet known, and has to come before any fix:

1. **How often.** One case is an anecdote. The corpus has 12 contradicted
   claims total; re-reading each one's cited files against the diff it was
   shown is a bounded, deterministic check — a claim citing a path that
   carries no hunk in that release is the shape to count.
2. **Whether it is one prompt's problem.** The judge is handed ranked hunks
   plus the release's full path list (`allPaths`, so it can ask for a file
   it needs). A model can name a path from that list and then describe
   content it never saw. Whether the list is load-bearing here is testable:
   a golden case whose claim names a file present in `allPaths` but absent
   from the hunks, with `contradicted` as the wrong answer and
   `no-evidence` as the right one.

Only with those two numbers does a fix become a decision rather than a
guess. The obvious candidates — requiring a `contradicted` verdict's cited
files to carry a hunk the judge actually received, or grading the citation
in calibration rather than only the verdict — both move rulings and would
face the full discipline: golden cases, `pnpm eval` before and after, the
README validation table re-measured.

**Settled in the same breath, so it does not get re-litigated:** the
identifier-anchor question that opened this whole line closed with the bump
block. Widening the shared identifier bar to v-prefixed versions (`v7.1.4`,
the original OpenCloud observation) is no longer demand-driven by anything
in the corpus — the class that motivated it is answered through its own
deterministic channel. It reopens only on new evidence of its own.

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
  the cap. Settling bump claims off the diff's own pin delta removed seven
  of the corpus's eight bump contradictions without touching a scoring
  number, which is what "score-neutral first" was for — there is now no
  A/B debt, no re-measured README table, no calibration drift to chase. The
  eighth survivor is a judge citing files it was not shown (open, above),
  and no cap semantics repairs that. Reopening the cap needs a case where
  the verdict is right and the cap is still wrong.
- **Action PR-comment variant: rejected until real demand** (2026-08-04):
  the tool checks release notes against a diff, and a PR has no release
  notes — the claims-based PR intake already covers this repo's own PRs.
  Reopens only via a user issue carrying a concrete use case.
