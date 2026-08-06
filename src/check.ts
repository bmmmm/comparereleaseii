// SPDX-License-Identifier: GPL-3.0-or-later
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { cloneDirFor } from "./paths.ts";
import { loadGithubRelease, fetchGithubContext, pickBaseRelease } from "./sources/github.ts";
import {
  assertCloneUrl,
  ensureClone,
  loadLocalRange,
  loadLocalRelease,
  localRepoContext,
} from "./sources/local.ts";
import { fetchForgeReleases, parseRepoUrl, type ForgeListing } from "./sources/forge.ts";
import { parseClaims, markCarriedOver } from "./claims.ts";
import { anchorMatch } from "./match.ts";
import { pooled } from "./util.ts";
import { verifyClaims, computeCoverage } from "./verify.ts";
import { suggestNotes } from "./suggest.ts";
import { authorActivity, computeMetrics, SCORING_GENERATION } from "./metrics.ts";
import { checkPromises, type CarriedPromise } from "./promises.ts";
import { pinBumps } from "./pins.ts";
import { releaseSurface } from "./substance.ts";
import {
  buildSnapshots,
  cloneHistory,
  summarizeBaseline,
  type HistoryRelease,
  type HistorySource,
} from "./history.ts";
import type { JudgeEngine } from "./judge.ts";
import { summarizeShipped } from "./findings.ts";
import { reconcile, resolveBumpClaims } from "./reconcile.ts";
import type {
  Audience,
  BumpResolution,
  Claim,
  ComponentCheck,
  DiffFile,
  FindingsSection,
  PinBump,
  ReleaseData,
  Report,
  RepoContext,
  Verdict,
} from "./types.ts";

export interface CheckSettings {
  judgeMode: "auto" | "all" | "off";
  engine: JudgeEngine | null;
  escalateEngine: JudgeEngine | null;
  concurrency: number;
  reverse: boolean;
  /** Number of previous releases for the anomaly baseline (0 disables). */
  baseline: number;
  /** Where those releases come from — any forge, or null to skip the baseline. */
  history?: HistorySource | null;
  /** Draft a release-note line for the highest-churn undocumented commits. */
  suggest?: boolean;
  /** Cap on how many uncovered commits get an LLM-drafted suggestion (cost bound). */
  suggestLimit?: number;
  /** Still-open promises from earlier releases (watch state) to re-check. */
  carriedPromises?: CarriedPromise[];
  /** Pin name → owner/repo (or URL): first-party components whose pins
   * cannot identify their target themselves (a bare WEB_ASSETS_VERSION). */
  components?: Record<string, string>;
  /** Expand first-party pin bumps into depth-1 sub-checks through this
   * loader; absent disables expansion. Production passes componentLoader —
   * the indirection is the network seam tests stub. */
  expand?: ComponentLoader;
  /** `false` skips the LLM findings pass (typed "what shipped" summary).
   * On by default whenever a judge engine is active. */
  findings?: boolean;
  /** Hard evidence budget in chars for the findings pass. */
  findingsBudget?: number;
  /** The repo's default lens, stamped on the report for renderers. */
  audience?: Audience;
}

/** Loads one component release range (tag, diffed against base). */
export type ComponentLoader = (
  repoUrl: string,
  opts: { tag: string; base: string },
) => Promise<{ data: ReleaseData; context: RepoContext }>;

/**
 * The production component loader: a github.com URL goes through the
 * gh-backed source (published notes, compare API, truncation fallback);
 * every other host is a forge URL through the cached clone. Both routes are
 * the same machinery a direct check of that repo would use, so the clone
 * cache and the verdict cache are shared with it.
 */
export const componentLoader: ComponentLoader = (repoUrl, opts) => {
  const gh = repoUrl.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+)$/i);
  if (gh) return loadGithubReleaseData(gh[1], { tag: opts.tag, base: opts.base });
  return prepareForgeTarget(repoUrl).then((t) =>
    loadForgeRelease(t, { head: opts.tag, base: opts.base }),
  );
};

/** Injection seam for tests — production always uses the real sources. */
export interface GithubLoadDeps {
  loadGithubRelease: typeof loadGithubRelease;
  fetchGithubContext: typeof fetchGithubContext;
  cloneDirFor: typeof cloneDirFor;
  ensureClone: typeof ensureClone;
  loadLocalRange: typeof loadLocalRange;
}

/**
 * Release data + repo context from GitHub, falling back to a partial clone
 * when the compare API truncates the diff.
 */
export async function loadGithubReleaseData(
  repo: string,
  opts: { tag?: string; base?: string; notesFile?: string },
  deps: GithubLoadDeps = { loadGithubRelease, fetchGithubContext, cloneDirFor, ensureClone, loadLocalRange },
): Promise<{ data: ReleaseData; context: RepoContext }> {
  let [data, context] = await Promise.all([
    deps.loadGithubRelease({ repo, tag: opts.tag, base: opts.base }),
    deps.fetchGithubContext(repo),
  ]);

  if (opts.notesFile) {
    data.notes = await readFile(opts.notesFile, "utf8");
  }

  if (data.truncated) {
    console.error("Compare API truncated the diff — falling back to a partial clone…");
    try {
      // A clone target in a shared temp dir is a symlink waiting to happen —
      // git would happily follow it and write outside the cache.
      const url = `https://github.com/${repo}.git`;
      const dir = await deps.cloneDirFor(url);
      if (!dir) throw new Error("no private cache directory for the clone fallback");
      await deps.ensureClone(url, dir);
      const range = await deps.loadLocalRange(dir, data.baseRef, data.headRef);
      data = {
        ...data,
        ...range,
        truncated: false,
        warnings: data.warnings
          .filter((w) => !w.startsWith("Compare API"))
          .concat("Diff loaded from a local partial clone (compare API truncated)."),
      };
    } catch (err) {
      data.warnings.push(
        `Partial-clone fallback failed: ${(err as Error).message.slice(0, 120)}`,
      );
    }
  }
  return { data, context };
}

export interface RepoLink {
  /** Web URL prefix for commit/compare links, e.g. https://github.com/o/r. */
  base: string;
  /** GitLab spells commit/compare routes with a `/-/`; every other forge doesn't. */
  style: "github" | "gitlab";
}

/**
 * A forge repository readied for checking: the cached clone, the release
 * API's answer (null when no API answered — the CHANGELOG then carries the
 * notes, which is what --local has always done), web links, and the history
 * source the baseline reads. Built once per repo; each release check on top
 * of it is loadForgeRelease.
 */
export interface ForgeTarget {
  url: string;
  /** Cached clone directory — the check runs the --local path against it. */
  dir: string;
  /** owner/repo when the URL parses to one; labels reports and cache slugs. */
  slug: string | null;
  /** Web origin (scheme + host), when the URL parses. */
  origin: string | null;
  link: RepoLink | null;
  forge: ForgeListing | null;
  /** Stable published releases, newest first — base notes and the baseline. */
  releases: HistoryRelease[] | undefined;
  history: HistorySource;
}

/**
 * Clone (cached) and probe the forge's release API. `opts.forge` reuses an
 * earlier fetchForgeReleases answer — watch polls the list before deciding
 * whether to clone at all, and one probe per run is enough.
 */
export async function prepareForgeTarget(
  url: string,
  opts: { forge?: ForgeListing | null } = {},
): Promise<ForgeTarget> {
  const cloneUrl = assertCloneUrl(url);
  const dir = await cloneDirFor(cloneUrl);
  if (!dir) {
    throw new Error(
      "checking a repository URL needs a private directory to clone into — set XDG_CACHE_HOME to a writable path.",
    );
  }
  console.error(`Cloning ${cloneUrl} (cached at ${dir})…`);
  await ensureClone(cloneUrl, dir);

  const target = parseRepoUrl(cloneUrl);
  const forge =
    opts.forge !== undefined ? opts.forge : target && (await fetchForgeReleases(target));
  if (target && !forge) {
    console.error(
      `No Forgejo/Gitea or GitLab release API at ${target.origin} — using the CHANGELOG section for the notes.`,
    );
  }
  const slug = target ? `${target.owner}/${target.repo}` : null;
  // The web origin is known even when the host has no release API; the
  // path dialect comes from the API detect, host name as the fallback.
  const link: RepoLink | null = target
    ? {
        base: `${target.origin}/${target.owner}/${target.repo}`,
        style:
          forge?.kind === "gitlab" || (!forge && /gitlab/i.test(target.origin))
            ? "gitlab"
            : "github",
      }
    : null;
  const releases: HistoryRelease[] | undefined = forge
    ? forge.releases
        .filter((r) => !r.draft && !r.prerelease)
        .map((r) => ({
          tag: r.tag_name,
          notes: r.body,
          date: r.published_at?.slice(0, 10) ?? null,
        }))
    : undefined;
  return {
    url: cloneUrl,
    dir,
    slug,
    origin: target?.origin ?? null,
    link,
    forge,
    releases,
    history: cloneHistory({
      dir,
      slug: slug ?? basename(dir),
      cacheKey: cloneUrl,
      releases,
    }),
  };
}

/**
 * One release of a prepared forge target: published notes and the forge's
 * base pick when the API knows the release, the CHANGELOG section otherwise
 * — then the --local load against the clone.
 */
export async function loadForgeRelease(
  t: ForgeTarget,
  opts: { head?: string; base?: string; notesFile?: string } = {},
): Promise<{ data: ReleaseData; context: RepoContext }> {
  let head = opts.head;
  let base = opts.base;
  let notes: string | undefined;
  if (t.forge) {
    const release = head
      ? t.forge.releases.find((r) => r.tag_name === head)
      : t.forge.releases.find((r) => !r.draft && !r.prerelease);
    if (release) {
      notes = release.body;
      // An explicit base always wins; otherwise the forge's own release
      // order beats "the tag before this one", which is what a clone can see.
      base ??= pickBaseRelease(t.forge.releases, release.tag_name) ?? undefined;
      head ??= release.tag_name;
      console.error(
        `Published notes for ${release.tag_name} from the ${t.forge.kind} API at ${t.origin}.`,
      );
    } else if (head) {
      console.error(
        `${head} is not a published release on ${t.origin} — falling back to the CHANGELOG section.`,
      );
    }
  }
  const data = await loadLocalRelease({
    repo: t.dir,
    head,
    base,
    notesFile: opts.notesFile,
    notes,
    // The list fetched for base-picking carries every body — the base's
    // notes cost no extra request. Resolution happens inside, against the
    // base the load actually uses (git describe may pick one this scope
    // cannot know).
    publishedReleases: t.releases,
    repoLabel: t.slug ?? undefined,
  });
  const context = await localRepoContext(t.dir, data.headRef);
  return { data, context };
}

/**
 * The full analysis pipeline for loaded release data: claims, verification,
 * coverage, metrics, report. `link` enables web links in the report; pass
 * null for sources without a known web origin (--local).
 */
export async function analyzeRelease(
  data: ReleaseData,
  context: RepoContext,
  link: RepoLink | null,
  s: CheckSettings,
): Promise<Report> {
  const claims = parseClaims(data.notes);
  if (data.baseNotes) markCarriedOver(claims, data.baseNotes, data.baseRef);
  if (!claims.length) {
    throw new Error("No claims found in the release notes — nothing to check.");
  }
  console.error(
    `${claims.length} claims parsed from the notes of ${data.headRef}; verifying against ${data.commits.length} commits…`,
  );

  // A single unbuildable snapshot already warns inside buildSnapshots; this
  // catch is the wholesale failure (release listing down, clone unusable) —
  // without a warning the report reads exactly like "too few releases".
  const baselinePromise =
    s.history && s.baseline > 0
      ? buildSnapshots(s.history, {
          count: s.baseline,
          before: data.headRef,
          concurrency: s.concurrency,
        }).catch(
          (err: Error) => {
            data.warnings.push(
              `Baseline unavailable (${err.message.split("\n")[0].slice(0, 120)}) — anomaly comparison against past releases skipped.`,
            );
            return null;
          },
        )
      : Promise.resolve(null);
  // The version-pin delta is read straight off the diff — deterministic,
  // score-neutral, and computed before any LLM stage so a --judge off run
  // still carries it. It runs ahead of verification because the pin join
  // below settles bump claims the ladder would otherwise pay a judge for.
  const pins = pinBumps(data.files, {
    repoLabel: data.repoLabel,
    components: s.components,
    origin: link ? new URL(link.base).origin : undefined,
    linkStyle: link?.style,
  });
  const bumps = await resolveBumps(data, claims, pins, s.concurrency);
  const bumpAnchors = new Map(
    bumps.filter((b) => b.observed).map((b) => [claims[b.claim].id, b]),
  );

  const [results, baselineSnapshots] = await Promise.all([
    verifyClaims(data, claims, {
      judgeMode: s.judgeMode,
      engine: s.engine,
      escalateEngine: s.escalateEngine,
      concurrency: s.concurrency,
      maxHunks: 6,
      maxEvidenceChars: 20000,
      bumps: bumpAnchors,
    }),
    baselinePromise,
  ]);
  const baseline = baselineSnapshots?.length ? summarizeBaseline(baselineSnapshots) : null;

  const coverage = s.reverse ? await computeCoverage(data, claims, results) : null;
  const metrics = computeMetrics({ data, results, coverage, context, baseline });

  // Promises are about LATER releases, so they inform and never score: the
  // flag is info-level and pushed after computeMetrics has fixed the numbers.
  const promises = checkPromises(data, s.carriedPromises ?? []);
  for (const p of promises) {
    if (p.status !== "broken") continue;
    metrics.flags.push({
      severity: "info",
      kind: "broken-promise",
      message: `Broken promise from ${p.from}: "${p.text.slice(0, 140)}" — ${p.note}`,
      files: [],
      commitShas: [],
    });
  }

  const components = s.expand ? await expandComponents(pins, data.repoLabel, s) : undefined;

  // The findings pass runs after computeMetrics has fixed the numbers —
  // structurally score-neutral, like pins and promises.
  let findings: FindingsSection | undefined;
  if (s.engine && s.findings !== false && data.files.length) {
    console.error(`Reading the diff into findings (what shipped)…`);
    findings = await summarizeShipped(data, {
      engine: s.engine,
      concurrency: s.concurrency,
      budgetChars: s.findingsBudget,
    });
  }

  let uncovered = coverage?.uncovered ?? [];
  if (s.suggest) {
    if (!s.engine) {
      console.error("--suggest needs a judge engine — skipping (run with --engine, or drop the flag).");
    } else if (uncovered.length) {
      uncovered = await suggestNotes(data, uncovered, {
        engine: s.engine,
        concurrency: s.concurrency,
        limit: s.suggestLimit ?? 15,
        // Same budget as claim verification: one commit's full diff can be
        // as large as the hunks judged for a claim, and these are the
        // highest-churn commits in the release — the ones least served by a
        // tight cap.
        maxEvidenceChars: 20000,
      });
    }
  }

  // The late join: claims meet findings only here, after both sides exist
  // and the uncovered list is final — no findings (--judge off,
  // --no-findings, empty diff) means no reconciliation, not an empty
  // scaffold. Score-neutral by construction: the metrics above are fixed.
  const reconciliation = findings?.findings.length
    ? reconcile(results, findings.findings, uncovered, coverage?.commitFiles ?? null, bumps)
    : undefined;

  return {
    repoLabel: data.repoLabel,
    baseRef: data.baseRef,
    headRef: data.headRef,
    stats: {
      commits: data.commits.length,
      files: data.files.length,
      additions: data.files.reduce((sum, f) => sum + f.additions, 0),
      deletions: data.files.reduce((sum, f) => sum + f.deletions, 0),
    },
    results,
    uncovered,
    reverseChecked: s.reverse,
    metrics,
    warnings: data.warnings,
    truncated: data.truncated ?? false,
    engine: s.engine ? s.engine.name : "off (deterministic only)",
    scoringGeneration: SCORING_GENERATION,
    linkBase: link?.base,
    linkStyle: link?.style,
    promises: promises.length ? promises : undefined,
    // Computed after the metrics are fixed — display and ledger data only.
    authors: data.commits.length
      ? authorActivity(data.commits, coverage?.commitFiles ?? null)
      : undefined,
    pins: pins.length ? pins : undefined,
    surface: data.files.length ? releaseSurface(data.files) : undefined,
    components,
    findings,
    audience: s.audience,
    reconciliation,
  };
}

/**
 * Bump claims against the pin delta, release diff first.
 *
 * A claim the release diff leaves unmatched gets a second look at the diff
 * of the commit it names: a bump landing on the version the base branch
 * already carried cancels out over the range and leaves no pin there, while
 * the commit that made it is right in the release. traefik v3.6.25 is the
 * case — `dd-trace-go` moves v2.2.3 → v2.8.2 inside commit ef514e15, its
 * go.mod line is unchanged across the range, and reading only the range
 * left the release capped at 35 for a note that describes what happened.
 * Only claims that named their own commit take this route, and only after
 * the release diff had nothing to say.
 */
async function resolveBumps(
  data: ReleaseData,
  claims: Claim[],
  pins: PinBump[],
  concurrency: number,
): Promise<BumpResolution[]> {
  const resolved = resolveBumpClaims(claims, pins);
  const unmatched = resolved.filter((b) => b.status === "unmatched");
  if (!unmatched.length) return resolved;

  const shas = new Set<string>();
  const prs = new Set<number>();
  for (const b of unmatched) {
    const claim = claims[b.claim];
    const anchors = anchorMatch(claim, data.commits);
    if (anchors.commits.length) {
      for (const commit of anchors.commits) shas.add(commit.sha);
    } else if (claim.prNumbers.length && data.resolvePr) {
      // Squash-without-suffix repos: the note's "(#13530)" appears in no
      // commit message, and the forge is the only one who knows which
      // commit merged it. The verification ladder asks the same question
      // for the same claims a moment later, off the source's own cache.
      for (const pr of claim.prNumbers.slice(0, 5)) prs.add(pr);
    }
  }
  if (prs.size && data.resolvePr) {
    const resolvePr = data.resolvePr;
    const found = await pooled([...prs], concurrency, (n) => resolvePr(n).catch(() => null));
    for (const sha of found) {
      const commit =
        sha && data.commits.find((c) => sha.startsWith(c.sha) || c.sha.startsWith(sha));
      if (commit) shas.add(commit.sha);
    }
  }
  if (!shas.size) return resolved;

  const lists = await pooled([...shas], concurrency, (sha) =>
    data.commitFiles(sha).catch(() => [] as DiffFile[]),
  );
  const commitPins = pinBumps(lists.flat(), { repoLabel: data.repoLabel });
  if (!commitPins.length) return resolved;

  const second = resolveBumpClaims(claims, commitPins, { viaCommit: true });
  return resolved.map((b) => {
    if (b.status !== "unmatched") return b;
    const retry = second.find((r) => r.claim === b.claim);
    return retry?.observed ? retry : b;
  });
}

/** `v7.1.2` and `7.1.2` name the same release in the wild — one retry. */
const toggleV = (v: string): string => (v.startsWith("v") ? v.slice(1) : `v${v}`);

/**
 * Depth-1 sub-checks for the first-party pins that name a loadable repo:
 * the component's own (from, to) range through the same pipeline. Only
 * first-party pins expand — a third-party bump is routine background, not a
 * release of this product. Sequential: components are few, and their judge
 * calls already parallelize inside each check.
 */
async function expandComponents(
  pins: PinBump[],
  repoLabel: string,
  s: CheckSettings,
): Promise<ComponentCheck[] | undefined> {
  const targets = pins.filter(
    // A pin on the checked repo itself (own download URL in the docs) would
    // re-check this very release as its own component.
    (p) => p.firstParty && p.repoUrl && p.repo !== repoLabel,
  );
  if (!targets.length) return undefined;
  const out: ComponentCheck[] = [];
  for (const pin of targets) {
    console.error(
      `First-party pin ${pin.name} ${pin.from} → ${pin.to} — sub-checking ${pin.repoUrl}…`,
    );
    out.push(await checkComponent(pin, s));
  }
  return out;
}

async function checkComponent(pin: PinBump, s: CheckSettings): Promise<ComponentCheck> {
  const summary: ComponentCheck = {
    name: pin.repo!.split("/")[1] ?? pin.repo!,
    repo: pin.repo!,
    from: pin.from,
    to: pin.to,
  };
  let loaded: { data: ReleaseData; context: RepoContext };
  try {
    try {
      loaded = await s.expand!(pin.repoUrl!, { tag: pin.to, base: pin.from });
    } catch (first) {
      try {
        loaded = await s.expand!(pin.repoUrl!, { tag: toggleV(pin.to), base: toggleV(pin.from) });
      } catch {
        // The pin's own spelling is the honest error to surface.
        throw first;
      }
    }
  } catch (err) {
    summary.error = `component load failed: ${(err as Error).message.split("\n")[0].slice(0, 160)} — tried ${pin.to} and ${toggleV(pin.to)} at ${pin.repoUrl}`;
    return summary;
  }
  const { data, context } = loaded;
  summary.baseRef = data.baseRef;
  summary.headRef = data.headRef;

  const childSettings: CheckSettings = {
    judgeMode: s.judgeMode,
    engine: s.engine,
    escalateEngine: s.escalateEngine,
    concurrency: s.concurrency,
    reverse: s.reverse,
    baseline: 0,
    // Depth stays 1: the component's own first-party pins are listed in its
    // report but never expanded. The parent's components map stays behind
    // too — its keys are the parent's pin names, and in the child's context
    // the same name could label a different repo entirely.
    expand: undefined,
    // The child folds into one summary line; its deterministic surface is
    // that summary. An LLM findings pass per component would multiply the
    // parent's judge bill for detail the fold-in never shows.
    findings: false,
  };
  try {
    const child = await analyzeRelease(data, context, null, childSettings);
    const claims: Record<Verdict, number> = {
      verified: 0,
      partial: 0,
      "no-evidence": 0,
      contradicted: 0,
      skipped: 0,
    };
    for (const r of child.results) claims[r.verdict]++;
    summary.stats = child.stats;
    summary.score = child.metrics.scores.overall;
    summary.scoreLabel = child.metrics.scores.label;
    summary.claims = claims;
    if (child.reverseChecked) summary.uncovered = child.uncovered.length;
    summary.surface = child.surface;
    if (child.truncated) summary.truncated = true;
  } catch (err) {
    // Notes-less child releases still have a diff — the deterministic
    // surface is exactly what the expansion exists to show.
    if (!/No claims found/.test((err as Error).message)) {
      summary.error = `component check failed: ${(err as Error).message.split("\n")[0].slice(0, 160)}`;
      return summary;
    }
    summary.noNotes = true;
    summary.stats = {
      commits: data.commits.length,
      files: data.files.length,
      additions: data.files.reduce((sum, f) => sum + f.additions, 0),
      deletions: data.files.reduce((sum, f) => sum + f.deletions, 0),
    };
    summary.surface = data.files.length ? releaseSurface(data.files) : undefined;
    if (data.truncated) summary.truncated = true;
  }
  return summary;
}
