# Roadmap — the next level

> **Status 2026-07-26:** all three phases are implemented on `main` — npm
> packaging (the tarball ships compiled `dist/` because Node refuses to
> strip types under `node_modules`; the roadmap's "ship src/" assumption was
> wrong), the composite GitHub Action with a keyless smoke workflow, `watch`
> mode with state/index/notify, the 20-case golden set, and SCORING.md.
> One deliberate direction change against 1.1/3.2: this is a solo,
> local-first project, so releasing is a local routine (`pnpm dogfood` gate
> + `--calibrate` drift check + `pnpm publish`) instead of a secret-carrying
> CI pipeline — the repo needs no ANTHROPIC_API_KEY/NPM_TOKEN secrets and
> stays judge-agnostic. Open: publishing v0.1.0 itself and the local-9B
> rerun with `--concurrency 1`
> ([#6](https://github.com/bmmmm/comparereleaseii/issues/6) territory).

Status when this plan was written (2026-07-26): the CLI is feature-complete
and validated — five release-note dialects checked against real releases
(headscale 96, git-cliff 91, restic 90, vaultwarden 79, fabricated notes 5),
real findings confirmed (a release note advertising a feature absent from the
diff; a new endpoint hidden behind "Updates and fixes"), deterministic cached
judging, escalation, local models, OpenRouter, `--estimate`, `--calibrate`
with model ranking, CI green, dual-remote published.

**The bottleneck is no longer functionality.** It is (1) accessibility —
nobody can use the tool in 30 seconds, (2) continuity — the value appears
when every NEW release is checked automatically, not when someone remembers
to run a CLI, and (3) judge trust over time — prompts and models drift.
The three phases attack exactly these, in order of leverage.

Deliberately out of scope for now: the local model-selection run
([#6](https://github.com/bmmmm/comparereleaseii/issues/6), separate
undertaking), any web SaaS/database, and score-formula tuning beyond
documentation.

---

## Phase 1 — Distribution: from repo to `pnpm dlx` and a GitHub Action

Goal: a stranger goes from zero to a verdict in under a minute, and a
maintainer can gate releases without ever cloning us.

### 1.1 npm publish
- Add `files` whitelist (`src/`, `bin/`, `test/eval/golden.json` — calibrate
  needs it at runtime; exclude `test/`, `tmp/`, reports), `repository`,
  `keywords`, `exports` to package.json. Keep zero runtime deps.
- Resolve the golden-set path via `import.meta.url` relative to the installed
  package (already done — verify it survives `pnpm dlx`).
- `prepublishOnly`: `pnpm check && pnpm test`.
- Publish with npm provenance (`npm publish --provenance` via a release
  workflow, not from a laptop). Version 0.1.0.
- **Done when:** `pnpm dlx comparereleaseii restic/restic --judge off` works
  on a machine that has only Node 24 + gh.

### 1.2 GitHub Action
- `action.yml` (composite): inputs `tag`, `base`, `engine` (default `api`),
  `model`, `fail-on`, `anthropic-api-key` (secret); runs the published
  package, writes the markdown report to `$GITHUB_STEP_SUMMARY`, uploads the
  HTML report as artifact, exits with the CLI's code.
- Trigger examples in README: `on: release` (gate your own notes at publish
  time) and `workflow_dispatch` with repo/tag inputs (check any repo).
- Optional input `comment: true` → post/update a comment on the release with
  the summary (needs `contents: write`).
- **Done when:** a scratch repo using the action goes red on the fabricated
  vaultwarden notes fixture and green on restic v0.19.1.

### 1.3 Docs polish for adoption
- README: quick-start switches to `pnpm dlx`; action usage block; badge
  snippet. CHANGELOG.md started (we of all tools should have honest notes —
  and dogfood: run the tool on our own first release).
- **Done when:** our own v0.1.0 release notes score ≥90 with our own checker
  in CI (dogfooding gate).

## Phase 2 — Watchdog: continuous release monitoring

Goal: "watch these 10 repos; when any of them publishes a release, check it
and tell me if something smells" — the supply-chain-watchdog use case that
motivated the risk flags.

### 2.1 `watch` subcommand
- `comparerelease watch --config watch.json`: config lists repos + per-repo
  options (fail-on, engine, baseline). State file (`~/.local/state/...` or
  configurable) remembers the last checked release per repo.
- A run: for each repo, find releases newer than state → full check → write
  `reports/<repo>/<tag>.{html,md,json}` → update state. No new releases =
  no-op (cheap: one API call per repo).
- Index: regenerate `reports/index.html` — table of repos × latest score,
  red rows for suspicious/failed releases, links to the full reports.
- **Done when:** a cron/launchd invocation over ≥10 real repos completes,
  a second immediate invocation is a no-op, and a fabricated-notes fixture
  repo shows up red in the index.

### 2.2 Alerting hook
- `--notify <cmd>`: on any release below threshold (or with critical flags),
  run the command with the JSON report path as argument — composable with
  mail/ntfy/webhook without us shipping integrations.
- Exit code of `watch`: worst result of the batch (CI-friendly).
- **Done when:** a below-threshold release triggers the hook exactly once
  (state prevents re-alerting on re-runs).

### 2.3 Ops packaging (own infra, optional)
- A small launchd/cron recipe in `docs/watchdog.md` + example config with
  the five validated repos. Judge default: local model with escalation —
  the watchdog is the natural home for the local-first setup.

## Phase 3 — Judge trust over time

Goal: keep the verdict quality measurable while models, prompts and providers
change underneath us.

### 3.1 Golden set 8 → ~20 cases
- Add: more `contradicted` shapes (removal claims, "disabled by default"
  claims, version claims), a legitimate `need`-protocol case, non-Rust
  ecosystems (JS lockfile attack, Python setup.py hook, Go module rename),
  docs-only claims, a revert ("fixed X" while the fix was reverted later in
  the range). Source them from real validated runs like the first eight —
  never synthetic-only.
- Keep the over-verify flag the primary safety metric.
- **Done when:** Haiku still passes ≥18/20 and the set separates it from the
  local 9B by ≥4 cases (discrimination proof).

### 3.2 Scheduled eval in CI
- Workflow (monthly + manual dispatch, needs `ANTHROPIC_API_KEY` secret):
  run `--calibrate` for the default judge, fail red on over-verify > 0 or
  passed < threshold. This is the drift alarm for silent model updates and
  our own prompt edits.
- **Done when:** the workflow ran green once and a deliberately broken
  prompt (test branch) turns it red.

### 3.3 SCORING.md
- Freeze and document the score semantics: component formulas, weights,
  caps, flag severities and the reasoning behind each (generated-entry ¼
  weight, auth/crypto-only criticals, escalation override). Users must be
  able to interpret 79 vs 91 without reading source.
- **Done when:** README links it and the HTML report footer links it.

---

## Iteration 2 — apply what the shakedown taught (2026-07-26)

The phase-1–3 build validated the tool against 11 real repos and two judges;
this iteration turns what that validation *found* into fixes. Priorities in
order — each lands as its own commit series, validated the usual way.

### 2.0 Consolidate the working tree (before anything else)
The `--suggest` work in flight (suggest.ts plus changes across report/html/
verify/cli) must be finished, tested and committed before new work starts —
no feature work on a dirty tree. Going forward: one session per checkout,
parallel sessions use worktrees.
- **Done when:** `git status` clean, suite green, `--suggest` documented in
  the README options table.
- **Landed 2026-07-26:** consolidated as `4f80b6a` on top of the `--suggest`
  series; suite green. `--suggest` is documented in `--help` and README
  prose — the README options table no longer exists since the slim-down.

### 2.1 Close the escalation gap — the highest-value 9B finding
`isSecuritySensitive` escalates a local judge's `verified` only when the
claim carries advisory anchors or sits in a Security-named section. The 9B
rubber-stamped the setup.py install hook as verified under "Packaging
cleanup" / "What's Changed" — production would NOT escalate that verdict.
Extend the trigger: `verified` from a local primary also escalates when the
matched evidence touches sensitive paths (dependency manifests, install
hooks, lockfiles, auth/crypto — reuse `sensitiveCategory`).
- **Done when:** a unit test proves the setup.py shape escalates, and every
  attack-shape golden case routes through escalation with a local primary.
- **Landed 2026-07-26:** `verified` from a local primary now also escalates
  when the evidence paths hit a `sensitiveCategory`; setup.py unit test,
  non-sensitive negative case, and an attack-shape golden sweep prove it.

### 2.2 Sharpen the need protocol; de-circularize changelog evidence
Both judges dodge `need`: Haiku answered `partial` citing the CHANGELOG hunk
(notes proving notes — circular), the 9B answered `no-evidence`. Two levers:
tell the judge in the prompt when `need` is the right answer (claim names a
file the hunks don't contain), and down-weight changelog/docs hunks as
evidence for code claims.
- **Done when:** Haiku passes the need case without regressing the rest,
  and a changelog-only hunk no longer supports a code claim.
- **Landed 2026-07-26:** need guidance + changelog-circularity rule in the
  judge prompt; the vague-claim fallback filters changelog hunks; calibrate
  now offers the need protocol (`allowNeed` + per-case `allPaths` — the need
  case was previously unwinnable since the prompt never offered "need").
  Haiku: 20/20 including the need case, over-verify 0.

### 2.3 Find the best local judge (issue #6, now unblocked)
`--concurrency 1` made the full oMLX ranking runnable: 11 models × 20 cases,
detached, roughly an hour. Include the #6 review list: need-misuse, timing
skew, case validity.
- **Done when:** the README reference point names the best local judge with
  its score and #6 closes with the ranking table.

### 2.4 False-positive sweep over the report corpus
The watchdog shakedown caught two FP classes (docs and test files matching
auth keywords) by reading real reports. tmp/watch-reports2 holds 11 of them
— walk every flag, every FP becomes a class fix with a test; optionally
widen the corpus to ~25 repos overnight.
- **Done when:** every critical flag in the corpus is either true or fixed
  as a class, and honest repos stay ≥ 65.

### 2.5 Ship v0.1.0
Run the local routine: `pnpm dogfood` → `--calibrate` → `pnpm publish` →
push tags. The README's `uses: bmmmm/comparereleaseii@v0.1.0` becomes valid
with the tag.
- **Done when:** `pnpm dlx comparereleaseii` resolves from the registry and
  the action ref works in a workflow.

Process learnings applied outside the repo (global CLAUDE.md + project
memory): clarify who releases from where BEFORE building release/CI infra;
parallel sessions only in worktrees; `!`-handoff commands pinned (explicit
`--model`) and detached.

## Order and why

1 → 2 → 3. Distribution first because every later phase benefits from an
installable artifact (the Action powers the watchdog examples; the eval
workflow uses the published package). Watchdog second because it turns the
tool from a demo into a daily instrument — and it is the use case the risk
flags were built for. Judge-trust third because it hardens what phases 1–2
expose to strangers; its groundwork (eval harness, calibrate) already
exists.

Rough effort: phase 1 one focused session, phase 2 one to two, phase 3 one.
Each phase lands as its own PR-sized commit series on `main`, validated the
way this repo always validates: against real releases, with the fabricated
fixture as the negative control.

Tracking issues: [#7 Phase 1](https://github.com/bmmmm/comparereleaseii/issues/7) ·
[#8 Phase 2](https://github.com/bmmmm/comparereleaseii/issues/8) ·
[#9 Phase 3](https://github.com/bmmmm/comparereleaseii/issues/9)
