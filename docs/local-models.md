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

Reference point: a local Qwen3.5-9B scored 13/20 on the golden set with 3
rubber-stamps — all three on attack shapes (an install hook passed off as
cleanup, a disabled-by-default lie, a refactor sold as a security fix). That
is exactly the failure mode escalation exists for: fine for bulk
verification, release-critical verdicts go to a stronger engine. (Haiku:
19/20, zero rubber-stamps.)

## Escalation

With a local primary judge, `--escalate` (default `auto`) sends
release-critical verdicts (`no-evidence`, `contradicted`, and `verified` on
security claims) to a stronger engine for an independent review when one is
available (`claude` CLI or `ANTHROPIC_API_KEY`). Disable with
`--escalate off`, or pin engine/model via `--escalate`/`--escalate-model`.

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
