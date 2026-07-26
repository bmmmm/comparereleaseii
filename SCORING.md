# How the trust score works

The score answers one question: **how much should you trust these release
notes as a description of what actually shipped?** It is designed so that a
fabricated release cannot look good by being good at averages — hence the
caps below. This document freezes the semantics; changes to any number here
are breaking changes to how reports read and belong in the changelog.

## Verdicts per claim

Every atomic claim gets one verdict:

| Verdict | Meaning |
|---|---|
| `verified` | The diff contains concrete evidence for the claim |
| `partial` | Some supporting evidence, but weak or incomplete |
| `no-evidence` | Nothing in the diff supports the claim |
| `contradicted` | The diff shows the claim is false |
| `skipped` | Informational claim (`meta`), not checkable against code |

Deterministic stages (PR/commit anchors, lexical identifier matching) settle
the clear cases; an LLM judge rules the rest, citing evidence lines.
Verdicts that would fail a release (`no-evidence`, `contradicted`) are never
accepted from a single model call: either a stronger **escalation engine**
independently reviews the claim and its verdict wins, or a 3-vote median of
independent passes must agree. `verified` verdicts on security claims
escalate the same way — a rubber stamp on a security fix is the most
expensive possible mistake.

## The three components

### correctness — do the notes tell the truth?

The weighted share of supported `change` claims:

```
correctness = 100 · Σ weight(claim) · value(verdict) / Σ weight(claim)

value: verified = 1 · partial = 0.5 · no-evidence / contradicted = 0
weight: handwritten claim = 1 · auto-generated entry = 0.25
```

Auto-generated `Title by @user in #N` list entries are produced from the
same commits we check them against — true by construction, so they carry ¼
weight. Handwritten claims are where notes lie; they dominate this
component. No checkable claims at all → correctness 100 (nothing asserted,
nothing wrong — completeness and risk still apply).

**Exception — a diff with no source.** When the release's changed-file set
contains no source file at all (only docs, changelogs, feeds, licence and
project metadata, images), `no-evidence` claims drop *out of* the ratio
instead of scoring 0. See "Not verifiable" below.

### completeness — do the notes cover what shipped?

The **churn-weighted** share of commits covered by at least one claim:

```
completeness = 100 · (changed lines in covered commits) / (changed lines in all commits)
```

Merge commits are excluded (their churn double-counts their parents). A
1-line typo commit and a 3000-line refactor are deliberately not equal —
hiding the refactor costs 3000 lines of coverage. Local runs without the
reverse check (`--no-reverse`) have no completeness; the overall formula
reweights (below).

### risk — does anything smell?

Starts at 100, minus a penalty per risk flag:

```
risk = max(0, 100 − 25·critical − 10·warn − 0·info)
```

| Severity | Flags |
|---|---|
| **critical** | contradicted claims · undocumented auth/crypto changes · vague note hiding auth/crypto changes · undocumented new dependency · undocumented opaque change (binary, minified, no patch) · install-hook change in an undocumented file · first-ever binary artifact (baseline) |
| **warn** | unsupported change claims · undocumented CI/build or dependency-manifest changes · vague note hiding notable non-auth changes · documented opaque changes · first-time author on sensitive paths (baseline) |
| **info** | documented new dependencies · release-size anomaly vs. baseline · unchecked claims on a diff with no source ("not verifiable") |

The asymmetry is deliberate: changelogs routinely omit lockfile and CI
churn (some generators filter it by design) — that is a `warn`. Silent
changes to auth/crypto code and silently added dependencies are the
signature of a compromised release — those are `critical`.

## Overall

```
overall = 0.45·correctness + 0.25·completeness + 0.30·risk
          (without completeness: 0.60·correctness + 0.40·risk)
```

Then two **hard caps**, applied in order:

- any `contradicted` claim → overall ≤ 35
- else any `critical` flag → overall ≤ 45

A release that lies about one thing does not get to be "82/100, mostly
fine". The caps put it below every honest-but-sloppy release by
construction.

| Overall | Label |
|---|---|
| ≥ 85 | solid |
| 65–84 | minor gaps |
| 45–64 | questionable |
| < 45 | suspicious |

## Not verifiable — releases whose diff holds no source

Some releases cannot be checked at all: a closed-source product publishing
notes from a mirror repo, a docs-only bump, a release whose whole diff is
`CHANGELOG.md` and `feed.xml`. Lexical matching has nothing to anchor on, so
every claim lands on `no-evidence` — the same verdict a fabricated release
gets, for the opposite reason.

The signal is the **diff's** file set, not the repo's language stats: a repo
can be 80% Python and still ship a release that touches no source. When no
changed file is a source file, the report sets `metrics.sourcelessDiff` and:

- `no-evidence` claims leave the correctness ratio instead of scoring 0
- the `unsupported-claim` **warn** flag becomes a `not-verifiable` **info**
  flag — no risk penalty
- reports (terminal, Markdown, JSON, HTML) carry the line *"This release's
  diff contains no source-code changes — claims could not be checked against
  code"*, and each affected claim says so too
- `--fail-on no-evidence` does not fail the build

What this deliberately does **not** do: claim the notes are true. The score
still loses its completeness component if the docs churn is undocumented,
and every risk flag still applies. The report says "unknown", not "fine".

## Reading a score

- **95+** — notes are an accurate, near-complete account of the diff.
- **80s** — honest notes with routine gaps: undocumented CI/dependency
  churn, a few weakly-evidenced claims. Typical for good projects.
- **65–84 with warn flags** — read the flags before trusting the notes.
- **≤ 45** — capped: something concrete is wrong (a contradicted claim or a
  critical flag). The score stops mattering; the flags are the finding.

Scores are comparable across repos, but the baseline block in the report
(median churn and note coverage of the repo's own previous releases) is the
better calibration for "is this normal *here*?".
