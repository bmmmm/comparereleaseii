# Field cases

One row per external "the tool missed X" — an issue, a reader's mail, a probe
against a release someone else cared about. The row is written **before** the
fix, from a real deterministic run (`--engine off --judge off --baseline 0`,
the release's own compare range as `--base`), and the hunk that carries the
miss becomes `test/fixtures/field/<repo>-<tag>-<slug>.patch` with a
`FIELD_CASES` entry in `test/detection.test.ts` the same day. The recipe is in
[CONTRIBUTING.md](../CONTRIBUTING.md#recording-a-field-case).

A row is closed by the phase that makes the "after" line true; a documented
miss stays a row with its decision and the numbers behind it.

| Source | Release (base) | The change | What the tool said (before) | What it should have said | Closed by | After |
|---|---|---|---|---|---|---|
| openai/codex#48195 (2026-10-13) | rust-v0.157.0 (rust-v0.156.0) | `default_enabled: false → true` for `daemon_auto_start`, `Experimental → Stable`, in `codex-rs/features/src/lib.rs` (PR #47179, 2.4k chars) | Claim "Enabled automatic background-server startup…" `partial` (subject restatement); findings pass read 7 of 1091 files — `codex-rs/` was one subsystem of 1083, its 20k read went to `gateway_auth_login_tests.rs` — no finding named the daemon. Surface: nothing (the key delta cancelled the line as a move). | A default flipped and no note names the key; the findings pass must read the 2.4k hunk. | 61cee87 (surface), b0bdfe1 (reserved read, tests last, container split) | `defaults changed: ⚠ daemon_auto_start false→true` in all three renderers; the plan reads 13 files from 56 subsystems with `codex-rs/features/src/lib.rs` in the reserved `(defaults)` read; Haiku on that read: "[breaking/user] daemon_auto_start wechselt von Stage::Experimental (default_enabled: false) auf Stage::Stable mit default_enabled: true". |
| probe, same day | opencloud-eu/opencloud v6.0.0 (v5.2.0) — **not** v7.0.0: the corpus report's base v4.0.7 is no ancestor of v7.0.0 (`pickBaseRelease` picks by publish date; a 4.x backport was published last), and commit dea306247 "Do not remove stopwords by default" shipped in v6.0.0 | `CleanStopWords: true → false`, `BatchSize: 500 → 50` in `services/search/pkg/config/defaults/defaultconfig.go` | 78 claims (v7.0.0) / 126 (v6.0.0), none mention it; the surface showed nothing; the findings pass read `vendor/` first in every OpenCloud release with findings. | Two defaults moved, neither named. | 61cee87, b0bdfe1 | `⚠ CleanStopWords true→false, ⚠ BatchSize 500→50` (plus `introductionVersion "%%NEXT%%"→"6.0.0" ×4`, true and noisy); uncovered commit line `fns DefaultConfig · ±default CleanStopWords true→false`; `vendor` never read; Haiku on the reserved read: "[breaking/operator] Die Search-Defaults ändern sich: CleanStopWords … true auf false, BatchSize … 500 auf 50". |
| probe, same day | zed-industries/zed v1.11.3 (v1.10.3) | `message_editor.auto_replace_emoji_shortcode: true` removed from `assets/settings/default.json` (PR #60260) | 93 claims; the commit was listed as uncovered, but its surface line said nothing — `.json` was outside `configKeys`. | `−key auto_replace_emoji_shortcode` on the surface and on the uncovered commit. | 61cee87 | Surface `−key auto_replace_emoji_shortcode, −key message_editor`; uncovered line `… · −key auto_replace_emoji_shortcode · −key message_editor`. No value moved, so no `defaults` entry — correct. |
| probe, same day | GyulyVGC/sniffnet v1.4.2 (v1.4.1) | `.promisc(true) → .promisc(false)` inside the pause/resume commit 85344cad, `src/networking/types/capture_context.rs` | 21 claims, none mention promiscuous mode; the commit is covered by the pause/resume note, so nothing flags it. | Debatable: the capture no longer sees traffic the host does not receive. | **documented miss** — class C (a setter's argument) is off by decision | `pnpm defaults-census tmp/corpus` 2026-10-13: 96 toggles over 123 releases, 88 unnamed, nearly all layout widths (`with_width 40→80`), i18n keys (`t("showHide")`) and UI labels; `.promisc` is one real change among them, and no key owns the value for a note to name. The fixture asserts `defaults: []` so the day the decision changes, the test says so. |

## Numbers the decisions rest on

`pnpm defaults-census tmp/corpus`, 123 releases, 23 s (2026-10-13, after the
review fixes — settings-shaped JSON by basename or parent directory only,
`.schema.json`/`tsconfig` and dot-directories out, `docs/`/`examples/` out,
bare-word values in source must spell a constant, a note names a key only as
a whole token):

| Class | Changes | Unnamed in notes | Releases with ≥1 |
|---|---:|---:|---:|
| `config` | 50 | 42 (84 %) | 26 of 123 |
| `source` | 34 | 25 (74 %) | 12 of 123 |
| `toggle` (not shipped) | 96 | 88 (92 %) | 31 of 123 |

Nine of the `config` rows are traefik's `integration/gateway-api-conformance-reports/*.yaml`
(three releases × three), kept on purpose: excluding `integration/` as a test
path had hidden product modules' hosts (`src/integration/slack.ts`) — review
finding, reverted.

The findings plan over the same corpus (clone cache, no judge; what
`planFindings` + `capHunks` would hand the model), before 0b9acba → after
the review fixes (reserved read takes whole files only, path arm obeys the
extractor's eligibility):

| | Before | After |
|---|---:|---:|
| Changed files the pass reads | 1805 of 27793 (6.49 %) | 2134 (7.68 %) |
| `vendor` the first subsystem read | 12 releases | 0 |
| Vendored files read | 41 | 0 |
| Releases with one subsystem holding ≥ 80 % of ≥ 50 files | 8 | 3 |
| Test chars among what is read | 10.6 % | 10.2 % |

Test *files* read rose 128 → 194: a subsystem's small tests now fit after its
source instead of one large test eating the 20k slot.

## Found on the way, not touched here

- The corpus report for OpenCloud v7.0.0 has base v4.0.7, which is not an
  ancestor of v7.0.0 (`pickBaseRelease`, `src/sources/github.ts`).
- Codex's bot changelog format `- #N Title @user` is not recognised by
  `isGeneratedEntry` (`src/verify.ts`), so every Codex release scores
  correctness ≈ 50 regardless of content.
- The `claude -p` engine runs in a temp dir but inherits `~/.claude/CLAUDE.md`:
  the Haiku findings above came back in the operator's language.
- A `RiskFlag` for an undocumented default would move scores and the README
  table; the informational line ships first, a corpus sweep decides later.
- The Markdown report wraps diff values in backticks without escaping a
  backtick inside them — the same practice every other surface value and
  the uncovered-commit line follow; HTML and terminal escape. A value such
  as `"a`b"` ends the code span early (review finding, pre-existing shape).
- `capHunks`/`truncate` (`src/verify.ts`) append a ~25-char marker past the
  cap, so `usedChars` exceeds the budget by that much in ~22 corpus
  releases. Pre-existing; "the cap holds" means no extra file is read.
- Several noise filters in the extractor (`NAME_NOISE`, `CONSTANT_LIKE`,
  `TOOLING_JSON`, the lock/snapshot/translation exclusions) carry a measured
  reduction but no mutant of their own; the census is their check.
