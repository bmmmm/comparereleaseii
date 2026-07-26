# Roadmap — the next level

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
