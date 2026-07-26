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
the clear cases; an LLM judge rules the rest, citing evidence lines. An
anchor alone never produces `verified`: a note that restates its own commit
subject only shows that the author agrees with themselves, so a linked PR or
sha raises a claim's priority for judging and stops there. Only identifiers
from the claim actually found in the diff (score ≥ 5, the same bar with and
without an anchor) can settle a claim deterministically — plus
auto-generated entries, which are true by construction.
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

**Carried-over claims.** Cumulative or recap-style notes repeat their
predecessor verbatim — standing intros, whole feature lists. Text that already
stood in the base release's notes describes the product, not this release; it
is reported separately and leaves the ratio the way meta claims do. Lines
under four words are exempt: "Bug fixes" recurs everywhere and still asserts
something each time.

**Exception — releases that cannot be checked here.** When the release's own
shape explains the misses (no source file in the diff at all, or a fork whose
notes describe upstream code), `no-evidence` claims drop *out of* the ratio
instead of scoring 0. See "Unverified" below.

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
| **critical** | contradicted claims · undocumented auth/crypto changes *in an otherwise well-documented release* · vague note hiding auth/crypto changes · undocumented new dependency · undocumented opaque change (binary, minified, no patch) · install-hook change in an undocumented file · first-ever binary artifact (baseline) |
| **warn** | unsupported change claims · undocumented auth/crypto changes where under 60 % of the churn is documented · undocumented CI/build or dependency-manifest changes · vague note hiding notable non-auth changes · documented opaque changes · first-time author on sensitive paths (baseline) |
| **info** | documented new dependencies · release-size anomaly vs. baseline · unchecked claims on a release that cannot be checked here ("not verifiable") |

The asymmetry is deliberate: changelogs routinely omit lockfile and CI
churn (some generators filter it by design) — that is a `warn`. Silent
changes to auth/crypto code and silently added dependencies are the
signature of a compromised release — those are `critical`.

**Why the auth/crypto critical needs a well-documented release.** The
signature is "the notes read as a full account, but the auth change is
missing" — not "the notes cover a fraction of the release and auth happens to
be in the rest". Past ~150 commits some undocumented sensitive path is
near-certain, so an unconditional critical there measures release size rather
than risk (zed and traefik each sat on the risk floor for it). Below 60 %
documented churn the flag drops to `warn` and names the completeness gap as
the finding — completeness already charges for it. Without a reverse check
there is no basis to downgrade, so it stays `critical`.

**New dependencies mean new suppliers.** A second line for a supplier already
in the manifest is not one: a Go major bump (`lego/v4` → `/v5`), a submodule
of a dependency already present (`gateway-api/conformance`), a Cargo member
crate picking up a `workspace = true` declaration, or the project's own local
modules (`replace … => ./path`). None of those raise the flag.

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
| any | **unverified** — no claim could be checked here (below) |

## Unverified — releases that cannot be checked in this repo

Some releases cannot be checked at all, and lexical matching then has nothing
to anchor on: every claim lands on `no-evidence` — the same verdict a
fabricated release gets, for the opposite reason. Two shapes, both benign:

| `metrics.unverifiable.kind` | Shape | Decided from |
|---|---|---|
| `sourceless` | The diff contains no source file — a docs-only bump, or a changelog mirror of a closed-source product (whole diff = `CHANGELOG.md` + `feed.xml`) | this release alone |
| `out-of-repo` | The diff *has* source, but the notes describe code that lives elsewhere: a fork shipping upstream features, a build or distribution repo | this release **and** the repo's own history |

In the JSON report this is one field: `metrics.unverifiable` is
`{ kind, reason }` or `null`. Consumers branch on that, not on the score.

The signal is the **diff's** file set, never the repo's language stats: a repo
can be 80% Python and still ship a release that touches no source.

`out-of-repo` deliberately costs more evidence, because "most claims miss" is
also exactly what a fabricated release looks like. It is claimed only when all
of these hold:

- a strict majority of this release's `change` claims are `no-evidence`
- the last ≥ 3 releases exist as a baseline, and their median **lexical
  coverage** (share of claims whose identifiers appear anywhere in that
  release's diff — deterministic, no judge) is ≤ 25 %
- no claim is `contradicted` and no flag is `critical` — evidence *about this
  release* outranks any pattern in the history

When either kind holds:

- `no-evidence` claims leave the correctness ratio instead of scoring 0
- the `unsupported-claim` **warn** flag becomes a `not-verifiable` **info**
  flag — no risk penalty
- if that leaves *no* checkable claim, the label becomes `unverified`
  regardless of the number — correctness 100 there means "nothing was found
  wrong", not "the notes were checked and hold"
- reports (terminal, Markdown, JSON, HTML) carry the reason, and each affected
  claim says why it went unchecked
- `--fail-on no-evidence` does not fail the build; the watch index tags the
  row so it reads differently from a genuine score collapse

What this deliberately does **not** do: claim the notes are true. Completeness
still counts undocumented churn, and every risk flag still applies. The report
says "unknown", not "fine".

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
