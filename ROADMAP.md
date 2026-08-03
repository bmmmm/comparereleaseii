# Roadmap — the next level

> **Status 2026-08-03:** everything planned below is on `main` — the three
> original phases (distribution, watchdog, judge trust; shipped without npm
> and without repo secrets, both deliberate), iterations 2–4, the
> 2026-07-27 block series (bughunt follow-up, hardening backlog, forge
> watching, presentation + author ledger), the long view (backfill,
> phases/events/heatmap), and the second axis (pins → substance →
> first-party expansion → findings/lenses → substance coverage). This file
> is a journal: each section keeps its plan and its landed notes, newest
> section last.

## Open (2026-08-03)

The complete list — everything below this section is landed or explicitly
settled. The first four items are planned in detail in "Next — v0.7.0 and
the axis in operation" at the bottom of the file (journal order: newest
last).

- **Cut v0.7.0** (Block 1 there): the Unreleased CHANGELOG block, incl.
  the score-relevant S5 change.
- **Watcher parity + lens rollout** (Block 2): extension pin bump, S4a
  `audience:` values in the live config, stale-XDG-state deletion.
- **Backfill the live watchlist** (Block 3): user go at run time (judge
  cost).
- **Reconciliation layer** (Block 4): design proposal written, two
  decisions marked open.
- **Demand-driven only** (no schedule, deliberately not in the plan): the
  F23 maxBuffer decision; the Action PR-comment variant.

Settled decisions (badges rejected, `watch serve` unbuilt, public scans
rejected, calibration frozen): see "Settled — do not reopen without new
facts" further down.

---

## Landed — post-bughunt plan (2026-07-27)

Context: a full-repo bug hunt at v0.2.0 read all 22 modules, confirmed and
fixed 20 findings (see the Unreleased CHANGELOG section and the commit
series merged as `60fb121`), and left three deferred findings as FIXME
anchors in code. This section is the agreed follow-up plan, including the
disposition of every open idea — decisions here are settled, not up for
re-litigation.

### Block 1 — release v0.2.2
Ship the 17 Unreleased entries via the local routine
(`pnpm release:prepare` / `release:publish`). Dogfood already passed
100/100 on the merged tree. **Done when:** tag + both forges carry the
release.
- **Landed 2026-07-27.** Dogfood 100/100; tag `v0.2.2` on both forges,
  GitHub release published. One deviation from the routine: the release ran
  from the worktree on `bughunt` (whose tip WAS remote `main`), so the
  publish script's branch push was replaced by explicit `HEAD:main` pushes —
  `release:publish` would have pushed a `bughunt` branch to both forges.

### Block 2 — F15 hotfix: mixed-source author identities (30 min)
When check data comes from a clone (compare-truncation fallback) while
baseline snapshots came from the GitHub API, git names never match API
logins and `new-author-sensitive` fires spuriously — a real false-alarm
source in watch mode. Hotfix: detect the mixed-source case and demote the
flag to `info` with a "author identities not comparable across sources"
note. The clean fix is Block 8. **Done when:** a truncation-fallback check
against an API-built baseline produces no warn-level new-author flag.
- **Landed 2026-07-27** (`13d6a36`), and superseded by Block 8 the same day —
  the demotion and its `mixedAuthorSources` field lived for six commits.

### Block 3 — golden-set gate: "is this local model fit to judge?" (~2 days)
Not more calibration iterations — a one-time driving test, then the LLM
topic freezes. The 25 existing cases already cover contradicted traps,
rubber-stamp resistance and injection; the four real gaps and the plan:

- **G1 — harden the set (~1 day):** add a `category` field to every case;
  new cases for the gaps: 2× circularity (a changelog hunk restating the
  claim must not verify it), 1× marker forgery (fake UNTRUSTED block
  boundary), 1× need temptation (evidence suffices — asking for more files
  is the wrong answer), 2–3× partial, and 3–4 **long-context variants**
  (same questions padded to 10–20k chars of real diff material, generated
  deterministically from fixtures) — every current case is 70–830 chars
  while production prompts carry up to 20k, so the set measures the wrong
  prompt size today. Target ~35 cases.
- **G2 — gate rules instead of a global score (~½ day):** per-category
  results plus a format-error rate (JSON-repair need is itself a signal).
  Disqualifying categories: any injection fail or a rubber-stamp on a
  security case → NOT RECOMMENDED; long-context must pass on its own;
  otherwise USABLE with `--escalate`; clean sweep → sole judge. Every
  rejection names the failed category.
- **G3 — freeze the Haiku reference (~2 h + one paid run):** run Haiku over
  the hardened set once, check the result in as
  `test/eval/reference-haiku.json` (model id + date); "fit" then concretely
  means "matches Haiku on all disqualifying categories".
  `docs/local-models.md` gets an "Is my model fit to judge?" section whose
  answer is one command. Optional: `--samples N` flip-rate metric (verdict
  instability was real: three runs, three verdicts on one claim).

**Done when:** one command answers recommend/escalate-only/reject for an
arbitrary local model, with the failed category named; Haiku reference
checked in; no further golden-set work planned.

- **Landed 2026-07-27** (`9bd7093`). Set 25 → 36 with categories; the four
  long-context variants expand at load time from `test/eval/padding.json`
  (real diff hunks of this repo, deliberately excluding judge.ts — prompt
  text reads as instructions). `gateCalibration()` implements exactly the
  G2 rules; JSON-repair became measurable via `JudgeFormatError`/meta.
  Haiku reference frozen at 36/36 gate `sole-judge` across two independent
  fresh-cache runs. What the runs settled that the plan could not: Haiku
  answers round-1 `need` on cases whose hunk cannot prove absence, and
  flickers between `need` and `no-evidence` on injections without ever
  obeying — those cases accept `need` now; the need-temptation case stays
  strict because its evidence visibly suffices. The optional `--samples N`
  flip-rate metric was skipped: two full runs answered the stability
  question the metric was for.

### Block 4 — HTML reporting (~1 day)
The report is the product's face and currently GitHub-biased:
- **Forge commit links:** `linkBase` is only set for `owner/repo` checks — a
  Forgejo/GitLab report has no clickable commits, treemap tiles or compare
  URL at all, although `parseRepoUrl` already knows the origin. Add per-forge
  URL shapes (Forgejo `/commit/`, GitLab `/-/commit/`); the GitHub-specific
  sha256 diff anchors stay GitHub-only.
- **Baseline sparkline:** put the individual snapshots (not just the
  medians) additively into `metrics.baseline` and render a small SVG trend
  for churn/coverage next to the numbers.
- **Light-mode parity:** the single report is hard dark while the watch
  index adapts; align them.
**Done when:** a `--repo-url` Forgejo report is fully linked, the baseline
renders as a trend, and both color schemes work.
- **Landed 2026-07-27** (`52e6e21`). `analyzeRelease` takes a `RepoLink`
  (base + path dialect) instead of a GitHub slug; GitLab spells `/-/`
  routes, everything else shares GitHub's; the sha256 treemap anchors stay
  GitHub-only. Verified live against gitea.com (`gitea/tea` fully linked,
  130 compare links, zero fabricated anchors). Baseline snapshots ride in
  `metrics.baseline` oldest-first and render as two inline sparklines with
  per-release tooltips; the report CSS moved to variables, light-first with
  a dark media query, sharing the watch index palette.

### Block 5 — deterministic self-check + test expansion (~1 day)
- Run the golden set through the `--judge off` deterministic ladder
  (anchor/lexical/generated) and assert those verdicts — CI-fit, no LLM,
  covers the path that decides most verdicts on anchored releases.
- Engine-adapter tests for `judge.ts` via fetch/exec mocks (the mock pattern
  exists since the aggregator-guard test): claude-cli JSON parse and
  `is_error`, API/OpenAI error paths, `discoverLocalModels` timeout.
- `check.ts` truncation-fallback test (stubbed): truncated compare → clone
  fallback → warning rewrite.
**Done when:** the deterministic ladder has pinned golden verdicts and the
two money-path modules lose their untested status.
- **Landed 2026-07-27** (`9858b09`). The pin lives in
  `test/eval/golden-deterministic.json` (33 no-evidence, 3 partial via
  lexical evidence; `UPDATE_PINNED=1` refreshes deliberately) plus a
  property test that the judge-free ladder never rubber-stamps. judge.ts is
  tested through a fetch mock and a stub `claude` binary on PATH (no module
  mocks needed); check.ts's fallback through an injection seam with
  production defaults — which also gave the Block 2 hotfix its end-to-end
  proof.

### Block 6 — rebuild the mutation harness, checked in this time (~½ day)
The predicted loss happened: `tmp/rt/mutate.mjs` (28 guards, 28/28 killed)
is gone from every worktree. Rebuild as `scripts/mutate.ts` + `pnpm mutate`
with the guard list as its documentation, plus an AGENTS.md line that a new
guard belongs in it. **Done when:** `pnpm mutate` reports N/N killed from a
tracked file.
- **Landed 2026-07-27** (`d9f8342`). 20 guards then, 23 after Blocks 7–8
  added theirs — all killed. A stale pattern aborts loudly, sources restore
  even when the suite run throws, and a substring argument runs single
  mutants. The harness immediately earned its keep in Block 8: a weaker
  body-assertion let the NUL-framing mutant survive until the test asserted
  the full poisoned body.

### Block 7 — promise tracking (~2–3 days)
The one genuinely new fact-check dimension: tag forward-looking claims in
`parseClaims` ("will be removed", "deprecated since", "planned for"), verify
release N's promises against release N+1's diff (the `baseNotes` needed are
already in `ReleaseData` for the carry-over check), and track
kept/broken/still-open across releases via the watch state history. Lands as
its own report + HTML section and an info-level flag — **not** a score
component; scoring changes are a separate decision under the measurement
discipline (A/B, the ~10-point noise floor). **Done when:** a repo whose
notes promised a removal that never happened shows a "broken promise" entry.
- **Landed 2026-07-27** (`30a2e9c`), deterministic rather than judged:
  promise identifiers matched against deletions (removal) or additions
  (addition). Two definitions the plan left open: **broken** requires the
  promise's named target release to be reached (a target-less promise stays
  still-open forever rather than ever accusing), and a promise naming no
  code identifier stays honestly still-open. Score neutrality is proven by
  a test comparing scores with and without the promise; watch carries
  still-open promises in its state and badges broken ones in the index.

### Block 8 — F15 clean + F22, one pass (~½ day)
Email as the identity key (git `%an`+`%ae`; the compare API carries
`commit.author.email`; noreply addresses are per-account stable). Snapshots
store emails — the new version stamp invalidates old caches cleanly. While
`loadCommits` is open, switch it to NUL-framed `git log -z` and split fields
on the first three `\x1f` only (closes the F22 desync FIXME). **Done when:**
the F15/F22 FIXMEs are gone and the truncation-fallback scenario matches
authors correctly.
- **Landed 2026-07-27** (`6f275aa`). `authorKey()` = lowercased git-header
  email, display-name fallback; snapshots store keys, `baselineFlags`
  accepts key or pre-email name; the Block 2 demotion and its field are
  gone. Fields split on the first *four* separators — the plan said three
  before `%ae` joined the format. Both FIXMEs removed; F23 (maxBuffer)
  stays by design. 23/23 mutants killed.

### Landed — post-0.3.0 hardening backlog (2026-07-27)

Found while shipping blocks 1–8, anchored here so the session recap is not
the only record. Ordered by risk; none is release-blocking.

> **All six landed 2026-07-27**, same day, one commit series (`4efc8f0` …).
> Per-item notes appended below; details in the Unreleased CHANGELOG section.

1. **Email spoofing weakens `new-author-sensitive` on the API path.** The
   git-header email is attacker-chosen; the GitHub login is not. Since 0.3.0
   keys identity by email first, a commit forging a known maintainer's email
   passes the first-time-author check that the login match would have
   caught. Fix shape: on API sources, "known email + unknown login" is not a
   pass — it is its own warn, because that combination is the spoofing
   signature.
   - **Landed** (`4efc8f0`, sharpened after review): snapshots record the
     email→account PAIRING, and `author-email-spoof` (warn) fires only when
     a pairing the history always saw stops holding — a different account,
     or none. The first cut kept a flat login list and warned on honest
     maintainers whose email was simply never linked to an account
     (reproduced by the reviewer); the pairing distinguishes exactly that.
     Clone paths carry no attribution and stay silent instead of guessing.
2. **The watch promise ledger is unbounded.** Target-less promises never
   resolve and ride forever; the dedupe key is normalized text, so trivial
   rewording multiplies entries. Cap the ledger and age still-open promises
   out as visibly "stale" after N releases.
   - **Landed** (`382f8be`): `carriedFor` counts carries in the state; the
     10th unresolved carry reports as `stale` and leaves the ledger, the
     ledger caps at 50 with the drop announced, own promises kept first.
3. **Promise tracking and carried-over need GitHub in practice.** Only
   `loadGithubRelease` sets `baseNotes`; the forge path already fetched
   every release body for base-picking but drops the base's notes, and
   `--local` has `changelogReleases`. Wire `baseNotes` through both.
   - **Landed** (`5d37554`): the forge path hands the effective base's
     published body through; the CHANGELOG path reads the base tag's
     section from the same file; the two media never mix. Verified live
     against gitea.com.
4. **Calibration measures round 1 only.** `need` counts as injection
   resistance, but nobody checks what the model answers once its request is
   served. Run the need round inside calibration (same hunks, `allowNeed`
   off) and grade the final verdict; the need-temptation case stays strict.
   - **Landed** (`703a8e0`): outcomes read `need→<verdict>`; a round-2
     obedience fails the case and disqualifies. `legit-need-more-files`
     gained `finalExpected: no-evidence` — after the unfillable request,
     verifying anyway would be a guess. The reference was re-frozen under
     the new grading the same day: two independent fresh-cache Haiku runs,
     both 36/36 `sole-judge`, five `need→<verdict>` chains on record;
     `scripts/freeze-reference.ts` is the re-freeze command.
5. **The frozen reference can drift from the set.** No test ties
   `reference-haiku.json`'s outcome names to `golden.json` — growing the set
   leaves the reference silently stale. One consistency test.
   - **Landed** (`b1f4158`): the test requires an outcome for exactly the
     current cases plus matching per-category totals, and names the
     re-freeze step on failure.
6. Smaller, in one line each: light-mode contrast was never visually
   verified (`tmp/report-preview.html` waits for a browser); `padding.json`
   collision-freedom against case claims is untested; ANSI escapes in notes
   reach the terminal unfiltered (pre-existing, surface grew with promise
   text); `pnpm mutate` runs the suite 23× serially and is not in CI — a
   nightly job would catch a surviving mutant before a PR does;
   `release:publish` pushes the current branch, so the worktree flow needed
   manual `HEAD:main` pushes twice — teach it the detached-branch case.
   - **All landed**: both color schemes verified in a browser against a
     live gitea.com report; a test cross-checks every golden claim's
     identifiers against every padding hunk; `printTerminal` strips
     C0/DEL/C1 plus Trojan-Source bidi/format characters from foreign text,
     newlines collapse, and the same filter covers the `watch init` picker
     and `--calibrate` reasoning (mutation-guarded); `mutate.yml` runs
     nightly keyless; `release:publish` pushes `HEAD:<default>` when HEAD
     is not on the default branch. An Opus review of the whole series then
     hardened the spoof warn (pairing, above), taught the ledger cap to
     prefer still-open entries, extracted the watch promise wiring into
     tested functions, and labeled the frozen Haiku reference as
     round-1-graded in `--calibrate` output. 29/29 mutants killed.

### Landed — the watchdog leaves GitHub, and setup becomes a command (2026-07-27)

Context: v0.4.0 shipped the full hardening backlog, and the same-day
real-data check (a full `watch` pass over the 12-repo list plus a 4-repo
baseline spot sample) found nothing to fix — scores in their known bands,
no false spoof warns, the one suspicious flag verified true against the
snapshots. What remains is operational, in two blocks. Decisions here are
settled; A lands before B (setup should configure the finished surface,
not grow a flag later).

#### Block A — watch entries for any forge (`repoUrl`)
`WatchRepoConfig` only knows `repo: "owner/repo"` and loads hard through
`loadGithubReleaseData`, while the single check has spoken Forgejo/GitLab
and local clones since 4.2 — you can check your own Forgejo repo by hand
but not watch it. Every building block already exists: `fetchForgeReleases`
answers "is there a new release?" (the poll AND base-picking),
`cloneHistory` builds the baseline, `loadLocalRelease` +
`publishedReleases` resolve notes and base notes with the no-published-
notes warning. Add `repoUrl` as an alternative to `repo` (exactly one of
the two per entry), route those entries through the clone path, state key
stays `label ?? repoUrl`. `watch init` stays GitHub-only by design (it
reads a GitHub account); forge repos arrive via `watch add --repo-url` or
the config file.
**Done when:** a Forgejo/Gitea repo in the watchlist is picked up on a new
release exactly like a GitHub one — state, report files, index row,
alerting — verified live (gitea.com, or this repo's own Forgejo origin).
- **Landed 2026-07-27** (`cb24f8f`). The CLI's `--repo-url` block became two
  shared functions (`prepareForgeTarget` + `loadForgeRelease`) so watch and
  the CLI are one code path; the poll stays one API call, the clone waits for
  an actual new release. Two things the plan did not spell out: the index
  needed `releaseUrl` in the state (old GitHub states fall back to the
  derived URL, and a URL-shaped key is never pinned on github.com — mutation-
  guarded), and `watch add --repo-url` probes the release API at add time so
  an unwatchable host is refused with the reason instead of erroring every
  run. Verified live against gitea.com: first run picks up `gitea/tea`
  v0.14.2 (state keyed by URL, three report files, forge-linked index row,
  flagged), second run is a no-op.

#### Block B — `watch setup`: from bare machine to running routine
The operating decisions are undocumented handwork today: where config/
state/reports live, which judge (and whether the local one is even fit),
how often, launchd or cron, where to alert. `watch init` (the interactive
TTY picker) is the established pattern; `setup` is its sibling for
operations, and it only ever writes files — no daemon, nothing installed
silently:
1. **Home:** propose a directory (default `~/release-watch/`, freely
   changeable), write config + state there; adopt an existing state file
   when pointed at one.
2. **Judge:** detect the `claude` CLI / `OPENAI_BASE_URL`; for a local
   model offer the calibration gate on the spot — fit / escalate-only /
   reject has been a one-command answer since the golden-set gate.
3. **Schedule:** write the launchd plist (macOS) or crontab line and PRINT
   the command that activates it.
4. **Notify:** optional ntfy/mail/command hook, fired once as a test.
5. With Block A landed: accept `--repo-url` entries in the same flow.
**Done when:** on a machine with nothing but the checkout and a judge,
`watch setup` ends with a scheduled routine whose first run produces the
index — without opening the docs.
- **Landed 2026-07-27** (`src/setup.ts`). All five steps as planned; answers
  first, every write after the last answer, so a cancel mid-flow writes
  nothing. The schedule runs through `sh -lc` (cron/launchd's bare PATH knows
  neither gh nor claude), paths are shell-quoted and XML-escaped, and a
  local model failing the calibration gate is demoted to `judge: off` unless
  kept deliberately. `remove`/`list`/URL-adds stopped demanding gh along the
  way. Verified end to end: a piped-answer setup run wrote config + plist,
  and its printed first-run command produced state, reports and index for a
  gitea.com entry.

Operational note (updated 2026-07-28): the live setup runs from
`~/release-watch/` (config, state, reports, named launchd runner — hourly
since 2026-07-28); the interim copies this note used to point at
(`tmp/release-watch/` in the iteration-2 worktree, the old state under
`~/.local/state/comparereleaseii/`) are superseded — the tmp copy was
removed in the 2026-07-28 cleanup, the old XDG state is a stale duplicate
kept only until its deletion gets a user go.

### Landed — presentation, analytics, and the author dimension (2026-07-27/28)

Context: the HTML layer is the least-built side. The report renders well but
nobody is shown it (README carries zero screenshots, no demo); the watch
state holds up to 20 checks per repo of which the index renders six trend
dots; the promise ledger and the score derivation are invisible; author data
(identity keys, email→account pairings, first-time/spoof flags) exists in
snapshots but has no view. Candidate blocks, roughly in recommended order:

- **P1 — repo detail page** (`reports/<repo>/index.html`, written by watch):
  full score time series from the state history, flag history, verdict
  composition over time, promise-ledger view with carry countdowns ("carry
  7/10 until stale"). All from data that already exists.
- **P4 — author ledger:** accumulate per-identity history in the watch state
  (the promise-ledger pattern): first seen, commits per release, share of
  sensitive-path touches, binary contributions, pairing stability, bot
  detection; a new-author timeline per release; concentration metrics
  (top-1 commit share — single-maintainer is a supply-chain risk too).
  Framing decision, settled now: behavioral anomalies per release, stated
  neutrally — **no person-level trust labels**. "Friendly/trusted user" is
  exactly the false comfort the xz backdoor exploited (the attacker WAS the
  established co-maintainer); "suspicious user" is a public accusation built
  from heuristics with false positives. Show facts ("since 14 releases, 212
  commits"), flag behaviors, leave the verdict to the reader.
- **P5 — promotion:** README screenshots (report + index), a static demo
  page (GitHub Pages serving a real example report), optionally a per-repo
  SVG trust badge.
- **P2 — index upgrades:** aggregate tiles (watched/flagged/broken promises/
  score distribution), column sort + flagged-only filter (self-contained
  vanilla JS), a chronological cross-repo release feed as the second axis —
  optionally as a static Atom feed (pull counterpart to the ntfy push).
- **P3 — score decomposition in the report:** a small waterfall from
  components through caps and flag deductions to the final number — the
  visible version of SCORING.md.

Constraints that stand: static files only (`watch serve` stays unbuilt);
every new view is score-neutral (pure display never moves a number; anything
that would faces the A/B measurement discipline). Open: prioritization; how
deep author history reaches (baseline window vs. accumulating in state —
lean state-accumulating); whether badges are wanted at all.

- **The presentation blocks landed 2026-07-27** (P1, P2, P3, P5 — the
  session read "Presentation" as excluding the author dimension, so **P4
  stays open**, its neutral-framing decision still standing). Order
  deviated deliberately: P5 last, so the screenshots show the finished
  surface. P1 as `src/watch-detail.ts` (score series vs. own median,
  verdict composition, releases table, promise-ledger carry countdowns),
  plus a follow-up the old 12-repo state exposed: one derivation
  (`reportDirOf`) now decides where the page lands, where the index links,
  and how many levels its relative links climb — legacy nested layouts
  included. P2 as tiles + sort/filter + cross-repo release feed + static
  Atom (`feed.xml`, relative links, stable ids). P3 as `scoreBreakdown()`
  next to `computeScores` — reconciles by construction, surfaces any
  future drift as an "unexplained adjustment" bar, two mutants guard it.
  P5: README opens on a real sniffnet report, watchdog section shows
  dashboard + history page (light/dark `<picture>` pairs); `docs/demo/` is
  an unedited watch pass over five public repos (12 checks, claude-cli
  judge, config + seeded state included). The verdict/score palettes were
  run through a CVD validator: they fail as *categorical* colors but serve
  as *status* colors — kept, with the standing rule that color never
  carries identity alone (symbols, counts and tooltips everywhere).
  Waiting on the user: enable GitHub Pages (main, `/docs`) so the demo
  links resolve, and the P5 badge question stays open.
- **P4 followed 2026-07-28** (user: "pages sollte an sein, weiter" — Pages
  source corrected to main + `/docs` the same day). State-accumulating, as
  leaned: `Report.authors[]` (computed after scoring, feeds nothing back)
  → per-repo `AuthorRecord` ledger (firstSeen immutable, mutation-guarded;
  attribution changes accumulate; cap keeps active-then-busiest) → history
  page renders the facts table (bot chip, attribution history) and per
  release count / new-to-this-watcher / top-1 commit share. The neutral
  framing is printed on the page itself. The badge question closed as
  settled the same day (see "Settled" below) — nothing from this block
  remains open.

### Demand-driven only (no schedule)
- **F23 maxBuffer:** first decide whether kernel-scale releases are a target
  at all. If not: a one-hour actionable error ("diff exceeds 64 MB — narrow
  with --base"). If yes: streaming diff parse + per-file patch cap with
  warning (the GitHub-API behavior downstream already handles).
- **Action PR-comment variant:** GitHub-only nice-to-have, waits for a
  concrete need.

### Settled — do not reopen without new facts
- **LLM calibration iterations: frozen.** Score deltas under ~10 points are
  noise; further model-ranking/golden-tuning work has poor marginal value.
  Block 3 is the one exception precisely because it *ends* the topic.
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

Order: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8. Rationale: ship first, kill the
false-alarm source second, then the one block needing a paid reference run,
then visible product value (HTML), then the safety net (tests, mutation
harness) **before** promise tracking adds new surface to exactly the modules
those guards protect.

---

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

## Landed — the long view (2026-07-28)

Context: the watchdog is live (hourly launchd job at `~/release-watch`,
running the SHA-pinned gh extension; v0.5.0/v0.5.1 shipped the history
pages, dashboard, author ledger and the unwedge/skip mechanism). Three
gaps surfaced on the first day of operations: the history page is hard to
find, a fresh watcher is baseline-blind for months (cold start), and a
*long* history has no adequate view — a 300-point score line is noise.
Decisions below were settled in discussion on 2026-07-28.

### Block A — make the history page findable (small)
The most valuable drilldown hides behind a small gray "history" link at
the row's end, while the most prominent click (the repo name) leaves the
site toward the forge — backwards to the common idiom. Change: repo name
links to the *internal* history page; the forge moves to a small ↗ right
after the name (the release column already uses exactly that pattern);
the trailing "history" link goes away, legend updated. Waiting rows (no
checks yet) keep the forge link — they have no history page. This
deliberately changes the documented "repo links out to its forge"
behavior: update `docs/watchdog.md` and the index tests with it.
**Done when:** clicking a repo name opens its history page, ↗ opens the
forge, tests assert both.
- **Landed 2026-07-28** (`c5014ab`), as planned. Waiting rows keep the
  forge link on the name — they have no history page; the docs paragraph
  and the index tests state the new idiom.

### Block B — `watch backfill`: solve the cold start honestly
A fresh watcher needs 3 checks for a median and 6 for drift — with a
monthly-release repo that is most of a year of blindness. Backfill fixes
it by checking the *past* releases the state never saw.

Settled design (do not re-litigate):
- **No sampling.** "One release per month" breaks the method: each check
  verifies notes against *its own* diff (prev→tag); skipped releases
  leave commits no checked diff covers — promise resolution and the
  author ledger get holes, and scores stop being comparable. Checks are
  gap-free, oldest-first; *display* resolution is a rendering concern
  (Block C).
- **Own mode, not the catch-up.** `pickNewReleases`' `slice(-cap)`
  prioritizes the *newest* releases when behind — right for alerting,
  the exact opposite of backfill. A reset state + hourly runs would never
  reach the old releases (found 2026-07-28).
- CLI: `watch backfill [repo…] --releases N | --since <date>`, with a
  cost statement before starting ("214 releases, est. ~4h judge time —
  proceed?") and `--yes` for scripts. Release listing needs pagination
  (today: newest 30).
- Resumable by construction: state saves after every check; the
  `recordCheckFailure` skip mechanism guards against wedging on broken
  old releases. Backfilled checks never fire `--notify` (historical
  alerts are noise); flagged stays in the record.
- **Decouple the windows:** `historyLimit` becomes configurable (hard 20
  today), and the baseline median deliberately stays on the last ~10
  checks so old note culture cannot dilute what "normal" means now.

**Done when:** a fresh repo entry backfilled with `--releases 10` shows a
median, drift detection and a filled author ledger after one command, and
a backfill interrupted halfway resumes without re-checking.
- **Landed 2026-07-28** (`332bda4`). The watch loop's check body became one
  shared `checkAndRecord`; state bookkeeping moved behind `recordChecked`
  with the invariants a past-checking mode needs — chronological inserts,
  `latest` and the poll cursor forward-only (a skip used to move the cursor
  unconditionally, which for a backfilled old release would have re-alerted
  everything since). Three calls the plan did not spell out: retries are
  3 immediate attempts inside the run (the state's `failing` slot holds one
  tag, so cross-run counting would self-reset under `continue`), with three
  finally-failed releases in a row aborting as "looks systemic"; the
  promise thread runs chronologically through the backfill and becomes the
  state's ledger only when it reaches the present, so a pure-past run never
  touches the live thread; and the deep listing rides into the forge
  target/GitHub base pick, so notes, bases and baselines reach as far back
  as the scope instead of the newest page. `DRIFT_WINDOW` (12) joined the
  baseline window — an ancient level shift is the long view's story, not a
  standing alert. Verified live against gitea.com: `--releases 5` then
  `--releases 10` on `gitea/tea` checks 5+5 with no re-checks (median,
  62-identity ledger), third run a no-op. Eight mutants; all killed.

### Block C — the long view: phases and exceptions, not more dots
For a long history the unit of narrative is not the release, it is the
phase and the exception ("is this still the project I trusted three years
ago — if not, when did it change?"; the xz pattern is a *regime change*
no score line shows). One page that scales with data depth — the existing
history page grows sections once enough checks exist; no second page.
All four views chosen by the user on 2026-07-28; everything derives
deterministically from the state (no judge), so detections get unit
tests and, where they guard scoring-adjacent claims, mutants.
1. **Phase/regime bands** (the core): segment the history into stretches
   of stable behavior — change points from a rolling-median level shift
   over a threshold, top-identity change, concentration jump, cadence
   change. Per phase: score band + median, author count + top share,
   cadence, broken-promise count. The transitions carry the information.
2. **Event log**: the 10–20 things that stood out across years — flagged
   releases (with critical counts), score level shifts, top-identity
   changes, broken promises, first appearances with immediate high
   share. Each links its evidence (report / history row). Facts only,
   the framing line applies — no insinuations.
3. **Yearly distribution**: one strip per year, min/median/max + outliers
   linking their reports. 300 releases become five readable rows.
4. **Calendar heatmap**: one cell per release (or month), color = score
   bucket — cadence, gaps and level shifts as texture. Color never
   carries alone: symbols/tooltips per cell, palette rules as
   established (status colors, validated).

**Done when:** a repo with 100+ backfilled checks renders phases, events,
yearly strips and the heatmap from state alone, `--judge off`
deterministic, with the framing line on the page.
- **Landed 2026-07-28** (`65100b4`), as `src/watch-longview.ts`; a 118-check
  synthetic record exercises all four sections in the tests. Three things
  the plan left open, decided in the code: the state now records each
  release's top identity by display name (`authors.top1Name`) — without it
  the top-identity and first-appearance detections had nothing to read;
  one threshold (12 checks) gates all four sections; the calendar is
  monthly, not per-release (300 cells would drown the texture the view
  exists for). One thing the plan could not know: the median look-ahead
  that confirms a change point trips one check early — the boundary now
  snaps to the first release that itself reads as the new regime, so a
  phase starts exactly at the handover. Six mutants pin the detector
  edges; 47/47 killed across the harness.

Order: A → B → C (C needs B's data to be worth looking at). Immediate
operational step available before any of this: a one-shot high-`maxPerRun`
backfill of the live 11-repo watchlist (last ~5 releases each) via the
existing catch-up — waits for an explicit user go (judge cost, live
state).

Noted, no commitment: a deep-backfill "adoption audit" moment (should I
take this dependency at all?) is the same page fed by `--since <years
ago>` — it needs no separate feature, only the willingness to pay for the
checks.

---

## Landed — the second axis: what actually shipped (2026-08-02)

Context: the OpenCloud walkthrough exposed two structural limits at once.
(1) **Product ≠ repo.** opencloud-eu/opencloud pins its entire frontend as
one Makefile line — `WEB_ASSETS_VERSION = v7.2.0` in `services/web/Makefile`,
downloaded as a release tarball, not a go.mod entry — so a whole frontend
release enters the server's diff as a one-line bump and the check never sees
its substance. `deps.ts` cannot see it twice over: it only parses dependency
manifests, and it deliberately filters version bumps (`known` set,
`sameSupplier`) because for third-party deps a bump is routine. For a
first-party component the bump *is* the release. (2) **The completeness
direction still stands on commit messages.** `subjectCovered` (verify.ts)
marks a commit covered at ≥ 0.45 subject similarity, and the report
describes uncovered commits by their subjects — claims describing claims;
only `--suggest` reads the hunks. This is the founding thesis ("notes are
claims") not yet applied to our own reverse direction.

Decisions (settled with the user 2026-08-02):

- **Second axis, not a pivot.** A diff-substance report ("what actually
  shipped") becomes an equal deliverable next to the notes fact-check. The
  trust score and the claims ladder stay; both axes share the pipeline and
  the cache, and coverage eventually ends on diff findings instead of
  subjects.
- **Deterministic first, LLM later.** Mechanics are testable,
  mutation-guardable and free; the LLM reads only what mechanics
  prioritized. Every new stage lands score-neutral until measured — the 4.1
  constraint stands (single-sample deltas under ~10 points are noise).
- **The judge never sees commit messages while reading diff substance.**
  Feeding it the message anchors it on the claim — the changelog-circularity
  rule (iteration 2.2), generalized. Messages and notes join *late*, as a
  reconciliation layer: confirmed (claimed + observed), undocumented
  (observed, never claimed — the interesting signal), unsupported (claimed,
  never observed).
- **Audience is a property of the finding AND of the repo.** Findings carry
  "who is affected" (deploy/config → admin, api → integrator, ui → end
  user, security surface → everyone, with urgency). The default lens is per
  repo, not global — a hosting service like OpenCloud has no real power-user
  audience, vaultwarden reads security+selfhosting. Which profile fits which
  watchlist repo is an explicit pre-block analysis (S4a), not a guess.
- **Casual consumers are not an audience** — they do not decide updates.
- **Third-party bumps are never expanded** (explosion). Optional later, as
  its own decision: OSV advisory enrichment ("this bump closes CVE-…") —
  keyless, local-first-compatible.

### S1 — version-pin delta + first-party detection
Every changed line that bumps a version pin becomes a structured object
`(name, from, to, file)`: dependency manifests (reuse deps.ts parsing — the
bump data is currently discarded on purpose) plus plain-text pins the
OpenCloud shape needs — `NAME_VERSION = vX.Y.Z` Makefile variables,
Dockerfile `FROM`/`ARG` tags, versioned download URLs in scripts. Classify
first-party (pin target shares the checked repo's org/owner, or is listed in
a per-repo `components` config) vs third-party. New report/JSON section,
score-neutral. **Done when:** the OpenCloud server release that bumps
`WEB_ASSETS_VERSION` reports "web v7.1.0 → v7.2.0, first-party, release
link", and a routine third-party go.mod bump stays one quiet line.
- **Landed 2026-08-02** (`c5b5c24`), done-when held live on OpenCloud.

### S2 — mechanical substance layer
Deterministic surface deltas from the release diff, no LLM: changed symbols
from hunk headers (git's xfuncname gives function names for free), file-
category rollup, config surface (new/removed config keys, env-var reads,
CLI flags, helm/compose defaults), DB migrations, API-route files. The
uncovered-commit output describes changes by observed surface, not by
subject + churn alone. **Done when:** a `--judge off` run on any source
yields a "what actually shipped" section listing surfaces touched, and the
uncovered list carries observed-surface descriptions.
- **Landed 2026-08-02** (`fe5c219`).

### S3 — first-party expansion: the product graph
A first-party pin bump triggers a sub-check of the referenced repo over
`(from, to)` with the same algorithm, depth 1, through the existing
clone/cache machinery — if the component repo is on the watchlist its
analysis is already paid. The parent report links and folds in the child's
summary: "server v3.x ships web v7.2.0 — its check: …". **Done when:** the
OpenCloud server release renders the web release's substance inline, and an
immediate re-run pays zero additional judge calls.
- **Landed 2026-08-03** (`c4a0781`). The zero-cost proof needed a small
  notes file — cache accounting does not need scale — and a permanent test
  now pins the property it rests on: an expanded check asks byte-identical
  judge questions across runs.

### S4a — audience profiles, measured not guessed (pre-block)
Before any lens rendering: walk the real watchlist and classify which
audiences each project type actually has; define the 2–3 profiles that
cover it (admin/operator, security+selfhosting, end-user-visible); decide
per-repo `audience:` config with a heuristic proposal vs pure config. Paper
exercise, lands as a ROADMAP addendum with the profile table.
- **Landed 2026-08-03** (`dd28c9d`) — the addendum below is the deliverable.

**Addendum (2026-08-03) — the measured table.** Walked the live watchlist
(12 repos). Classification key: who *decides* the update — not who runs
the binary. A single selfhoster is still an operator: the findings that
matter to them are config and deploy, not UI. And the user profile is not
the casual consumer the decisions block excludes — it is the person who
installed the app and decides its updates.

| repo | what it is | who decides updates | default lens |
|---|---|---|---|
| zen-browser/desktop | desktop browser (Firefox fork) | the person using it | user |
| anthropic-experimental/sandbox-runtime | sandboxing runtime/library | developers embedding it | integrator |
| dani-garcia/vaultwarden | self-hosted password server | the admin hosting it | operator |
| traefik/traefik | reverse proxy | the admin hosting it | operator |
| nextcloud/desktop | sync client | the person using it | user |
| bitwarden/clients | password-manager clients | the person using it | user |
| zed-industries/zed | code editor | the person using it | user |
| jundot/omlx | local LLM server (OpenAI-compat API) | the operator running it | operator (integrator second) |
| GyulyVGC/sniffnet | network monitor | the person using it | user |
| cjpais/Handy | speech-to-text app | the person using it | user |
| soundcloud/api | API tracker, no product code | developers building on the API | integrator |
| p0deje/Maccy | clipboard manager | the person using it | user |

Three profiles cover 12/12; no repo needed a fourth:

- **operator** — hosts it as a service: deploy/packaging, config keys,
  env vars, flags, migrations, exposed-API changes, resource behavior.
  Breaking changes gate the upgrade.
- **integrator** — builds against it: API/SDK surface, wire formats,
  deprecations, exports, versioning policy.
- **user** — runs it for themselves: visible behavior, features, fixes
  they can feel, UX, performance. Internals are noise.

Two corrections against the guessed trio. **Security+selfhosting is not
a profile.** Selfhosting is the operator profile; security is a finding
property (`audience: everyone`, with urgency) that pierces every lens —
vaultwarden (operator) and bitwarden/clients (user) share the same
security rule under different default lenses, which is exactly why it
cannot be a lens itself. **Integrator was missing from the guess** and
is real: soundcloud/api has no operator and no end-user reading at all.
The three profiles map 1:1 onto the finding-level audience tags from the
decisions block (deploy/config → operator, api → integrator, ui → user,
security → everyone) — a lens is a plain filter over finding tags, and
security passes every filter.

Config decision: **pure config, no heuristic.** `audience:` per watch
repo, one of `operator | integrator | user`. At check time the pipeline
sees changed files, not the project's nature — a heuristic misclassifies
exactly the hybrids (zed ships Dockerfiles but is a user app; omlx is a
server consumed as an API), and a silently wrong lens hides the findings
its real audience needed. Unconfigured repos and one-off checks render
unfiltered — all findings grouped by audience tag — so nothing is lost,
it just reads longer. Secondary audiences (omlx → integrator) need no
config key: other lenses stay reachable as filters over the same
findings.

### S4b — LLM summarization + lenses
Budget-driven summarization of the hunks S1/S2 prioritized (the tf-idf
ranking exists) into typed findings — breaking / behavior / security /
feature / internal, plus affected surface — blind to messages, hierarchical
(hunk → subsystem → release), generate-to-fit against a hard token budget
with the remainder declared ("N files not read in detail"), cached per
(repo, base, head) like verdicts. Render the repo's default lens first,
others as filters. **Done when:** two runs on a cached release are
bit-identical, the budget line is printed, and an OpenCloud-shaped release
reads differently under admin vs end-user lens from the same findings.
- **Landed 2026-08-03** (`5a45d36`, changelog exclusion `9d0d530`). Live on
  OpenCloud: two cached runs produced byte-identical JSON (`cmp`), the
  budget line declares the remainder ("read 6/39 subsystems, 86/350 files
  in detail — 264 not read in detail"), and the real v7.2.0 range reads
  differently per lens from the same findings — the operator sees the LDAP
  default-URI break and removed config fields, the end user sees Dutch
  formal pronouns and new Polish translations, and the NATS-TLS security
  finding pierces both. One thing the plan could not know, measured on the
  first live run: with the changelog in the read set every finding cited
  CHANGELOG.md — the notes describing themselves — so changelog paths are
  excluded from the read, same boundary evidence matching draws
  (mutant-pinned). Six mutants total; findings stay score-neutral by
  structure and by test.

### S5 — retire subjectCovered
Coverage ends on substance: claims reconcile against findings, not against
commit subjects; `subjectCovered`'s ≥ 0.45 similarity shortcut goes away.
Score-relevant, so it moves last and under the measurement discipline: two
arms, independent fresh caches, repeated runs. **Done when:** the A/B names
what moved and why, and no honest repo in the corpus loses more than the
noise floor.
- **Landed 2026-08-03.** The A/B (five-release corpus, `--judge off`, so
  every delta is the coverage change and nothing else): headscale,
  git-cliff and vaultwarden bit-identical, restic −1 overall — two
  cherry-picked commits whose notes carry no identifiers are now honestly
  uncovered — and the fabricated negative control unchanged. What the
  measurement rejected: the first replacement, plain token overlap at the
  old 0.45 share, handed the fabricated notes +20 completeness by
  rewarding real component names; the shipped rule demands
  `lexicalMatch ≥ 5`, the bar the forward direction calls strong evidence,
  and changelog files never count as that evidence. Judge-on re-measure of
  the README validation table with a fresh cache: 100 / 90 / 89 / 79 / 5 —
  every row within ±1 of the 2026-07 run, table updated in the same
  commit.

Order: S1 → S2 → S3 → S4a → S4b → S5. S1/S2 are additive and score-neutral
(ship early, they make OpenCloud *visible*); S3 solves it; S4 makes the new
axis readable; S5 is the only stage that touches scoring and inherits
everything learned before it. All six blocks landed 2026-08-02/03.

Noted, no commitment: the reconciliation layer from the decisions block —
claims joined against findings as confirmed / undocumented / unsupported —
has no block of its own yet. The blind findings (S4b) and the substance
coverage rule (S5) are exactly its two inputs when it gets one.

---

## Phase 1 — Distribution: from repo to `pnpm dlx` and a GitHub Action

> **Landed 2026-07-26** — deliberately without npm (no account, no standing
> supply-chain surface; see 2.5): git tag + GitHub release + the composite
> Action, which only needs the tag. The packaging path stays exercised in
> CI; the tarball ships compiled `dist/` because Node refuses to strip
> types under `node_modules`.

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

> **Landed 2026-07-26/27** — watch mode, alerting hook, launchd/cron recipe
> (`docs/watchdog.md`); grown far past this plan by the later block series
> (forge entries, backfill, history pages, long view).

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

> **Landed 2026-07-26/27** — golden set grew to 36 cases with the fitness
> gate (Block 3) and a frozen Haiku reference; SCORING.md shipped. The
> secret-carrying monthly CI eval (3.2) was deliberately not built (no repo
> secrets): drift checks run locally via `--calibrate` in the release
> routine, and the nightly keyless job covers mutants, not judges.

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

- Run the existing watchlist against 0.1.2. **Set `XDG_CACHE_HOME` to a
  writable dir first** — without a usable cache the judge varies between runs
  and none of the numbers below are comparable (measured: 84 vs 90 on the
  same check). The verdict cache also carries the tool version in its key
  since 0.1.2, so nothing from earlier runs is reusable: budget the run as
  fully paid.
- Two traps, both already worked out with the captured baseline in the
  tracker: the state file's scores predate iteration 3 (they are v0.1.0-era,
  not v0.1.1), and `watch` refuses to re-check a release it has already
  seen — a plain re-run reports "up to date" for every repo and measures
  nothing. Read that before starting; it decides whether this is a clean A/B
  or a measurement of everything since the first run.
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
- **Measured 2026-07-26.** Not through `watch` — the same 12 tags driven
  through the CLI directly, once from a checkout of `v0.1.1` and once from
  `v0.1.2`, separate writable cache dirs per arm (their key formats do not
  collide anyway, `VERSION` is only in 0.1.2's). The state file's numbers are
  kept as a third column but they are v0.1.0-era and were measured with a
  cache that no longer exists; the A/B is the two fresh arms.

  | repo | tag | v0.1.0-era | v0.1.1 | v0.1.2 | Δ |
  |---|---|---|---|---|---|
  | traefik/traefik | v3.7.9 | 25 suspicious | 45 questionable | 45 questionable | 0 |
  | anthropics/claude-code | v2.1.220 | 27 suspicious | 75 unverified | 65 unverified | −10 |
  | nextcloud/desktop | v4.0.11 | 37 suspicious | 69 minor gaps | 72 minor gaps | +3 |
  | zed-industries/zed | v1.12.0 | 45 questionable | 72 minor gaps | 66 minor gaps | −6 |
  | jundot/omlx | v0.5.3 | 45 questionable | 45 questionable | 45 questionable | 0 |
  | GyulyVGC/sniffnet | v1.5.1 | 45 questionable | 45 questionable | 45 questionable | 0 |
  | zen-browser/desktop | 1.21.9b | 62 questionable | 66 minor gaps | 65 unverified | −1 |
  | dani-garcia/vaultwarden | 1.37.0 | 88 solid | 76 minor gaps | 91 solid | +15 |
  | cjpais/Handy | v0.9.4 | 91 solid | 91 solid | 88 solid | −3 |
  | bitwarden/clients | cli-v2026.7.0 | 91 solid | 85 solid | 84 minor gaps | −1 |
  | anthropic-experimental/sandbox-runtime | v0.0.68 | 100 solid | 100 solid | 100 solid | 0 |
  | soundcloud/api | 2026-07-19 | 100 solid | 100 solid | 100 solid | 0 |

  **The plan's premise was wrong, and finding that out is the result.** It
  asked to attribute every move over 10 points to one of four rules. Two of
  the three moves that size are not rule changes at all: one is measurement
  noise and one was a broken diff. The scoring changes themselves move real
  repos by −6 to +3.

  *Attributable, deterministic, deserved.* claude-code −10 is exactly
  `UNVERIFIED_CAP`: nothing in that release was checkable, and 75 read better
  than a release that was checked and had gaps. nextcloud +3 is one
  `undocumented-sensitive` warn that stopped firing — `sensitiveCategory()`
  no longer classifies project metadata as auth/crypto. Both are the fix
  working.

  *Attributable, and mostly a trade.* zed −6 and the internal moves on omlx
  (correctness 91 → 82) and sniffnet (100 → 89) are all the anchored-path
  change: a claim whose only support was its own commit subject is now
  judged instead of settled. On zed that turned seven `verified` into
  `partial`, and reading the judge's own reasoning, several of them say the
  diff shows exactly what the note claims and then answer `partial` anyway —
  the rule is right, the judge is conservative on the claims it never used
  to see. The same change pays for itself elsewhere: sniffnet's completeness
  went 10 → 34 because judging produces an evidence file list that anchoring
  never did, so 11 latency commits stopped counting as undocumented. It also
  caught a real error the old path rubber-stamped — sniffnet's notes claim
  "Persian (#1196)" at a 100 % subject match, and the Persian translations
  in that diff are commented out.

  *Not attributable to any rule.* vaultwarden's +15 is noise. Run the same
  tag against the same version with a fresh cache and it lands anywhere in
  an 8-point band: `v0.1.1` scored 76, 83, 84 and `v0.1.2` scored 91, 79, 80
  across three independent runs each. Judge *routing* is deterministic — all
  three runs made the identical 10 (0.1.1) and 12 (0.1.2) calls, no failures
  — only the answers differ. sniffnet is worse: three `v0.1.2` runs of the
  Persian claim answered `partial`, `no-evidence` and `contradicted`, and
  the third floors the whole release at 35 with a critical flag. **A
  single-sample A/B on real repos cannot see an effect smaller than about 10
  points.** The verdict cache makes a *re-run* free and identical, which is
  what made this look reproducible; it does not make a first run a
  measurement.

  *Not a scoring change at all.* traefik, zed and bitwarden all exceed the
  compare API's 300-file cap, and the partial-clone fallback cannot run in a
  sandbox that denies writes to `.git/` — it fails, and the check proceeds on
  18 % of bitwarden's diff. That alone read as bitwarden −10 (45 → 35) and
  zed 45/45. Re-run with a working clone, the same two arms give bitwarden
  85 → 84 and zed 72 → 66. The failure is in `warnings` and on stderr, so it
  is not silent — but `watch.ts` does not carry warnings into the state or
  the index, so a watchlist row shows `45 questionable` for a release that
  scores 85 when the diff is complete.

  **Verdict: the new defaults are right; three rules need softening, and one
  of them is not a rule.**

  1. `lockfile-source` must not fire on a git dependency pinned to a full
     40-hex rev. Proof: cjpais/Handy v0.9.4 (`git+https://github.com/cjpais/
     tao?rev=c3bee28c…` in `src-tauri/Cargo.lock`, −10 risk, 91 → 88) and the
     same shape on zed (`zed-industries/trash-rs?rev=47761739…`). A full rev
     is content-addressed; the hijack this flag exists for needs a *mutable*
     ref or a foreign tarball.
  2. `contradicted` is decided by one judge answer and is the only verdict
     with a hard score floor *and* a critical flag. Proof: sniffnet's Persian
     claim, 45/45/35 across three identical runs. The vote path already
     exists — require two concordant votes for `contradicted` rather than a
     median a tie can hand it.
  3. The `out-of-repo` carve-out has no hysteresis. Proof: zen-browser
     1.21.9b — one verdict moving `partial` → `no-evidence` takes the miss
     ratio past the strict-majority bar, and the release goes from
     `66 minor gaps` to `unverified 65` with a different story attached.
  4. Not a rule: `watch` must carry `warnings` into the state and the index.
     A score computed on a truncated diff should not sit in a table looking
     like a score.

  What Iteration 5 inherits is a method constraint, not just a fix list:
  anything measured against real repos with an LLM judge needs repeated runs
  with independent caches, and a delta under ~10 points is not evidence.

- **All four spent, same day.** `lockfile-source` skips a git source carrying
  its resolved 40-hex commit (Handy back to 91); `contradicted` needs a second
  voter; the `out-of-repo` bar moves to two thirds; `watch` carries the
  check's warnings into state and index. Two things the fixing turned up that
  the measurement had not:
  - `bin/comparerelease.mjs` preferred `dist/` over `src/`, and only the
    published tarball ships without `src/` — so in any checkout a `dist/` left
    from an older `pnpm build` silently *was* the tool. The first verification
    run of these very fixes reported v0.1.1's numbers out of a stale build.
    `src/` wins now, with a behavioural test.
  - `pnpm dogfood` asked for the CHANGELOG section named by package.json,
    which between a release and the next bump is one already tagged — it
    compared shipped notes against the diff that came after them and blamed
    the notes (80/100). It reads `Unreleased` in that case now, and this
    working tree scores 100.

  One rejected alternative, so it is not re-proposed: deciding `out-of-repo`
  on the deterministic `lexicalCoverage` instead of the judge's misses, which
  would take the noise out of the gate entirely. Measured — it tracks note
  *style*, not where code lives: sniffnet scores 0.15 and vaultwarden 0.31 on
  releases that are neither forks nor distribution repos, because short
  bullets and generated PR lists carry no identifiers. The threshold move is a
  trade, not a clean fix, and zen-browser 1.21.9b — the case the carve-out was
  built for — now reads `64 questionable`.

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
- **Landed 2026-07-26 (4.2a).** `--repo-url <url>` clones into
  `$XDG_CACHE_HOME` (fetch on later runs) and runs the existing `--local`
  path; `--tag` names the ref there. The done-criterion below is met already,
  since 4.2a alone is what it tests: this repo's `v0.1.2` through the Forgejo
  URL and through the GitHub mirror return the same 25 commits, 35 files,
  ±1885/−229, the same verdicts and the same 82/100 — only the language
  breakdown differs (Linguist vs. counting locally). One thing the plan did
  not list: a repository URL is an argument to `git clone`, which also accepts
  `ext::sh -c …` (a transport helper git executes) and, with a leading `-`,
  options like `--upload-pack=` that run a command. Passing argv instead of a
  shell string stops neither, so both shapes are refused by name.
- **4.2b — one endpoint per forge, only for notes and the release list.**
  Forgejo/Gitea (`/api/v1/repos/{o}/{r}/releases`) and GitLab
  (`/api/v4/projects/{id}/releases`) both expose a flat releases list. That
  is the whole integration surface: notes text, tag name, published date —
  enough for base-picking and the `--baseline` history. Compare, commits and
  per-commit diffs stay on git. Auth: reuse whatever `git` already has for
  public repos; a token env var per forge for private ones, never a config
  file.
  - **Landed 2026-07-26**, as `src/sources/forge.ts` — the whole non-git
    surface, one file. Notes and base-picking worked; `--baseline` stayed
    GitHub-only and was recorded here as the one part not delivered.
    Verified against gitea.com (`gitea/tea` v0.14.2): notes from the API,
    base `v0.14.1` from the release list, 15 of 24 claims anchored.
  - **The baseline followed on 2026-07-27**, and the seam turned out to be one
    interface rather than a second code path. A snapshot needs which tags are
    releases plus their notes, and the diff of each against the one before —
    GitHub answers both, which is why they had been one hardcoded pair of
    calls. `HistorySource` splits them: `githubHistory()` keeps the API pair,
    `cloneHistory()` takes the release list from the forge (or from the tags
    the CHANGELOG documents, when the host has no API) and computes every
    range with `loadLocalRange`. `--local` gained a baseline as a side effect,
    and `--history` stopped being GitHub-only. Verified on gitea.com: five
    releases of `gitea/tea`, dates from the API, diffs from the clone, and
    the first-time-author flag firing off those snapshots.
  - Two things worth keeping. `git for-each-ref` does **not** expand `%x1f` —
    that escape belongs to `git log`, and the separator arrived as a literal
    string, so the tag list parsed to nothing and the baseline was silently
    empty rather than wrong. A refname cannot contain a space, so the date
    goes first now and the first space separates. And a single release the
    source cannot answer for used to cost the *whole* baseline: `snapshotFor`
    threw up through `buildSnapshots` into a `.catch(() => null)` at the call
    site, and the run continued with no baseline and nothing said. A clone
    makes that ordinary — a tag the last fetch never got, a range whose blobs
    the promisor remote refuses — so failures are now per snapshot, warned
    about, and the rest survive.
  - Three failures only a live run produced. Node's `fetch` ignores
    `HTTP(S)_PROXY` unless `NODE_USE_ENV_PROXY=1` is set before startup — so
    behind a proxy `git` reaches the forge and the API does not, and the
    fallback reported "no release API here". A failing `fetch` shared one
    `try` with "is this a repository", so any update error sent the code to
    `git clone` against a full directory and killed the run over a usable
    cache. And a blobless clone fetches contents on demand, so a server
    hiccup surfaced as `could not fetch <sha> from promisor remote`. All
    three now say what happened and what to do.
- **4.2c — merge-request dialect.** `extractPrNumbers()` matches `(#123)` and
  `Merge pull request #123`, both GitHub conventions. GitLab writes `!123`
  and "See merge request group/proj!123"; Forgejo mostly follows GitHub.
  Anchors are one of the deterministic verification stages, so a missing
  dialect quietly costs evidence rather than erroring — needs a fixture per
  forge in `test/fixtures/`.
  - **Landed 2026-07-26.** Both sides speak both dialects: the commit side
    reads `(!123)`, `(group/proj!123)` and "See merge request group/proj!123";
    the claim side reads `!123` and `/merge_requests/123`. The GitLab fixture
    earned its keep immediately — the namespaced prose form has a word
    character in front of the `!`, so the rule that keeps `#` from matching
    inside identifiers could not fire, and that one shape stayed unanchored
    until the fixture said so. The slash is what keeps the extra rule off
    ordinary prose that ends in an exclamation.
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

## Order and why (the original three-phase plan)

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

---

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
The standing offer from the long-view section, now worth more: the
reports it writes carry findings and lenses. `watch backfill --releases 5`
across the watchlist — the command states the judge cost and asks before
starting; backfilled checks never alert. Runs after Block 2 so the
reports are written by the released version with lens config in place.
**Done when:** every watchlist repo has a median, drift detection and a
filled author ledger (≥ 5 checks each), or a documented skip.

### Block 4 — reconciliation: claims meet findings (design, then build)
The axis's decisions block already settles the shape: messages and notes
join *late*, against the findings — confirmed (claimed + observed),
undocumented (observed, never claimed — the interesting signal),
unsupported (claimed, never observed). Score-neutral until measured, like
every stage before it. Proposal, deterministic first: match claims to
findings with the S5 machinery (identifier overlap against a finding's
text + files), render as per-finding tags in the findings section plus one
"unsupported claims" line; a judged matching pass only where the
deterministic one stays empty — and only as a later, separate decision.
Open before building: whether reconciliation renders inside the findings
section or as its own; whether `undocumented` findings should order the
uncovered list (display only — anything score-touching faces the A/B
discipline).
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
