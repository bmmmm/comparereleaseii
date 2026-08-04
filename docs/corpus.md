# What 80 releases say about release notes

Everything below comes from one watch home running since 2026-07-18: 13
repositories, 80 releases, every one of them checked in both directions —
claims against the diff, and the diff against the claims. It is not a study.
It is one operator's corpus, one judge engine, and a repository selection
that reflects what that operator runs, not what the ecosystem looks like.
Read the [limits](#what-this-does-not-show) before quoting a number.

Reproduce any figure here with:

```console
$ pnpm corpus-stats ~/release-watch/reports
```

Repository names are deliberately absent from that output. This tool informs
its operator; it does not publish compressed judgements next to other
people's project names (see the settled entry in `ROADMAP.md`). `--named`
exists for reading your own corpus, not for pasting into a text.

## Notes are either thorough or decorative — rarely in between

The share of changed lines that any note covers, across 80 releases:

| Coverage of the diff | Releases |
|---|---:|
| ≥ 90 % | 46 |
| 75–90 % | 7 |
| 50–75 % | 5 |
| 25–50 % | 7 |
| < 25 % | 15 |

The median release documents 94.2 % of what it changed. The mean is 71.9 %.
That gap is the finding: more than half of all releases are close to
complete, and a hard core of 15 releases (19 %) ships with over three
quarters of its changed lines unmentioned by any note. There is no broad
middle of "somewhat documented" releases. A team either writes notes against
the diff or writes them against a feeling, and the second group does not
gradually improve — it clusters at the bottom.

For a reader, this means the useful question is not "are these notes good?"
but "which of the two kinds is this?" — and that is answerable in seconds,
mechanically, before you read a single line.

## What the notes claim, and what the diff says

2,911 claims parsed; 1,394 of them (47.9 %) escalated to a judge — the rest
were settled deterministically or skipped as unverifiable.

| Verdict | Claims | Share |
|---|---:|---:|
| `verified` | 2,093 | 71.9 % |
| `no-evidence` | 348 | 12.0 % |
| `skipped` | 327 | 11.2 % |
| `partial` | 131 | 4.5 % |
| `contradicted` | 12 | 0.4 % |

**Contradicted claims are rare, and most of them are boring.** All twelve,
classified by hand:

- **Four are real, substantive errors.** The sharpest: a release note
  advertising four new audio output formats for a non-streaming endpoint,
  while the diff adds a validation block rejecting every format but the
  original one with a 400 and the comment *"Only WAV is produced (no
  transcoding)"*. Also: a page announcing a final version while the tag
  being cut is a release candidate; a note describing a fallback to a build
  pipeline that the same diff deletes in its entirety (422 lines); a note
  announcing the deletion of a translation directory that is still fully
  present at the tag.
- **Two are real but trivial** — a dependency bump note naming `2.8.1` where
  both `go.mod` and `go.sum` say `2.8.2`.
- **Six are an artefact of comparing a per-PR note against a per-release
  diff.** The note correctly quotes its own pull request ("bump
  `actions/cache` from 5.0.3 to 5.0.4"), but the release aggregates several
  bumps of the same action, so the diff shows 4.3.0 → 5.0.5. Nobody wrote
  anything false; the claim and the evidence are simply cut at different
  granularities.

That last group matters more than its size suggests, because a contradicted
claim is a hard cap on the trust score. Two of the five releases carrying a
`critical/contradicted-claim` flag are pushed to 35/100 ("suspicious") by a
single dependency version digit. See [the open question](#the-open-question)
below.

## The silent direction is where the risk sits

Reverse checking — which changes no note mentions — produced far more
signal than contradicted claims did:

| Flag | Count |
|---|---:|
| `warn/opaque-change` | 166 |
| `critical/opaque-change` | 58 |
| `warn/undocumented-sensitive` | 37 |
| `info/size-anomaly` | 28 |
| `warn/unsupported-claim` | 27 |
| `info/new-dependency` | 27 |
| `warn/new-author-sensitive` | 22 |
| `critical/undocumented-sensitive` | 7 |
| `warn/vague-claim-surplus` | 6 |
| `critical/new-dependency` | 6 |
| `critical/contradicted-claim` | 5 |
| `warn/lockfile-source` | 4 |
| `warn/judge-unavailable` | 4 |
| `info/not-verifiable` | 3 |

19 of 80 releases changed a file with no reviewable patch — a binary, a
database, a compiled asset — and in 11 of them no note mentioned it at all.
These are not exotic projects: the pattern is a geo-IP database or a font
that ships silently alongside the features people did write about. A reader
comparing two versions has no way to see what changed in those bytes, and
the notes give them no reason to look.

20 of 80 releases (25 %) carry at least one critical flag. Trust scores
across the corpus run 25 to 100, median 80.

| Label | Releases |
|---|---:|
| solid | 32 |
| minor gaps | 22 |
| questionable | 14 |
| suspicious | 9 |
| unverified | 3 |

## The open question

The corpus supplies the facts `ROADMAP.md` was waiting for before reopening
the identifier-anchor question, and sharpens it: bump claims do not merely
dominate the *unsupported* line, they dominate the *contradicted* verdict —
eight of twelve — and through the hard cap they demonstrably move scores.
Two releases read "suspicious" on the strength of a patch-version digit in a
dependency note.

Whether that is wrong is a judgement call, not a bug: the note does state a
version the diff does not support. But a score that says "suspicious" is
claiming something stronger than "one bump note is off by a patch level",
and this corpus is the first evidence that the two routinely get conflated.

## What this does not show

- **One judge.** Every verdict here comes from `claude-cli/haiku`. A
  different engine produces different marginal calls; `--calibrate` bounds
  that drift but does not remove it.
- **Thirteen repositories, chosen by one operator.** Desktop apps, a proxy,
  a password manager, a packet sniffer, an editor. No web frameworks, no
  libraries, nothing from the enterprise Java world. The bimodality above
  may be a property of this sample.
- **Skew.** One repository contributes multiple tag lines (`web-`,
  `desktop-`, `browser-`, `cli-`), so releases are not independent draws.
- **11.2 % of claims were skipped** as structurally unverifiable — links,
  thanks, headings. They are excluded from the verdict shares above, not
  counted as failures.
- **The 0.4 % contradicted rate is a floor, not a measurement.** It counts
  what a judge could prove against the diff it was shown. A claim about
  behaviour that no diff line reveals is `no-evidence`, not `contradicted`.
