# Demo — real output of a real watch pass

Everything in this directory is real output of `comparerelease watch`, run
on 2026-07-27/28 against five public repositories with the `claude-cli`
judge (Haiku): the dashboard (`index.html`), one Atom feed (`feed.xml`),
and per repo a history page plus the HTML and Markdown report of every
checked release. Serve the directory statically — GitHub Pages, any web
server, or a plain browser — and every link works.

Two edits keep upstream commit-author e-mail addresses out of this public
directory, because a machine-readable e-mail list at a stable URL is a
harvest surface this demo has no business being: the `--json` reports are
not committed (`.gitignore` enforces it), and the author-ledger identity
keys inside `watch-state.json` are replaced with short hashes by
`scripts/redact-demo-state.ts` — the ledger itself stays, so the state and
the rendered pages agree, and the author tables show only names and forge
handles, which is all they ever render. Every score, verdict, flag and
author fact is untouched tool output.

Reproduce it from a checkout:

```console
$ node src/cli.ts watch --config docs/demo/demo-watch.json
```

`demo-watch.json` and `watch-state.json` are the config and (redacted)
state of the committed pass; a re-run only checks releases published since
and regenerates the pages byte-identically apart from timestamps. The
original state was seeded with `lastTag`/`lastPublishedAt` set a few
releases back for three of the repos — the ordinary "the watcher was
installed a while ago" catch-up — so the history pages have a real series
to show. Refreshing the demo means: reseed or keep the state, run the
watch, run `node scripts/redact-demo-state.ts`, commit.
