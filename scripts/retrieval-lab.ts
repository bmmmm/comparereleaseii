// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { anchorMatch, rankHunks, isChangelogPath } from "../src/match.ts";
import { claimEvidence, capHunks, isGeneratedEntry } from "../src/verify.ts";
import { loadLocalRange, parseUnifiedDiff } from "../src/sources/local.ts";
import { cloneDirFor } from "../src/paths.ts";
import { untrustedBlock } from "../src/judge.ts";
import type { Claim, DiffFile, ReleaseData, Report } from "../src/types.ts";
import { dedupeReports } from "./corpus-aggregate.ts";

type Hunk = { path: string; hunk: string };
export type Candidate = Hunk & { id: string; state: string };
export interface LabCase {
  id: string;
  release: string;
  split: "development" | "holdout";
  claim: Claim;
  candidates: Candidate[];
  baseline: Hunk[];
  expanded: Hunk[];
  excluded: string | null;
}
export interface Dataset {
  version: 1;
  source: string;
  releases: string[];
  budget: { maxHunks: number; maxEvidenceChars: number; maxCandidates: number };
  cases: LabCase[];
  loads: Array<{ release: string; error: string }>;
  fingerprint: string;
}
export interface Ranking {
  fingerprint: string;
  runtime: Record<string, unknown>;
  loadMs: number;
  totalMs: number;
  runs: Array<{ cases: Array<{
    id: string;
    ms: number;
    scores: Array<{ id: string; score: number; truncated: boolean }>;
    error?: string;
  }> }>;
}
export interface Labels {
  fingerprint: string;
  cases: Array<{ id: string; relevant: string[]; rationale: string }>;
}
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function fingerprint(data: Omit<Dataset, "fingerprint"> | Dataset): string {
  const { version, source, releases, budget, cases, loads } = data;
  return digest({ version, source, releases, budget, cases, loads });
}

export function candidatesFor(claim: Claim, files: DiffFile[]): Candidate[] {
  const unique = new Map<string, Candidate>();
  for (const file of files) {
    if (!file.patch || isChangelogPath(file.path)) continue;
    for (const hunk of file.patch.split(/^(?=@@)/m).filter((h) => h.startsWith("@@"))) {
      const id = digest([file.path, hunk]);
      unique.set(id, { id, path: file.path, hunk, state:
        untrustedBlock("CLAIM", claim.text) + "\n" + untrustedBlock("DIFF", `${file.path}\n${hunk}`) });
    }
  }
  return [...unique.values()];
}

export function validateDataset(data: Dataset): void {
  assert.equal(data.version, 1, "Unsupported lab dataset version");
  assert.ok(data.cases.length > 0, "No claims in the dataset");
  assert.equal(data.fingerprint, fingerprint(data), "Dataset content changed; prepare it again");
  for (const value of Object.values(data.budget)) assert.ok(Number.isSafeInteger(value) && value > 0, "Invalid budget");
  assert.equal(new Set(data.cases.map((c) => c.id)).size, data.cases.length, "Duplicate cases");
  for (const c of data.cases) {
    assert.equal(new Set(c.candidates.map((h) => h.id)).size, c.candidates.length, "Duplicate candidates");
    for (const h of c.candidates) assert.equal(h.id, digest([h.path, h.hunk]), "Candidate content changed");
  }
}

export function layaSelection(c: LabCase, row: Ranking["runs"][number]["cases"][number], budget: Dataset["budget"]):
  { hunks: Hunk[]; fallback: string | null } {
  if (c.excluded) return { hunks: c.baseline, fallback: c.excluded };
  if (row.error) return { hunks: c.baseline, fallback: row.error };
  const ids = new Set(c.candidates.map((h) => h.id));
  assert.equal(row.scores.length, ids.size, "Incomplete Laya response");
  assert.equal(new Set(row.scores.map((s) => s.id)).size, ids.size, "Duplicate Laya scores");
  for (const s of row.scores) {
    assert.ok(ids.has(s.id), "Unknown Laya candidate");
    assert.ok(Number.isFinite(s.score), "Non-finite Laya score");
    assert.ok(s.score >= 0, "Negative Laya probability");
    assert.ok(s.score <= 1, "Laya probability exceeds one");
    assert.equal(typeof s.truncated, "boolean", "Missing truncation diagnostic");
  }
  if (row.scores.some((s) => s.truncated)) return { hunks: c.baseline, fallback: "context-truncated" };
  const scores = new Map(row.scores.map((s) => [s.id, s.score]));
  const sorted = [...c.candidates].sort((a, b) => scores.get(b.id)! - scores.get(a.id)!);
  return { hunks: capHunks(sorted.slice(0, budget.maxHunks), budget.maxEvidenceChars), fallback: null };
}

export function compare(data: Dataset, ranking: Ranking, labels?: Labels) {
  validateDataset(data);
  assert.equal(ranking.fingerprint, data.fingerprint, "Ranking belongs to another dataset");
  assert.ok(ranking.runs.length > 0, "No Laya runs");
  const annotations = new Map<string, Labels["cases"][number]>();
  if (labels) {
    assert.equal(labels.fingerprint, data.fingerprint, "Labels belong to another dataset");
    for (const label of labels.cases) {
      assert.ok(!annotations.has(label.id), "Duplicate label");
      const c = data.cases.find((c) => c.id === label.id);
      assert.ok(c, "Label names an unknown case");
      assert.ok(label.rationale.trim().length > 0, "Evidence labels need a rationale");
      assert.equal(new Set(label.relevant).size, label.relevant.length, "Duplicate evidence label");
      for (const id of label.relevant) assert.ok(c.candidates.some((h) => h.id === id), "Unknown evidence label");
      annotations.set(label.id, label);
    }
  }
  const summaries = ranking.runs.map((run) => {
    assert.equal(run.cases.length, data.cases.length, "Incomplete ranking run");
    assert.equal(new Set(run.cases.map((r) => r.id)).size, data.cases.length, "Duplicate ranking rows");
    const rows = data.cases.map((c) => {
      const r = run.cases.find((r) => r.id === c.id);
      assert.ok(r, "Missing ranking case");
      const laya = layaSelection(c, r, data.budget);
      const label = annotations.get(c.id);
      const recall = (hunks: Hunk[]): number | null => {
        if (!label?.relevant.length) return null;
        return label.relevant.filter((id) => {
          const h = c.candidates.find((h) => h.id === id)!;
          // A clipped prefix is not proof that the relevant change reached the judge.
          return hunks.some((selected) => selected.path === h.path && selected.hunk.includes(h.hunk));
        }).length / label.relevant.length;
      };
      return { id: c.id, release: c.release, split: c.split, fallback: laya.fallback, ms: r.ms,
        labeled: Boolean(label), baselineRecall: recall(c.baseline), expandedRecall: recall(c.expanded),
        layaRecall: recall(laya.hunks), laya: laya.hunks };
    });
    const bySplit = (["development", "holdout"] as const).map((split) => {
      const slice = rows.filter((r) => r.split === split);
      const measured = slice.filter((r) => r.baselineRecall !== null && r.fallback === null);
      const mean = (key: "baselineRecall" | "expandedRecall" | "layaRecall") => measured.length
        ? measured.reduce((n, r) => n + r[key]!, 0) / measured.length : null;
      const wins = measured.filter((r) => r.layaRecall! > r.baselineRecall!).length;
      const losses = measured.filter((r) => r.layaRecall! < r.baselineRecall!).length;
      return { split, claims: slice.length, labeled: slice.filter((r) => r.labeled).length,
        applicable: slice.filter((r) => r.fallback === null).length, paired: measured.length,
        baselineRecall: mean("baselineRecall"), expandedRecall: mean("expandedRecall"), layaRecall: mean("layaRecall"),
        wins, losses, ties: measured.length - wins - losses };
    });
    return { bySplit, rows };
  });
  return { scope: "Retrieval experiment only; no verdict accuracy or production benefit measured",
    fingerprint: data.fingerprint, runtime: ranking.runtime, loadMs: ranking.loadMs, totalMs: ranking.totalMs,
    labeled: annotations.size, claims: data.cases.length, runs: summaries };
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function reviewHtml(data: Dataset): string {
  validateDataset(data);
  const body = data.cases.map((c) => `<article data-id="${esc(c.id)}"><h2>${esc(c.release)} · ${esc(c.split)}</h2>
    <p>${esc(c.claim.text)}</p><p>${esc(c.excluded ?? "Eligible for Laya")}</p>
    <label><input type="checkbox" class="reviewed"> I reviewed the entire candidate pool</label>
    <p><label>Evidence rationale <input class="rationale" size="80"></label></p>
    ${c.candidates.map((h) => `<details><summary><label><input type="checkbox" value="${esc(h.id)}" class="relevant"> Relevant evidence</label> ${esc(h.path)}</summary><pre>${esc(h.hunk)}</pre></details>`).join("\n")}</article>`).join("\n");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Retrieval lab · blind evidence review</title>
    <style>body{font:16px system-ui;max-width:1100px;margin:40px auto;padding:0 20px;background:#fafafa;color:#18212b}article{margin:30px 0;padding:24px;background:white;border:1px solid #ccd3da;border-radius:8px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}details{padding:12px;border-bottom:1px solid #ddd}button{padding:12px;font:inherit}input.rationale{max-width:90%}</style>
    <h1>Blind evidence review</h1><p>Read each complete pool. Mark every hunk relevant to testing the claim, including contradictory evidence. An empty selection means no candidate supplies evidence. Selection methods and model scores are hidden.</p>
    <button id="export">Download reviewed labels</button><span id="status"></span>${body}
    <script>document.getElementById('export').onclick=()=>{
      const cases=[];for(const a of document.querySelectorAll('article')){if(!a.querySelector('.reviewed').checked)continue;
      const rationale=a.querySelector('.rationale').value.trim();if(!rationale){document.getElementById('status').textContent='Every reviewed case needs a rationale.';return;}
      cases.push({id:a.dataset.id,relevant:[...a.querySelectorAll('.relevant:checked')].map(x=>x.value),rationale});}
      if(!cases.length){document.getElementById('status').textContent='Review at least one case.';return;}
      const url=URL.createObjectURL(new Blob([JSON.stringify({fingerprint:'${data.fingerprint}',cases},null,2)],{type:'application/json'}));
      const link=document.createElement('a');link.href=url;link.download='evidence-labels.json';link.click();URL.revokeObjectURL(url);
      document.getElementById('status').textContent=cases.length+' reviewed cases exported.';};</script></html>`;
}

export function comparisonHtml(data: Dataset, ranking: Ranking, labels?: Labels): string {
  const result = compare(data, ranking, labels);
  const showHunks = (hunks: Hunk[]): string => hunks.map((h) =>
    `<details><summary>${esc(h.path)}</summary><pre>${esc(h.hunk)}</pre></details>`).join("");
  const runs = result.runs.map((run, i) => `<section><h2>Run ${i + 1}</h2>
    <pre>${esc(JSON.stringify(run.bySplit, null, 2))}</pre>
    ${run.rows.map((row) => {
      const c = data.cases.find((c) => c.id === row.id)!;
      const scores = ranking.runs[i]!.cases.find((r) => r.id === row.id)!.scores;
      return `<details class="case"><summary>${esc(c.release)} · ${esc(c.claim.text)}</summary>
        <p>${esc(row.fallback ?? "Laya applied")} · ${Math.round(row.ms)} ms · ${c.candidates.length} candidates</p>
        <div class="columns"><div><h3>Current selection</h3>${showHunks(c.baseline)}</div>
        <div><h3>Lexical + fill</h3>${showHunks(c.expanded)}</div>
        <div><h3>Laya</h3>${showHunks(row.laya)}</div></div>
        <details><summary>Candidate probabilities and context diagnostics</summary>
        ${c.candidates.map((h) => {
          const score = scores.find((s) => s.id === h.id);
          return `<details><summary>${esc(h.path)} · P(relevant): ${esc(String(score?.score ?? "not measured"))} · truncated: ${esc(String(score?.truncated ?? "not measured"))}</summary><pre>${esc(h.hunk)}</pre></details>`;
        }).join("")}</details></details>`;
    }).join("")}</section>`).join("");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>comparereleaseii retrieval lab</title>
    <style>body{font:15px system-ui;margin:30px;padding:0 10px;background:#fafafa;color:#18212b}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}summary{cursor:pointer;padding:10px}section,.case{margin:20px 0;border:1px solid #ccd3da;padding:12px;background:white}.columns{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px}@media(max-width:800px){.columns{grid-template-columns:1fr}}</style>
    <h1>comparereleaseii retrieval lab</h1><p>${esc(result.scope)}</p>
    <p>${data.releases.length} releases · ${result.claims} claims · ${result.labeled} labeled · load/import ${Math.round(result.loadMs)} ms · experiment ${Math.round(result.totalMs)} ms</p>
    <details><summary>Runtime and model identity</summary><pre>${esc(JSON.stringify(result.runtime, null, 2))}</pre></details>
    <details><summary>Release load failures</summary><pre>${esc(JSON.stringify(data.loads, null, 2))}</pre></details>${runs}</html>`;
}

async function prepare(reportsDir: string, releases: number, claims: number, targets: string[]): Promise<Dataset> {
  const parsed: Report[] = [];
  for (const file of (await readdir(reportsDir, { recursive: true })).sort()) {
    if (!file.endsWith(".json") || /credential|secret|token/i.test(file)) continue;
    parsed.push(JSON.parse(await readFile(`${reportsDir}/${file}`, "utf8")) as Report);
  }
  const reports = dedupeReports(parsed);
  const selected: Report[] = [];
  if (targets.length) {
    for (const target of targets) {
      const found = reports.find((r) => `${r.repoLabel}@${r.headRef}` === target);
      assert.ok(found, `Missing requested release: ${target}`);
      selected.push(found);
    }
  } else {
    // Round-robin over repositories, then spread across their release sizes.
    const groups = new Map<string, Report[]>();
    for (const r of reports) groups.set(r.repoLabel, [...(groups.get(r.repoLabel) ?? []), r]);
    for (const group of groups.values()) group.sort((a, b) => a.stats.files - b.stats.files);
    for (let round = 0; selected.length < releases; round++) {
      let added = false;
      for (const group of groups.values()) {
        const r = group[round % 2 === 0 ? Math.floor(round / 2) : group.length - 1 - Math.floor(round / 2)];
        if (r && !selected.includes(r) && selected.length < releases) { selected.push(r); added = true; }
      }
      if (!added) break;
    }
  }
  const data: Dataset = { version: 1, source: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    releases: selected.map((r) => `${r.repoLabel}@${r.headRef}`),
    budget: { maxHunks: 6, maxEvidenceChars: 20000, maxCandidates: 32 }, cases: [], loads: [], fingerprint: "" };
  for (const report of selected) {
    const release = `${report.repoLabel}@${report.headRef}`;
    console.error(`Freezing ${release}`);
    try {
      const clone = await cloneDirFor(report.linkBase ?? `https://github.com/${report.repoLabel}`);
      assert.ok(clone, "Clone cache unavailable");
      const range = await loadLocalRange(clone, report.baseRef, report.headRef);
      const releaseData: ReleaseData = { ...range, repoLabel: report.repoLabel, baseRef: report.baseRef,
        headRef: report.headRef, notes: "", warnings: [] };
      const eligible = report.results.map((r) => r.claim).filter((c) => c.kind === "change" && !c.carriedOverFrom)
        .filter((c) => !isGeneratedEntry(c, anchorMatch(c, range.commits).commits));
      const sample = eligible.length <= claims ? eligible : Array.from({ length: claims }, (_, i) => eligible[Math.floor(i * eligible.length / claims)]!);
      const frozen: LabCase[] = [];
      for (const claim of sample) {
        const anchors = anchorMatch(claim, range.commits);
        const pool = anchors.commits.length
          ? (await Promise.all(anchors.commits.map((c) => range.commitFiles(c.sha)))).flat() : range.files;
        let excluded: string | null = null;
        for (const commit of anchors.commits) {
          const parents = execFileSync("git", ["-C", clone, "show", "-s", "--format=%P", commit.sha], { encoding: "utf8" }).trim().split(" ");
          if (parents.length > 1) {
            const firstParent = parseUnifiedDiff(execFileSync("git", ["-C", clone, "diff", "--patch", "--no-color", parents[0]!, commit.sha], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
            if (firstParent.some((f) => f.patch) && !(await range.commitFiles(commit.sha)).some((f) => f.patch)) excluded = "merge-diff-unread";
          }
        }
        const candidates = candidatesFor(claim, pool);
        if (!excluded && !candidates.length) excluded = "empty-pool";
        if (!excluded && candidates.length > data.budget.maxCandidates) excluded = "candidate-limit";
        const baseline = await claimEvidence(releaseData, claim, data.budget);
        assert.equal(releaseData.warnings.length, 0, "Source emitted load warnings");
        const lexical = rankHunks(claim, pool, data.budget.maxHunks);
        const extended = [...lexical, ...candidates.filter((h) => !lexical.some((l) => l.path === h.path && l.hunk === h.hunk))];
        frozen.push({ id: digest([release, claim.id, claim.text]), release,
          split: parseInt(digest(report.repoLabel).slice(0, 8), 16) % 2 ? "holdout" : "development",
          claim, candidates, baseline: baseline.hunks,
          expanded: capHunks(extended.slice(0, data.budget.maxHunks), data.budget.maxEvidenceChars), excluded });
      }
      data.cases.push(...frozen);
    } catch (err) { data.loads.push({ release, error: (err as Error).message }); }
  }
  data.fingerprint = fingerprint(data);
  validateDataset(data);
  return data;
}

function positive(raw: string | undefined, fallback: number): number {
  const n = raw === undefined ? fallback : Number(raw);
  assert.ok(Number.isSafeInteger(n) && n > 0, "Counts must be positive integers");
  return n;
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    reports: { type: "string" }, input: { type: "string" }, out: { type: "string" },
    ranking: { type: "string" }, labels: { type: "string" }, python: { type: "string" },
    model: { type: "string" }, revision: { type: "string" }, repeats: { type: "string" },
    releases: { type: "string" }, claims: { type: "string" }, target: { type: "string", multiple: true }, html: { type: "string" },
  } });
  const [command] = positionals;
  assert.ok(values.out, "Pass --out <file>");
  if (command === "prepare") {
    assert.ok(values.reports, "Pass --reports <directory>");
    const data = await prepare(values.reports, positive(values.releases, 12), positive(values.claims, 8), values.target ?? []);
    await writeFile(values.out, JSON.stringify(data, null, 2) + "\n");
    console.log(JSON.stringify({ claims: data.cases.length, eligible: data.cases.filter((c) => !c.excluded).length, loadFailures: data.loads.length, fingerprint: data.fingerprint }));
    return;
  }
  assert.ok(values.input, "Pass --input <dataset.json>");
  const data = JSON.parse(await readFile(values.input, "utf8")) as Dataset;
  validateDataset(data);
  if (command === "review") {
    await writeFile(values.out, reviewHtml(data));
  } else if (command === "rank") {
    assert.ok(values.python, "Pass --python <lab venv>/bin/python");
    assert.ok(values.revision, "Pin --revision to a model commit");
    assert.ok(/^[a-f0-9]{40}$/.test(values.revision), "Model revision must be a full commit hash");
    assert.ok(data.cases.some((c) => !c.excluded), "No cases eligible for Laya");
    await new Promise<void>((resolve, reject) => {
      const child = spawn(values.python!, [new URL("laya-rank.py", import.meta.url).pathname,
        "--input", values.input!, "--out", values.out!, "--model", values.model ?? "aac6fef/laya-multilingual-mlx",
        "--revision", values.revision!, "--repeats", String(positive(values.repeats, 3))], { stdio: ["ignore", "inherit", "inherit"] });
      const timer = setTimeout(() => { child.kill(); reject(new Error("Laya experiment timed out after 30 minutes")); }, 30 * 60_000);
      child.on("error", (err) => { clearTimeout(timer); reject(err); });
      child.on("exit", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Laya worker exited ${code}`)); });
    });
    const ranking = JSON.parse(await readFile(values.out, "utf8")) as Ranking;
    compare(data, ranking);
  } else if (command === "compare") {
    assert.ok(values.ranking, "Pass --ranking <laya.json>");
    const ranking = JSON.parse(await readFile(values.ranking, "utf8")) as Ranking;
    const labels = values.labels ? JSON.parse(await readFile(values.labels, "utf8")) as Labels : undefined;
    const result = compare(data, ranking, labels);
    await writeFile(values.out, JSON.stringify(result, null, 2) + "\n");
    if (values.html) await writeFile(values.html, comparisonHtml(data, ranking, labels));
    console.log(JSON.stringify({ scope: result.scope, claims: result.claims, labeled: result.labeled, runs: result.runs.map((r) => r.bySplit) }, null, 2));
  } else throw new Error("Commands: prepare | review | rank | compare. See docs/retrieval-lab.md");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: Error) => { console.error(err.message); process.exitCode = 2; });
}
