# Security policy

## Reporting

Do not open a public issue. Use GitHub's
[private vulnerability reporting](https://github.com/bmmmm/comparereleaseii/security/advisories/new)
for this repository.

Useful in a report: a reproduction, the impact you see, and the version or
commit. Expect a first response within a week. This is a single-maintainer
project — there is no bounty, and no SLA beyond a genuine effort to fix real
issues quickly and credit you.

## What is in scope

The tool takes untrusted input by design: release notes, diffs and repository
metadata from arbitrary third-party projects, plus responses from local model
servers. Anything that turns that input into more than text is in scope:

- Command injection through repo names, refs, tags or paths reaching `git`, `gh`
  or `claude` subprocess arguments.
- Path traversal via file names from a diff, or through `--notes-file`,
  `--md`, `--json`, `--html` output paths.
- Script injection in the `--html` report — release notes, file paths, tags and
  refs are all attacker-controlled text and must always be escaped, in element
  content and in attribute values alike.
- Prompt injection: text from a release steering the judge's verdict instead of
  being judged.
- Leaking `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `gh` credentials into output,
  reports, the on-disk cache or error messages.
- Reading or writing outside the cache directory
  (`$XDG_CACHE_HOME/comparereleaseii`, else `~/.cache/comparereleaseii`), or
  trusting a cache entry another user could have planted.
- A crafted release that makes the tool report a green verdict on notes it
  should flag — a correctness bug in a security tool is a security bug.

## What is not

- The judge being wrong on ambiguous evidence. That is a
  [wrong verdict](https://github.com/bmmmm/comparereleaseii/issues/new?template=01-wrong-verdict.yml)
  report, and the golden set is how it gets fixed.
- A local model server you pointed the tool at being insecure or hostile.
  `--openai-url` sends judge prompts wherever you tell it to.
- Vulnerabilities in `gh`, `git`, `claude` or Node itself — report those upstream.
