# Watchdog: continuous release monitoring

`comparerelease watch` turns the checker into a supply-chain watchdog: point
it at a list of repos, run it from cron/launchd, and every NEW release gets a
full fact-check the moment it appears. No new releases means a no-op run
(one GitHub API call per repo).

```console
$ comparerelease watch --config watch.json
restic/restic: up to date (v0.19.1)
juanfont/headscale: checking v0.30.0…
juanfont/headscale: v0.30.0 → score 94 (solid)
watch: 4 repos · 1 new release(s) checked · 0 flagged · index reports/index.html · exit 0
```

Each checked release writes `reports/<repo>/<tag>.{html,md,json}` and
regenerates `reports/index.html` — a one-page overview with red rows for
flagged releases and links to the full reports.

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
    { "repo": "dani-garcia/vaultwarden", "baseline": 8 }
  ]
}
```

`defaults` applies to every repo; each entry can override it. Per-repo
options: `judge`, `engine`, `model`, `openaiUrl`, `escalate`,
`escalateModel`, `failOn`, `baseline`, `concurrency`, `includePrerelease`,
`notifyBelow`, `notesFile`, `label`. Relative paths (`reportsDir`,
`stateFile`, `notesFile`) resolve against the config file's directory.

The judge defaults shown above are the recommended watchdog setup: a local
OpenAI-compatible model (Ollama/MLX/vLLM) does the bulk verification for
free and in private, and `escalate: "auto"` sends release-critical verdicts
(`no-evidence`, `contradicted`, security claims) to a stronger engine when
one is available. Run `comparerelease --calibrate --engine openai` first to
check your local model against the golden set. No local server? Set
`"engine": "claude-cli"` or `"engine": "api"` in `defaults`.

## Flagging and notifications

A release is flagged when any of these hold:

- the exit gate fails (`failOn` — the watch default is `contradicted`,
  lenient on purpose: honest releases often carry unprovable claims such as
  private security advisories, and alerting on every one is fatigue; set
  `"failOn": "no-evidence"` per repo for the strict CI-style gate),
- a critical risk flag fired (install hooks, undocumented auth/crypto
  changes, silently added dependencies, …),
- the trust score is below `notifyBelow` (default 65).

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
entry; `notesFile` is resolved relative to the config file.)

## Scheduling

### cron

```cron
17 * * * * cd $HOME/release-watch && PATH=/opt/homebrew/bin:/usr/local/bin:$PATH comparerelease watch --config watch.json >> watch.log 2>&1
```

`gh` (and `claude` or your local model server) must be reachable from
cron's minimal PATH — hence the PATH prefix.

### launchd (macOS)

`~/Library/LaunchAgents/comparereleaseii.watch.plist`, then
`launchctl load` it:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>comparereleaseii.watch</string>
  <key>ProgramArguments</key><array>
    <string>/bin/sh</string><string>-lc</string>
    <string>comparerelease watch --config $HOME/release-watch/watch.json</string>
  </array>
  <key>StartInterval</key><integer>3600</integer>
  <key>StandardOutPath</key><string>/tmp/comparereleaseii-watch.log</string>
  <key>StandardErrorPath</key><string>/tmp/comparereleaseii-watch.log</string>
</dict></plist>
```

`sh -lc` pulls in your login PATH so `comparerelease`, `gh` and the judge
engine are found. Point a static file server (or just your browser) at the
reports directory — `index.html` is the dashboard.
