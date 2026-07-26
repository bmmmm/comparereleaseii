# comparereleaseii

[![tests](https://github.com/bmmmm/comparereleaseii/actions/workflows/ci.yml/badge.svg)](https://github.com/bmmmm/comparereleaseii/actions/workflows/ci.yml)
[![release notes: checked](https://github.com/bmmmm/comparereleaseii/actions/workflows/check-release-notes.yml/badge.svg)](https://github.com/bmmmm/comparereleaseii/actions/workflows/check-release-notes.yml)

Fact-check release notes against the actual code diff.

Release notes are claims. This tool takes a release, splits the notes into
atomic claims, and checks each claim against the real diff between the
release and its predecessor — plus the reverse direction: which code changes
are *not* covered by any note (silent changes).

## Quick start

Works with any GitHub repository or local git clone — pick a repo, pick a
release, get a verdict:

```console
$ gh extension install bmmmm/gh-comparereleaseii
$ gh comparereleaseii restic/restic --tag v0.19.1 --html report.html
19 claims parsed from the notes of v0.19.1; verifying against 38 commits…

comparereleaseii — release-note fact check
restic/restic  v0.19.0 → v0.19.1  (38 commits, 50 files, +826/−113)
judge engine: claude-cli/haiku
…
Summary: 19 claims — 9 verified, 0 partial, 0 no-evidence, 0 contradicted, 10 skipped
Trust score: 90/100 (solid) — correctness 100 · completeness 72 · risk 90

Risk flags:
  ! Undocumented changes in dependencies paths
    go.mod, go.sum
HTML report written to report.html
```

Three ways to run it, the same CLI behind all of them:

- **`gh` extension** (above) — a SHA-pinned wrapper that follows releases via
  `gh extension upgrade`; nothing on your machine tracks a moving branch.
- **Source checkout** — `gh repo clone bmmmm/comparereleaseii`, then
  `node src/cli.ts …`. No install, no build step: Node ≥ 24 runs the
  TypeScript directly and there are no runtime dependencies. For cron jobs and
  scripts, put the short name on your `PATH` from inside the checkout:
  `ln -s "$PWD/bin/comparerelease.mjs" ~/.local/bin/comparerelease`.
- **CI** — the repo doubles as a [GitHub Action](#run-it-continuously):
  `uses: bmmmm/comparereleaseii@v0.1.1`, nothing to clone.

Requirements: Node ≥ 24, a judge, and an authenticated
[`gh`](https://cli.github.com) for GitHub repos — `--local` reads a clone from
disk with plain `git` and never calls `gh`. As judge: the
[`claude`](https://code.claude.com) CLI (default), an `ANTHROPIC_API_KEY`, or
any OpenAI-compatible server ([local models](docs/local-models.md)); without
one, the tool degrades gracefully to the deterministic stages.

`--estimate` previews claims, LLM calls, tokens and cost before the first run:
the restic release above costs ~3 Haiku calls ≈ $0.01, a big one (vaultwarden
1.37.0 — 45 claims across 90 files) ~13 calls ≈ $0.07. Re-runs hit the verdict
cache and take seconds.

## How it works

Each claim runs through an escalation ladder — cheap deterministic checks
first, an LLM judge only for what remains unclear:

1. **Anchors** — PR numbers, commit SHAs referenced in the claim are resolved
   against the commits in the release range.
2. **Lexical** — code identifiers extracted from the claim (`code spans`,
   `SCREAMING_CASE`, camelCase, file names, deep versions) are grepped in the
   changed lines of the diff.
3. **Ranking** — the diff's hunks are ranked against the claim (tiny tf-idf +
   path boost) to select the evidence worth judging.
4. **LLM judge** — claim + top hunks go to a model which rules `verified` /
   `partial` / `no-evidence` / `contradicted`, citing concrete evidence
   lines. Verdicts that would fail a release are confirmed by a 3-vote
   median; all verdicts land in an on-disk cache
   (`$XDG_CACHE_HOME/comparereleaseii`, else `~/.cache/comparereleaseii`,
   mode 0700, keyed by tool version) — re-runs on unchanged data are free and
   bit-identical. `--no-cache` skips it.

The reverse (completeness) check flags commits whose changes no claim
covers — auto-generated `Title by @user in #N` entries carry only ¼ weight
(handwritten claims are where notes lie), and vague claims ("Updates and
fixes") flip the question: the judge lists what the note *hides*.

Every run computes an explainable **trust score** (0–100) from correctness,
completeness and risk. Contradicted claims or critical flags cap it — a fake
release cannot average itself back to green. With `--baseline <n>` the
repo's own release history becomes an anomaly baseline (unusual size,
first-time authors on sensitive paths, first-ever binaries). Exact
formulas, weights and flag severities: [SCORING.md](SCORING.md).

Writing notes instead of checking them? `--suggest` drafts a line for each
high-churn undocumented commit from its actual diff, and
`gh comparereleaseii guidelines >> AGENTS.md` hands the writing rules to your
coding agent — see
[docs/writing-release-notes.md](docs/writing-release-notes.md).

## Usage

The examples use the extension's name; from a source checkout every one of
them reads `node src/cli.ts …`, and via the `PATH` symlink above
`comparerelease …` — same arguments, same output.

```console
$ gh comparereleaseii juanfont/headscale                                # latest release
$ gh comparereleaseii --local ~/src/myrepo --base v1.2.0 --head v1.3.0  # local clone
$ gh comparereleaseii owner/repo --tag v2.0 --notes-file draft.md       # check a draft
```

`--help` lists all options. Reports: `--md` / `--json` / `--html` — the HTML
report is a single file with no external assets: trust-score ring, verdict
bar, risk flags, and a treemap of the diff (tile size = changed lines, color
= documentation status, amber border = sensitive path — an undocumented
change in an auth path is one big red amber-bordered tile).

Exit codes: `0` all claims supported · `1` unsupported or contradicted claims
found (CI gate) · `2` usage or data errors. Use `--fail-on contradicted` for a
lenient gate that tolerates unprovable claims (e.g. private advisories).

Not every release *can* be checked here: a docs-only bump, a changelog mirror
of a closed-source product, a fork whose notes describe upstream code. Those
are labelled **unverified** instead of collapsing into a wall of unsupported
claims, and `--fail-on no-evidence` does not fail the build on them — the
report says "unknown", not "fine". How that is decided, and why it takes the
repo's own release history to claim it:
[SCORING.md](SCORING.md#unverified--releases-that-cannot-be-checked-in-this-repo).

## Judges: local models, calibration, escalation

Any OpenAI-compatible server (Ollama, MLX, LM Studio, vLLM) works as judge —
nothing leaves your machine, no model is hardcoded, `--model` is
auto-discovered from `/v1/models`. `--calibrate` measures any candidate judge
against a 25-case golden set (rubber-stamping and prompt injection are called
out explicitly) and can rank every model your server offers; `--escalate auto`
sends release-critical verdicts from a local judge to a stronger engine when
one is available. Hosted aggregators (OpenRouter) work through the same engine.
Details, calibration numbers and quirks: [docs/local-models.md](docs/local-models.md).

## Run it continuously

**On your machine — the release watchdog.** `watch init` builds the repo
list from what your GitHub account already follows (watched, starred,
release notifications), then `comparerelease watch --config watch.json`
runs from cron/launchd: every new release is fact-checked the moment it
appears, per-repo state keeps re-runs cheap and alerts single-shot,
`reports/index.html` is the dashboard, and `--notify <cmd>` pipes flagged
releases to ntfy/mail/webhook. Config format, judge setup, cron/launchd
snippets and a scheduled-CI variant: [docs/watchdog.md](docs/watchdog.md).

**In CI — the GitHub Action.** The repo doubles as a composite action that
checks a release's notes, writes the report to the step summary, uploads the
HTML report as an artifact, and fails the job by the CLI's exit code:

```yaml
name: check-release-notes
on:
  release:
    types: [published]
permissions:
  contents: read
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: bmmmm/comparereleaseii@v0.1.1
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

Inputs mirror the CLI — full list in [action.yml](action.yml). `comment:
true` appends the verdict to the release body, `notes-file` gates a draft
in a PR workflow *before* publishing, and `engine: "off"` runs keyless
(deterministic stages only — exactly how this repo checks its own
releases). Checked releases can carry the badge:

```markdown
[![release notes: checked](https://github.com/OWNER/REPO/actions/workflows/check-release-notes.yml/badge.svg)](https://github.com/OWNER/REPO/actions/workflows/check-release-notes.yml)
```

## Tested against release notes we admire

The test material is real changelogs from mature, well-run projects with
genuinely different release-note styles — GitHub's auto-generated PR lists,
handwritten security sections, Keep-a-Changelog files, setext/issue-anchored
notes (restic), full sha-list changelogs (headscale). If the checker holds up
across that spread, it'll hold up on yours:

| Release | Notes style | Score (validation run, 2026-07) |
|---|---|---|
| headscale v0.29.2 | prose + full sha list | 96 (solid) |
| git-cliff v2.13.0 | Keep a Changelog, conventional commits | 91 (solid) |
| restic v0.19.1 | setext sections, issue anchors, cherry-picks | 90 (solid) |
| vaultwarden 1.37.0 | generated PR list + handwritten security | 79 (flags a few unprovable claims) |
| negative control: our own fabricated notes on the vaultwarden 1.37.0 diff | — | 5 (suspicious), exit 1 |

One verdict from the vaultwarden run shows the point — a fabricated claim,
caught against the actual diff:

```
✘ The icon endpoint was removed entirely in this release
  contradicted (0.90) — routes() still registers icon_internal and
  icon_external; the diff shows refactoring, the endpoints remain active.
```

## Development

```console
$ pnpm install
$ pnpm check   # tsc --noEmit
$ pnpm test    # node:test unit tests
$ pnpm eval    # judge eval against the golden set (needs an engine)
```

No runtime dependencies; `gh`, `git` and `claude` are called as subprocesses.

Releasing happens from a dev machine — no repo secrets, no CI involvement,
the judge runs where it always runs for us: locally. Bump `package.json`
(`pnpm test` then names every recipe still pinning the old tag), write the
version's [CHANGELOG.md](CHANGELOG.md) section, then:

```console
$ pnpm dogfood                    # our notes checked by our own checker — < 90 blocks
$ node src/cli.ts --calibrate     # judge drift check against the golden set
$ git tag vX.Y.Z && git push origin main --tags && git push github main --tags
$ gh release create vX.Y.Z --notes-file <notes>   # check-release-notes.yml re-checks it
$ gh workflow run bump-pin.yml --repo bmmmm/gh-comparereleaseii   # pin now, not tomorrow
```

There is no npm publish — the tag *is* the distribution: a clone and the
Action both run `src/` directly on Node ≥ 24. The extension's `tool.pin`
follows the latest release on its own daily schedule; the dispatch above only
closes the window between publishing and that run, in which
`gh extension install` still hands new users the previous version.

## Contributing

Bug reports, dialects that misparse and wrong verdicts are all welcome — the
[issue forms](https://github.com/bmmmm/comparereleaseii/issues/new/choose) ask
for the evidence each kind needs, and a wrong-verdict report that carries a
`test/eval/golden.json` entry arrives as a ready-made regression test.

[CONTRIBUTING.md](CONTRIBUTING.md) covers the workflow and the stable contracts;
[AGENTS.md](AGENTS.md) is the condensed version for coding agents. Pull requests
state their claims and let this tool check them against their own diff.
Vulnerabilities go through [SECURITY.md](SECURITY.md), not the issue tracker.

## Support

If this tool is useful to you, you can support development at
[ko-fi.com/bmabma](https://ko-fi.com/bmabma).

## License

GPL-3.0-or-later — see [LICENSE](LICENSE).
