# Roadmap — the next level

> **Status 2026-07-26:** all three phases are implemented on `main` — npm
> packaging (the tarball ships compiled `dist/` because Node refuses to
> strip types under `node_modules`; the roadmap's "ship src/" assumption was
> wrong), the composite GitHub Action with a keyless smoke workflow, `watch`
> mode with state/index/notify, the golden set, and SCORING.md.
> One deliberate direction change against 1.1/3.2: this is a solo,
> local-first project, so releasing is a local routine (`pnpm dogfood` gate
> + `--calibrate` drift check + git tag + GitHub release) instead of a
> secret-carrying CI pipeline — the repo needs no
> ANTHROPIC_API_KEY/NPM_TOKEN secrets and stays judge-agnostic. Both former
> open points landed in Iteration 2: v0.1.0 shipped as git tag + GitHub
> release (no npm — see 2.5), and the full 11-model ranking closed
> [#6](https://github.com/bmmmm/comparereleaseii/issues/6).

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
- **Landed 2026-07-26:** full 11-model oMLX ranking ran post-2.2-prompts.
  Best local judge: Qwen3.5-27B-Claude-4.6-Opus-Distilled (19/20,
  over-verify 0, 46 s/call); speed pick Qwen3.6-35B-A3B fp16 (17/20, 0,
  3.4 s/call); the 9B lands at 14/20 with 3 rubber-stamps. Haiku 20/20 —
  6 cases ahead of the 9B. docs/local-models.md carries a coarse
  community-results table (PRs welcome, no absolute scores — they don't
  transfer); the exact dated ranking lives in #6.

### 2.4 False-positive sweep over the report corpus
The watchdog shakedown caught two FP classes (docs and test files matching
auth keywords) by reading real reports. A local corpus of 11 of them was
generated under `tmp/` — walk every flag, every FP becomes a class fix with
a test; optionally widen the corpus to ~25 repos overnight.
- **Done when:** every critical flag in the corpus is either true or fixed
  as a class, and honest repos stay ≥ 65.
- **Landed 2026-07-26:** corpus regenerated under `tmp/` (gitignored — the
  findings below are the durable part). Both honest-repo criticals were the already-fixed
  docs/tests-as-auth classes; the sweep found one live FP class —
  `.github/*.md` counted as ci/build — fixed by checking DOC_FILE before
  CI_BUILD. All remaining flags are true by design (fabricated-control
  criticals, dependency-manifest warns, testdata opaque-change, bot as
  first-time author). Re-run: ripgrep 45→73, caddy 45→91.

### 2.5 Ship v0.1.0
Run the local routine: `pnpm dogfood` → `--calibrate` → `pnpm publish` →
push tags. The README's `uses: bmmmm/comparereleaseii@v0.1.0` becomes valid
with the tag.
- **Done when:** `pnpm dlx comparereleaseii` resolves from the registry and
  the action ref works in a workflow.
- **Landed 2026-07-26:** shipped WITHOUT npm — user decision: no npm
  account, no standing supply-chain surface for one convenience installer.
  The Action only needs the git tag (`bin/comparerelease.mjs` falls back to
  `src/`; Node ≥ 24 runs the TypeScript directly), so the ship is tag
  v0.1.0 + GitHub release, notes gated at 95/100. README quick start
  switched to clone+run; the watchdog CI recipe checks the tool out at
  `v0.1.0`. `pnpm dlx` can be added any time later (account + `pnpm
  publish` + README revert).
- **The packaging path stays exercised, not just present:** `pnpm build` runs
  in CI, so the `dist/` branch of `bin/comparerelease.mjs` and
  `tsconfig.build.json` cannot rot while unused. Verified end to end on
  2026-07-26 — `pnpm pack` → extract under `node_modules/` → run: help,
  `guidelines` (needs `docs/` from the tarball) and a full check all work,
  the golden set resolves from `dist/`, and the report is byte-identical to
  the same check run from `src/`.

Process learnings applied outside the repo (global CLAUDE.md + project
memory): clarify who releases from where BEFORE building release/CI infra;
parallel sessions only in worktrees; `!`-handoff commands pinned (explicit
`--model`) and detached.

## Iteration 3 — lessons from the first real watchlist (2026-07-26)

The first 12-repo watchlist run (user's own GitHub notifications → watch
init) flagged 8 of 12. Post-mortem on the reports split that into: one tool
bug (base picking — fixed same day, bitwarden 35→91), two NEW systematic
measurement gaps (3.1/3.2/3.3), and two honest-but-mislabeled classes
(3.4/3.5). Verdict on the method itself: the correctness component and the
verdict ladder discriminate correctly (sniffnet/zed score 98 correctness
while red; the four clean repos score 88–100; fabricated control stays 5).
What breaks in the real world is the assumption "notes describe exactly the
base→head diff" and the absolute reading of completeness/risk.

### 3.1 HTML/boilerplate lines must not become checkable claims
omlx: an `<img>` tag and a marketing header both became claims and both
landed no-evidence. Parser: lines that are pure markup (HTML tags without
prose) never become claims; standing marketing intros are covered by 3.2.
- **Done when:** the omlx fixture yields no claim for the img line, claim
  count drops accordingly, no regression on the five dialect fixtures.
- **Landed 2026-07-26:** paragraphs and bullets whose text is empty after
  stripping HTML tags never become claims; inline HTML inside real prose
  survives.

### 3.2 Carried-over claims: dedupe against the base release's notes
omlx v0.5.3 repeats v0.5.2 material verbatim (4 of the top no-evidence
claims, including the standing intro — verified against the live API). One
extra API call fetches the base release's notes; claims whose normalized
text already appears there are reported as "carried over from <base>" and
leave correctness (like meta claims) instead of drowning the score in
no-evidence.
- **Done when:** omlx v0.5.3 re-checks solid, carried-over claims listed
  separately in terminal/HTML/markdown.
- **Landed 2026-07-26:** 48 of omlx's 59 claims recognised as standing text;
  correctness now measures the 11 real ones (82). Not "solid" — what caps it
  at 45 is a genuine undocumented minified `tailwind.css`, no longer drowned
  claims. The base notes cost no extra request (the release list fetched to
  pick the base already carries every body); only an explicit `--base` does.
  Guards against neutralising a claim by repeating it: full-text match, and
  lines under four words exempt.

### 3.3 Out-of-repo releases: say it, don't insinuate
zen-browser ships upstream Firefox features whose code never appears in the
fork's own diff (HDR, QWACs, Globe-F — all no-evidence); claude-code is a
changelog-only repo. The verdicts are technically right, the "suspicious/
questionable" story is wrong. Cheap detection first: when the majority of
checkable claims are no-evidence AND the repo's baseline shows that is its
normal shape, the report should state "these notes describe changes outside
this repo's diff (fork/build/distribution repo)" instead of implying deceit.
- **Done when:** zen's report carries the explicit out-of-repo notice and
  the watch index shows it distinctly from a genuine score collapse.
- **Landed 2026-07-26:** both halves, as one `metrics.unverifiable`
  category. `sourceless` (no source file in the diff at all) came from
  [#12](https://github.com/bmmmm/comparereleaseii/issues/12) and needs no
  history — claude-code v2.1.220 went 27 suspicious → 75 unverified.
  `out-of-repo` needs the repo's own: release snapshots gained a
  deterministic `lexicalCoverage`, and the shape is only claimed when a
  strict majority of claims miss AND the last ≥ 3 releases show the same
  pattern AND nothing is contradicted or critical — zen-browser
  questionable → 96 unverified with the explicit notice, watch index
  tagged. One thing the plan did not foresee: with the misses out of the
  ratio, zen first read "96/100 solid" — a clean bill of health for a
  release where nothing was checked. Hence the new `unverified` label,
  which wins over the numeric band whenever no checkable claim is left.

### 3.4 Baseline-relative labels and alerting
traefik is ~25 on every release (9% churn coverage is its culture, not an
incident). The state already holds up to 20 checks per repo — the label and
the watch alerting should read the score against the repo's own history:
"25 — in line with this repo's median" is calm, "60 — down from a 90
median" is the alarm. Absolute `notifyBelow` stays as the fallback for the
first checks.
- **Done when:** a repo with a stable low score stops alerting after its
  baseline forms, and a synthetic score drop on a stable-high repo alerts.
- **Landed 2026-07-26:** after three checks the repo's median *replaces* the
  absolute `notifyBelow` rather than joining it — otherwise a stable-high repo
  would still be measured against 65 and its drop to 70 would stay silent. The
  level is taken from the checks before the current one, so a slow slide
  cannot redefine "normal". Index shows `~median` or a red drop arrow.

### 3.5 Risk-flag specificity on large releases
zed (158 commits) and nextcloud (676) each collected 2 criticals — at that
size some undocumented sensitive-path change is near-certain, so the flag
measures release size, not risk. Options, to be decided by data from the
report corpus: cap the warn-penalty, and/or require a baseline anomaly
(first-time author, first binary, unusual churn) before a critical fires on
releases whose churn is within the repo's norm.
- **Done when:** honest large releases in the corpus stop hitting the risk
  floor while the fabricated control and the golden attack shapes keep
  their criticals.
- **Landed 2026-07-26:** a fresh 10-repo corpus (zed, nextcloud, traefik,
  cli, ripgrep, caddy, bat, restic, fzf, helix — regenerate with
  `--judge off --json`) confirmed the hypothesis: no release under 100
  commits produced a single critical.
  Reading the flags first found three FP classes, fixed before any threshold
  moved: Cargo parsed without section context (`version` under `[package]`),
  `workspace = true` refs counted as new suppliers, and go.mod self-modules /
  same-supplier second lines. zed 5 criticals → 1. The remaining one needed no
  threshold but a definition: the attack signature is "notes read as a full
  account, but the auth change is missing", so `undocumented-sensitive` stays
  critical only above 60 % documented churn. zed 45 → 69, traefik keeps its
  earned critical (`gonginx` arrives undocumented), fabricated control stays
  suspicious at 22.

### 3.6 Golden set: add the real-world shapes
The set validates judges against attack shapes; the watchlist showed the
frequent benign shapes are missing: cumulative/recap notes (omlx), fork/
out-of-repo notes (zen), thin-notes culture (traefik), monorepo product
tags (bitwarden — regression-covered in pickBaseRelease unit tests already).
- **Done when:** calibration distinguishes a judge that handles these
  shapes from one that panics on them.
- **Landed 2026-07-26:** golden set 20 → 23 with the benign shapes: a
  docs-only diff, a fork claiming an upstream feature, and a thin note against
  a large unrelated diff. Each tests that the judge answers `no-evidence` or
  `verified` instead of reaching for `contradicted`. Cumulative notes needed
  no case — carried-over claims are filtered deterministically before the
  judge sees them (3.2), and are covered by unit tests. Haiku 23/23,
  over-verify 0. The thin-note case first failed with a legitimate `need`
  (the judge wanted to see whether the reader path took the lock too) — the
  fixture was incomplete, not the judge.

## Iteration 4 — measure what 0.1.2 changed, then leave GitHub (2026-07-26)

Two threads, deliberately in this order. The audit release moved every
number the tool produces and nobody has seen what that does to real repos;
and the tool still only speaks one forge, though its own data model has been
forge-agnostic since day one.

### 4.1 Re-run the watchlist under 0.1.2 — measure before building

0.1.2 changed scoring in four ways that compound on real releases: a note
echoing its own commit subject no longer settles a claim, an anchored claim
without a judge tops out at `partial`, `judge-unavailable` is a new warn
flag, and `watch` now flags a sliding level. Our own release check went 86 →
82 from the anchored-path change alone. On an 11-repo watchlist of other
people's projects that could read as sharper detection or as alert fatigue,
and the two look identical from here.

- Run the existing watchlist (`~/ops/release-watch/watch.json`, 11 repos,
  `claude-cli`; state already holds 12 repos from the first run) against
  0.1.2. **Set `XDG_CACHE_HOME` to a writable dir first** — without a usable
  cache the judge varies between runs and none of the numbers below are
  comparable (measured: 84 vs 90 on the same check).
- For every repo, put the 0.1.2 score next to the one in the state file from
  the first run, and attribute each move of more than 10 points to a cause:
  which of the four changes did it, or is it genuine drift in that project's
  notes? An unattributable move is the interesting finding.
- Separate the two failure shapes explicitly: a repo that now scores lower
  *and should* (the notes really do lean on commit-subject echo) versus one
  that scores lower because the deterministic path got stricter while the
  notes stayed honest. Only the second is a bug.
- **Done when:** every repo's move is attributed, and the result says either
  "the new defaults are right" or names the specific rule to soften — with
  the release that proves it. That verdict is what Iteration 5 is built on,
  the same way Iteration 3 came out of the first watchlist run.

### 4.2 Forge-agnostic input: Forgejo, GitLab, and anything with git

Today `owner/repo` means GitHub and nothing else, which rules out every
self-hosted Forgejo and GitLab — including the forge this project's own
`origin` lives on. The goal is that pointing the tool at a repository URL or
a release URL does what it already does for GitHub.

The cheap route is not one API adapter per forge. `ReleaseData`
(`src/types.ts`) is already the forge-agnostic contract — `loadGithubRelease`
and `loadLocalRelease` both satisfy it — and `ensureClone()`
(`src/sources/local.ts`) already clones an arbitrary URL with
`--filter=blob:none`. A clone answers almost every question the checker asks:
diff, commits, subjects, authors, per-commit diffs, tags for the baseline,
languages and cadence. Only two things genuinely live on the forge: the
release notes, and which releases exist. So:

- **4.2a — URL in, clone out, no new API.** `comparerelease --repo-url
  <url> [--tag <t>]` clones (cached), resolves base/head from tags, and takes
  notes from `--notes-file` or the CHANGELOG section, which `loadLocalRelease`
  already does. This alone covers every forge on earth, including private and
  air-gapped ones, and it ships without touching a single HTTP client. Worth
  noting the clone diff is *better* than GitHub's: the API truncates large
  compares (hence `truncated` in `ReleaseData`), a clone does not.
- **4.2b — one endpoint per forge, only for notes and the release list.**
  Forgejo/Gitea (`/api/v1/repos/{o}/{r}/releases`) and GitLab
  (`/api/v4/projects/{id}/releases`) both expose a flat releases list. That
  is the whole integration surface: notes text, tag name, published date —
  enough for base-picking and the `--baseline` history. Compare, commits and
  per-commit diffs stay on git. Auth: reuse whatever `git` already has for
  public repos; a token env var per forge for private ones, never a config
  file.
- **4.2c — merge-request dialect.** `extractPrNumbers()` matches `(#123)` and
  `Merge pull request #123`, both GitHub conventions. GitLab writes `!123`
  and "See merge request group/proj!123"; Forgejo mostly follows GitHub.
  Anchors are one of the deterministic verification stages, so a missing
  dialect quietly costs evidence rather than erroring — needs a fixture per
  forge in `test/fixtures/`.
- **Stays GitHub-only, on purpose:** `watch init` builds its candidate list
  from stars, watched repos and release notifications — inherently a GitHub
  account feature. Other forges get repos via `watch add`, which is one line
  and already forge-neutral once 4.2a lands.
- **Done when:** the same release checks identically through `--repo-url`
  against a self-hosted Forgejo repo and through `owner/repo` against its
  GitHub mirror — this repo is its own fixture, since it is mirrored to both.

**Why 4.1 first:** 4.2 widens the input surface. Widening it while the
scoring behaviour underneath has just changed and has never been measured on
real repos means any surprise afterwards has two possible causes instead of
one.

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
