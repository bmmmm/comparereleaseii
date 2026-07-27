# Demo — real output of a real watch pass

Everything in this directory is unedited output of `comparerelease watch`,
run on 2026-07-27 against five public repositories with the `claude-cli`
judge (Haiku): the dashboard (`index.html`), one Atom feed (`feed.xml`),
and per repo a history page plus the full HTML/Markdown/JSON report of
every checked release. Serve the directory statically — GitHub Pages, any
web server, or a plain browser — and every link works.

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
