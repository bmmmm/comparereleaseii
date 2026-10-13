# comparereleaseii — session rules

@AGENTS.md

AGENTS.md (imported above) is binding. This file holds only what it does not
say, or what overrides a global rule.

## Pushing — this repo inverts the global default

Finished work goes to `origin` (private forge) **only**; `github` is pushed
**only when cutting a release** — never dual-push. The real forge host never
enters a tracked file (placeholders, real values from `~/.env`); a leak-gate
block is fixed by rewording neutrally, not by a private commit variant.

## The corpus lives in the checkout, not in `$HOME`

The reports directory for `corpus-stats`, `sweep` and `mutate-notes` is
**`tmp/corpus/`** (ignored via `tmp/`). Refresh it with
`cp -Rp <watch home>/reports tmp/corpus` — `-p` keeps report mtimes, the only
record of when a report was produced. Do not measure in `~/release-watch`.

`mutate-notes` still reads diffs from the clone cache
(`$XDG_CACHE_HOME/comparereleaseii`, else `~/.cache/comparereleaseii`); that
cache stays outside the repo. User-facing docs keep saying `~/release-watch` —
`tmp/corpus/` is a development convention, not a product default.

## One report, three renderers

`printTerminal`, `toMarkdown` (`src/report.ts`) and `toHtml` (`src/html.ts`)
may differ in markup only — never in **which entries they pick, in what order,
and under which name**. Those decisions live once in `src/report.ts`
(`uncoveredInOrder`, `findingTagger`, `configSurfaceEntries`, `pinDisplayName`,
`bumpDetail`, `topLanguages`, `baselineLine`, `contextLine`); a renderer that
recomputes one is the bug.

A section added to one renderer goes into all three, or the commit says why a
format omits it. Assert against all three in one test (`test/report.test.ts`,
the "all three renderers" cases).

## Refactoring here

A refactor meant to keep behaviour proves it: check out the previous commit in
a `git worktree` and byte-compare all four outputs (`--md`, `--html`, `--json`,
terminal) for two releases with `--engine off --judge off`. `diff -q` is the
claim; a green suite is not. Break each piece you touch and check the suite
notices — removing the `safeSegment` guard in `writeReportFiles` once left
every test green.
