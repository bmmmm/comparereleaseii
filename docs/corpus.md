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
single dependency version digit. That is what the table above measured; what
came of it is [below](#the-question-this-corpus-opened-and-what-came-of-it) —
none of the eight bump contradictions exists any more.

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

## The question this corpus opened, and what came of it

The corpus supplied the facts `ROADMAP.md` was waiting for before reopening
the identifier-anchor question, and sharpened it: bump claims did not merely
dominate the *unsupported* line, they dominated the *contradicted* verdict —
eight of twelve — and through the hard cap they demonstrably moved scores.
Two releases read "suspicious" on the strength of a patch-version digit in a
dependency note.

**That question is now closed, without the score being touched.** A bump
claim states a pin and a version; the diff carries the same pin and its own
version, so the comparison needs no model at all. Since this release the two
are joined deterministically before any judge runs (see `SCORING.md`), and a
release that moves a pin *past* the version its note names reads as
**overtaken** — not as a contradiction.

Re-checked against the same diffs, all eight are gone.
nextcloud/desktop v34.0.0 settles twelve of its thirteen bump claims off the
pins alone, all six former contradictions among them; traefik v2.11.54's
reads as overtaken (the release moved `dd-trace-go` v2.2.3 → v2.8.2, past
the 2.8.1 the note names). Nothing about the scoring formula, the hard cap
or the golden set's scoring semantics changed to achieve that — the class
simply stopped being a guess.

The eighth took a second mechanism and is worth stating, because it looked
for a while like a judge hallucinating. traefik v3.6.25's release diff moves
`dd-trace-go` nowhere — the module's `go.mod` line is identical at both
ends of the range, because the base branch already carried the destination
version. The commit the note names moves it v2.2.3 → v2.8.2, and that
commit is in the release. The judge had been reading the commit diff it was
handed; the pin join had been reading the range. Both were right about what
they were shown. A bump claim the range cannot answer now falls back on its
own commit, which reads that case as overtaken.

Re-checked through the watcher, traefik v2.11.54 moves from 35
("suspicious", one contradicted claim, one critical flag) to 88 ("solid",
neither). v3.6.25 loses its bump contradiction just as deterministically and
still does not settle on a number: it carries a second contradiction — an
advisory claim whose own test comment names a different GHSA id — whose
verdict differs between runs. Worth stating because it marks the boundary
this work moved. The pin join is deterministic and its part of the answer
does not vary; everything around it is still one judge reading a diff.

The 106 bump claims across the corpus are now counted apart by
`pnpm corpus-stats`, so the same number can be re-derived on any watch home:
7.6 % of them contradicted against 0.14 % for every other claim, which is
the ratio this whole line of work started from.

### The number the join was not reading: where the pin came *from*

All of the above settles a bump claim on its destination. The version a note
says the pin came **from** was never read at all, so
`opencloud-eu/opencloud@v7.3.0`'s "opa from 1.18.1 to 1.18.2" read `verified`
against a range that moves the pin 1.15.2 → 1.18.2. Before writing a rule for
that, the corpus was asked how its notes actually spell an origin — 108
releases, 555 bump claims, 216 of them naming a from-version, and 76 of those
with a pin the diff moved:

| the note's from-version | n | what it is |
|---|---|---|
| the pin's own starting point | 40 | exact |
| inside the move the pin made | 26 | one hop of an aggregated series |
| below where the pin started, or past where it lands | 10 | a move this release does not make |

The 26 are the reason the obvious rule is the wrong one. A release aggregates
several bumps of one pin and Dependabot writes one line per hop, so
`1.18.1 → 1.18.2` inside a `1.15.2 → 1.18.2` move is an honest note about its
own pull request — the same shape as `overtaken` on the destination side, and
requiring the origins to agree would have flagged the majority spelling of an
honest release.

So the reading is positional, and only the third row is a finding. Its four
non-contradicted members (the other six are already contradicted on the
destination) look like `fsnotify 1.8.0 → 1.10.1` where the release goes
1.9.0 → 1.10.1: the bump happened, the verdict stands, but three releases'
worth of change is credited to one, and risk is what a reader weighs a
version distance by. That costs the reading confidence and earns it a line in
the report — which is the part that was missing, because a `confirmed` bump
printed no line at all.

## Where the judge bill goes

The bump class was found by counting: it dominated one column, and the
deterministic rule that replaced it is both cheaper and more accurate than
the model was. `pnpm corpus-stats` now breaks the whole judge bill down the
same way, so the next such class can be found the same way instead of
noticed by accident.

The classes are the **routes** a claim takes, not its topic — what separates
them is the evidence the deterministic pass already held before anything was
asked:

| Class | what it means |
|---|---|
| `bump` | names a pin and a version; the diff's own pin delta settles it |
| `generated` | PR-list boilerplate whose title equals the squash commit |
| `anchored-strong` | names a commit in the range *and* its identifiers appear in that commit's diff |
| `anchored-weak` | names a commit, but the claim text could not be matched to its diff |
| `unanchored-lexical` | no commit, but identifiers hit somewhere in the release diff |
| `unanchored-none` | no commit, no identifier match |
| `meta` | asserts nothing about this release — links, thanks, headings |

Per class the report gives claims, how many reached a judge, a floor on the
calls spent, that class's share of the bill, how many went through the
independent verification passes, and how many of *those* came back with the
passes disagreeing. The last column is the sharp one: the same engine, the
same prompt, a different answer means the judge is contributing variance
rather than evidence, and on that class a deterministic rule cannot do worse
than a coin.

Call counts are deliberately a **floor**. A report records that a judge
answered, that a second engine reviewed, and every vote a verification pass
returned. It records nothing about a `need` round that asked for more files,
a pass that threw, an escalation that failed, or a surplus audit that found
nothing — so a class that already looks expensive here is only more so.

## Sweeping a threshold, without letting it tune itself

The bars this tool judges by are hand-set numbers, and three of them were
changed by feel and measured afterwards. `pnpm sweep <reports dir>` runs that
order forwards: it patches the literal in the source, measures, restores, and
prints the Pareto front over three axes — fabricated releases the
deterministic stages catch (`mutate-notes`), golden cases the judge-free
ladder answers within `expected` plus the ones it rubber-stamps, and claims
left for a model.

It reports. It never writes a constant, and it must not learn how: a
threshold that moves by itself makes every score incomparable with every
other and turns the frozen references into decoration. A person reads the
front, picks a point, and edits the source with the measurement in the
comment.

Three things it says out loud rather than leaving to be inferred:

- **A flat axis did not hold; it was not looking.** When the golden column
  does not move across a dial, that is printed — otherwise a flat column
  reads as "fidelity checked and fine", the same mistake as a green test
  that cannot go red.
- **Scores are shown, never ranked.** The corpus's median correctness,
  completeness and overall appear beside the front, explicitly outside it.
  Higher is not better here; a sweep that picked the point with the best
  scores would be the tuning loop the whole script refuses to be. Measured
  on the live watch home, `generated-weight` swings median correctness from
  44 to 83 while all three ranking axes stay flat — a dial the front cannot
  advise on, and a person decides on the semantics.
- **A dial that moves scores says so**, and names `SCORING_GENERATION` as
  the thing to bump in the same commit.

`MATCH_BAR` (`src/reconcile.ts`) is the fourth hand-set bar and is
deliberately not swept: it gates which findings a claim is said to describe,
in a layer that is informational and never scored, and that layer only exists
when the findings pass ran — which needs a judge. None of the three axes can
see it, so a sweep would report three zeros and call it a front.

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
