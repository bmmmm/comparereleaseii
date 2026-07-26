# Writing release notes that hold up

comparereleaseii's default job is detecting drift after the fact: a claim
that outran the diff, a change that shipped with no note at all. This page
is the other direction — what to do *before* publishing so there is nothing
to detect. Every rule below maps to something the checker actually measures
(see [SCORING.md](../SCORING.md) for the exact formulas); this is that
scoring logic read as instructions instead of as a grade.

## Rules for AI coding agents

Paste this section into your project's `AGENTS.md` or `CLAUDE.md` so any
coding agent that touches release notes or a changelog follows it — or seed
it directly:

    comparerelease guidelines >> AGENTS.md

When writing or editing a release note or changelog entry:

- Name the mechanism, not just the outcome ("the count-and-increment in
  `register_access()` is now a single atomic SQL UPDATE", not "fixed a
  bypass").
- Give any commit touching auth, crypto, CI/build config, or a dependency
  manifest its own explicit line, even a one-sentence one, even if the diff
  itself is small.
- Never write a placeholder note ("misc fixes", "various improvements") for
  a commit with any user-visible effect. A placeholder is only correct for
  genuinely internal changes (formatting, comments, a behavior-preserving
  refactor) — say that explicitly instead of being vague.
- Before claiming something was removed, disabled, or no longer happens,
  grep the code for it. A removal claim the diff contradicts is the most
  damaging kind of release note there is.
- Before considering the notes finished, run this tool against your own
  diff and draft, and treat "Undocumented changes" in its output as
  unfinished work, not as informational:

      comparerelease --local . --base <previous-tag> --head <ref> \
        --notes-file <your-draft> --suggest

- Do not stop until that run reports zero undocumented commits on a
  sensitive path (auth, crypto, CI/build, dependency manifests) and no
  contradicted claims — both cap the trust score regardless of everything
  else. Full rationale for each rule:
  https://github.com/bmmmm/comparereleaseii/blob/main/docs/writing-release-notes.md

## 1. State the mechanism, not just the outcome

The checker verifies a claim by finding diff evidence for it. A claim that
only asserts an outcome ("Fixed a security issue") gives the judge nothing
concrete to match against and scores `partial` at best. A claim that names
what changed gives it something to check — and gives your reader something
to trust:

- Weak: *"Fixed a bypass in access checks."*
- Strong: *"Fixed a bypass in access checks — the count-and-increment in
  `register_access()` is now a single atomic SQL `UPDATE`, closing a race
  where two concurrent requests could both pass the limit check."*

The strong version is what a `verified (0.95)` verdict looks like in
practice — see the vaultwarden example in the [README](../README.md).

## 2. Every sensitive-path change gets an explicit line

Auth, crypto, CI/build config, and dependency manifests are scored
differently on purpose: an undocumented change there is a **critical** risk
flag, not a warning, because that is exactly the profile of a compromised
release. If a commit touches one of these paths, it needs its own note even
if it's small — "bump `jsonwebtoken` to 9.0.2 (patches a signature-bypass
advisory)" costs one line and removes a critical flag.

Routine CI/lockfile churn with no behavior change is a `warn`, not
`critical` — you don't have to narrate every dependency bump, but silently
*adding* a new dependency (not just bumping one) is still worth a line: it
expands what a security review has to cover.

## 3. Don't let a vague entry hide a real change

"Various fixes and improvements" is transparently true and scores badly —
not because vague notes are penalized directly, but because the checker's
surplus audit looks at what a vague note's linked commit actually contains
and calls out anything notable it hides (new endpoints, new config options,
behavior changes). If a bullet needs more than one line to stay honest, give
it the line. If a commit genuinely has nothing user-facing (a comment fix, a
formatting pass), a vague note is the *correct* choice — the audit only
flags what should have been said and wasn't.

## 4. Auto-generated PR lists are a floor, not a ceiling

GitHub's "Title by @user in #N" release-note generator produces claims that
are true by construction (they restate the commit they link), so the
checker weights them at ¼ in the correctness score — they can't manufacture
a high score by themselves. They're a fine starting point (they guarantee
every PR is at least mentioned) but the score rewards going back and turning
the ones that matter into real, mechanism-stating sentences per rule 1.

## 5. Check completeness, not just claims

The reverse (completeness) check answers a different question than "is this
note true": *"does anything in the diff have no note at all?"* This is
where most silent drift hides — not a lie, just an omission. Run it before
publishing, not after:

```console
$ comparerelease --local . --base v1.2.0 --head HEAD --notes-file DRAFT.md
```

against your own working draft, and read the "Undocumented changes" list.
Add `--suggest` and the checker drafts a starting line for the highest-churn
gaps, drawn from the actual diff of each commit:

```console
$ comparerelease --local . --notes-file DRAFT.md --suggest
Undocumented changes — 2 commit(s) not covered by any note:
  ! a1b2c3d4 refactor session handling (+340/−210, 5 files)
    suggested note: "Session tokens are now rotated on privilege escalation, not just on login."
  ! e5f6a7b8 bump lockfile (+12/−4, 1 files)
    suggested note: "Internal change — no user-facing impact to document."
```

Treat these as drafts to edit, not text to paste — the judge only sees the
diff, not your intent, and can misjudge user-facing impact on unfamiliar
code. But an inaccurate draft is still faster to correct than a blank line
is to notice is missing; that's the whole value of the reverse check.
`--suggest-limit` (default 15) bounds it to the highest-churn gaps so the
extra judge calls stay cheap on large releases.

## 6. Let a contradiction be a contradiction

If a claim says something was removed and the code still registers it, that
is not a partial-credit situation — it caps the whole release's score
(≤35, see SCORING.md). Before publishing a claim about removal or disabling
a feature, grep the code for the thing you're claiming is gone. This is the
single check most worth doing by hand: it's cheap, and it's the one mistake
the score treats as unforgivable.

## In short

Write claims that name a mechanism, don't skip sensitive paths, don't let
"misc fixes" hide something real, and run the reverse check (with
`--suggest` for a first draft of the gaps) before you publish. That's the
whole difference between a `solid` (≥85) release and a `minor gaps` one —
and it's also just what a release note that a user can trust looks like.
