# comparereleaseii

Fact-check release notes against the actual code diff.

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
   `contradicted`, citing concrete evidence lines.

The reverse (completeness) check flags commits whose changes no claim covers.

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

## Requirements

- Node.js ≥ 24 (runs TypeScript natively, no build step)
- [`gh`](https://cli.github.com/) (authenticated) for the GitHub source
- [`claude`](https://code.claude.com/) CLI for the default judge engine, or an
  `ANTHROPIC_API_KEY` with `--engine api`, or `--judge off` for
  deterministic-only checks

## Usage

```console
$ node src/cli.ts dani-garcia/vaultwarden --tag 1.37.0
$ node src/cli.ts --local ~/src/myrepo --base v1.2.0 --head v1.3.0
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
```

Exit codes: `0` all claims supported · `1` unsupported or contradicted claims
found (CI gate) · `2` usage or data errors. Use `--fail-on contradicted` for a
lenient gate that tolerates unprovable claims (e.g. private advisories).

The `--html` report is a single file with no external assets: trust-score
ring, verdict bar, risk flags, and a treemap of the diff — tile size = changed
lines, color = documentation status, amber border = sensitive path. An
undocumented change in an auth path is one big red amber-bordered tile.

## Example

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
```

No runtime dependencies; `gh`, `git` and `claude` are called as subprocesses.

## License

GPL-3.0-or-later — see [LICENSE](LICENSE).
