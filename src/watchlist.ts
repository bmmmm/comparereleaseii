// SPDX-License-Identifier: GPL-3.0-or-later
// Build and maintain the watch-config repo list from the user's own GitHub
// account: watched repos, stars, recent release notifications.
import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { ghApi } from "./sources/github.ts";
import { c } from "./util.ts";
import type { WatchConfig } from "./watch.ts";

export type CandidateSource = "watched" | "starred" | "notifications";

export interface RepoCandidate {
  repo: string;
  source: CandidateSource;
  pushedAt: string | null;
  archived: boolean;
  description: string | null;
}

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

/** "1,3-5" → [1,3,4,5]; "a"/"all" → every index; null on anything invalid. */
export function parseSelection(input: string, max: number): number[] | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;
  if (trimmed === "a" || trimmed === "all") {
    return Array.from({ length: max }, (_, i) => i + 1);
  }
  const picked = new Set<number>();
  for (const part of trimmed.split(",")) {
    const m = part.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!m) return null;
    const from = Number(m[1]);
    const to = m[2] ? Number(m[2]) : from;
    if (from < 1 || to > max || from > to) return null;
    for (let i = from; i <= to; i++) picked.add(i);
  }
  return [...picked].sort((a, b) => a - b);
}

/** Dedupe by repo (first source wins), drop archived, newest activity first. */
export function mergeCandidates(lists: RepoCandidate[][]): {
  candidates: RepoCandidate[];
  archivedDropped: number;
} {
  const seen = new Map<string, RepoCandidate>();
  const archived = new Set<string>();
  for (const cand of lists.flat()) {
    if (cand.archived) {
      archived.add(cand.repo);
      continue;
    }
    if (!seen.has(cand.repo)) seen.set(cand.repo, cand);
  }
  const archivedDropped = [...archived].filter((repo) => !seen.has(repo)).length;
  return { candidates: sortByActivity([...seen.values()]), archivedDropped };
}

export function sortByActivity(candidates: RepoCandidate[]): RepoCandidate[] {
  return [...candidates].sort((a, b) => (b.pushedAt ?? "").localeCompare(a.pushedAt ?? ""));
}

/** Add repos to the config, skipping ones already present. */
export function addRepos(
  config: WatchConfig,
  repos: string[],
): { added: string[]; skipped: string[] } {
  const existing = new Set(config.repos.map((r) => r.repo));
  const added: string[] = [];
  const skipped: string[] = [];
  for (const repo of repos) {
    if (existing.has(repo)) {
      skipped.push(repo);
      continue;
    }
    config.repos.push({ repo });
    existing.add(repo);
    added.push(repo);
  }
  return { added, skipped };
}

/** Remove every entry for the repo; returns how many were removed. */
export function removeRepo(config: WatchConfig, repo: string): number {
  const before = config.repos.length;
  config.repos = config.repos.filter((r) => r.repo !== repo);
  return before - config.repos.length;
}

interface GhRepoSummary {
  full_name: string;
  pushed_at: string | null;
  archived: boolean;
  description: string | null;
}

/** Paginate a gh list endpoint; flags the cap instead of hiding it. */
async function ghPaged(
  path: string,
  maxPages: number,
): Promise<{ items: GhRepoSummary[]; capped: boolean }> {
  const sep = path.includes("?") ? "&" : "?";
  const items: GhRepoSummary[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const batch = await ghApi<GhRepoSummary[]>(`${path}${sep}per_page=100&page=${page}`);
    items.push(...batch);
    if (batch.length < 100) return { items, capped: false };
  }
  return { items, capped: true };
}

const toCandidate =
  (source: CandidateSource) =>
  (r: GhRepoSummary): RepoCandidate => ({
    repo: r.full_name,
    source,
    pushedAt: r.pushed_at ?? null,
    archived: r.archived ?? false,
    description: r.description,
  });

export async function fetchCandidates(source: CandidateSource): Promise<RepoCandidate[]> {
  if (source === "watched" || source === "starred") {
    const path = source === "watched" ? "user/subscriptions" : "user/starred";
    const { items, capped } = await ghPaged(path, 3);
    if (capped) console.error(`${source}: 300+ repos — showing the 300 most recent.`);
    return items.map(toCandidate(source));
  }
  // The notification payload's repository object carries no pushed_at and no
  // archived flag — those are backfilled by enrichCandidates.
  const notes = await ghApi<
    Array<{ subject: { type: string }; repository: { full_name: string; description: string | null } }>
  >("notifications?all=true&per_page=100");
  if (notes.length === 100) {
    console.error("notifications: only the 100 most recent notifications scanned.");
  }
  return notes
    .filter((n) => n.subject.type === "Release")
    .map((n) => ({
      repo: n.repository.full_name,
      source: "notifications" as const,
      pushedAt: null,
      archived: false,
      description: n.repository.description,
    }));
}

/** Backfill pushed_at/archived for candidates whose source omits them. */
async function enrichCandidates(candidates: RepoCandidate[]): Promise<void> {
  const needy = candidates.filter((cand) => cand.source === "notifications");
  if (!needy.length) return;
  console.error(`fetching metadata for ${needy.length} notification repo(s)…`);
  for (let i = 0; i < needy.length; i += 10) {
    await Promise.all(
      needy.slice(i, i + 10).map(async (cand) => {
        try {
          const meta = await ghApi<GhRepoSummary>(`repos/${cand.repo}`);
          cand.pushedAt = meta.pushed_at ?? null;
          cand.archived = meta.archived ?? false;
          cand.description ??= meta.description;
        } catch {
          // Metadata is a nicety — keep the candidate, it just sorts last.
        }
      }),
    );
  }
}

const CONFIG_SHAPE_HINT = 'expected a JSON object with a "repos" array — see docs/watchdog.md';

export async function loadConfig(
  path: string,
): Promise<{ config: WatchConfig; existed: boolean }> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return { config: { repos: [] }, existed: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Watch config ${path} is not valid JSON: ${(err as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} is not a watch config: ${CONFIG_SHAPE_HINT}.`);
  }
  const config = parsed as WatchConfig;
  if (config.repos === undefined) {
    config.repos = [];
  } else if (!Array.isArray(config.repos)) {
    throw new Error(`${path} is not a watch config: "repos" is not an array — ${CONFIG_SHAPE_HINT}.`);
  }
  return { config, existed: true };
}

export async function saveConfig(path: string, config: WatchConfig): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(config, null, 2) + "\n");
  await rename(tmp, path);
}

function printCandidates(candidates: RepoCandidate[]): void {
  const numWidth = String(candidates.length).length;
  const repoWidth = Math.max(...candidates.map((cand) => cand.repo.length));
  for (const [i, cand] of candidates.entries()) {
    const num = String(i + 1).padStart(numWidth);
    const pushed = cand.pushedAt ? cand.pushedAt.slice(0, 7) : "       ";
    const desc = cand.description
      ? cand.description.length > 48
        ? cand.description.slice(0, 45) + "…"
        : cand.description
      : "";
    // stderr like the prompt — stdout stays clean for `watch list` piping.
    console.error(
      `  ${num}  ${cand.repo.padEnd(repoWidth)} ${c.dim(pushed)} ${c.dim(cand.source.padEnd(13))} ${c.dim(desc)}`,
    );
  }
}

export async function runWatchInit(opts: {
  configPath: string;
  from: string;
}): Promise<number> {
  if (!process.stdin.isTTY) {
    throw new Error(
      "watch init is interactive and needs a terminal — use `watch add <owner/repo>` in scripts.",
    );
  }
  const sources = opts.from.split(",").map((s) => s.trim()).filter(Boolean);
  for (const s of sources) {
    if (!["watched", "starred", "notifications"].includes(s)) {
      throw new Error(`--from must be a comma list of watched, starred, notifications (got "${s}").`);
    }
  }
  const { config, existed } = await loadConfig(opts.configPath);
  const already = new Set(config.repos.map((r) => r.repo));

  const lists: RepoCandidate[][] = [];
  let failedSources = 0;
  for (const source of sources as CandidateSource[]) {
    try {
      lists.push(await fetchCandidates(source));
    } catch (err) {
      failedSources++;
      console.error(`warning: fetching ${source} repos failed — ${(err as Error).message}`);
    }
  }
  if (failedSources === sources.length) {
    throw new Error("All sources failed — check `gh auth status`.");
  }
  if (failedSources) {
    console.error(
      `warning: ${failedSources} of ${sources.length} sources failed — the list below is incomplete.`,
    );
  }
  const merged = mergeCandidates(lists);
  let candidates = merged.candidates.filter((cand) => !already.has(cand.repo));
  const hidden = merged.candidates.length - candidates.length;
  await enrichCandidates(candidates);
  const lateArchived = candidates.filter((cand) => cand.archived).length;
  candidates = sortByActivity(candidates.filter((cand) => !cand.archived));
  const archivedDropped = merged.archivedDropped + lateArchived;
  if (archivedDropped) console.error(`${archivedDropped} archived repo(s) skipped.`);
  if (hidden) console.error(`${hidden} repo(s) already in ${opts.configPath} — hidden.`);
  if (!candidates.length) {
    console.error("Nothing new to add.");
    return failedSources ? 2 : 0;
  }

  console.error(`\nRepos from your GitHub account (${sources.join(", ")}):\n`);
  printCandidates(candidates);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const closed = new Promise<null>((res) => rl.once("close", () => res(null)));
  let picked: number[] | null = null;
  try {
    while (true) {
      const answer = await Promise.race([
        rl.question(
          `\nWatch which repos? numbers/ranges ("1,3-5"), "a" for all, empty to cancel: `,
        ),
        closed,
      ]);
      if (answer === null || !answer.trim()) {
        console.error("\nCancelled — config unchanged.");
        return 0;
      }
      picked = parseSelection(answer, candidates.length);
      if (picked) break;
      console.error(`Cannot parse that — expected numbers 1-${candidates.length}, ranges, or "a".`);
    }
  } finally {
    rl.close();
  }

  const { added } = addRepos(config, picked.map((i) => candidates[i - 1].repo));
  await saveConfig(opts.configPath, config);
  const configPath = resolve(opts.configPath);
  console.error(
    `\n${added.length} repo(s) added to ${opts.configPath}${existed ? "" : " (created)"} — ${config.repos.length} watched total.`,
  );
  console.error(
    `Run it: comparerelease watch --config ${configPath}\n` +
      `Judge, alerting and scheduling options: docs/watchdog.md`,
  );
  return failedSources ? 2 : 0;
}

export async function runWatchAdd(opts: {
  configPath: string;
  repo: string;
}): Promise<number> {
  if (!REPO_RE.test(opts.repo)) {
    throw new Error(`watch add expects owner/repo (got "${opts.repo}").`);
  }
  let meta: GhRepoSummary;
  try {
    meta = await ghApi<GhRepoSummary>(`repos/${opts.repo}`);
  } catch (err) {
    const msg = (err as Error).message;
    if (/HTTP 404|Not Found/i.test(msg)) {
      throw new Error(`${opts.repo} not found on GitHub — check the owner/repo spelling.`);
    }
    throw new Error(`Looking up ${opts.repo} failed: ${msg}`);
  }
  const repo = meta.full_name; // canonical casing, follows renames
  const releases = await ghApi<unknown[]>(`repos/${repo}/releases?per_page=1`);
  const { config, existed } = await loadConfig(opts.configPath);
  const { added } = addRepos(config, [repo]);
  if (!added.length) {
    console.error(`${repo} is already in ${opts.configPath}.`);
    return 0;
  }
  await saveConfig(opts.configPath, config);
  console.error(`${repo} added to ${opts.configPath}${existed ? "" : " (created)"}.`);
  if (meta.archived) {
    console.error(`note: ${repo} is archived — it will never release again.`);
  } else if (!releases.length) {
    console.error(`note: ${repo} has no releases yet — it stays a cheap no-op until the first one.`);
  }
  return 0;
}

export async function runWatchRemove(opts: {
  configPath: string;
  repo: string;
}): Promise<number> {
  const { config, existed } = await loadConfig(opts.configPath);
  if (!existed) throw new Error(`${opts.configPath} does not exist.`);
  const removed = removeRepo(config, opts.repo);
  if (!removed) {
    console.error(`${opts.repo} is not in ${opts.configPath} — nothing to do.`);
    return 0;
  }
  await saveConfig(opts.configPath, config);
  console.error(
    `${opts.repo} removed from ${opts.configPath} (${removed} ${removed === 1 ? "entry" : "entries"}).`,
  );
  return 0;
}

export async function runWatchList(opts: { configPath: string }): Promise<number> {
  const { config, existed } = await loadConfig(opts.configPath);
  if (!existed) throw new Error(`${opts.configPath} does not exist — start with \`watch init\`.`);
  if (!config.repos.length) {
    console.error(`${opts.configPath} watches no repos yet — add some with \`watch init\` or \`watch add\`.`);
    return 0;
  }
  for (const entry of config.repos) {
    const extras = Object.entries(entry)
      .filter(([k]) => k !== "repo")
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    console.log(extras ? `${entry.repo}  ${c.dim(extras)}` : entry.repo);
  }
  return 0;
}
