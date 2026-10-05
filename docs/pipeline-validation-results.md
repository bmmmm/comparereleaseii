# Three-case pipeline validation

Executed on 2026-10-05 against `0302db9`. The later plan commit `8b2b578`
has an identical `src/` tree. Production code and golden references remain
unchanged. The measured evidence loss is Zed's six-hunk selection cap;
the two reviewed behavioral claims still finish as `verified`.
The git-cliff reference remains disputed because the note names the wrong crate.

## Inputs and settings

Original published notes were fetched once with `gh release view --json
body,tagName,publishedAt`. Production `loadLocalRange` loaded each fixed
range from the clone cache, including per-commit diffs. `localRepoContext`
provided the context. This measures the clone source and a frozen production
replay; it does not measure GitHub compare-API loading or an online CLI run.

| Case | Base commit | Head commit | Commits / files |
|---|---|---|---|
| maccy | `96e65e6625cf34af1380acc6d47a55f063506623` | `dec66013b1a6865608949845e8eabd85cff3fc29` | 4 / 6 |
| zed | `00bd72e7838f4b875a913cd112b47a0ebe1ca62b` | `5cdb7ab9d9546db683132cfa78e68acec3064cac` | 5 / 9 |
| git-cliff | `988e8638432dcfc762dfec3ea470eb82aab80380` | `d2354923cdc09b4da80dc110eec15569fc2ae871` | 85 / 98 |

| Case | SHA-256 of original notes | SHA-256 of raw range diff |
|---|---|---|
| maccy | `08544ae65ea74f1ac06ed861ed1c99317b337d29726bc34cbd8c338549525d76` | `3ccf82ca3b7d545020e91ef1cb22506f41de662aef95d843a6a2f569d9604dfb` |
| zed | `66f468b88939e206cdbdc2d498bbf755056aa941c1ee03fe78f058bcc3621322` | `827951253f0db1782744361344c8cd072105d1b29e99c7b76e7af28bae86871e` |
| git-cliff | `cc5eeebc7ac8550602a6ebc9cca9e4e53ec537b5d1f4a634df1ce7aebb4024d3` | `ecde92725704ea80790df170209c7a639ef78a5a177a8c5a86168de42188bd0d` |

[Machine-readable results](pipeline-validation-results.json) also record
hashes of parsed files, commit metadata and all frozen per-commit diffs.
Raw inputs, actual prompts, responses, reports and the measurement scripts
remain in the ignored `tmp/pipeline-validation-artifacts/` directory, outside
the measurement worktrees.

Runtime: Node 26.10.0, pnpm 11.17.0, Claude Code 2.1.289. Explicit engine:
`claude-cli/claude-haiku-4-5-20251001`. Full replays use `judge=auto`,
one concurrent request, no escalation, reverse coverage enabled, and
20,000 evidence characters. Full `analyzeRelease` runs include findings;
the optional history baseline and component expansion are disabled.
The Claude CLI engine does not specify a temperature or output-token cap.
Its returned text hides input/output usage and upstream cache status, which
are therefore unavailable. No cost or speed improvement is claimed.

## Independent source review

These are fresh Codex readings of complete loaded hunk pools, recorded before
production judge answers, not human ground truth or a population benchmark.
Previous labels and model verdicts were not treated as reference evidence.

- **Maccy:** two relevant hunks. `Clipboard.swift` inserts a freshly created
  item immediately on macOS below 15; `Observables/History.swift` extracts
  that insertion and retains the later insertion only on macOS 15+.
  Both executable changes support the timing fix. The inferred reference is
  `verified`; the crash itself was not reproduced on macOS 14.
- **Zed:** five relevant hunks. `DisplaySnapshot` converts buffer rows to
  tab-map rows; `TabSnapshot` implements that conversion; two selection
  hunks carry the typed row through the caller. The added regression test
  exercises selection above and below a multi-line fold. The inferred
  reference is `verified`; the upstream test was read, not executed.
- **git-cliff:** the complete linked commit `ee8bfd19811fbdfaf31d8c595c75d00ad21611ce`
  removes `dirs = "6.0.0"`, adds `etcetera = "0.11.0"`, and replaces
  config discovery with `choose_base_strategy`. It does not remove
  `dirs_next`. `partial` describes a real migration with a wrong crate
  name; a literal `contradicted` reading is also defensible under the
  current prompt. No agreed human reference exists, so verdict agreement
  is ungraded and the existing partial-only golden label was not relaxed.

## Stage traces

- **Maccy:** all seven available source hunks are loaded. PR #1264 does not
  match a commit in the clone range, so production uses the unanchored route.
  Both reviewed hunks survive the six-hunk selection and appear in the actual
  8,485-character judge prompt. Its single target call returns `verified`.
  The saved Laya loss is not a production selection loss.
- **Zed:** PR #62063 anchors to `eb4ae4b155f61e50c2fe6d441a18f6a8d0b59041`;
  all twelve source hunks are loaded. Selection retains three of five
  reviewed hunks and drops the regression-test hunk and the caller wrapping
  `MultiBufferRow`. The actual 8,760-character prompt retains the same three:
  the first loss is selection, before prompt construction or inference.
  The target call returns `verified` without requesting more files.
  The saved Laya context truncation does not demonstrate a production
  context-limit failure.
- **git-cliff:** claim 13 anchors to the linked commit and its thirteen-hunk
  pool. The six selected hunks contain all four independently reviewed
  manifest/config changes, including the `dirs` removal and `etcetera`
  addition. Evidence selection does not hide the crate-name mismatch.
  Production returns `partial`, explicitly identifying the wrong crate name.
  One replay of the exact existing calibration prompt returns `no-evidence`
  against the existing `partial` reference. Its six hunks have identical
  content to production after trimming their trailing whitespace; the full
  changed-files list is identical. Four golden hunks omit a trailing newline.
  The fixture also uses generic repo/refs and no linked commit, whereas
  production supplies the real metadata. This bounds the failure to
  interpretation/reference ambiguity, not missing selected evidence; one
  answer per prompt cannot isolate the effect of metadata from model variation.

## Measurements

Recall requires the correct path and the entire reviewed hunk at the
selection/prompt boundary. Empty reference sets are forbidden. Removing
each reviewed hunk lowers recall; independently mutating the path and
full-hunk operands is detected. These checks ran on the real frozen inputs.

| Case | Run | Target verdict | Selected recall | Prompt recall per call | Target calls | All calls | Upstream calls | Seconds |
|---|---|---|---:|---|---:|---:|---:|---:|
| maccy | cold | verified | 1.00 | 1.00 | 1 | 4 | 4 | 62.822 |
| maccy | warm | verified | 1.00 | 1.00 | 1 | 4 | 0 | 0.040 |
| maccy | target-six | verified | 1.00 | 1.00 | 1 | 1 | 0 | 0.030 |
| maccy | target-twelve | verified | 1.00 | 1.00 | 1 | 1 | 1 | 13.582 |
| zed | cold | verified | 0.60 | 0.60 | 1 | 10 | 10 | 188.029 |
| zed | warm | verified | 0.60 | 0.60 | 1 | 10 | 0 | 0.026 |
| zed | target-six | verified | 0.60 | 0.60 | 1 | 1 | 0 | 0.019 |
| zed | target-twelve | verified | 1.00 | 1.00 | 1 | 1 | 1 | 16.700 |
| git-cliff | cold | partial | 1.00 | 1.00 | 1 | 71 | 71 | 866.023 |
| git-cliff | warm | partial | 1.00 | 1.00 | 1 | 71 | 0 | 0.135 |
| git-cliff | target-six | partial | 1.00 | 1.00 | 1 | 1 | 0 | 0.029 |
| git-cliff | target-twelve | partial | 1.00 | 1.00 | 1 | 1 | 1 | 38.130 |

`cold` means a fresh application verdict cache, not a known cold model or
provider cache. `warm` is a complete replay from that same verdict cache.
All three cold/warm report JSON files are byte-identical, and the warm runs
make zero upstream model calls. Cold/warm seconds cover frozen-input read,
`analyzeRelease`, reverse coverage
and findings; original note retrieval and input freezing are excluded.
The input-freezing times are recorded separately and include on-demand blob
fetches for the newly cached git-cliff clone, so they are not comparable
load benchmarks. The `target-*` rows cover only one claim through
`verifyClaims`; their seconds are not end-to-end release measurements.
The diagnostic variant preserves all three target verdicts and raises Zed's
selection and prompt recall from 0.60 to 1.00.

The paired target control uses isolated worktrees, identical frozen inputs,
the same explicit engine, cache identity and all settings except the hunk
limit. Baseline prompts reuse the recorded answers. A temporary one-line
`maxHunks: 6` → `12` change supplies the diagnostic variant; it is removed
after measurement. Zed's variant includes all five reviewed hunks in
9,195 evidence characters, below the unchanged character cap.

All complete replays are retained with their warnings, judge failures,
findings errors and truncation status in the result artifact. Two initial
sandbox judge runs failed before any model response and are excluded;
their fallbacks are not quality outcomes. An initial git-cliff freeze also
failed to fetch missing blobs under the sandbox; the complete freeze was
repeated with network access. The recorded lesson is to classify these
transport failures before interpreting a fallback as a model ruling.

## Proposed correction and limits

For a bounded follow-up, preserve the complete source evidence of a small
anchored commit when it fits the existing character budget. The paired
12-hunk control establishes that Zed's missing evidence fits and identifies
the six-hunk limit as its cause. It does not establish that globally raising
the limit is the best correction or that fuller evidence improves verdicts:
both reviewed behavioral claims already pass, and git-cliff is ambiguous.
The diagnostic patch is therefore not promoted to production.

No Laya integration or corpus expansion was performed. A production
retrieval change would still need a red regression test, mutation guard,
golden evaluation before/after, and the prescribed note-mutation comparison.
The judge-only `bump-release-overtakes-its-own-note` failure was not recast
as a production pin-route failure. Deterministic settlements from the full
replays remain listed separately in the result JSON: twelve informational
git-cliff claims are skipped; none of these three releases settles a bump
claim through the pin route.

## Changed, verified, unverified

Changed: this comparison and the plan's execution status. Production code,
public contracts, defaults and golden labels are unchanged.

Verified: frozen refs and input hashes; complete available source pools;
actual selection and prompt boundaries; final target responses; cold/warm
application-cache behavior; the paired hunk-limit diagnosis.
`pnpm check` and all 567 tests pass with the diagnostic patch removed.
The command-scoped `--config.verify-deps-before-run=false` reuses existing
dependencies in the isolated worktree without a global configuration edit.

Unverified: human verdict accuracy, the git-cliff reference, upstream crash
reproduction, input/output token usage, model/provider cache temperature,
online forge-loading latency, production benefit of the proposed correction,
and cost or speed improvements.
