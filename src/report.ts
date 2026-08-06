// SPDX-License-Identifier: GPL-3.0-or-later
import { c, stripControl } from "./util.ts";
import { SCORE_MINOR, SCORE_SOLID } from "./theme.ts";
import { surfaceLine } from "./substance.ts";
import type {
  Audience,
  BumpJoin,
  ClaimResult,
  ComponentCheck,
  Finding,
  FindingKind,
  PinBump,
  Report,
  UnverifiableKind,
  Verdict,
} from "./types.ts";

// Everything printed to the terminal that originated outside this tool —
// notes, commit subjects, judge reasoning, file paths — goes through this.
// git forbids control characters in ref names, but not in messages or notes.
// Newlines collapse too: every foreign string here renders on one line, and
// a kept newline would let judge output forge whole report lines (a fake
// "Trust score: 100/100" among them).
const safe = (s: string): string => stripControl(s).replace(/\n+/g, " ");

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
  return safe(parts.join(" · "));
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
 *
 * Gated on the score's own label, not re-derived from claim kinds — the two
 * must never disagree about whether this release is "unverified", or the
 * report can show a clean score right next to a "not verifiable" note.
 */
export function unverifiableNote(
  report: Report,
): { heading: string; reason: string; claimNote: string } | null {
  const u = report.metrics.unverifiable;
  if (!u || report.metrics.scores.label !== "unverified") return null;
  return { heading: HEADING[u.kind], reason: u.reason, claimNote: CLAIM_NOTE[u.kind] };
}

/** Claims repeated verbatim from the base release, grouped by that release. */
export function carriedOver(report: Report): { baseRef: string; count: number } | null {
  const carried = report.results.filter((r) => r.claim.carriedOverFrom);
  if (!carried.length) return null;
  return { baseRef: carried[0].claim.carriedOverFrom!, count: carried.length };
}

/** The sub-check summary of a first-party pin, when one ran for it. */
function componentFor(
  report: Report,
  pin: PinBump,
): ComponentCheck | undefined {
  return report.components?.find(
    (m) => m.repo === pin.repo && m.from === pin.from && m.to === pin.to,
  );
}

/** Summary bits of a component sub-check — one source for every renderer. */
export function componentBits(m: ComponentCheck): string[] {
  const bits: string[] = [];
  if (m.score !== undefined) bits.push(`score ${m.score}/100 (${m.scoreLabel})`);
  if (m.claims) {
    const order: Verdict[] = ["verified", "partial", "no-evidence", "contradicted", "skipped"];
    const total = order.reduce((sum, v) => sum + m.claims![v], 0);
    const parts = order.filter((v) => m.claims![v] > 0).map((v) => `${m.claims![v]} ${v}`);
    bits.push(`${total} claims — ${parts.join(", ")}`);
  }
  if (m.noNotes) bits.push("no release notes to check — surface only");
  if (m.uncovered !== undefined) bits.push(`${m.uncovered} undocumented`);
  if (m.stats) {
    bits.push(`${m.stats.commits} commits, +${m.stats.additions}/−${m.stats.deletions}`);
  }
  if (m.truncated) bits.push("diff truncated");
  return bits;
}

/**
 * One bump claim as every renderer shows it: what the note said, what the
 * diff moved, and the file that decided it. The overtaken line carries both
 * numbers, because that difference IS the finding — "the note says 5.0.4,
 * the release moves it 4.3.0 → 5.0.5" tells a reader in one line what the
 * verdict alone cannot.
 */
export interface BumpLine {
  status: BumpJoin;
  name: string;
  /** What the note names, `from → to` when it named both sides. */
  claimed: string;
  /** What the diff moved this pin through. Absent when nothing matched. */
  observed?: string;
  file?: string;
  /** The move is in the named commit's diff, not in the release diff. */
  viaCommit?: boolean;
}

const BUMP_LABEL: Record<BumpJoin, string> = {
  confirmed: "confirmed",
  overtaken: "overtaken by the release",
  contradicted: "contradicted",
  unmatched: "no pin of that name in the diff",
};

/** Bump claims as one class: the counts, and the lines worth reading. */
export function bumpSummary(
  report: Report,
): { total: number; counts: string; lines: BumpLine[] } | null {
  const bumps = report.reconciliation?.bumps;
  if (!bumps?.length) return null;
  const order: BumpJoin[] = ["confirmed", "overtaken", "contradicted", "unmatched"];
  const counts = order
    .map((s) => ({ s, n: bumps.filter((b) => b.status === s).length }))
    .filter(({ n }) => n > 0)
    .map(({ s, n }) => `${n} ${BUMP_LABEL[s]}`)
    .join(", ");
  // Confirmed lines say nothing a reader has to act on — the count carries
  // them. Everything else is a difference between the note and the diff.
  const lines = bumps
    .filter((b) => b.status !== "confirmed")
    .map((b): BumpLine => ({
      status: b.status,
      name: b.claimed.name,
      claimed: b.claimed.from ? `${b.claimed.from} → ${b.claimed.to}` : b.claimed.to,
      observed: b.observed ? `${b.observed.from} → ${b.observed.to}` : undefined,
      file: b.observed?.file,
      viaCommit: b.observed?.viaCommit,
    }));
  return { total: bumps.length, counts, lines };
}

/** Severity order shared by every renderer — breaking first, internal last. */
const KIND_ORDER: FindingKind[] = [
  "breaking",
  "security",
  "behavior",
  "feature",
  "internal",
];

const KIND_RANK = new Map(KIND_ORDER.map((k, i) => [k, i]));

export interface LensView {
  /** Findings this lens shows, severity order (stable within a kind). */
  shown: Finding[];
  /** Non-internal findings for other audiences the lens folded away. */
  otherAudiences: number;
  /** Internal findings — visible only without a lens. */
  internalHidden: number;
}

/**
 * The lens is a filter over finding audiences, never over content: a lens
 * shows its own audience plus `everyone` (security pierces every lens —
 * the S4a decision), folds other audiences behind a count, and hides
 * `internal` findings (invisible outside the codebase by definition).
 * Without a lens everything renders, internal last.
 */
export function lensFindings(findings: Finding[], lens: Audience | undefined): LensView {
  const bySeverity = [...findings].sort(
    (a, b) => (KIND_RANK.get(a.kind) ?? 9) - (KIND_RANK.get(b.kind) ?? 9),
  );
  if (!lens) {
    return { shown: bySeverity, otherAudiences: 0, internalHidden: 0 };
  }
  const nonInternal = bySeverity.filter((f) => f.kind !== "internal");
  const shown = nonInternal.filter((f) => f.audience === lens || f.audience === "everyone");
  return {
    shown,
    otherAudiences: nonInternal.length - shown.length,
    internalHidden: bySeverity.length - nonInternal.length,
  };
}

/** The declared remainder of the findings pass, one line for every renderer. */
export function budgetLine(report: Report): string | null {
  const b = report.findings?.budget;
  if (!b) return null;
  const unread = b.filesTotal - b.filesRead;
  return (
    `read ${b.subsystemsRead}/${b.subsystemsTotal} subsystems, ${b.filesRead}/${b.filesTotal} files in detail ` +
    `(${b.usedChars.toLocaleString("en-US")}/${b.maxChars.toLocaleString("en-US")} chars)` +
    (unread > 0 ? ` — ${unread} file(s) not read in detail` : "")
  );
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
      `${c.cyan(safe(report.repoLabel))}  ${safe(report.baseRef)} → ${safe(report.headRef)}  ` +
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
      console.log(c.bold(`\n${safe(section)}`));
    }
    const color = COLOR[r.verdict];
    const raw = r.claim.text.length > 110 ? r.claim.text.slice(0, 107) + "…" : r.claim.text;
    console.log(`  ${color(SYMBOL[r.verdict])} ${safe(raw)}`);
    if (r.verdict !== "skipped") {
      console.log(
        `    ${color(r.verdict)} ${c.dim(`(${r.confidence.toFixed(2)}) · ${evidenceLine(r)}`)}`,
      );
      if (r.reasoning) console.log(c.dim(`    ${safe(r.reasoning)}`));
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

  const carried = carriedOver(report);
  if (carried) {
    console.log(
      c.dim(
        `${carried.count} claim(s) carried over verbatim from ${safe(carried.baseRef)} — standing text, not scored.`,
      ),
    );
  }

  const s = report.metrics.scores;
  // Unverified gets its own color, never the same bucket a genuinely-scored
  // 65-84 renders in — a capped "we don't know" must not read as "checked,
  // minor gaps" just because it landed on the same number.
  const scoreColor =
    s.label === "unverified"
      ? c.cyan
      : s.overall >= SCORE_SOLID
        ? c.green
        : s.overall >= SCORE_MINOR
          ? c.yellow
          : c.red;
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
      console.log(`  ${mark} ${safe(f.message)}`);
      if (f.files.length) console.log(c.dim(`    ${safe(f.files.slice(0, 4).join(", "))}`));
    }
  }

  if (report.promises?.length) {
    console.log(c.bold("\nPromises from earlier releases:"));
    for (const p of report.promises) {
      const mark =
        p.status === "kept"
          ? c.green("✓")
          : p.status === "broken"
            ? c.red("✗")
            : p.status === "stale"
              ? c.dim("∅")
              : c.dim("…");
      console.log(`  ${mark} ${p.status} (${safe(p.from)}) ${safe(p.text.slice(0, 100))}`);
      console.log(c.dim(`    ${safe(p.note)}${p.files.length ? ` — ${safe(p.files.slice(0, 3).join(", "))}` : ""}`));
    }
  }

  const surf = report.surface;
  if (surf?.categories.length) {
    console.log(
      c.bold("\nWhat actually shipped") + c.dim(" — read deterministically off the diff:"),
    );
    console.log(
      "  " +
        surf.categories
          .map((t) => `${t.files} ${t.category} ${c.dim(`(+${t.additions}/−${t.deletions})`)}`)
          .join(" · "),
    );
    if (surf.symbols.length) {
      console.log(
        c.dim(
          `  symbols: ${safe(surf.symbols.join(", "))}${surf.moreSymbols ? ` (+${surf.moreSymbols} more)` : ""}`,
        ),
      );
    }
    const cfg = [
      ...surf.envVars.added.map((v) => `+env ${v}`),
      ...surf.envVars.removed.map((v) => `−env ${v}`),
      ...surf.cliFlags.added.map((v) => `+flag ${v}`),
      ...surf.cliFlags.removed.map((v) => `−flag ${v}`),
      ...surf.configKeys.added.map((v) => `+key ${v}`),
      ...surf.configKeys.removed.map((v) => `−key ${v}`),
    ];
    if (cfg.length) {
      const shown = cfg.slice(0, 10);
      console.log(
        c.dim(
          `  config surface: ${safe(shown.join(", "))}${cfg.length > shown.length ? ` … +${cfg.length - shown.length} more` : ""}`,
        ),
      );
    }
    if (surf.migrations.length) {
      console.log(
        c.dim(
          `  migrations: ${safe(surf.migrations.slice(0, 3).join(", "))}${surf.migrations.length > 3 ? ` +${surf.migrations.length - 3} more` : ""}`,
        ),
      );
    }
    if (surf.apiRoutes.length) {
      console.log(c.dim(`  api surface: ${surf.apiRoutes.length} route/handler file(s)`));
    }
  }

  const fin = report.findings;
  if (fin) {
    const kindColor: Record<FindingKind, (s: string) => string> = {
      breaking: c.red,
      security: c.red,
      behavior: c.yellow,
      feature: c.green,
      internal: c.gray,
    };
    console.log(
      c.bold("\nFindings") + c.dim(" — the diff as read by the judge, blind to commit messages:"),
    );
    const budget = budgetLine(report);
    if (budget) console.log(c.dim(`  ${budget}`));
    if (fin.summary) console.log(`  ${safe(fin.summary)}`);
    const lens = report.audience;
    const view = lensFindings(fin.findings, lens);
    if (lens) {
      console.log(c.dim(`  lens: ${lens} — security findings show under every lens`));
    }
    const rec = report.reconciliation;
    const confirmedIdx = new Set(rec?.confirmed.map((l) => l.finding) ?? []);
    const undocumentedIdx = new Set(rec?.undocumented ?? []);
    for (const f of view.shown) {
      const fi = fin.findings.indexOf(f);
      const tag = confirmedIdx.has(fi)
        ? c.dim(" · claimed")
        : undocumentedIdx.has(fi)
          ? c.yellow(" · never claimed")
          : "";
      console.log(`  ${kindColor[f.kind](f.kind)} ${c.dim(`[${f.audience}]`)} ${safe(f.text)}${tag}`);
      if (f.files.length) {
        const files = f.files.slice(0, 3).join(", ");
        const more = f.files.length - 3;
        console.log(c.dim(`    ${safe(files)}${more > 0 ? ` +${more} more` : ""}`));
      }
    }
    if (!view.shown.length && fin.findings.length) {
      console.log(c.dim("  no findings for this lens."));
    } else if (!fin.findings.length && !fin.errors?.length) {
      console.log(c.dim("  nothing beyond noise in the read subsystems."));
    }
    const folded: string[] = [];
    if (view.otherAudiences) folded.push(`${view.otherAudiences} finding(s) for other audiences`);
    if (view.internalHidden) folded.push(`${view.internalHidden} internal`);
    if (folded.length) {
      console.log(c.dim(`  … ${folded.join(", ")} folded by this lens (--lens all shows everything)`));
    }
    for (const e of fin.errors ?? []) {
      console.log(c.yellow(`  subsystem read failed: ${safe(e)}`));
    }
    if (rec?.unsupported.length) {
      const texts = rec.unsupported
        .slice(0, 2)
        .map((i) => `"${report.results[i].claim.text.slice(0, 60)}"`);
      console.log(
        c.dim(
          `  claims no finding observes — ${rec.unsupported.length}: ${safe(texts.join(", "))}${rec.unsupported.length > 2 ? ", …" : ""}`,
        ),
      );
    }
  }

  if (report.pins?.length) {
    const firstParty = report.pins.filter((p) => p.firstParty);
    const thirdParty = report.pins.filter((p) => !p.firstParty);
    console.log(
      c.bold("\nVersion pins moved") +
        c.dim(` — ${report.pins.length} pinned version(s) bumped in this diff:`),
    );
    for (const p of firstParty) {
      const shown = p.repo ? (p.repo.split("/")[1] ?? p.repo) : p.name;
      console.log(
        `  ${c.cyan("↑")} ${safe(`${shown} ${p.from} → ${p.to}`)} ${c.cyan("first-party")}` +
          (p.repo ? c.dim(` (${safe(p.repo)})`) : ""),
      );
      console.log(c.dim(`    ${safe(p.file)}${p.releaseUrl ? ` · ${safe(p.releaseUrl)}` : ""}`));
      const comp = componentFor(report, p);
      if (!comp) continue;
      if (comp.error) {
        console.log(c.yellow(`    ↳ ${safe(comp.error)}`));
        continue;
      }
      console.log(`    ${c.cyan("↳")} its check: ${safe(componentBits(comp).join(" · "))}`);
      const shipped = comp.surface ? surfaceLine(comp.surface) : undefined;
      if (shipped) console.log(c.dim(`      shipped: ${safe(shipped)}`));
    }
    for (const p of thirdParty.slice(0, 8)) {
      console.log(c.dim(`  · ${safe(`${p.name} ${p.from} → ${p.to}`)}`));
    }
    if (thirdParty.length > 8) {
      console.log(c.dim(`  … and ${thirdParty.length - 8} more third-party bumps`));
    }
  }

  const bumps = bumpSummary(report);
  if (bumps) {
    console.log(
      c.bold("\nDependency bumps") +
        c.dim(` — ${bumps.total} claim(s) held against the diff's pins: ${bumps.counts}`),
    );
    for (const b of bumps.lines) {
      const mark =
        b.status === "contradicted" ? c.red("✘") : b.status === "overtaken" ? c.yellow("↗") : c.dim("·");
      const detail = b.observed
        ? `the note says ${b.claimed}, the diff moves it ${b.observed}`
        : `the note says ${b.claimed}`;
      console.log(`  ${mark} ${safe(`${b.name} — ${detail}`)}`);
      if (b.file) console.log(c.dim(`    ${safe(b.file)}`));
    }
  }

  if (!report.reverseChecked) {
    console.log(c.dim("\nCompleteness check skipped (--no-reverse)."));
  } else if (report.uncovered.length) {
    console.log(
      c.bold(`\nUndocumented changes`) +
        c.dim(` — ${report.uncovered.length} commit(s) not covered by any note:`),
    );
    const order = report.reconciliation?.uncoveredOrder;
    const listed = order ? order.map((i) => report.uncovered[i]) : report.uncovered;
    if (order) {
      console.log(c.dim("  ordered: commits sharing files with an undocumented finding first"));
    }
    for (const u of listed.slice(0, 10)) {
      console.log(
        `  ${c.yellow("!")} ${u.commit.sha.slice(0, 8)} ${safe(u.commit.subject)} ` +
          c.dim(`(+${u.additions}/−${u.deletions}, ${u.fileCount} files)`),
      );
      if (u.surface) {
        console.log(c.dim(`    touched: ${safe(u.surface)}`));
      }
      if (u.suggestedNote) {
        console.log(c.dim(`    suggested note: "${safe(u.suggestedNote)}"`));
      }
    }
    if (report.uncovered.length > 10) {
      console.log(c.dim(`  … and ${report.uncovered.length - 10} more`));
    }
  } else {
    console.log(c.green("\nAll commits in the range are covered by the release notes."));
  }

  for (const w of report.warnings) console.log(c.yellow(`\nwarning: ${safe(w)}`));
}

export function toMarkdown(report: Report): string {
  const counts = countVerdicts(report.results);
  const s = report.metrics.scores;
  const note = unverifiableNote(report);
  const carried = carriedOver(report);
  const lines: string[] = [
    `# Release-note fact check: ${report.repoLabel} ${report.baseRef} → ${report.headRef}`,
    "",
    `Judge engine: \`${report.engine}\` · ${report.stats.commits} commits, ${report.stats.files} files, +${report.stats.additions}/−${report.stats.deletions}`,
    "",
    `**Trust score: ${s.overall}/100 (${s.label})** — correctness ${s.correctness} · completeness ${s.completeness ?? "n/a"} · risk ${s.risk}`,
    "",
    ...(note ? [`> **${note.heading}** — ${note.reason}`, ""] : []),
    ...(carried
      ? [
          `> **Carried over** — ${carried.count} claim(s) repeat \`${carried.baseRef}\` verbatim; standing text, not scored.`,
          "",
        ]
      : []),
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
  if (report.promises?.length) {
    lines.push("", "## Promises from earlier releases", "");
    for (const p of report.promises) {
      lines.push(`- **${p.status}** (from \`${p.from}\`) ${p.text}`);
      lines.push(`  - ${p.note}${p.files.length ? ` (${p.files.slice(0, 3).join(", ")})` : ""}`);
    }
  }
  const surf = report.surface;
  if (surf?.categories.length) {
    lines.push("", "## What actually shipped", "");
    lines.push(
      `- ${surf.categories.map((t) => `${t.files} ${t.category} (+${t.additions}/−${t.deletions})`).join(" · ")}`,
    );
    if (surf.symbols.length) {
      lines.push(
        `- symbols: ${surf.symbols.map((s) => `\`${s}\``).join(", ")}${surf.moreSymbols ? ` (+${surf.moreSymbols} more)` : ""}`,
      );
    }
    const cfg = [
      ...surf.envVars.added.map((v) => `+env \`${v}\``),
      ...surf.envVars.removed.map((v) => `−env \`${v}\``),
      ...surf.cliFlags.added.map((v) => `+flag \`${v}\``),
      ...surf.cliFlags.removed.map((v) => `−flag \`${v}\``),
      ...surf.configKeys.added.map((v) => `+key \`${v}\``),
      ...surf.configKeys.removed.map((v) => `−key \`${v}\``),
    ];
    if (cfg.length) lines.push(`- config surface: ${cfg.join(", ")}`);
    if (surf.migrations.length) {
      lines.push(`- migrations: ${surf.migrations.map((m) => `\`${m}\``).join(", ")}`);
    }
    if (surf.apiRoutes.length) {
      lines.push(`- api surface: ${surf.apiRoutes.map((m) => `\`${m}\``).join(", ")}`);
    }
  }
  const fin = report.findings;
  if (fin) {
    // The file artifact is complete: every audience, no lens filtering —
    // the lens is a view; a report on disk must not lose findings to it.
    lines.push("", "## Findings", "");
    const budget = budgetLine(report);
    if (budget) lines.push(`_${budget}_`, "");
    if (report.audience) lines.push(`Default lens: **${report.audience}**`, "");
    if (fin.summary) lines.push(fin.summary, "");
    const rec = report.reconciliation;
    const confirmedIdx = new Set(rec?.confirmed.map((l) => l.finding) ?? []);
    const undocumentedIdx = new Set(rec?.undocumented ?? []);
    for (const f of lensFindings(fin.findings, undefined).shown) {
      const fi = fin.findings.indexOf(f);
      const tag = confirmedIdx.has(fi)
        ? " — *claimed*"
        : undocumentedIdx.has(fi)
          ? " — **never claimed**"
          : "";
      const files = f.files.length
        ? ` (${f.files.slice(0, 4).map((p) => `\`${p}\``).join(", ")})`
        : "";
      lines.push(`- **${f.kind}** [${f.audience}] ${f.text}${files}${tag}`);
    }
    if (!fin.findings.length && !fin.errors?.length) {
      lines.push("Nothing beyond noise in the read subsystems.");
    }
    for (const e of fin.errors ?? []) {
      lines.push(`- subsystem read failed: ${e}`);
    }
    if (rec?.unsupported.length) {
      const texts = rec.unsupported
        .slice(0, 3)
        .map((i) => `"${report.results[i].claim.text.slice(0, 80)}"`);
      lines.push(
        "",
        `Claims no finding observes — ${rec.unsupported.length}: ${texts.join(", ")}${rec.unsupported.length > 3 ? ", …" : ""}`,
      );
    }
  }
  if (report.pins?.length) {
    lines.push("", "## Version pins moved", "");
    for (const p of report.pins) {
      const shown = p.firstParty && p.repo ? (p.repo.split("/")[1] ?? p.repo) : p.name;
      const head = `${shown} ${p.from} → ${p.to}`;
      lines.push(
        p.firstParty
          ? `- **${head} — first-party**${p.repo ? ` (\`${p.repo}\`)` : ""}${p.releaseUrl ? ` — [release](${p.releaseUrl})` : ""} · \`${p.file}\``
          : `- ${head} (\`${p.file}\`)`,
      );
      const comp = p.firstParty ? componentFor(report, p) : undefined;
      if (!comp) continue;
      if (comp.error) {
        lines.push(`  - sub-check: ${comp.error}`);
        continue;
      }
      lines.push(`  - its check: ${componentBits(comp).join(" · ")}`);
      const shipped = comp.surface ? surfaceLine(comp.surface) : undefined;
      if (shipped) lines.push(`  - shipped: ${shipped}`);
    }
  }

  const bumps = bumpSummary(report);
  if (bumps) {
    lines.push("", "## Dependency bumps", "");
    lines.push(`${bumps.total} bump claim(s) held against the diff's own pins: ${bumps.counts}.`);
    if (bumps.lines.length) lines.push("");
    for (const b of bumps.lines) {
      const detail = b.observed
        ? `the note says ${b.claimed}, the diff moves it ${b.observed}`
        : `the note says ${b.claimed}`;
      lines.push(
        `- **${b.name}** — ${detail}${b.file ? ` (\`${b.file}\`)` : ""} — ${BUMP_LABEL[b.status]}`,
      );
    }
  }
  lines.push("", "## Undocumented changes", "");
  if (!report.reverseChecked) {
    lines.push("Completeness check skipped (--no-reverse).");
  } else if (!report.uncovered.length) {
    lines.push("None — all commits in the range are covered by the release notes.");
  } else {
    const order = report.reconciliation?.uncoveredOrder;
    const listed = order ? order.map((i) => report.uncovered[i]) : report.uncovered;
    if (order) {
      lines.push("_Ordered: commits sharing files with an undocumented finding first._", "");
    }
    for (const u of listed) {
      lines.push(
        `- \`${u.commit.sha.slice(0, 8)}\` ${u.commit.subject} (+${u.additions}/−${u.deletions}, ${u.fileCount} files)`,
      );
      if (u.surface) {
        lines.push(`  - touched: ${u.surface}`);
      }
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

export function exitCode(
  report: Report,
  failOn: "none" | "contradicted" | "no-evidence",
  minCoverage?: number,
): number {
  if (failOn !== "none") {
    const counts = countVerdicts(report.results);
    if (counts.contradicted > 0) return 1;
    // A diff with no source files could not have supported the claims in the
    // first place — failing the build on that would punish the release shape,
    // not the notes.
    if (failOn === "no-evidence" && counts["no-evidence"] > 0 && !unverifiableNote(report)) return 1;
  }
  // The coverage gate is independent of the verdict gate: --fail-on none
  // still honours an explicit --min-coverage. A null completeness (reverse
  // check skipped) or an unverified release cannot fail it — there is no
  // measurement to gate on.
  const completeness = report.metrics.scores.completeness;
  if (
    minCoverage !== undefined &&
    completeness !== null &&
    completeness < minCoverage &&
    !unverifiableNote(report)
  ) {
    return 1;
  }
  return 0;
}
