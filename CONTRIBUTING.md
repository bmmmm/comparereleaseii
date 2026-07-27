# Contributing

This project checks whether release notes match the code. It asks the same of
contributions: **state what your change does, and make the diff prove it.**

That is not ceremony. A pull request whose claims are explicit, whose tests fail
without it, and whose scope is bounded can be reviewed in minutes. One that
leaves those things implicit needs the reviewer to reconstruct intent from the
diff — which is slow, error-prone, and how good changes go stale.

## Setup

```console
$ pnpm install          # pnpm only — npm and yarn are blocked by a preinstall guard
$ pnpm check            # tsc --noEmit
$ pnpm test             # node:test unit tests
$ pnpm eval             # golden-set eval, needs a judge engine
```

Node ≥ 24 runs the TypeScript directly. There is no build step and no runtime
npm dependency: `gh`, `git` and `claude` are called as subprocesses. Keep it
that way — a dependency needs a strong argument.

## Where things live

| Path | Responsibility |
|---|---|
| `src/cli.ts` | Flags, orchestration, `--estimate` |
| `src/check.ts` | One release end to end — shared by the CLI and watch mode |
| `src/sources/github.ts` | Release data via `gh`, compare API, truncation fallback |
| `src/sources/local.ts` | Local git ranges, CHANGELOG section extraction, unified-diff parsing |
| `src/sources/forge.ts` | Release lists from Forgejo/Gitea and GitLab — the only non-git surface `--repo-url` needs |
| `src/claims.ts` | Notes → claims (bullets, prose, sections, dedupe) |
| `src/match.ts` | Identifier extraction and lexical matching against changed lines |
| `src/verify.ts` | The escalation ladder, second retrieval round, coverage check |
| `src/judge.ts` | Judge engines, prompt construction, response parsing |
| `src/calibrate.ts` | Golden set against the configured judge |
| `src/cache.ts` | On-disk verdict cache |
| `src/metrics.ts` | Trust score, risk flags, per-file coverage |
| `src/report.ts` | Terminal and markdown output, exit codes |
| `src/html.ts` | Self-contained HTML report |
| `src/history.ts` | Release timeline and anomaly baseline |
| `src/promises.ts` | Promise tracking — forward-looking notes checked against later releases |
| `src/suggest.ts` | `--suggest` — draft a note line for undocumented commits |
| `src/watch.ts` | Watch mode: state file, per-repo runs, dashboard index, `--notify` |
| `src/watch-detail.ts` | Per-repo history page: score series, verdict composition, promise ledger |
| `src/watchlist.ts` | `watch init/add/remove/list` — build the repo list from your GitHub account |
| `src/setup.ts` | `watch setup` — interactive: home dir, judge + calibration gate, launchd/cron file, notify hook |
| `src/guidelines.ts` | `guidelines` — the agent checklist extracted from `docs/` |
| `src/types.ts` | Data model — the `--json` schema lives here |
| `src/util.ts` | Subprocess helpers, concurrency pool, markdown section extraction |
| `src/paths.ts` | Build version, the private cache directory and its vetting, path-segment sanitizer |
| `test/fixtures/*.md` | Real release notes, per dialect |
| `test/eval/golden.json` | Judge cases with accepted verdicts |

## Filing an issue

Pick the form that matches — each asks for the evidence that specific class of
bug needs, and skipping it is what makes an issue sit unanswered.

- **Wrong verdict** — the hunk that decides it, and ideally a `golden.json` entry.
  That entry *is* the regression test; a report carrying one is usually fixed
  immediately.
- **Bug** — a command against a public repo and a **pinned tag**, plus whether it
  survives `--judge off --no-cache`. That one answer splits "deterministic code
  bug" from "model behaviour", which are unrelated fixes.
- **Notes dialect** — the smallest excerpt that still misparses. It becomes a
  fixture, so the parser can never regress on that dialect again.
- **Judge engine** — the `--calibrate` output. It settles whether the plumbing is
  broken or the model is simply too weak, and we only fix the former.
- **Feature** — the CLI surface you propose, plus acceptance criteria. The form
  asks you to design it, because that is what makes it implementable.
- **Task** — a settled design someone can pick up without asking anything.

## The three contracts

People gate their CI on this tool. These surfaces are stable, and breaking one
silently is worse than any bug:

1. **Exit codes** — `0` all claims supported · `1` unsupported or contradicted ·
   `2` usage or data error.
2. **The `--json` report schema** — the `Report` interface in `src/types.ts`.
   Adding fields is fine. Removing, renaming or retyping is not.
3. **Flags and their defaults** — an existing flag keeps its meaning.

A fourth, unwritten one: **with `--judge off`, identical input produces
identical output.** The deterministic stages are what people fall back to when
no model is available. Nothing may leak nondeterminism into them.

## Tests

Every behavioural change needs a test that fails without it. Three kinds:

- **Unit** (`test/*.test.ts`, `node --test`) — parsing, matching, scoring, exit
  codes. Table-driven where the cases are data.
- **Fixtures** (`test/fixtures/*.md`) — a real release-notes dialect, kept to the
  smallest excerpt that shows the behaviour.
- **Golden set** (`test/eval/golden.json`) — anything that can move a *ruling*.
  `expected` is a list: include every verdict you would accept as correct, so the
  set stays honest about genuinely ambiguous evidence instead of overfitting to
  one model's phrasing.

If you change the judge prompt, run `pnpm eval` before and after and put both
numbers in the PR. If you change how a judge *response is parsed*, re-verify
with `--no-cache`: the cache key is derived from the prompt, so a parsing change
leaves old entries in place and they will be re-read by your new parser.

If you change scoring, re-measure the five releases in the README's validation
table and update it in the same commit. Nothing automated can catch that one —
it takes real judge runs — and a table the current code no longer reproduces is
the drift this tool exists to find.

## Releasing

```console
$ pnpm release:prepare 0.2.2   # bump, rename Unreleased, fix version pins, gate on test+dogfood
$ git diff                     # review
$ git add package.json CHANGELOG.md README.md docs/
$ git commit -m "Release v0.2.2: <short pitch>"
$ pnpm release:publish         # tag, push to every remote, open the GitHub release
```

`release:prepare` refuses to run on a dirty tree or a branch behind its
upstream — a stale checkout (a second worktree or session pushed since this
one last fetched) is caught before it wastes a release on outdated files. It
writes CHANGELOG.md, package.json and any stale version pin, then runs
`pnpm test` and `pnpm dogfood` as gates; nothing is committed automatically,
because the release commit's message is the one thing worth writing by hand.

## Pull requests

The template asks for claims, real command output, a failing test, contract
confirmations, risk, and scope. Fill it in and the review is mechanical.

Two automated jobs run, and **neither can fail your build**:

- **pr intake** — reads the description and posts a checklist of what is still
  open, so the reviewer sees the state at a glance.
- **self-check** — extracts your claims block and runs this project's own checker
  over your diff with `--judge off`. It reports which claims the anchors and
  identifier matching tie to the diff. A claim with no evidence there is a
  prompt to check it by hand, not a defect — deterministic matching cannot see
  semantics, which is the entire reason the LLM stage exists.

Write claims the way the tool reads them: one bullet per user-visible change,
symbols and files in `backticks`, issues and PRs as `#N`. Claim what the change
*does*, not which files you opened.

Keep the diff inside the scope the claims imply. If you find an adjacent problem,
say so in "Out of scope" and file an issue — a second concern in one PR doubles
the review and delays both.

## Using an LLM

Welcome, and no disclosure ritual required beyond the checkbox in the template.
This is a tool for verifying claims rather than trusting them, so it would be
odd to demand that contributions be typed by hand.

One rule: **you stand behind it.** You ran it, you read every line, and you can
explain why each change is there. Output that a reviewer's questions cannot be
answered about will be closed regardless of whether it works — an unmaintainable
correct patch is still a liability. Never paste private code, keys or internal
URLs into an issue.

## Security

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).

## Licence

Contributions are licensed under GPL-3.0-or-later. Keep the SPDX header on new
source files:

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
```
