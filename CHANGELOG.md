# Changelog

All notable changes to comparereleaseii are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com); every release of this
tool is checked with the tool itself before it ships.

## 0.1.0 — 2026-07-26

Initial release.

### Added

- Claim extraction: release notes are split into atomic claims by
  `parseClaims`, with detection of auto-generated "Title by @user in #N" list
  entries so handwritten claims carry the weight in scoring.
- Deterministic verification ladder in `verifyClaims`: PR/commit anchors are
  resolved against the release range, code identifiers from each claim are
  grepped in the changed lines, and a tf-idf hunk ranking selects the evidence
  worth judging.
- LLM judge with pluggable engines in `selectEngine`: the `claude` CLI, the
  Anthropic API, and any OpenAI-compatible server (`--engine openai`) with
  automatic model discovery via `discoverLocalModels`; release-critical
  verdicts from a local model are reviewed by a stronger escalation engine.
- On-disk verdict cache (`withVerdictCache`) — re-runs on unchanged data are
  free and deterministic.
- Explainable trust score in `computeMetrics`: correctness, completeness and
  risk components with caps, plus risk flags for undocumented changes in
  sensitive paths, silently added dependencies, binary blobs and install-hook
  changes.
- Reverse completeness check (`computeCoverage`) flagging commits whose
  changes no claim covers, and a surplus audit that asks what vague claims
  hide.
- Release-history baseline (`--baseline`, `buildSnapshots`) for anomaly
  detection and a `--history` timeline view.
- Cost preview with `--estimate` before the first judged run.
- Judge calibration with `--calibrate` (`runCalibration`) against the golden
  set in `test/eval/golden.json`, including ranking multiple models to find
  the best local judge.
- Reports: terminal output, `--md` markdown, `--json`, and a self-contained
  `--html` report (`toHtml`) with trust-score ring and diff treemap.
- Sources: GitHub releases via `gh` (`loadGithubRelease`) and local git
  clones via `--local` (`loadLocalRelease`), including draft notes through
  `--notes-file`; a repo's first release is diffed against the full history.
- CI gate behavior: exit code 0/1/2 with `--fail-on none | contradicted |
  no-evidence`.
- Distribution: a `comparerelease` bin launcher, a compiled `dist/` build for
  the npm package, and a composite GitHub Action (`action.yml`) that writes
  the report to the step summary and uploads the HTML report as an artifact.
- Watch mode (`comparerelease watch`, `runWatch`): continuous release
  monitoring from a JSON config — a state file remembers the last checked
  release per repo, new releases are checked and written to
  `reports/<repo>/<tag>`, `reports/index.html` is regenerated as a dashboard
  (`toWatchIndexHtml`), `--notify` runs an alert command exactly once per
  flagged release, and the exit code is the worst of the batch.
- SCORING.md freezes the trust-score semantics: component formulas, weights,
  flag severities and hard caps, linked from the README and the HTML report
  footer.
- The golden set (`test/eval/golden.json`) covers 20 cases including
  lockfile, install-hook, typosquat, revert and need-protocol shapes; a
  monthly `eval.yml` workflow recalibrates the default judge and fails on
  over-verification.
