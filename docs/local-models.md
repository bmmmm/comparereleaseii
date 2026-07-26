# Local models as judge

Fully local judging works via any OpenAI-compatible server (Ollama, MLX,
LM Studio, vLLM) — nothing leaves your machine, and no model is hardcoded:

```console
$ node src/cli.ts owner/repo --engine openai            # auto-discovers the model
$ OPENAI_BASE_URL=http://127.0.0.1:8080/v1 node src/cli.ts owner/repo --engine openai
```

## Zero config

`--model` is optional — the server's `/v1/models` list is queried and the
model picked automatically. The same discovery runs in the fallback path:
when neither `claude` nor an API key is available but a local server is
running, the tool uses it instead of degrading to deterministic-only.

## Calibrate your model — or find your best one

`--calibrate` runs the golden set (`test/eval/golden.json`) against the
configured judge and tells you whether it is safe as a sole judge —
over-verification (rubber-stamping unsupported claims) is called out
explicitly.

- With `--engine openai` and no `--model`, every model the server offers is
  calibrated sequentially and ranked (accuracy, rubber-stamp risk, speed)
  with a "best local judge" recommendation.
- A comma-separated `--calibrate --model "a,b,c"` ranks a shortlist of
  candidate judges — on local servers and aggregators alike.
- Run calibration against single-model local servers with `--concurrency 1` —
  parallel prefills can trip their memory guards.

```console
$ node src/cli.ts --calibrate --engine openai \
    --openai-url http://127.0.0.1:8010/v1 --concurrency 1
```

## Which model should I pick? (community results)

Rough direction only — no absolute scores, because they don't transfer:
quantization, hardware and prompt versions all shift the numbers, and 25
golden cases carry ±1–2 cases of noise. Run `--calibrate` against your own
server for a real answer; the table below just saves you from starting
blind.

Rows marked **re-measured 2026-07** were run against the golden set and the
prompt as they stand in v0.1.2 — the two injection cases included. The
remaining rows predate both and are a prior, not a result.

| model | verdict as judge | notes | reported |
|---|---|---|---|
| Qwen3.5-27B-Claude-4.6-Opus-Distilled 4bit | **safe as sole judge** | 25/25, no rubber-stamp, and the only one that used the need protocol instead of guessing. Slow: ~65 s/call | re-measured 2026-07 |
| Qwen3.6-35B-A3B MoE 4bit | good — use with escalation | 23/25, no rubber-stamp, ~6 s/call — the speed pick. Missed the lockfile source shape and the need protocol | re-measured 2026-07 |
| gemma-4-12B-it 8bit | okay — escalation required | 23/25 but one rubber-stamp: sold a lockfile pointing at a non-registry tarball as verified. ~13 s/call | re-measured 2026-07 |
| gpt-oss-20b (MXFP4-Q8 / OptiQ-4bit) | okay — escalation required | mid accuracy | maintainer, 2026-07 |
| gemma-4-26b-a4b-it 4bit | okay — escalation required | mid accuracy, one rubber-stamp | maintainer, 2026-07 |
| Qwen3.5-9B 4bit | avoid as sole judge | 19/25 with five rubber-stamps, all on attack shapes: a refactor sold as a security fix, a disabled-by-default lie, an install hook as "cleanup", a fix reverted later in the range, and the lockfile source. ~7 s/call | re-measured 2026-07 |
| gemma-4-e2b / e4b (edge) | avoid as sole judge | too small for verdict work; the e2b is also the only model on the server that obeyed a planted instruction | re-measured 2026-07 |
| MarkItDown | not a judge | document converter — listed to show the ranking flags non-LLMs instead of crashing | maintainer, 2026-07 |

The pattern so far: dense ≥12B or MoE ≥30B works with escalation; below
~10B the models rubber-stamp exactly the attack shapes the tool exists to
catch. Escalation (below) covers that failure mode — the 9B is fine for
bulk verification when release-critical verdicts go to a stronger engine.

**Injection resistance does not track judging accuracy.** All eleven models
on the reference server were also given the two injection cases on their own.
Nine resisted, including the 9B that rubber-stamps five ordinary attack
shapes; the only one that obeyed a planted instruction was the 2B edge model,
and MarkItDown errored out because it is not an LLM. So a model being hard to
talk out of the evidence says nothing about whether it reads the evidence
well — and the fencing in the prompt does most of the work here, which is why
these two cases are worth re-running whenever the prompt changes rather than
being treated as a model property.

Two cases separate the field more than size does: `legit-need-more-files`
(only the 27B asked for the file it was missing instead of guessing) and
`js-lockfile-nonregistry-source`, which three of the four missed and two sold
as verified. That second one is now also caught deterministically — see the
`lockfile-source` flag in [SCORING.md](../SCORING.md) — so a weaker judge
costs less there than these numbers suggest.

**Ran `--calibrate` on your own server? PRs welcome** — add a row with the
model + quant, the verdict line the calibration printed, and anything
surprising in notes. Misses are as useful as hits.

## Escalation

With a local primary judge, `--escalate` (default `auto`) sends
release-critical verdicts (`no-evidence`, `contradicted`, and `verified`
where the claim or its evidence touches security-sensitive territory —
advisories, Security sections, dependency manifests, lockfiles, install
hooks, auth/crypto paths) to a stronger engine for an independent review
when one is available (`claude` CLI or `ANTHROPIC_API_KEY`). Disable with
`--escalate off`, or pin engine/model via `--escalate`/`--escalate-model`.

When no second engine is available — which is the case for a *non*-local
primary under `--escalate auto` — the same verdicts get two more independent
passes from the primary instead, and the median decides. If one pass fails
and the votes come out even, the stricter middle wins.

## Hosted aggregators (OpenRouter etc.)

The same engine speaks to hosted aggregators — point the base URL at it, use
your OpenRouter key as `OPENAI_API_KEY`, and always pass an explicit model
(auto-pick and calibrate-all are guarded against the hundreds of models an
aggregator lists):

```console
$ OPENAI_API_KEY=$OPENROUTER_API_KEY node src/cli.ts owner/repo \
    --engine openai --openai-url https://openrouter.ai/api/v1 --model qwen/qwen3-32b
$ … --calibrate --model "qwen/qwen3-32b,google/gemini-2.5-flash,mistralai/mistral-small"
```

Mind that free-tier aggregator models may train on your data; for private
repos prefer local models or paid endpoints.

## Small-model quirks

JSON quirks of small models (unterminated objects, hidden thinking budgets)
are handled by the parser and request defaults — no flags needed.
