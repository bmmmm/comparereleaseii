# Watchdog: continuous release monitoring

`comparerelease watch` turns the checker into a supply-chain watchdog: point
it at a list of repos, run it from cron/launchd, and every NEW release gets a
full fact-check the moment it appears. No new releases means a no-op run
(one API call per repo). GitHub repos are listed as `owner/repo`; any
Forgejo/Gitea or GitLab repo joins the same list by URL (`repoUrl`) — polled
over that forge's release API, checked through a cached clone.

This page uses the short `comparerelease` name throughout, because a
scheduler wants one command it can call. From inside a checkout:
`ln -s "$PWD/bin/comparerelease.mjs" ~/.local/bin/comparerelease`. Every
command here works the same as `gh comparereleaseii watch …` if you installed
the extension instead — then `gh` is what has to be on cron's `PATH`.

```console
$ comparerelease watch --config watch.json
restic/restic: up to date (v0.19.1)
juanfont/headscale: checking v0.30.0…
juanfont/headscale: v0.30.0 → score 94 (solid)
watch: 4 repos · 1 new release(s) checked · 0 flagged · index reports/index.html · exit 0
```

Each checked release writes `reports/<repo>/<tag>.{html,md,json}` and
regenerates `reports/index.html` — a one-page overview with red rows for
flagged releases; every row links to its full report (click anywhere in the
row), repo and release link out to their forge, and the score components
(correctness · completeness · risk) sit next to the trust score. Repos that
haven't had a release since being added are listed as waiting, so the index
always mirrors the configured list. Above the table, tiles aggregate the
watchlist (repos, flagged, broken promises, score distribution); columns
sort on click and a toggle shows flagged rows only; below it, a release
feed lists every checked release across repos, newest first. The same feed
is written as static Atom to `reports/feed.xml` (relative links — serve the
reports directory and any feed reader can subscribe), and each repo row
links a `history` page (`reports/<repo>/index.html`) with the full score
series, verdict composition per release, the promise ledger, and an author
ledger — per-identity facts accumulated across checked releases (first
seen, commits, sensitive-path and binary commits, forge-attribution
history, bot tag) plus each release's identity count, first-appearances
and top-identity commit share. Facts only, by design: no trust ratings on
people in either direction.

## How state works

A state file remembers the last checked release per repo (default:
`$XDG_STATE_HOME/comparereleaseii/watch-state.json`, i.e.
`~/.local/state/…` — override with `stateFile` in the config or `--state`).

- First run per repo: only the latest release is checked (no backfill
  surprise).
- Later runs: everything published since the last checked release, oldest
  first, capped at `maxPerRun` (default 3) per repo and run.
- A release is checked exactly once — re-runs cannot re-alert.
- State is saved after every successful check, so a crash never loses or
  repeats work.
- A failing check is retried on the next runs; after 3 runs failing on the
  same release, watch moves past it so newer releases still get checked.
  The skip is never silent: it is logged, and the release stays listed
  under "Unchecked releases" on the repo's history page — a gap there
  means "unchecked", not "fine".

## Building the repo list

Your GitHub account already knows which repos you care about — `watch init`
turns that into a config interactively:

```console
$ comparerelease watch init
Repos from your GitHub account (watched, starred, notifications):

   1  anomalyco/opencode      2026-07  starred   AI coding agent, built for the terminal
   2  zed-industries/zed      2026-07  starred   Code at the speed of thought
   …
Watch which repos? numbers/ranges ("1,3-5"), "a" for all, empty to cancel: 1,4-6
4 repo(s) added to watch.json (created) — 4 watched total.
```

Sources (`--from`, default all three): `watched` — repos you subscribed to,
`starred` — your stars, `notifications` — repos whose release notifications
you actually received. Archived repos and repos already in the config are
filtered out; the list is sorted by recent activity.

For scripts and CI, or one-off changes:

```console
$ comparerelease watch add restic/restic      # validates the repo exists
$ comparerelease watch remove restic/restic
$ comparerelease watch list
```

`watch init` is GitHub-only by design (it reads a GitHub account). Repos on
any other forge join by URL — validated the same way: the add fails with the
reason if no release API answers, because the poll needs one:

```console
$ comparerelease watch add --repo-url https://gitea.com/gitea/tea
gitea/tea (forgejo at https://gitea.com) added to watch.json.
$ comparerelease watch remove https://gitea.com/gitea/tea
```

Private forge repos need the matching token exported where watch runs:
`FORGEJO_TOKEN`/`GITEA_TOKEN` or `GITLAB_TOKEN`. A plain git host without a
release API cannot be watched (nothing answers "is there a new release?") —
those repos can still be checked one-off with `--repo-url`.

All list commands default to `./watch.json`; pass `--config <file>` to use
another path. They only touch the `repos` array — `defaults`, `notify` and
every other setting survive edits. `add` and `remove` are idempotent:
re-adding a present repo or removing an absent one is a no-op, exit 0.

## Config format

```json
{
  "reportsDir": "reports",
  "maxPerRun": 3,
  "notify": "ntfy publish releases",
  "defaults": {
    "engine": "openai",
    "escalate": "auto",
    "notifyBelow": 65
  },
  "repos": [
    { "repo": "restic/restic" },
    { "repo": "juanfont/headscale" },
    { "repo": "orhun/git-cliff" },
    { "repo": "dani-garcia/vaultwarden", "baseline": 8 },
    { "repoUrl": "https://gitea.com/gitea/tea" }
  ]
}
```

`defaults` applies to every repo; each entry can override it. Exactly one of
`repo` (GitHub) and `repoUrl` (any Forgejo/Gitea/GitLab URL) per entry; a
`repoUrl` entry's state key is the URL unless `label` renames it, and its
report directory is the URL's path-safe form (`https_gitea.com_gitea_tea`). Per-repo options: `judge`, `engine`, `model`, `openaiUrl`,
`escalate`, `escalateModel`, `failOn`, `baseline`, `concurrency`,
`includePrerelease`, `notifyBelow`, `notesFile`, `label`. Relative paths
(`reportsDir`, `stateFile`, `notesFile`) resolve against the config file's
directory.

The judge defaults shown above are the recommended watchdog setup: a local
OpenAI-compatible model (Ollama/MLX/vLLM) does the bulk verification for
free and in private, and `escalate: "auto"` sends release-critical verdicts
(`no-evidence`, `contradicted`, security claims) to a stronger engine when
one is available. Run `comparerelease --calibrate --engine openai` first to
check your local model against the golden set. No local server? Set
`"engine": "claude-cli"` or `"engine": "api"` in `defaults`.

## Reading the first run

A fresh watchlist's first run flags a lot — that is expected, and most of
it is information, not attack:

- **Thin release notes score low honestly.** A project that ships 187
  commits under 11 bullet points gets a single-digit completeness — the
  score says "these notes don't tell you what changed", not "this release
  is malicious". If that is a repo's normal culture, lower its
  `notifyBelow` or set `"failOn": "none"` per repo, and let the critical
  risk flags (install hooks, undocumented auth/crypto changes) do the
  alerting.
- **Changelog-only repos can't be checked.** A repo that contains no
  source (release notes describe a product built elsewhere) gives the
  checker nothing to diff against — every claim lands on a version-bump
  commit. Take it off the list.
- **Monorepo product tags and parallel maintenance lines** are handled:
  the base release must share the tag prefix (`cli-v…` diffs against the
  previous `cli-v…`) and prefers the same major line (`v3.7.9` against
  `v3.7.8`/`v3.6.x`, not the `v2.11.x` backport released in between).

## Flagging and notifications

A release is flagged when any of these hold:

- the exit gate fails (`failOn` — the watch default is `contradicted`,
  lenient on purpose: honest releases often carry unprovable claims such as
  private security advisories, and alerting on every one is fatigue; set
  `"failOn": "no-evidence"` per repo for the strict CI-style gate),
- a critical risk flag fired (install hooks, undocumented auth/crypto
  changes, silently added dependencies, …),
- the trust score is below `notifyBelow` (default 65) — or, once three
  checks exist, at least 20 points below **this repo's own median**, which
  replaces the absolute bar (a repo that always sits near 25 stops crying
  wolf; one that always sits near 95 now alerts at 75),
- the repo's own level has slid: with six checks or more, the median of the
  newer half is 20 or more below the median of the older half. The relative
  bar fires once on a step down and then the lower level *is* the normal it
  compares against — this catches the case where nothing looks anomalous
  because the anomaly became the baseline.

With `--notify <cmd>` (or `"notify"` in the config) every flagged release
runs `<cmd> <path-to-json-report>` — composable with whatever you have:

```console
$ comparerelease watch --config watch.json --notify 'ntfy publish releases'
$ comparerelease watch --config watch.json --notify '~/bin/release-alert.sh'
```

The command receives the JSON report path as its single extra argument;
`jq` the details you care about in your script. The exit code of `watch` is
the worst result of the batch (`0` all green, `1` a gate failed, `2` an
error) — CI-friendly.

## Self-test: prove the red path works

From a checkout of this repo, add the fabricated-notes fixture as a
negative control — it must show up red in the index:

```json
{ "repo": "dani-garcia/vaultwarden", "label": "fabricated-control",
  "notesFile": "test/fixtures/vaultwarden-1.37.0-fabricated.md" }
```

(`label` keeps its state and reports separate from the honest vaultwarden
entry and is shown in the report header — `dani-garcia/vaultwarden
(fabricated-control)` — so the red report can never be mistaken for
vaultwarden's real release; `notesFile` is resolved relative to the config
file.)

## Scheduling

### The short way: `watch setup`

`comparerelease watch setup` asks the four operating questions interactively —
home directory (config, state, reports and log in one place, default
`~/release-watch/`), judge (detected from this machine, with the calibration
gate one answer away for a local model), schedule, and an optional notify
hook (test-fired once — a failing command is dropped unless kept
deliberately) — then writes the config and the schedule: on macOS a runner
script named `comparereleaseii-watch` plus a plist that executes it (macOS
names a background job by its program, so the job shows up under that name
instead of an anonymous "sh"), on other platforms a crontab line. It then
**prints** the command that activates the schedule (on macOS: copy the
plist into `~/Library/LaunchAgents` + `launchctl bootstrap`, so it survives
reboots; on cron: an append guarded against double-pasting). It only ever
writes files; nothing is installed. An existing config or state file is
adopted, not overwritten. The hand-wired recipes below do the same thing and
show the moving parts.

### cron

```cron
17 * * * * cd $HOME/release-watch && PATH=/opt/homebrew/bin:/usr/local/bin:$PATH comparerelease watch --config watch.json >> watch.log 2>&1
```

`gh` (and `claude` or your local model server) must be reachable from
cron's minimal PATH — hence the PATH prefix.

### launchd (macOS)

An executable runner script `~/release-watch/comparereleaseii-watch` —
macOS names a background job by its program (in `launchctl print`, System
Settings' Background Items, the bootstrap notification), so a named script
shows up as itself where a `/bin/sh -lc` wrapper would announce itself as
an anonymous "sh":

```sh
#!/bin/sh
PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
export PATH
exec comparerelease watch --config "$HOME/release-watch/watch.json"
```

Then `~/Library/LaunchAgents/comparereleaseii.watch.plist`, and
`launchctl load` it:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>comparereleaseii.watch</string>
  <key>ProgramArguments</key><array>
    <string>/Users/you/release-watch/comparereleaseii-watch</string><!-- absolute on purpose: launchd expands no $HOME (path-guard:allow) -->
  </array>
  <key>StartInterval</key><integer>3600</integer>
  <key>StandardOutPath</key><string>/tmp/comparereleaseii-watch.log</string>
  <key>StandardErrorPath</key><string>/tmp/comparereleaseii-watch.log</string>
</dict></plist>
```

The PATH prefix in the script is what launchd's bare environment lacks —
`comparerelease`, `gh` and the judge engine live there. Point a static file
server (or just your browser) at the reports directory — `index.html` is
the dashboard.

### GitHub Actions (scheduled)

No always-on machine? A scheduled workflow runs the same watchdog in CI.
Commit your `watch.json` to the repo that hosts the workflow, and set
`engine` to `api` (with an `ANTHROPIC_API_KEY` secret) or `off` — the
`claude` CLI is not available on runners:

A flagged release makes the watch step exit 1 on purpose — the workflow must
still save the state and upload the reports on exactly those runs, hence
`continue-on-error` + explicit cache save/restore + the final gate step
(a plain `actions/cache` step skips its save when the job failed, which
would re-judge and re-alert the same release on every schedule):

```yaml
name: release-watch
on:
  schedule:
    - cron: "17 6 * * *"
  workflow_dispatch:
permissions:
  contents: read
jobs:
  watch:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7   # your repo — watch.json lives here
      - uses: actions/checkout@v7   # the tool — no install, runs from source
        with:
          repository: bmmmm/comparereleaseii
          ref: v0.5.1
          path: comparereleaseii
      - uses: actions/setup-node@v7
        with:
          node-version: 24
      - uses: actions/cache/restore@v6
        with:
          # State keeps alerts single-shot; the verdict cache keeps a re-check
          # of an unchanged release free (same prompt + engine + tool version
          # → same answer, from disk).
          path: |
            ~/.local/state/comparereleaseii
            ~/.cache/comparereleaseii
          key: watch-state-${{ github.run_id }}
          restore-keys: watch-state-
      - id: watch
        continue-on-error: true
        run: node comparereleaseii/src/cli.ts watch --config watch.json
        env:
          GH_TOKEN: ${{ github.token }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      - uses: actions/cache/save@v6
        if: always()
        with:
          path: |
            ~/.local/state/comparereleaseii
            ~/.cache/comparereleaseii
          key: watch-state-${{ github.run_id }}
      - uses: actions/upload-artifact@v7
        if: always()
        with:
          name: watch-reports
          path: reports
      - name: Surface the watch verdict
        if: steps.watch.outcome == 'failure'
        run: exit 1
```

Caveats, honestly:

- **Cache eviction** (~7 days unused, size pressure) resets the state — the
  next run behaves like a first run and re-checks each repo's latest
  release, so in the worst case one release is re-alerted once. If that
  matters, commit the state file to a branch instead.
- **`github.token` is scoped to the hosting repo**: it cannot read private
  repos in the watch list, and its rate limit (1,000 requests/hour) can run
  out mid-batch — one checked release costs roughly `3 + commits +
  2×baseline` API calls. For private repos or busy lists use a fine-grained
  PAT in a secret, and consider a lower `baseline`.
- A red run means a flagged release — wire a notification onto workflow
  failure, or use `--notify` with something reachable from CI.
