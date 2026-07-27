// SPDX-License-Identifier: GPL-3.0-or-later
// The demo commits its watch state so the pass is reproducible — but the
// author ledger's identity keys are upstream commit-author e-mails, and a
// machine-readable e-mail list at a stable URL is a harvest surface the
// demo has no business being. This replaces every ledger key with a short
// hash: the state stays internally consistent (pages regenerate with the
// same author tables — the key is never rendered), while the e-mails stay
// out of the repository. Run it after every demo refresh, before
// committing; the demo README names it as part of the flow.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const statePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "docs",
  "demo",
  "watch-state.json",
);
const state = JSON.parse(readFileSync(statePath, "utf8"));
let redacted = 0;
for (const repo of Object.values(state.repos) as Array<{
  authors?: Array<{ key: string }>;
}>) {
  for (const a of repo.authors ?? []) {
    if (a.key.startsWith("redacted:")) continue;
    a.key = `redacted:${createHash("sha256").update(a.key).digest("hex").slice(0, 12)}`;
    redacted++;
  }
}
writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
console.log(`${statePath}: ${redacted} author key(s) redacted`);
