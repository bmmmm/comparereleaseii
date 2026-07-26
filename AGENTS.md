# Agent instructions

Working notes for coding agents. Humans: [CONTRIBUTING.md](CONTRIBUTING.md) is
the readable version — this file is the short, imperative one.

## Commands

```console
pnpm install --frozen-lockfile   # pnpm only; a preinstall guard blocks npm/yarn
pnpm check                       # tsc --noEmit — must pass
pnpm test                        # node --test 'test/*.test.ts' — must pass
pnpm eval                        # golden-set eval; needs a judge engine
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
| `src/claims.ts` | Notes → claims |
| `src/match.ts` | Identifier extraction, lexical matching |
| `src/verify.ts` | Escalation ladder, second retrieval round, coverage |
| `src/judge.ts` | Engines, prompt construction, response parsing |
| `src/calibrate.ts` | Golden set against the configured judge |
| `src/cache.ts` | Verdict cache |
| `src/metrics.ts` | Score, risk flags, per-file coverage |
| `src/report.ts` | Terminal/markdown output, exit codes |
| `src/html.ts` | HTML report |
| `src/history.ts` | Timeline, baseline |
| `src/suggest.ts` | `--suggest` — draft a note line for undocumented commits |
| `src/watch.ts` | Watch mode: state, per-repo runs, dashboard index, `--notify` |
| `src/watchlist.ts` | `watch init/add/remove/list` — repo list from your GitHub account |
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
- Comment only what the code cannot say — a constraint, a workaround, a
  surprising behaviour. The existing comments are the model: they explain *why*.
- Match the surrounding style. No new abstraction layer for a single call site.

## Traps

- **Verdict spelling.** Internally and on the CLI it is `no-evidence`. The judge
  prompt asks the model for `no_evidence`, and `src/judge.ts` normalises both.
  This is intentional — do not "unify" it.
- **The verdict cache.** The key is `sha256(engineName + prompt)`. Editing the
  prompt invalidates entries automatically; changing how a *response is parsed*
  does not, so old entries get re-read by your new parser. Verify parser changes
  with `--no-cache`.
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
3. Anything that can move a ruling has a `test/eval/golden.json` case, and
   `pnpm eval` was run before and after.
4. The PR description follows `.github/PULL_REQUEST_TEMPLATE.md`: claims as
   bullets with symbols in backticks, real pasted command output, the failing
   test named, contracts confirmed, scope stated.
5. Claims describe observable behaviour, not files touched, and every claim is
   traceable to the diff.
