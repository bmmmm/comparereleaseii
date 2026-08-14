# Module map

Path → responsibility, one line each. Moved out of AGENTS.md to keep that
file under its word budget — this table is reference material an agent looks
up, not a rule it needs to carry into every task. Start at `src/types.ts`
(the data model, read first), then `src/cli.ts` and `src/check.ts` for the
orchestration.

| Path | Responsibility |
|---|---|
| `src/cli.ts` | Flags, orchestration, `--estimate` |
| `src/estimate.ts` | `--estimate`: what a check would cost, measured by running the pipeline against a counting stub |
| `src/check.ts` | One release end to end — shared by the CLI and watch mode |
| `src/sources/github.ts` | Release data via `gh`, compare API, truncation fallback |
| `src/sources/local.ts` | Local git ranges, CHANGELOG extraction, unified-diff parsing |
| `src/sources/forge.ts` | Release lists from Forgejo/Gitea and GitLab — the only non-git surface `--repo-url` needs |
| `src/claims.ts` | Notes → claims |
| `src/match.ts` | Identifier extraction, lexical matching |
| `src/verify.ts` | Escalation ladder, second retrieval round, coverage |
| `src/judge.ts` | Engines, prompt construction, response parsing |
| `src/calibrate.ts` | Golden set against the configured judge |
| `src/golden.ts` | `--add-golden`: a claim from a stored report becomes a golden case, with the release's own evidence rebuilt |
| `src/cache.ts` | Verdict cache |
| `src/paths.ts` | Build version, the private cache directory and its vetting, path-segment sanitizer |
| `src/metrics.ts` | Score, risk flags, per-file coverage |
| `src/bump.ts` | Semver bump vs the commits' own BREAKING/feat markers |
| `src/deps.ts` | Dependency manifests in a diff: added packages, lockfile sources, opaque binaries |
| `src/pins.ts` | Version-pin delta: manifest/Makefile/Dockerfile/URL/workflow-`uses:` bumps, first-party classification — and the claim side, `detectBumpClaim` |
| `src/substance.ts` | What actually shipped: category rollup, changed symbols, config surface, migrations, routes |
| `src/findings.ts` | Typed findings: the diff read per subsystem within a hard budget, blind to commit messages |
| `src/reconcile.ts` | The late join of claims and findings: confirmed, undocumented, unsupported — plus the pin join that settles bump claims; deterministic, never scored |
| `src/report.ts` | Terminal/markdown output, exit codes |
| `src/html.ts` | HTML report |
| `src/theme.ts` | Score buckets and their colors — the boundaries every renderer and the terminal share |
| `src/history.ts` | Timeline, baseline |
| `src/promises.ts` | Forward-looking notes from earlier releases checked against this diff |
| `src/suggest.ts` | `--suggest` — draft a note line for undocumented commits |
| `src/watch.ts` | Watch mode: state, per-repo runs, dashboard index, `--notify` |
| `src/watch-state.ts` | What a check records and the rules that move the state — flagging, drift, ledgers. No I/O |
| `src/watch-lock.ts` | One writer per state file: create-or-fail lock, liveness by pid, released on signals |
| `src/watch-index.ts` | The dashboard across all watched repos and its Atom feed |
| `src/watch-detail.ts` | Per-repo history page: score series, verdict composition, promise ledger |
| `src/watch-longview.ts` | Long-view sections of the history page: phases, event log, yearly strips, calendar |
| `src/watchlist.ts` | `watch init/add/remove/list` — repo list from your GitHub account |
| `src/setup.ts` | `watch setup` — interactive home dir, judge + calibration gate, schedule file, notify |
| `src/guidelines.ts` | `guidelines` — agent checklist extracted from `docs/` |
| `src/util.ts` | Subprocess helpers, concurrency pool, markdown section extraction, HTML escaping, the notify hook |
| `src/types.ts` | Data model — read this first |
