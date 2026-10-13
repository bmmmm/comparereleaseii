// SPDX-License-Identifier: GPL-3.0-or-later
//
// The counterfactual behind a field case: one findings call over exactly the
// files you name — would the judge have described the change, had the
// budget reached the file? The prompt is the one summarizeShipped builds
// (blind to notes and commit messages); only the file selection is yours.
// openai/codex rust-v0.157.0 answered it first: the pass read 7 of 1091
// files and no finding named the daemon flip; given the three #47179 files
// alone, Haiku emitted `breaking/user` "DaemonAutoStart … default_enabled =
// true" at once — the budget, not the model, was the miss.
//
//   node scripts/findings-counterfactual.ts <owner/repo> --tag <tag> --base <base> \
//     --files <path,path,…> [--model haiku]
//
// Needs `gh` (the release range comes from the forge) and the `claude` CLI.
// One judge call, no cache — the answer should be fresh.
import { parseArgs } from "node:util";
import { loadGithubReleaseData } from "../src/check.ts";
import { buildFindingsPrompt, makeClaudeCliEngine, parseFindingsOutput } from "../src/judge.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    tag: { type: "string" },
    base: { type: "string" },
    files: { type: "string" },
    model: { type: "string", default: "haiku" },
  },
});
const repo = positionals[0];
if (!repo || !values.tag || !values.base || !values.files) {
  console.error(
    "Usage: node scripts/findings-counterfactual.ts <owner/repo> --tag <tag> --base <base> --files <a,b,…> [--model haiku]",
  );
  process.exit(2);
}

const wanted = new Set(values.files.split(",").map((s) => s.trim()).filter(Boolean));
const { data } = await loadGithubReleaseData(repo, { tag: values.tag, base: values.base });
const hunks = data.files
  .filter((f) => wanted.has(f.path) && f.patch)
  .map((f) => ({ path: f.path, hunk: f.patch! }));
const missing = [...wanted].filter((p) => !hunks.some((h) => h.path === p));
if (missing.length) console.error(`not in the release diff (or no patch): ${missing.join(", ")}`);
if (!hunks.length) {
  console.error("none of the named files carries a patch in this range — nothing to ask.");
  process.exit(1);
}

const prompt = buildFindingsPrompt({
  repoLabel: data.repoLabel,
  baseRef: data.baseRef,
  headRef: data.headRef,
  subsystem: `(counterfactual: ${hunks.length} named file${hunks.length === 1 ? "" : "s"})`,
  filesShown: hunks.length,
  filesTotal: hunks.length,
  hunks,
});
console.error(
  `asking ${values.model} about ${hunks.map((h) => `${h.path} (${h.hunk.length} chars)`).join(", ")}`,
);
const findings = parseFindingsOutput(await makeClaudeCliEngine(values.model).judge(prompt));

// One write, no process.exit after it (test/stdout.test.ts).
console.log(
  findings.length
    ? findings.map((f) => `- [${f.kind}/${f.audience}] ${f.text} (${f.files.join(", ")})`).join("\n")
    : "(no findings)",
);
