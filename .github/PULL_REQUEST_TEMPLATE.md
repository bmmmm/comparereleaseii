<!--
This template is the same bargain the tool itself makes with release notes:
state your claims, and let the diff be checked against them.

Fill it in and review is mechanical. Leave it empty and review turns into
archaeology — which is slow, and slow PRs get stale.
-->

Closes #

## What and why

<!-- Two or three sentences. The problem, and why this is the right shape of fix. -->

## Claims

<!--
One bullet per user-visible change. Put file names, functions and symbols in
`backticks` and reference PRs/issues as #N — those are the anchors the checker
resolves against the diff. Claim what the change *does*, not what you touched:
"caches the model list per base URL" beats "refactored discoverLocalModels".

The block between the markers is extracted verbatim by the self-check workflow
and run through this project's own checker against your diff. Keep the markers.
-->

<!-- self-check:begin -->
- `src/foo.ts`: `doThing()` now returns `null` instead of throwing when the ref is missing
- `--some-flag` accepts `never` in addition to `auto` and `always`
- Fixes the crash in `parseUnifiedDiff()` on renames without a hunk header (#12)
<!-- self-check:end -->

## Verification

<!--
Real output from your machine, not intentions. "Should work" is not verification.
-->

```console
$ pnpm check
$ pnpm test
```

<!-- Ran anything else? A real repo, --calibrate, an eval? Paste it. -->

## Tests

<!--
Name the test and prove it is load-bearing: it must fail without your change.
If you did not add one, say why here — "typing-only change", "output formatting
covered by an existing snapshot". An empty section reads as "untested".
-->

- Added / changed:
- Fails on `main` without this change: <!-- yes / no + how you checked -->

## Public contracts

<!-- People gate CI on this tool. Tick what still holds. -->

- [ ] Exit codes unchanged (`0` supported · `1` unsupported/contradicted · `2` usage/data error)
- [ ] `--json` report schema unchanged (no field removed, renamed or retyped)
- [ ] Existing flags keep their meaning and defaults
- [ ] No new runtime npm dependency
- [ ] Deterministic stages stay deterministic — same input, same output with `--judge off`

<!-- If any box stays unticked, describe the break and the migration here: -->

## Verdict impact

<!--
Only for changes that can move a ruling: judge prompt, retrieval/ranking, matching,
claim parsing, scoring. Delete this section otherwise.
-->

- Golden set (`pnpm eval`) before / after:
- Cached verdicts affected? <!-- Prompt edits change the cache key automatically.
     Changing how a response is *parsed* does not — old entries survive and are
     re-read by the new parser. If you touched parsing, re-verify with --no-cache. -->

## Risk and rollback

- What breaks if this is wrong:
- How to tell from the outside:
- Revert is clean: <!-- yes / no + what else would need undoing -->

## Out of scope

<!-- Adjacent problems you deliberately left alone. Prevents "while you're in there". -->

## Assistance

<!--
LLM-assisted work is welcome here — this is a tool for verifying claims, not a
place to pretend they were all typed by hand. The rule is only that you stand
behind it: you ran it, you read it, you can explain it.
-->

- [ ] I wrote or reviewed every line and can explain why each change is there
- [ ] I ran the commands under Verification myself and pasted their real output

---

<details>
<summary>Reviewer checklist</summary>

1. Claims block vs. diff — anything changed that no claim mentions?
2. Self-check summary — which claims found no lexical anchor, and is that explained?
3. Does the new test actually fail on `main`?
4. Contracts: exit codes, JSON schema, flags, dependencies.
5. Scope: does the diff stay inside the files the claims imply?
6. Verdict impact: golden set unchanged or improved.

</details>
