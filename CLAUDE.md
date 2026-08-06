# comparereleaseii — session rules

[AGENTS.md](AGENTS.md) is binding and is **not** loaded automatically — read it
before the first edit. It carries the commands, the module map, the traps, and
the definition of done. Start any code question at `src/types.ts`.

This file holds only what AGENTS.md does not say, or what overrides a global rule.

## Pushing — this repo inverts the global default

The global rule is "finished, tested work gets pushed". Here that means `origin`
(the private forge) **only**. The `github` remote is a record of releases, not a
feed of work: push it **only when cutting a release**. Never dual-push a
day-to-day commit, and never let the pre-push leak gate be what stops you — it
is a backstop, not a licence.

The real forge host never enters a tracked file (placeholders only, real values
from `~/.env`). A leak-gate block is solved by rewording neutrally, never by a
private variant of the commit.

## The corpus lives in the checkout, not in `$HOME`

`corpus-stats`, `sweep` and `mutate-notes` take a reports directory, and
AGENTS.md makes a run against one part of the definition of done for any change
to matching, coverage or the pin join. That directory is **`tmp/corpus/`**,
inside this repo and covered by the existing `tmp/` ignore rule — refresh it
from a watch home with `cp -R <watch home>/reports tmp/corpus` and then stay in
the checkout. A session that reaches into `~/release-watch` to measure has left
the working folder for no reason; the numbers are identical either way.

One thing the checkout cannot hold: `mutate-notes` rebuilds notes from the
stored reports but reads the **diffs from the clone cache**
(`$XDG_CACHE_HOME/comparereleaseii`, else `~/.cache/comparereleaseii`). That
cache stays where it is — it is derived data, it is large, and a clone of
someone else's repository has no business inside this one. So `tmp/corpus`
makes the corpus repo-local; it does not make the harness self-contained.

What does *not* change is the user-facing documentation. `~/release-watch` is
the right answer in README.md and `docs/` because that is where `watch setup`
puts a real operator's watch home. `tmp/corpus/` is a development convention,
not a product default — do not rewrite the docs to match it.

## One report, three renderers

`printTerminal`, `toMarkdown` (`src/report.ts`) and `toHtml` (`src/html.ts`)
render the same `Report` in three formats. What may differ is markup; what must
not is **which entries they pick, in what order, and under which name**. Those
decisions live once in `src/report.ts` (`uncoveredInOrder`, `findingTagger`,
`configSurfaceEntries`, `pinDisplayName`, `bumpDetail`, `topLanguages`,
`baselineLine`, `contextLine`) — a renderer that recomputes one of them is the
bug, not a style choice.

Adding a section to one renderer means adding it to all three, or stating in the
commit why a format legitimately omits it. This is not cosmetic: the Markdown
report silently lacked the baseline and the repo context for a while, and that
is the artifact `watch` writes to disk and a reader pastes into an issue. Guard
it the way the existing tests do — assert against all three renderers in one
test (`test/report.test.ts`, the "all three renderers" cases).

## Refactoring here

A refactor that is not meant to change behaviour proves it: check out the
previous commit in a `git worktree` and byte-compare all four outputs
(`--md`, `--html`, `--json`, terminal) for two releases with `--engine off
--judge off`. `diff -q` on identical files is the claim; a passing test suite
is not.

While you are in a function, break each piece you touch and check the suite
notices. Six untested paths surfaced that way in one cleanup round, including
the `safeSegment` path-traversal guard in `writeReportFiles` — removing it left
all 458 tests green.
