// SPDX-License-Identifier: GPL-3.0-or-later
import { c } from "./util.ts";
import type { ClaimResult, Report, UnverifiableKind, Verdict } from "./types.ts";

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
  if (r.evidence.functions?.length) {
    parts.push(`fns: ${r.evidence.functions.slice(0, 4).join(", ")}`);
  }
  return parts.join(" · ");
}

const HEADING: Record<UnverifiableKind, string> = {
  sourceless: "Not verifiable",
  "out-of-repo": "Changes outside this repo",
};

/** Why this individual claim went unchecked — shown under each no-evidence line. */
const CLAIM_NOTE: Record<UnverifiableKind, string> = {
  sourceless: "No source file is part of this release's diff.",
  "out-of-repo": "This claim's code is not part of this repo's diff.",
};

/**
 * Claims were made, but the release's shape means they could not be checked
 * here. Reported as its own category so a docs-only or fork release does not
 * read like a fabricated one. Null when the claims were genuinely checkable.
 */
export function unverifiableNote(
  report: Report,
): { heading: string; reason: string; claimNote: string } | null {
  const u = report.metrics.unverifiable;
  if (!u || !report.results.some((r) => r.claim.kind === "change")) return null;
  return { heading: HEADING[u.kind], reason: u.reason, claimNote: CLAIM_NOTE[u.kind] };
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

  const note = unverifiableNote(report);
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
      if (note && r.verdict === "no-evidence") {
        console.log(c.dim(`    ${note.claimNote}`));
      }
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

  const s = report.metrics.scores;
  const scoreColor = s.overall >= 85 ? c.green : s.overall >= 65 ? c.yellow : c.red;
  console.log(
    `${c.bold("Trust score:")} ${scoreColor(`${s.overall}/100 (${s.label})`)} — ` +
      c.dim(
        `correctness ${s.correctness} · completeness ${s.completeness ?? "n/a"} · risk ${s.risk}`,
      ),
  );
  if (note) {
    console.log(`${c.bold(`${note.heading}:`)} ${c.cyan(note.reason)}`);
  }
  const b = report.metrics.baseline;
  if (b) {
    console.log(
      c.dim(
        `Baseline (${b.releases} releases): median churn ±${b.medianChurn} · median note coverage ${Math.round(b.medianAnchoredCoverage * 100)}%`,
      ),
    );
  }
  const ctx = report.metrics.context;
  if (ctx.languages) {
    const langs = Object.entries(ctx.languages)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([l, b]) => `${l} ${((b / (ctx.codeBytes || 1)) * 100).toFixed(0)}%`)
      .join(" · ");
    console.log(
      c.dim(
        `Repo: ${langs} · ~${((ctx.codeBytes || 0) / 1_000_000).toFixed(1)} MB code` +
          (ctx.releaseCadenceDays ? ` · release cadence ~${ctx.releaseCadenceDays} d` : ""),
      ),
    );
  }
  if (report.metrics.flags.length) {
    console.log(c.bold("\nRisk flags:"));
    for (const f of report.metrics.flags) {
      const mark =
        f.severity === "critical" ? c.red("‼") : f.severity === "warn" ? c.yellow("!") : c.cyan("i");
      console.log(`  ${mark} ${f.message}`);
      if (f.files.length) console.log(c.dim(`    ${f.files.slice(0, 4).join(", ")}`));
    }
  }

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
      if (u.suggestedNote) {
        console.log(c.dim(`    suggested note: "${u.suggestedNote}"`));
      }
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
  const s = report.metrics.scores;
  const note = unverifiableNote(report);
  const lines: string[] = [
    `# Release-note fact check: ${report.repoLabel} ${report.baseRef} → ${report.headRef}`,
    "",
    `Judge engine: \`${report.engine}\` · ${report.stats.commits} commits, ${report.stats.files} files, +${report.stats.additions}/−${report.stats.deletions}`,
    "",
    `**Trust score: ${s.overall}/100 (${s.label})** — correctness ${s.correctness} · completeness ${s.completeness ?? "n/a"} · risk ${s.risk}`,
    "",
    ...(note ? [`> **${note.heading}** — ${note.reason}`, ""] : []),
    ...(report.metrics.flags.length
      ? [
          "## Risk flags",
          "",
          ...report.metrics.flags.map(
            (f) =>
              `- **${f.severity}** ${f.message}${f.files.length ? ` (${f.files.slice(0, 4).join(", ")})` : ""}`,
          ),
          "",
        ]
      : []),
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
      if (note && r.verdict === "no-evidence") {
        lines.push(`  - not verifiable: ${note.claimNote.replace(/\.$/, "").toLowerCase()}`);
      }
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
      if (u.suggestedNote) {
        lines.push(`  - suggested note: "${u.suggestedNote}"`);
      }
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
  // A diff with no source files could not have supported the claims in the
  // first place — failing the build on that would punish the release shape,
  // not the notes.
  if (failOn === "no-evidence" && counts["no-evidence"] > 0 && !unverifiableNote(report)) return 1;
  return 0;
}
