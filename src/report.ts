// SPDX-License-Identifier: GPL-3.0-or-later
import { c } from "./util.ts";
import type { ClaimResult, Report, Verdict } from "./types.ts";

const SYMBOL: Record<Verdict, string> = {
  verified: "✔",
  partial: "◐",
  "no-evidence": "?",
  contradicted: "✘",
  skipped: "·",
};

const COLOR: Record<Verdict, (s: string) => string> = {
  verified: c.green,
  partial: c.yellow,
  "no-evidence": c.magenta,
  contradicted: c.red,
  skipped: c.gray,
};

function evidenceLine(r: ClaimResult): string {
  const parts: string[] = [r.evidence.methods.join("+")];
  if (r.evidence.commitShas.length) {
    parts.push(
      r.evidence.commitShas
        .slice(0, 2)
        .map((s) => s.slice(0, 8))
        .join(",") + (r.evidence.commitShas.length > 2 ? "…" : ""),
    );
  }
  if (r.evidence.files.length) {
    const shown = r.evidence.files.slice(0, 3).join(", ");
    const more = r.evidence.files.length - 3;
    parts.push(shown + (more > 0 ? ` +${more} more` : ""));
  }
  return parts.join(" · ");
}

export function countVerdicts(results: ClaimResult[]): Record<Verdict, number> {
  const counts: Record<Verdict, number> = {
    verified: 0,
    partial: 0,
    "no-evidence": 0,
    contradicted: 0,
    skipped: 0,
  };
  for (const r of results) counts[r.verdict]++;
  return counts;
}

export function printTerminal(report: Report): void {
  const { stats } = report;
  console.log(
    `\n${c.bold("comparereleaseii")} — release-note fact check\n` +
      `${c.cyan(report.repoLabel)}  ${report.baseRef} → ${report.headRef}  ` +
      c.dim(
        `(${stats.commits} commits, ${stats.files} files, +${stats.additions}/−${stats.deletions})`,
      ) +
      `\n${c.dim(`judge engine: ${report.engine}`)}\n`,
  );

  let section = "";
  for (const r of report.results) {
    if (r.claim.section !== section) {
      section = r.claim.section;
      console.log(c.bold(`\n${section}`));
    }
    const color = COLOR[r.verdict];
    const text = r.claim.text.length > 110 ? r.claim.text.slice(0, 107) + "…" : r.claim.text;
    console.log(`  ${color(SYMBOL[r.verdict])} ${text}`);
    if (r.verdict !== "skipped") {
      console.log(
        `    ${color(r.verdict)} ${c.dim(`(${r.confidence.toFixed(2)}) · ${evidenceLine(r)}`)}`,
      );
      if (r.reasoning) console.log(c.dim(`    ${r.reasoning}`));
    }
  }

  const counts = countVerdicts(report.results);
  console.log(
    `\n${c.bold("Summary:")} ${report.results.length} claims — ` +
      [
        c.green(`${counts.verified} verified`),
        c.yellow(`${counts.partial} partial`),
        c.magenta(`${counts["no-evidence"]} no-evidence`),
        c.red(`${counts.contradicted} contradicted`),
        c.gray(`${counts.skipped} skipped`),
      ].join(", "),
  );

  if (!report.reverseChecked) {
    console.log(c.dim("\nCompleteness check skipped (--no-reverse)."));
  } else if (report.uncovered.length) {
    console.log(
      c.bold(`\nUndocumented changes`) +
        c.dim(` — ${report.uncovered.length} commit(s) not covered by any note:`),
    );
    for (const u of report.uncovered.slice(0, 10)) {
      console.log(
        `  ${c.yellow("!")} ${u.commit.sha.slice(0, 8)} ${u.commit.subject} ` +
          c.dim(`(+${u.additions}/−${u.deletions}, ${u.fileCount} files)`),
      );
    }
    if (report.uncovered.length > 10) {
      console.log(c.dim(`  … and ${report.uncovered.length - 10} more`));
    }
  } else {
    console.log(c.green("\nAll commits in the range are covered by the release notes."));
  }

  for (const w of report.warnings) console.log(c.yellow(`\nwarning: ${w}`));
}

export function toMarkdown(report: Report): string {
  const counts = countVerdicts(report.results);
  const lines: string[] = [
    `# Release-note fact check: ${report.repoLabel} ${report.baseRef} → ${report.headRef}`,
    "",
    `Judge engine: \`${report.engine}\` · ${report.stats.commits} commits, ${report.stats.files} files, +${report.stats.additions}/−${report.stats.deletions}`,
    "",
    "## Summary",
    "",
    "| Verdict | Count |",
    "|---|---|",
    ...(["verified", "partial", "no-evidence", "contradicted", "skipped"] as Verdict[]).map(
      (v) => `| ${v} | ${counts[v]} |`,
    ),
    "",
    "## Claims",
  ];
  let section = "";
  for (const r of report.results) {
    if (r.claim.section !== section) {
      section = r.claim.section;
      lines.push("", `### ${section}`, "");
    }
    lines.push(`- **${r.verdict}** (${r.confidence.toFixed(2)}) — ${r.claim.text}`);
    if (r.verdict !== "skipped") {
      const ev = evidenceLine(r);
      if (ev) lines.push(`  - evidence: ${ev}`);
      if (r.reasoning) lines.push(`  - ${r.reasoning}`);
    }
  }
  lines.push("", "## Undocumented changes", "");
  if (!report.reverseChecked) {
    lines.push("Completeness check skipped (--no-reverse).");
  } else if (!report.uncovered.length) {
    lines.push("None — all commits in the range are covered by the release notes.");
  } else {
    for (const u of report.uncovered) {
      lines.push(
        `- \`${u.commit.sha.slice(0, 8)}\` ${u.commit.subject} (+${u.additions}/−${u.deletions}, ${u.fileCount} files)`,
      );
    }
  }
  if (report.warnings.length) {
    lines.push("", "## Warnings", "", ...report.warnings.map((w) => `- ${w}`));
  }
  return lines.join("\n") + "\n";
}

export function exitCode(report: Report, failOn: "none" | "contradicted" | "no-evidence"): number {
  if (failOn === "none") return 0;
  const counts = countVerdicts(report.results);
  if (counts.contradicted > 0) return 1;
  if (failOn === "no-evidence" && counts["no-evidence"] > 0) return 1;
  return 0;
}
