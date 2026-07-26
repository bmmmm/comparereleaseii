# comparereleaseii

Fact-check release notes against the actual code diff.

## Quick start

Works with any GitHub repository or local git clone — pick a repo, pick a
release, get a verdict:

```console
$ git clone https://github.com/bmmmm/comparereleaseii && cd comparereleaseii
$ pnpm install
$ node src/cli.ts restic/restic --tag v0.19.1 --html report.html
```

Requires Node ≥ 24 and an authenticated [`gh`](https://cli.github.com). With
the [`claude`](https://code.claude.com) CLI (or `ANTHROPIC_API_KEY`) you get
LLM-judged verdicts; without either, the tool degrades gracefully to the
deterministic stages. `--estimate` previews the effort before the first run.

### Local models

Fully local judging works via any OpenAI-compatible server (Ollama, MLX,
LM Studio, vLLM) — nothing leaves your machine, and no model is hardcoded:

```console
$ node src/cli.ts owner/repo --engine openai            # auto-discovers the model
$ OPENAI_BASE_URL=http://127.0.0.1:8080/v1 node src/cli.ts owner/repo --engine openai
```

- **Zero config**: `--model` is optional — the server's `/v1/models` list is
  queried and the model picked automatically (also in the fallback path when
  neither `claude` nor an API key is available but a local server is running).
- **Calibrate YOUR model — or find your best one**: `--calibrate` runs the
  golden set against the configured judge and tells you whether it is safe as
  a sole judge — over-verification (rubber-stamping unsupported claims) is
  called out explicitly. With `--engine openai` and no `--model`, every model
  the server offers is calibrated sequentially and ranked (accuracy,
  rubber-stamp risk, speed) with a "best local judge" recommendation.
- **Escalation** (default `auto`): with a local primary judge,
  release-critical verdicts (`no_evidence`, `contradicted`, and `verified` on
  security claims) are independently reviewed by a stronger engine when one
  is available (`claude` CLI or `ANTHROPIC_API_KEY`). Disable with
  `--escalate off`, or pin engine/model via `--escalate`/`--escalate-model`.
- Small-model JSON quirks (unterminated objects, hidden thinking budgets)
  are handled by the parser and request defaults.

Reference point: a local Qwen3.5-9B scored 6/8 on the golden set — solid for
bulk verification, with escalation covering exactly its weak spot.

Release notes are claims. This tool verifies them: it takes a release, splits
the notes into atomic claims, and checks each claim against the real diff
between the release and its predecessor — plus the reverse direction: which
code changes are *not* covered by any note (silent changes).

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
4. **LLM judge** — claim + top hunks go to a model (default: Haiku via the
   `claude` CLI) which rules `verified` / `partial` / `no_evidence` /
   `contradicted`, citing concrete evidence lines. The judge may request up
   to three specific changed files once (bounded second retrieval round), and
   verdicts that would fail a release (`no_evidence`, `contradicted`) are
   confirmed by a 3-vote median. All verdicts land in an on-disk cache —
   re-runs on unchanged data are free and bit-identical.

The reverse (completeness) check flags commits whose changes no claim covers.
Two refinements keep the check honest:

- **Generated-entry detection** — auto-generated "Title by @user in #N" list
  entries whose title equals the squash commit are true by construction and
  carry only ¼ weight in the score; handwritten claims are where notes lie.
- **Surplus audit** — vague claims ("Updates and fixes") flip the question:
  the judge lists notable changes the note *hides* (new endpoints, behavior
  changes, added dependencies) and flags them.

Touched functions are extracted from unified-diff hunk headers and shown as
evidence labels (`fns: register_access, should_block_host`).

On top of the per-claim verdicts, every run computes an explainable **trust
score** (0–100) from three components:

- **correctness** — share of change claims the diff supports
- **completeness** — share of the churn (line-weighted) covered by the notes
- **risk** — 100 minus penalties from risk flags: undocumented changes in
  sensitive paths (auth/crypto, CI/build, dependency manifests), silently
  added dependencies, binary/minified/opaque blobs, install-hook changes

Contradicted claims or critical flags cap the overall score — a fake release
cannot average itself back to green. Repo context (code size, language mix,
release cadence) is shown for calibration.

With `--baseline <n>` (default 5, GitHub source) the previous releases become
an anomaly baseline: unusual release size, first-time authors on sensitive
paths, and first-ever binary artifacts are flagged relative to the repo's own
history. `--history <n>` prints the release timeline instead of a check:

```console
$ node src/cli.ts dani-garcia/vaultwarden --history 6
tag     date        commits  files  ±churn  claims  anchored  sensitive             deps+  bin
1.37.0  2026-07-24  27       90     10385   45      100%      ci,dependencies,auth  4      0
1.36.0  2026-05-03  18       54     1304    38      100%      ci,dependencies,auth  0      0
…
```

## Requirements

- Node.js ≥ 24 (runs TypeScript natively, no build step)
- [`gh`](https://cli.github.com/) (authenticated) for the GitHub source
- [`claude`](https://code.claude.com/) CLI for the default judge engine, or an
  `ANTHROPIC_API_KEY` with `--engine api`, or `--judge off` for
  deterministic-only checks

## Usage

```console
$ node src/cli.ts juanfont/headscale                                  # latest release
$ node src/cli.ts --local ~/src/myrepo --base v1.2.0 --head v1.3.0    # local clone
$ node src/cli.ts owner/repo --tag v2.0 --notes-file draft-notes.md   # check a draft
```

Options:

```
--tag <tag>         Release tag to check (default: latest release)
--base <ref>        Base tag/ref to diff against (default: previous release)
--local <path>      Use a local git repo instead of the GitHub API
--notes-file <file> Check this notes file instead of the published notes
--judge <mode>      auto | all | off   (auto: LLM only for unclear claims)
--engine <engine>   claude-cli | api | off
--model <model>     Judge model (default: haiku)
--md / --json <f>   Write markdown / JSON reports
--html <file>       Write a self-contained visual HTML report
--fail-on <what>    none | contradicted | no-evidence (default: no-evidence)
--estimate          Print a cost/effort estimate instead of judging
--no-cache          Bypass the on-disk verdict cache
```

`--estimate` answers "how expensive will this be?" before the first real run:
claims breakdown, planned LLM calls, input tokens, wall clock and API cost.
A typical release (~45 claims, 90 files) needs 10–15 Haiku calls ≈ $0.07 via
the API or 2–3 minutes via the claude CLI; cached re-runs take seconds.

Exit codes: `0` all claims supported · `1` unsupported or contradicted claims
found (CI gate) · `2` usage or data errors. Use `--fail-on contradicted` for a
lenient gate that tolerates unprovable claims (e.g. private advisories).

The `--html` report is a single file with no external assets: trust-score
ring, verdict bar, risk flags, and a treemap of the diff — tile size = changed
lines, color = documentation status, amber border = sensitive path. An
undocumented change in an auth path is one big red amber-bordered tile.

## Validated against real releases

The checker is release-note-dialect agnostic — validated against GitHub's
auto-generated PR lists, handwritten security sections, Keep-a-Changelog
files, setext/issue-anchored notes (restic) and full sha-list changelogs
(headscale):

| Release | Notes style | Score |
|---|---|---|
| headscale v0.29.2 | prose + full sha list | 96 (solid) |
| git-cliff v2.13.0 | Keep a Changelog, conventional commits | 91 (solid) |
| restic v0.19.1 | setext sections, issue anchors, cherry-picks | 90 (solid) |
| vaultwarden 1.37.0 | generated PR list + handwritten security | 79 (minor gaps) |
| vaultwarden 1.37.0, fabricated notes | — | 5 (suspicious), exit 1 |

Checking vaultwarden 1.37.0 (45 claims, 27 commits, 90 files) finds concrete
evidence for security claims whose advisories are still private:

```
✔ Send Access-Count Bypass GHSA-rxhg-2pw9-vf25
  verified (0.95) — atomic access-count check-and-increment in a single SQL
  UPDATE in register_access(); the comment states concurrent accesses could
  both pass the check and exceed the limit.
```

and honestly reports what the public diff cannot prove, while fabricated
claims are caught:

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
