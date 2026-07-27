# Demo — real output of a real watch pass

Everything in this directory is real output of `comparerelease watch`, run
on 2026-07-27 against five public repositories with the `claude-cli` judge
(Haiku): the dashboard (`index.html`), one Atom feed (`feed.xml`), and per
repo a history page plus the HTML and Markdown report of every checked
release. Serve the directory statically — GitHub Pages, any web server, or
a plain browser — and every link works. Two things are deliberately not
committed because they carry upstream commit-author e-mail addresses,
which this demo has no business republishing: the `--json` reports, and
the author-ledger arrays inside `watch-state.json` (their identity keys
are e-mails; the rendered author tables show only names and forge
handles). A reproduced run rebuilds the ledger from its own checks.

Reproduce it from a checkout:

```console
$ node src/cli.ts watch --config docs/demo/demo-watch.json
```

`demo-watch.json` and `watch-state.json` are the exact config and state the
pass used. The state was seeded with `lastTag`/`lastPublishedAt` set a few
releases back for three of the repos — the ordinary "the watcher was
installed a while ago" catch-up — so the history pages have a real series
to show; every score, verdict and flag is what the tool produced against
the live repositories. A re-run only checks releases published since.
