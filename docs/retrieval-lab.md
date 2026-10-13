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

Repeat `--target owner/repo@tag` to select exact releases instead. Empty pools
and merge commits whose first-parent diff contains patches that the current
loader missed are excluded from Laya. Load failures are recorded separately.
No production loader workaround is applied.

A pool larger than 32 candidates is no longer excluded (dataset version 2): it
becomes a `lexical-top` case whose candidates are the pool's first 32 in
lexical + fill order, and Laya can only reorder that shortlist. These cases
answer a different question — does Laya order the lexical shortlist better —
and `compare` reports them apart (`byPool`). A relevant hunk outside the
shortlist is invisible to every arm and every labeler. On the 2026-10-13
corpus this turned 239 of 561 sampled claims from excluded into measurable
(213 of them in the holdout split); the frozen file grows to 154 MB because
shortlists keep their largest hunks.

The dataset retains the original claim, complete candidate hunks, current
selection, control selection, release inventory and exclusions. An excluded
claim keeps only its pool size, not its pool, and the fenced pair Laya reads
is built at rank time instead of stored — together that brought a
whole-corpus dataset (123 releases, 561 claims) from a heap exhaustion to
14 MB (dataset version 2; version 1 files remain readable). Its hash
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

Laya reads 961 tokens of state (1024 minus a 62-token question prefix and a
separator, checkpoint above); 268 of the corpus's 2,077 eligible pairs are
longer, and chars per token run from 1.09 to a median of 2.71, so no character
budget is safe. The worker therefore windows each pair with Laya's own
tokenizer: contiguous body lines, every window re-headed with the claim and the
hunk's `@@` line, as many lines as fit; the candidate's score is the maximum
over its windows and the ranking records how many there were. A pair that fits
stays one window, identical to the unwindowed state. A single line that cannot
fit still reports truncation. On a six-claim smoke sample this turned three
cases that would have fallen back for truncation (a 424k-char hunk, 194
windows, ~14 s per claim) into scored ones; short pools stay at one window per
candidate and ~200 ms per claim.

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

## Fitness run 2 — pre-registered 2026-10-13, before any label or score

The follow-up above rests on two paired claims from one release. This run is
designed to decide, and everything below was fixed and committed before a
single label was written or a single pair was scored.

**Sample.** `retrieval-lab sample` over the whole corpus (`prepare --releases
200 --claims 8`, 561 claims, dataset `c79215cc…`): holdout split only, pools
above six hunks, at most 40,000 pool characters (a labeler reads the whole
pool), at most six claims per repository and pool kind, chosen by a hash of
the case id. Result `537cb38b191a376683684bf72c47fcfa59cc7ca2f1feef9ec4678b529b282b7e`:
79 claims from 39 releases of 10 repositories — 41 complete pools (9 repos)
and 38 lexical shortlists (10 repos), 1.56 M characters. Dropped: 160 other
split, 58 excluded, 57 pools of six or fewer, 140 pools over the character
cap, 67 over the repository cap. The character cap under-represents the very
long hunks windowing exists for; that is the price of labels a reader can
stand behind.

**Labels.** Two blind model labelers, independently: a Claude subagent and
Codex (`codex exec -s read-only`). Each sees what `retrieval-lab review`
shows — claim and complete pool — and nothing else: no selection, no score,
no stored verdict. Agreement is reported per hunk and per claim; every claim
the two disagree on is decided by the user on the review page. Labels are
frozen before `rank` runs and the labeler of each claim is recorded.

**Arms.** Current `claimEvidence`, lexical + fill, and Laya (pinned
checkpoint above, windowed, `--repeats 1`), each six hunks and 20,000
characters.

**Measure.** Per pool kind, on paired holdout claims (labeled with at least
one relevant hunk, no Laya fallback): mean recall of each arm, and Laya's
wins and losses against lexical + fill — the stronger control — with a
one-sided sign test over the non-tied claims (`vsExpanded.signTestP`).

**Decision.** For a pool kind, Laya becomes a candidate for an opt-in flag
only if all three hold: its mean recall is higher than lexical + fill's, it
wins more claims than it loses against lexical + fill, and the sign test gives
p < 0.05. Otherwise the isolation recommendation stands for that pool kind,
now with numbers. Not-worse is not enough: a new runtime dependency has to buy
something.

**Validity.** If more than 5 % of the labeled claims fall back (truncation or
worker error), the run is invalid; the cause is fixed and the run repeated
against the same frozen sample and labels. The development split is not
read. Not measured by this run: verdict accuracy, general injection
resistance, end-to-end latency.
