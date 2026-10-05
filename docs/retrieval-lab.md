# Retrieval comparison lab

An isolated experiment for Laya as an evidence ranker. It does not connect
Laya to the release checker, assign verdicts, or change scores. The lab
compares the current `claimEvidence` selection, lexical ranking filled with
zero-overlap candidates, and Laya on the same frozen candidate pool. All
three use six selections and a 20,000-character evidence budget.

## Freeze real input

Use stored reports and their existing cached clones. No judge runs, and with
`GIT_NO_LAZY_FETCH=1` missing Git objects fail instead of being downloaded.
The default sample is twelve releases, up to eight non-generated change
claims per release. Repositories are visited in sorted round-robin order;
subsequent rounds alternate small and large releases. Claims are spread
evenly across their notes. This is an exploratory sample, not a representative
quality benchmark. Whole repositories are assigned to development or holdout
by a fixed hash, so releases of one repository cannot cross the boundary.

```bash
mkdir -p tmp/laya-lab
GIT_NO_LAZY_FETCH=1 pnpm retrieval-lab prepare \
  --reports tmp/corpus --releases 12 --claims 8 \
  --out tmp/laya-lab/dataset.json
```

Repeat `--target owner/repo@tag` to select exact releases instead. Empty pools,
more than 32 candidates, and merge commits whose first-parent diff contains
patches that the current loader missed are excluded from Laya. Load failures
are recorded separately. No production loader workaround is applied.

The dataset retains the original claim, complete candidate hunks, current
selection, control selection, release inventory and exclusions. Its hash
binds rankings and labels to the exact input. Candidate pools intentionally
include hunks with no lexical overlap. Changelogs are excluded because notes
repeating themselves are not evidence. Claims, paths and hunks are fenced
with the existing `untrustedBlock` helper before reaching Laya.

## Review evidence independently

```bash
pnpm retrieval-lab review --input tmp/laya-lab/dataset.json \
  --out tmp/laya-lab/review.html
open tmp/laya-lab/review.html
```

The page hides selections and scores. Read the entire candidate pool, mark
every hunk relevant to testing the claim, including contradictory evidence,
write a rationale and check the reviewed box. Download the labels as
`evidence-labels.json` and place them in `tmp/laya-lab/`. Only reviewed claims
are exported. A reviewed empty selection records that no candidate supplies
evidence; it does not enter the recall denominator. Stored verdicts are
never treated as reference answers.

## Run Laya locally

Requires Apple Silicon with Metal access, Python >=3.11 and `uv`. The
Python environment and downloaded weights stay under the ignored lab
directory. Resolve the latest runtime when setting up; record the installed
versions rather than assuming what is current.

```bash
UV_CACHE_DIR=tmp/laya-lab/uv-cache uv venv --python 3.11 tmp/laya-lab/.venv
UV_CACHE_DIR=tmp/laya-lab/uv-cache uv pip install \
  --python tmp/laya-lab/.venv/bin/python --upgrade laya-mlx
UV_CACHE_DIR=tmp/laya-lab/uv-cache uv pip freeze \
  --python tmp/laya-lab/.venv/bin/python > tmp/laya-lab/runtime.txt
```

Use a full model commit hash from the Hugging Face model API. The initial
model is `aac6fef/laya-multilingual-mlx`; `--model` allows another checkpoint.
The runtime uses Laya's `noul` probability for relevance, not claim correctness.
[Laya's documented Python API](https://github.com/mizorewww/laya-mlx#python-api)
also exposes context truncation, which invalidates a ranking here.

```bash
HF_HOME=tmp/laya-lab/hf pnpm retrieval-lab rank \
  --input tmp/laya-lab/dataset.json \
  --python tmp/laya-lab/.venv/bin/python \
  --model aac6fef/laya-multilingual-mlx \
  --revision f2b4faf51023039425946074e2cf1361d2db11d5 \
  --repeats 3 --out tmp/laya-lab/ranking.json
```

That revision is the checkpoint measured on 2026-10-05, not an assertion that
it remains the latest. The worker loads once and processes pairs serially.
Load/import time includes downloading weights on the first run. First-use
and subsequent inference times are retained per claim and repetition.
After download, add `HF_HUB_OFFLINE=1` for offline repetitions. Comparing
saved outputs starts no model. There is no ranking cache or resumable worker.

## Compare and inspect

```bash
pnpm retrieval-lab compare --input tmp/laya-lab/dataset.json \
  --ranking tmp/laya-lab/ranking.json \
  --labels tmp/laya-lab/evidence-labels.json \
  --out tmp/laya-lab/comparison.json --html tmp/laya-lab/comparison.html
open tmp/laya-lab/comparison.html
```

Omit `--labels` to inspect the three selections before labels exist. Quality
then remains `null`. The HTML shows original selected diffs side by side,
runtime identity, repetitions and fallbacks; JSON retains the full measurement.

A Laya response needs exactly one finite probability in [0,1] per candidate
and explicit truncation diagnostics. If any pair was truncated or the worker
reported an error, the case falls back to its current selection and is excluded
from paired quality measurement. Malformed rows or stale dataset/label hashes
fail the comparison. Ties retain the frozen candidate order.

Recall counts independently labeled relevant hunks that reach the selection
in full, on the correct path. A clipped prefix does not count. Results report
labeled, applicable and paired claims separately for development and holdout,
with mean recall and paired wins/losses/ties for each repetition. Zero paired
claims yield `null`, never a perfect score. Cases excluded from Laya still
appear in the report, including fallback diffs.

This measures retrieval only. It does not measure final verdict accuracy,
judge calls, end-to-end release latency, a production cache, or the proposed
25% quality / 20% efficiency integration gates. A small exploratory sample
does not establish a statistically reliable benefit. Freeze the model, question
and independent labels before interpreting holdout results or expanding the
experiment into the production pipeline.

## Verification

```bash
pnpm check
pnpm test
pnpm mutate
node scripts/mutate.ts "retrieval lab"
```

The lab tests exercise rejected scores, context loss, stale inputs, incomplete
and duplicate responses, independent labels, complete evidence recall and HTML
escaping. The normal mutation harness owns source files while running; do not
edit source or run tests concurrently with it.

Require the lab's mutants to die via `own tests`: the full-suite fallback
also runs the mutation-list staleness check, so that fallback alone does not
establish which behavioral assertion noticed a mutant.

## Initial smoke measurement

On 2026-10-05, the default twelve-release sample froze 27 claims. Three serial
GPU repetitions with Laya 0.3.0 and the model revision above each yielded:

- 3 valid ranking cases;
- 11 cases with context truncation;
- 9 cases excluded for the merge-diff loader gap;
- 4 cases with empty pools.

Three independently read real-diff labels exercised the comparison: the browser
version bump supplied four relevant hunks, while a release-feed-only pool and
a component-pin-only pool did not establish their claims. These were reviewed
by Codex for smoke validation, not collected as a human quality benchmark.
The one paired positive case had full recall for all three selectors. There
was no positive paired holdout case and no demonstrated Laya quality gain.

The implementation passed 562 tests without skips. All 43 lab mutants were
killed by the lab test file itself. HTML escaping was tested; browser testing
of the local pages and the download button remained unverified because the
browser tool rejected `file:` navigation.

## Usage audit after the smoke run

The API call follows the documented `load` / `predict` / `noul` contract.
That establishes transport and parsing, not evidence-ranking fitness.
Short synthetic controls repeated three times on the same pinned checkpoint
showed a substantial input-format effect with no truncation:

| Irrelevant input | Plain field labels | Current untrusted-block layout |
|---|---:|---:|
| Button-color change against a request-timeout claim | 0.0306 | 0.8252 |
| Release-feed text repeating the timeout claim | 0.0251 | 0.6778 |

The supporting and contradicting controls still ranked above these negatives
in both layouts. This does not prove a ranking failure, nor justify removing
the untrusted markers; it shows that these values are not established relevance
probabilities on our task. The identical values in all three repetitions are
reproducibility observations, not three independent quality samples.

The three valid corpus cases contain only four, two and three candidates,
below the six-hunk selection limit. The only positive labeled case therefore
does not test whether Laya can choose useful evidence from a competing pool.
Before treating the lab as a fitness comparison, establish positive, negative,
contradictory and injection controls for the exact input layout, then use
independent labels on complete pools larger than the selection limit. Passing
implementation tests must not stand in for that model-task validation.

## Task-fitness follow-up

On 2026-10-05, the unchanged question, untrusted-block layout, runtime and
pinned checkpoint above were measured offline on three synthetic controls
and three independently read real-diff cases. Labels were frozen before
inference. Each set used one serial repetition; repeated smoke runs were
not counted as additional quality samples.

The controls each contained eleven hunks: two timeout-setting changes
(supporting and contradicting the claim), seven unrelated UI changes, and
two wording-only changes. Variants added an instruction and forged boundary
to one unrelated diff, or to the claim. States were produced by
`candidatesFor`, including its boundary escaping, and all pairs fit the
context. Laya retained both evidence hunks in all three top-six selections,
as did lexical ranking with fill; current selection retained one of two.
In the clean pool, four unrelated hunks outranked the contradicting change.
The matched UI hunk scored 1.0000 without injected instructions and 0.9834
with them, ranking first in both. This is a relevance-ranking failure on
that control, not evidence that the injection succeeded. No general injection
resistance was established.

The real cases retained complete, unmodified pools larger than six hunks:

| Release and claim | Pool | Current recall | Lexical + fill | Laya | Result |
|---|---:|---:|---:|---:|---|
| Maccy 2.6.1: copying crash on macOS 14 | 7 | 1.00 | 1.00 | 0.50 | Valid holdout loss |
| Maccy 2.6.1: cursor over a hidden search field | 7 | 1.00 | 1.00 | 1.00 | Valid holdout tie |
| Zed v1.13.2: tab-expanded selection panic | 12 | 0.60 | 0.60 | — | Context-truncated; excluded |

For the crash claim, Laya placed Indonesian translation hunks above the
code changes and ranked `Maccy/Clipboard.swift` seventh (0.5409), dropping
the immediate macOS-14 storage insertion from the six-hunk evidence budget.
The other relevant hunk, `Maccy/Observables/History.swift`, ranked sixth.
Mean recall on the two paired holdout claims was 1.00 for both controls and
0.75 for Laya: zero wins, one loss, one tie. Both claims belong to one release
and use Codex labels; this is a concrete counterexample, not a population
estimate or a human benchmark. The Zed fallback is not a Laya quality result.

The real-case worker measured 694 ms load/import and 1,349 ms total, with
196, 151 and 306 ms per case. These are retrieval-worker timings, not
end-to-end latency or an efficiency comparison. Frozen inputs, labels,
rankings and comparisons remain under `tmp/laya-lab/fitness-*`. The original
comparison was regenerated with the existing three smoke labels; its page
links to these follow-up measurements.

Recommendation: keep Laya isolated. The measured setup loses real evidence
and demonstrates no gain over lexical ranking with fill. Do not expand the
production pipeline or run a larger corpus to justify integration on this
evidence. Any later experiment needs a separately frozen setup and independent
labels. Synthetic controls must compute both reference selections before
comparison; empty placeholder selections create artificial wins.

Chrome verification over a loopback HTTP server confirmed the assessment,
the linked real-case comparison and the blind-review export. The downloaded
JSON contained exactly the one reviewed claim, the expected two evidence
IDs, its rationale and the matching dataset fingerprint. Unreviewed claims
were absent. `pnpm check` and all 562 tests passed without skips. No production
code or scoring changed; verdict accuracy, general injection resistance and
end-to-end efficiency remain unmeasured.
