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
One class never reaches the judge at all: a **dependency-bump claim** the
diff's own pin delta answers. "Bump `actions/cache` from 5.0.3 to 5.0.4"
states a pin and a version, and the diff carries the same pin and its own
version — the whole question is a comparison, and a model reading it adds
variance without adding evidence. On this class it added error: eight of the
twelve contradicted claims in the 80-release corpus were bump claims, and
six of those were a note correctly describing one slice of a bump the
release had aggregated (the note says 5.0.3 → 5.0.4, the release moves the
pin 4.3.0 → 5.0.5). That reads as **overtaken**, not as a contradiction, and
it verifies: the bump the note states is in this diff. A pin landing short
of the claimed version, or moving the other way, is `contradicted` on the
same deterministic evidence. Where no pin of that name moved, or the two
versions cannot be ordered, nothing is settled and the claim takes the
ordinary route.

Verdicts that would fail a release (`no-evidence`, `contradicted`) are never
accepted from a single model call, and neither is a `verified` whose evidence
touches sensitive paths (auth/crypto, dependency manifests, CI) or whose claim
names a security fix — a rubber stamp there is the most expensive possible
mistake. Either a stronger **escalation engine** reviews the claim
independently and its verdict wins, or two more independent passes run and
their median decides. `--escalate auto` only builds a second engine for a
local primary, so with the default `--engine claude-cli` the vote path is the
normal one, not the fallback. If a pass fails and the votes come out even,
the stricter middle wins: a lone lenient vote must not be what clears a
release.

`contradicted` is the one exception to that, in the other direction: it needs
a second voter who read the diff the same way. It is the only verdict that
both floors the score at 35 and raises a critical flag, and the even-vote rule
handed it to a single voice. Asked the same question three times, the judge
does not always answer the same thing — sniffnet v1.5.1's "Persian (#1196)"
came back `partial`, `no-evidence` and `contradicted` on three identical runs.
Unseconded, the claim is reported as the milder reading the other passes
agree on, and the reasoning says a pass dissented.

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

The repeat must be *standing* text, i.e. anchor nowhere in this range. A
repeated line that cites a PR or sha shipped here is an assertion about this
release and is checked and scored like any other — both sets of notes come
from the same publisher, so "I said it last time too" cannot be what takes a
claim out of the check. Text that really is standing also documents nothing:
it earns no completeness credit, neither through its anchors nor through
its text.

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

A commit counts as covered when a claim anchors to it (PR reference or
sha), when a verified/partial claim cites mostly its files as evidence, or
when a claim's identifiers — code spans, identifier-shaped terms —
demonstrably appear in the commit's **own diff**, at the same lexical bar
the forward direction calls strong evidence; changelog files never count
as that evidence, so the notes restating themselves cover nothing. That
last route is the cherry-pick rescue (patch-release branches lose PR
references). An earlier version of it compared the claim to the commit's
*subject line* instead — claims describing claims, both written by the
same publisher, so a fabricated note could buy coverage by echoing an
honest subject. Retired: identifiers in the diff are what earn coverage.

### risk — does anything smell?

Starts at 100, minus a penalty per risk flag:

```
risk = max(0, 100 − 25·critical − 10·warn − 0·info)
```

| Severity | Flags |
|---|---|
| **critical** | contradicted claims · undocumented auth/crypto changes *in an otherwise well-documented release* · vague note hiding auth/crypto changes · undocumented new dependency · undocumented non-registry resolution source in a lockfile · undocumented opaque change (binary, minified, no patch) · install-hook change in an undocumented file · first-ever binary artifact (baseline) |
| **warn** | unsupported change claims · undocumented auth/crypto changes where under 60 % of the churn is documented · undocumented CI/build or dependency-manifest changes · vague note hiding notable non-auth changes · documented opaque changes · documented non-registry resolution source in a lockfile · first-time author on sensitive paths (baseline) · author email that this repo's history always saw attributed to a different forge account, on sensitive paths (baseline, API sources — the git email is forgeable, the account is not; an email never linked to any account is an ordinary shape and stays quiet) · claims the judge could not answer for · a patch bump (or a minor bump from 1.0.0 on) whose commits carry an explicit BREAKING CHANGE marker — the version number is a claim too, and here it understates its own commits (marker-based only: a diff is never guessed to be breaking; 0.x minors and prerelease tags are out of scope, as is CalVer wearing semver syntax) |
| **info** | documented new dependencies · release-size anomaly vs. baseline · unchecked claims on a release that cannot be checked here ("not verifiable") · `feat:` commits inside a patch bump, in repos that speak conventional commits (≥ 25 % of subjects) |

**A judge that cannot answer is a finding.** On a transport error or an
answer that is not a verdict, the claim falls back to the deterministic
reading — which is by construction the milder one. Not answering must
therefore never be quietly better for a release than answering, so the
fallback raises a `judge-unavailable` warn flag naming the error and the
number of claims affected.

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

**A hijacked resolution keeps the old name.** Lockfiles are excluded from
the new-dependency check on purpose — the names in them restate the
manifest's. But a resolution hijack changes no name: the manifest keeps
asking for an ordinary package while the lockfile points the download at
someone else's host. Added lines introducing a non-registry source — a
tarball URL outside the known registries, or a `git`/`ssh`/`file`/`link`
reference — raise their own flag. Cargo's `registry+https://github.com/
rust-lang/crates.io-index` is the index, not a hijack, and is exempt. So is a
git source carrying its resolved 40-hex commit: what the flag looks for is a
source whose content can change after review, and a commit id *is* the
content. A branch, a moving tag, a short rev and a tarball URL all still
count — as does the arrival of a new supplier, which is the
new-dependency check's job.

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

The HTML report renders this exact derivation as a waterfall — 100, minus
each weighted component gap, minus the cap that binds — so a score can be
read off without opening this file.

| Overall | Label |
|---|---|
| ≥ 85 | solid |
| 65–84 | minor gaps |
| 45–64 | questionable |
| < 45 | suspicious |
| ≤ 65 | **unverified** — claims dropped out of the ratio because they could not be checked here (below) |

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
can be 80% Python and still ship a release that touches no source. "Source"
is decided by what the file *does*, not by its extension: a dependency
manifest, CI config or install hook counts however it is spelled
(`requirements.txt` decides what runs on the next install), and an SVG is
markup that can carry a script, not a picture.

`out-of-repo` deliberately costs more evidence, because "most claims miss" is
also exactly what a fabricated release looks like. It is claimed only when all
of these hold:

- **more than two thirds** of this release's `change` claims are
  `no-evidence`. A bare majority sat inside the judge's own spread:
  zen-browser 1.21.9b produced 5 and then 6 misses out of 10 checkable claims
  on two runs of the same tag, and a bar at one half is what separates those.
  The bar errs toward not claiming the carve-out, for the reason in the
  paragraph above — which also means a fork release sitting just under it
  reads `questionable` rather than `unverified`, and zen-browser 1.21.9b now
  does
- the last ≥ 3 releases exist as a baseline, and their median **lexical
  coverage** (share of claims whose identifiers appear anywhere in that
  release's diff — deterministic, no judge) is ≤ 25 %
- none of the missing claims is a security claim (an advisory ID, or a
  section named for security): an unprovable security fix is never routine,
  and the baseline that would excuse it is written by the same publisher

Neither kind is claimed while this release itself disagrees with its notes:
a `contradicted` claim or a `critical` flag blocks both, because evidence
*about this release* outranks any statement about its shape.

When either kind holds:

- `no-evidence` claims leave the correctness ratio instead of scoring 0
- the `unsupported-claim` **warn** flag becomes a `not-verifiable` **info**
  flag — no risk penalty
- the label becomes `unverified` and the overall score is **capped at 65**.
  Correctness 100 there means "nothing was found wrong", not "the notes were
  checked and hold" — and a release nobody could check must never read better
  than one that was checked and had gaps
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
