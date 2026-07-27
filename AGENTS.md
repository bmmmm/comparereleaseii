# Agent instructions

Working notes for coding agents. Humans: [CONTRIBUTING.md](CONTRIBUTING.md) is
the readable version — this file is the short, imperative one.

## Commands

```console
pnpm install --frozen-lockfile   # pnpm only; a preinstall guard blocks npm/yarn
pnpm check                       # tsc --noEmit — must pass
pnpm test                        # node --test 'test/*.test.ts' — must pass
pnpm eval                        # golden-set eval; needs a judge engine
pnpm mutate                      # mutation harness: every listed guard's test must kill its mutant
node src/cli.ts --help
```

Node ≥ 24 executes the TypeScript directly. There is no build step, no bundler,
and no runtime npm dependency — `gh`, `git` and `claude` are subprocesses. Do
not add a dependency, a build step, or a framework.

## Module map

| Path | Responsibility |
|---|---|
| `src/cli.ts` | Flags, orchestration, `--estimate` |
| `src/check.ts` | One release end to end — shared by the CLI and watch mode |
| `src/sources/github.ts` | Release data via `gh`, compare API, truncation fallback |
| `src/sources/local.ts` | Local git ranges, CHANGELOG extraction, unified-diff parsing |
| `src/sources/forge.ts` | Release lists from Forgejo/Gitea and GitLab — the only non-git surface `--repo-url` needs |
| `src/claims.ts` | Notes → claims |
| `src/match.ts` | Identifier extraction, lexical matching |
| `src/verify.ts` | Escalation ladder, second retrieval round, coverage |
| `src/judge.ts` | Engines, prompt construction, response parsing |
| `src/calibrate.ts` | Golden set against the configured judge |
| `src/cache.ts` | Verdict cache |
| `src/paths.ts` | Build version, the private cache directory and its vetting, path-segment sanitizer |
| `src/metrics.ts` | Score, risk flags, per-file coverage |
| `src/report.ts` | Terminal/markdown output, exit codes |
| `src/html.ts` | HTML report |
| `src/history.ts` | Timeline, baseline |
| `src/promises.ts` | Forward-looking notes from earlier releases checked against this diff |
| `src/suggest.ts` | `--suggest` — draft a note line for undocumented commits |
| `src/watch.ts` | Watch mode: state, per-repo runs, dashboard index, `--notify` |
| `src/watchlist.ts` | `watch init/add/remove/list` — repo list from your GitHub account |
| `src/setup.ts` | `watch setup` — interactive home dir, judge + calibration gate, schedule file, notify |
| `src/guidelines.ts` | `guidelines` — agent checklist extracted from `docs/` |
| `src/util.ts` | Subprocess helpers, concurrency pool, markdown section extraction |
| `src/types.ts` | Data model — read this first |

## Rules

- Start from `src/types.ts`. The data model is small and the whole pipeline is
  transformations over it.
- Keep `// SPDX-License-Identifier: GPL-3.0-or-later` as the first line of every
  source file — directly below the `#!` line where there is one.
- Do not break the three public contracts: exit codes (`0`/`1`/`2`), the `--json`
  schema (`Report` in `src/types.ts`), and existing flag semantics. Additive is
  fine; removing, renaming or retyping is not.
- With `--judge off` the tool must be fully deterministic: identical input,
  identical output. Never introduce time, randomness or map-iteration order into
  a deterministic stage.
- Every field a prompt or a report quotes from a release — notes, section
  headings, commit subjects, file paths, diff hunks, tags, refs — is written by
  the party under examination. In a prompt it goes inside the untrusted markers
  (`untrustedBlock` in `src/judge.ts`); in HTML it goes through `esc()`, and in
  an `href` through the URL helpers as well. The same holds for a PR body in a
  workflow: `.github/scripts/pr-intake.mjs` quotes it into a fence before it
  reaches the job summary, so the author cannot forge the verdict table a
  reviewer reads. There is no field here that is "obviously safe", and the list
  of sinks is not closed — a new one inherits the rule, it does not get an
  exemption.
- No claim may reach `verified` because the notes agree with the commit
  message. Both come from the same hand; only the diff is evidence.
- Change scoring and you change the README's validation table. Re-measure the
  five releases listed there and update it in the same commit — a table of
  scores the current code no longer produces is exactly the drift this tool
  exists to catch.
- Comment only what the code cannot say — a constraint, a workaround, a
  surprising behaviour. The existing comments are the model: they explain *why*.
- Match the surrounding style. No new abstraction layer for a single call site.
- Push to `origin` (the private forge) as you go; push to the `github` remote
  **only when cutting a release**. The public mirror is a record of releases,
  not a live feed of work in progress — and every push to it is one more
  chance for the pre-push leak gate to be the last line of defence rather
  than a backstop. The gate is not a licence to push often.

## Traps

- **Verdict spelling.** Internally and on the CLI it is `no-evidence`. The judge
  prompt asks the model for `no_evidence`, and `src/judge.ts` normalises both.
  This is intentional — do not "unify" it.
- **The verdict cache.** The key is `sha256(version + engineName + prompt)`, and
  the entry repeats all three so a stale file cannot be replayed under a new one.
  Editing the prompt invalidates entries automatically, and so does a release;
  changing how a *response is parsed* within one version does not, so old entries
  get re-read by your new parser. Verify parser changes with `--no-cache`.
- **Small-model tolerance.** The response parser deliberately accepts truncated
  and malformed JSON, and requests carry defaults for hidden thinking budgets.
  Tightening this breaks local models — read the comments in `src/judge.ts`
  before touching it.
- **Whitespace is load-bearing in `src/claims.ts`.** Indentation decides whether
  a line continues a bullet or opens a paragraph, and setext underlines are
  headings. Change parsing only with a fixture that proves the case.
- **`test/eval/golden.json` `expected` is a list.** Several verdicts can be
  correct for genuinely ambiguous evidence. Do not collapse it to one value to
  make a run pass.
- **Never widen the diff beyond the task.** Adjacent problems go in the PR's
  "Out of scope" section or into a new issue.

## Definition of done

1. `pnpm check` and `pnpm test` pass.
2. A test exists that fails without the change. Verify that — do not assume it.
   A new scoring/parsing guard also gets an entry in `scripts/mutate.ts`, and
   `pnpm mutate` must report it killed.
3. Anything that can move a ruling has a `test/eval/golden.json` case, and
   `pnpm eval` was run before and after.
4. The PR description follows `.github/PULL_REQUEST_TEMPLATE.md`: claims as
   bullets with symbols in backticks, real pasted command output, the failing
   test named, contracts confirmed, scope stated.
5. Claims describe observable behaviour, not files touched, and every claim is
   traceable to the diff.
