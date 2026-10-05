# Pipeline validation plan

Status: executed on 2026-10-05; see the
[three-case comparison](pipeline-validation-results.md). Production code
remains unchanged; the git-cliff reference and benefit of a production
correction remain unresolved.
Baseline: `0302db9` (`fix(judge): keep Laya out of text judge routing`).

## Objective

Trace three existing cases through the production pipeline and identify the
first demonstrated cause of an incorrect verdict or missing evidence.
The routing change excludes Laya from text-judge selection; it does not
establish better verdict accuracy or lower end-to-end cost.

## Cases

| Case | Question to resolve |
|---|---|
| Maccy 2.6.1: copying crash on macOS 14 | Do both relevant hunks, in `Clipboard.swift` and `Observables/History.swift`, reach the production judge, and does its final verdict agree with independently reviewed evidence? |
| Zed v1.13.2: tab-expanded selection panic | Where is evidence lost: loading, selection, prompt construction, or the model context limit? The existing Laya lab run was context-truncated; that does not establish a production failure. |
| git-cliff v2.13.0, claim 13: replace `dirs_next` with `etcetera` | Does the repeated golden-set mismatch come from the reference label, selected evidence, or judge interpretation? Review the claim's `dirs_next` wording against the diff's `dirs` removal before assuming the judge is wrong. |

The other repeated golden-set failure, `bump-release-overtakes-its-own-note`,
is a judge-only case. Resolvable version-pin changes already have a
deterministic production route; a failed judge calibration is not proof
that this route fails.

## Procedure

1. Freeze each release's refs, notes, complete available diffs and original
   claim. Reuse cached clones, reports and `tmp/laya-lab/fitness-*` where
   available. Record hashes, engine settings and model/runtime versions.
2. Review expected verdicts and relevant hunks independently of selections
   and model answers. Record rationale and any unresolved ambiguity.
   Existing Codex labels and stored verdicts are not a human benchmark.
3. Run the baseline through the existing production entry points. Capture
   loaded evidence, selected hunks, the actual judge prompt and final report.
   Keep deterministic settlements visible. Reuse saved Laya rankings only
   as diagnostic comparisons.
4. Record final verdict agreement, relevant-hunk recall at selection and
   prompt boundaries, judge calls, input/output usage where available, and
   end-to-end wall time. Mark missing usage as unavailable. Separate cold
   and warm caches. Exclude warning-bearing or incomplete runs from paired
   quality comparisons; retain them as evidence of loading failures.
5. Locate the first failing stage. Propose the smallest correction for one
   demonstrated cause, then compare baseline and correction in isolated
   worktrees on identical inputs and settings. Measure forge checks serially.

## Acceptance and scope

A correction must restore the reviewed evidence or improve the agreed
verdict on the affected case without regressions in the other two cases.
Cost or speed improvements require measured end-to-end results.
Ambiguous labels and incomplete inputs remain explicitly unresolved.

For a code correction, follow the repository's applicable checks: a
regression test proven red without the change, `pnpm check`, `pnpm test`,
guard mutations, and golden evaluation before and after a ruling change.
Matching, coverage or pin-join changes also require the prescribed
before/after note-mutation measurement and scoring-table updates when applicable.

No production change, model integration or larger corpus run is part of
saving this plan. Laya remains in the [retrieval lab](retrieval-lab.md).
A later integration needs a specific, bounded task and demonstrated benefit
over its existing alternative.

## Deliverable

A three-case comparison recording inputs, reference rationale, stage traces,
metrics, excluded runs and the proposed correction. Report changed,
verified and unverified results separately.
