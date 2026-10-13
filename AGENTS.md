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
pnpm sweep <reports dir>         # threshold sweep: Pareto front per hand-set bar. Reports, never writes
pnpm mutate-notes <dir> --generate  # + the model-written inverted-claim class (needs an engine)
#   --cases <n> (default 12) · --parallel <n> (default 4) · --no-resume
#   results are cached in the XDG cache keyed by src/ + mutations, so an
#   interrupted run resumes and a patched threshold never reuses old numbers
pnpm corpus-stats <reports dir>  # aggregate a watch home's reports; anonymous unless --named
pnpm corpus-clones <reports dir> # which releases the clone cache cannot answer, and clone them
pnpm corpus-bump-origins <dir>   # the from-version distribution SCORING.md's pin rule rests on
pnpm defaults-census <reports dir> # moved default values per class, and whether the notes name them
pnpm diagnose-coverage "o/r@tag" # which coverage route keeps a commit documented
node src/cli.ts --help
```

Node ≥ 24 executes the TypeScript directly. There is no build step, no bundler,
and no runtime npm dependency — `gh`, `git` and `claude` are subprocesses. Do
not add a dependency, a build step, or a framework.

## Module map

Full path → responsibility table: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
Entry points: `src/types.ts` (data model, read first), `src/cli.ts` (flags,
orchestration), `src/check.ts` (one release end to end, shared by the CLI and
watch mode).

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
  an `href` through the URL helpers as well; a PR body is fenced by
  `.github/scripts/pr-intake.mjs` before it reaches the job summary. No field
  is "obviously safe", and a new sink inherits the rule.
- No claim may reach `verified` because the notes agree with the commit
  message. Both come from the same hand; only the diff is evidence.
- Change scoring and you change the README's validation table. Re-measure the
  five releases listed there and update it in the same commit.
- Comment only what the code cannot say — a constraint, a workaround, a
  surprising behaviour. The existing comments are the model: they explain *why*.
- Match the surrounding style. No new abstraction layer for a single call site.
- Push policy inverts the global default here: `origin` only day to day,
  `github` only when cutting a release — see CLAUDE.md's "Pushing" section.

## Traps

- **`pnpm mutate` owns `src/` while it runs.** It patches a file, runs the
  suite, writes the original back — from the copy it read at the start. Editing
  a source file or running `pnpm test` during a mutation run therefore either
  loses the edit or fails a test against someone else's mutant. Let it finish
  (about seven minutes).
- **`pnpm sweep` owns `src/` the same way, for an hour or more.** The dial IS
  the literal in the source: a `pnpm test` during a sweep fails against the
  dial's current value, and `git add -A` commits it. Check `git diff src/`
  before staging anything while one runs. A sweep killed by SIGINT/SIGTERM
  restores itself; one lost any other way leaves the dial patched —
  `git diff src/` says so, `git checkout` fixes it.
- **A/B against the forge: measure serially, and filter warnings.** Fanning
  parallel checks at one GitHub account trips the rate limit, and a run that
  loses commit diffs to it is not a data point. Any before/after comparison drops runs whose report
  carries a load warning before it counts anything, and compares two
  `git worktree` checkouts rather than the live tree, which moves under an
  edit.
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
- **A script that prints a large result makes exactly ONE final write and no
  `process.exit` after it.** On macOS a pipe stdout is non-blocking:
  `console.log` + `process.exit` truncates at 64 KiB (test/stdout.test.ts).
  Copy the single conditional `console.log` at the end of
  `scripts/anchored-weak-census.ts`.
- **Never widen the diff beyond the task.** Adjacent problems go in the PR's
  "Out of scope" section or into a new issue.

## Definition of done

1. `pnpm check` and `pnpm test` pass.
2. A test exists that fails without the change. Verify that — do not assume it.
   A new scoring/parsing guard also gets an entry in `scripts/mutate.ts`, and
   `pnpm mutate` must report it killed. A change to matching, coverage or the
   pin join also gets `pnpm mutate-notes <reports dir>` run before and after:
   those are the stages that decide whether a fabricated note is caught, and
   the rates in `test/eval/reference-detection.json` are what says so.
3. Anything that can move a ruling has a `test/eval/golden.json` case, and
   `pnpm eval` was run before and after.
4. The PR description follows `.github/PULL_REQUEST_TEMPLATE.md`: claims as
   bullets with symbols in backticks, real pasted command output, the failing
   test named, contracts confirmed, scope stated.
5. Claims describe observable behaviour, not files touched, and every claim is
   traceable to the diff.
