// SPDX-License-Identifier: GPL-3.0-or-later
// Local release gate: check our own changelog notes with our own checker.
// Run `pnpm dogfood` before tagging a release — a trust score below 90 (or
// any contradicted claim) blocks it.
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { extractChangelogSection } from "../src/sources/local.ts";

const MIN_SCORE = 90;

const pkg = JSON.parse(await readFile("package.json", "utf8")) as { version: string };
const changelog = await readFile("CHANGELOG.md", "utf8");
const section = extractChangelogSection(changelog, pkg.version);
if (!section) {
  console.error(
    `CHANGELOG.md has no section for ${pkg.version} — write the release notes before releasing.`,
  );
  process.exit(2);
}

const dir = await mkdtemp(join(tmpdir(), "comparereleaseii-dogfood-"));
const notesFile = join(dir, "notes.md");
const jsonFile = join(dir, "report.json");
await writeFile(notesFile, section);

const res = spawnSync(
  process.execPath,
  [
    "src/cli.ts",
    "--local", ".",
    "--head", "HEAD",
    "--notes-file", notesFile,
    "--json", jsonFile,
    "--fail-on", "contradicted",
  ],
  { stdio: ["ignore", "inherit", "inherit"] },
);
if (res.status !== 0) {
  console.error("\ndogfood gate: the check itself failed — no release.");
  process.exit(res.status ?? 2);
}

const report = JSON.parse(await readFile(jsonFile, "utf8")) as {
  metrics: { scores: { overall: number; label: string } };
};
const { overall, label } = report.metrics.scores;
if (overall < MIN_SCORE) {
  console.error(
    `\ndogfood gate: trust score ${overall} (${label}) is below ${MIN_SCORE} — fix the notes (or the code) before releasing.`,
  );
  process.exit(1);
}
console.error(`\ndogfood gate: trust score ${overall} (${label}) — good to release.`);
