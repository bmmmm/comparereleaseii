# comparereleaseii

Fact-check release notes against the actual code diff.

Release notes are claims. This tool takes a release, splits the notes into
atomic claims, and checks each claim against the real diff between the
release and its predecessor — plus the reverse direction: which code changes
are *not* covered by any note (silent changes).

## Quick start

Works with any GitHub repository or local git clone — pick a repo, pick a
release, get a verdict:

```console
$ pnpm dlx comparereleaseii restic/restic --tag v0.19.1 --html report.html
```

(`npx comparereleaseii` works too. For hacking on the source, clone the repo
and run `node src/cli.ts` — no build step, see [Development](#development).)

Requirements: Node ≥ 24, an authenticated [`gh`](https://cli.github.com), and
a judge — the [`claude`](https://code.claude.com) CLI (default), an
`ANTHROPIC_API_KEY`, or any OpenAI-compatible server
([local models](docs/local-models.md)). Without one, the tool degrades
gracefully to the deterministic stages. `--estimate` previews claims, LLM
calls, tokens and cost before the first run — a typical release (~45 claims,
90 files) needs 10–15 Haiku calls ≈ $0.07; cached re-runs take seconds.

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
   median; all verdicts land in an on-disk cache — re-runs on unchanged data
   are free and bit-identical.

The reverse (completeness) check flags commits whose changes no claim covers.
Two refinements keep the check honest: auto-generated "Title by @user in #N"
entries are true by construction and carry only ¼ weight — handwritten claims
are where notes lie; and vague claims ("Updates and fixes") flip the
question — the judge lists notable changes the note *hides* and flags them.

`--suggest` turns the completeness check into a starting point: for the
highest-churn undocumented commits, the judge drafts a release-note line from
that commit's actual diff. See
[docs/writing-release-notes.md](docs/writing-release-notes.md) for how to
write notes that don't need this in the first place — and hand the same
rules to an LLM coding agent so it holds itself to them from the start:

```console
$ comparerelease guidelines >> AGENTS.md
```

Every run computes an explainable **trust score** (0–100, exact semantics in
[SCORING.md](SCORING.md)) from three components:

- **correctness** — share of change claims the diff supports
- **completeness** — share of the churn (line-weighted) covered by the notes
- **risk** — 100 minus penalties from risk flags: undocumented changes in
  sensitive paths (auth/crypto, CI/build, dependency manifests), silently
  added dependencies, binary/minified/opaque blobs, install-hook changes

Contradicted claims or critical flags cap the overall score — a fake release
cannot average itself back to green.

With `--baseline <n>` (default 5) the previous releases become an anomaly
baseline: unusual release size, first-time authors on sensitive paths and
first-ever binary artifacts are flagged relative to the repo's own history.
`--history <n>` prints the release timeline instead of a check.

## Usage

```console
$ node src/cli.ts juanfont/headscale                                  # latest release
$ node src/cli.ts --local ~/src/myrepo --base v1.2.0 --head v1.3.0    # local clone
$ node src/cli.ts owner/repo --tag v2.0 --notes-file draft-notes.md   # check a draft
```

`--help` lists all options. Reports: `--md` / `--json` / `--html` — the HTML
report is a single file with no external assets: trust-score ring, verdict
bar, risk flags, and a treemap of the diff (tile size = changed lines, color
= documentation status, amber border = sensitive path — an undocumented
change in an auth path is one big red amber-bordered tile).

Exit codes: `0` all claims supported · `1` unsupported or contradicted claims
found (CI gate) · `2` usage or data errors. Use `--fail-on contradicted` for a
lenient gate that tolerates unprovable claims (e.g. private advisories).

## Judges: local models, calibration, escalation

Any OpenAI-compatible server (Ollama, MLX, LM Studio, vLLM) works as judge —
nothing leaves your machine, no model is hardcoded, `--model` is
auto-discovered from `/v1/models`. `--calibrate` measures any candidate judge
against a 20-case golden set (rubber-stamping is called out explicitly) and
can rank every model your server offers; `--escalate auto` sends
release-critical verdicts from a local judge to a stronger engine when one is
available. Hosted aggregators (OpenRouter) work through the same engine.
Details, calibration numbers and quirks: [docs/local-models.md](docs/local-models.md).

## Run it continuously

**On your machine — the release watchdog.** Watch the repos *you* depend on:
`watch init` builds the list interactively from what your GitHub account
already follows (watched repos, stars, release notifications), `watch add
owner/repo` extends it, and `comparerelease watch --config watch.json` runs
from cron/launchd — every new release is fact-checked the moment it appears,
no new releases is a cheap no-op, per-repo state means nothing is checked or
alerted twice, and `reports/index.html` is a dashboard with red rows for
flagged releases. `--notify <cmd>` pipes every flagged release to your
alerting command (ntfy, mail, webhook). Judge setup, config format, self-test
recipe, cron/launchd snippets and a scheduled-CI variant for machines that
aren't always on: [docs/watchdog.md](docs/watchdog.md).

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
      - uses: bmmmm/comparereleaseii@v0.1.0
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

This runs *after* publishing — it cannot block a bad release, but it flags it
where everyone looks: `comment: true` appends the verdict to the release body
(needs `contents: write`). To gate *before* publishing, check the draft with
`notes-file` in a PR workflow. Inputs mirror the CLI (`repo`, `tag`, `base`,
`engine`, `model`, `fail-on`, `notes-file`); outputs are `score` and
`exit-code`. With `engine: "off"` the deterministic stages run without any
API key. Checked releases can carry the badge:

```markdown
[![release notes: checked](https://img.shields.io/badge/release_notes-checked-2da44e)](https://github.com/OWNER/REPO/actions/workflows/check-release-notes.yml)
```

## Tested against release notes we admire

The test material is real changelogs from mature, well-run projects with
genuinely different release-note styles — GitHub's auto-generated PR lists,
handwritten security sections, Keep-a-Changelog files, setext/issue-anchored
notes (restic), full sha-list changelogs (headscale). If the checker holds up
across that spread, it'll hold up on yours:

| Release | Notes style | Score |
|---|---|---|
| headscale v0.29.2 | prose + full sha list | 96 (solid) |
| git-cliff v2.13.0 | Keep a Changelog, conventional commits | 91 (solid) |
| restic v0.19.1 | setext sections, issue anchors, cherry-picks | 90 (solid) |
| vaultwarden 1.37.0 | generated PR list + handwritten security | 79 (flags a few unprovable claims) |
| vaultwarden 1.37.0, fabricated notes | — | 5 (suspicious), exit 1 |

Checking vaultwarden 1.37.0 (45 claims, 27 commits, 90 files) shows the kind
of value the checker adds: backing a terse security advisory with the actual
mechanism from the diff —

```
✔ Send Access-Count Bypass GHSA-rxhg-2pw9-vf25
  verified (0.95) — atomic access-count check-and-increment in a single SQL
  UPDATE in register_access(); the comment states concurrent accesses could
  both pass the check and exceed the limit.
```

— while staying honest about what the diff can't prove, and catching a
fabricated claim in the same run:

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
the judge runs where it always runs for us: locally. Bump `package.json`,
write the version's [CHANGELOG.md](CHANGELOG.md) section, then:

```console
$ pnpm dogfood                    # our notes checked by our own checker — < 90 blocks
$ node src/cli.ts --calibrate     # judge drift check against the golden set
$ pnpm publish                    # prepublishOnly runs check+test, prepack builds dist/
$ git tag v0.1.0 && git push origin main --tags && git push github main --tags
```

## Contributing

Bug reports, dialects that misparse and wrong verdicts are all welcome — the
[issue forms](https://github.com/bmmmm/comparereleaseii/issues/new/choose) ask
for the evidence each kind needs, and a wrong-verdict report that carries a
`test/eval/golden.json` entry arrives as a ready-made regression test.

[CONTRIBUTING.md](CONTRIBUTING.md) covers the workflow and the stable contracts;
[AGENTS.md](AGENTS.md) is the condensed version for coding agents. Pull requests
state their claims and let this tool check them against their own diff.

## Support

If this tool is useful to you, you can support development at
[ko-fi.com/bmabma](https://ko-fi.com/bmabma).

## License

GPL-3.0-or-later — see [LICENSE](LICENSE).
