// SPDX-License-Identifier: GPL-3.0-or-later
// `watch setup`: from a bare machine to a scheduled watch routine — the
// operations sibling of `watch init`. Four decisions that used to be
// undocumented handwork: where config/state/reports live, which judge (and
// whether a local one is even fit — the calibration gate is one command
// away), how often (launchd or cron), and where to alert.
//
// It only ever writes files, and only after every answer is in: the config,
// the schedule file, and nothing else. The command that activates the
// schedule is PRINTED, never run — no daemon, nothing installed silently.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { safeSegment } from "./paths.ts";
import { commandExists, c } from "./util.ts";
import { ghApi } from "./sources/github.ts";
import { discoverLocalModels } from "./judge.ts";
import { calibrateModels, gateCalibration, printCalibration, loadReference } from "./calibrate.ts";
import { runNotify, type WatchConfig, type WatchRepoConfig, type WatchState } from "./watch.ts";
import { addRepos, addRepoUrl, loadConfig, probeForgeUrl, saveConfig, REPO_RE } from "./watchlist.ts";

/** One judge this machine offers, in recommendation order. */
export interface JudgeOption {
  engine: "claude-cli" | "api" | "openai" | "off";
  openaiUrl?: string;
  note: string;
}

/** What the environment offers, best first; "off" is always the last resort. */
export function judgeOptions(opts: {
  hasClaude: boolean;
  env: NodeJS.ProcessEnv;
}): JudgeOption[] {
  const found: JudgeOption[] = [];
  if (opts.hasClaude) {
    found.push({ engine: "claude-cli", note: "the claude CLI on PATH (subscription-covered)" });
  }
  if (opts.env.ANTHROPIC_API_KEY) {
    found.push({ engine: "api", note: "ANTHROPIC_API_KEY is exported (pay per call)" });
  }
  if (opts.env.OPENAI_BASE_URL) {
    found.push({
      engine: "openai",
      openaiUrl: opts.env.OPENAI_BASE_URL,
      note: `OpenAI-compatible server at ${opts.env.OPENAI_BASE_URL} (from OPENAI_BASE_URL)`,
    });
  }
  found.push({ engine: "off", note: "no LLM — deterministic checks only (anchors, lexical evidence)" });
  return found;
}

/**
 * "30m" / "6h" / "daily" → launchd seconds + a cron expression. Minutes under
 * 5 are refused (that is polling, not watching), and only divisors of the
 * hour/day are accepted: cron's step syntax with a non-divisor (every 7
 * minutes) fires at :56 and then :00 — a ragged schedule that silently
 * diverges from launchd's exact interval. The cron minute is fixed at 17 so
 * a fleet of watchers does not stampede forges on the hour.
 */
export function scheduleSpec(input: string): { seconds: number; cron: string } | null {
  const t = input.trim().toLowerCase();
  if (t === "daily" || t === "1d" || t === "24h") return { seconds: 86_400, cron: "17 6 * * *" };
  let m = t.match(/^(\d+)\s*h(?:ours?)?$/);
  if (m) {
    const n = Number(m[1]);
    if (n < 1 || n > 24 || 24 % n !== 0) return null;
    if (n === 24) return { seconds: 86_400, cron: "17 6 * * *" };
    return { seconds: n * 3600, cron: n === 1 ? "17 * * * *" : `17 */${n} * * *` };
  }
  m = t.match(/^(\d+)\s*m(?:in(?:utes?)?)?$/);
  if (m) {
    const n = Number(m[1]);
    if (n === 60) return { seconds: 3600, cron: "17 * * * *" };
    if (n < 5 || n >= 60 || 60 % n !== 0) return null;
    return { seconds: n * 60, cron: `*/${n} * * * *` };
  }
  return null;
}

/**
 * Apply the picked judge to the config's defaults. Clearing the OTHER mode's
 * leftovers is the point: an adopted config may carry `judge: "off"` from an
 * earlier setup, and `runWatch` reads that field first — a newly picked
 * engine would silently never judge under it.
 */
export function applyJudgeChoice(defaults: Partial<WatchRepoConfig>, judge: JudgeOption): void {
  if (judge.engine === "off") {
    defaults.judge = "off";
    delete defaults.engine;
    delete defaults.model;
    delete defaults.openaiUrl;
    return;
  }
  delete defaults.judge;
  defaults.engine = judge.engine;
  defaults.escalate ??= "auto";
  if (judge.engine !== "openai") {
    // A model name adopted from an earlier local-server setup means nothing
    // to claude-cli/api — the default (haiku) does.
    delete defaults.model;
    delete defaults.openaiUrl;
  }
}

/** POSIX single-quote: closes, escapes the quote, reopens. */
function shq(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

function xmlEsc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The launchd job runs through `sh -lc` on purpose: launchd's PATH knows
 * neither gh nor claude nor a package-manager git, and the login shell's
 * profile is where the operator already solved that.
 */
export function launchdPlist(opts: {
  label: string;
  node: string;
  bin: string;
  config: string;
  logPath: string;
  seconds: number;
}): string {
  const cmd = `exec ${shq(opts.node)} ${shq(opts.bin)} watch --config ${shq(opts.config)}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xmlEsc(opts.label)}</string>
  <key>ProgramArguments</key><array>
    <string>/bin/sh</string><string>-lc</string>
    <string>${xmlEsc(cmd)}</string>
  </array>
  <key>StartInterval</key><integer>${opts.seconds}</integer>
  <key>StandardOutPath</key><string>${xmlEsc(opts.logPath)}</string>
  <key>StandardErrorPath</key><string>${xmlEsc(opts.logPath)}</string>
</dict></plist>
`;
}

/** One crontab line; the PATH prefix is what cron's minimal environment lacks. */
export function cronLine(opts: {
  node: string;
  bin: string;
  config: string;
  logPath: string;
  cron: string;
}): string {
  return (
    `${opts.cron} PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH" ` +
    `${shq(opts.node)} ${shq(opts.bin)} watch --config ${shq(opts.config)} >> ${shq(opts.logPath)} 2>&1`
  );
}

/** `~` is the first thing a user types at a path prompt; the shell is not
 * there to expand it. */
export function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;
}

export async function runWatchSetup(): Promise<number> {
  if (!process.stdin.isTTY) {
    throw new Error(
      "watch setup is interactive and needs a terminal — the files it would write are documented in docs/watchdog.md.",
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const closed = new Promise<null>((res) => rl.once("close", () => res(null)));
  /** Trimmed answer, the default on empty input, null on EOF (= cancel). */
  const ask = async (q: string, def: string): Promise<string | null> => {
    let answer: string | null;
    try {
      answer = await Promise.race([
        rl.question(`\n${q}${def ? ` [${def}]` : ""}: `),
        closed,
      ]);
    } catch {
      // The interface closed under us (ctrl-d between questions) — a cancel,
      // not a crash.
      return null;
    }
    if (answer === null) return null;
    return answer.trim() || def;
  };
  const yes = (s: string) => /^y(es)?$/i.test(s);

  try {
    console.error(
      "watch setup — answers first, files last. Writes a config and a schedule file,\n" +
        "prints the command that activates the schedule. Nothing is installed.",
    );

    // 1. Home: everything in one directory — config, state, reports, log —
    // so the whole routine is one path to back up, move or scp.
    const home = await ask("Where should the watch routine live?", join(homedir(), "release-watch"));
    if (home === null) return cancelled();
    const dir = resolve(expandHome(home));
    const configPath = join(dir, "watch.json");
    const { config, existed } = await loadConfig(configPath);
    if (existed) {
      console.error(
        `Adopting the existing ${configPath} (${config.repos.length} repo(s)) — answers here override its settings.`,
      );
    }

    // 2. State: fresh next to the config, or adopt one from an earlier setup
    // (its history keeps relative alerting and promise ledgers intact).
    if (!config.stateFile) {
      const stateAns = await ask(
        "Existing state file to adopt (path), empty for a fresh one next to the config",
        "",
      );
      if (stateAns === null) return cancelled();
      if (stateAns) {
        const statePath = resolve(expandHome(stateAns));
        let parsed: WatchState;
        try {
          parsed = JSON.parse(await readFile(statePath, "utf8")) as WatchState;
          if (parsed.version !== 1 || typeof parsed.repos !== "object") {
            throw new Error("unrecognized shape");
          }
        } catch (err) {
          throw new Error(
            `${statePath} is not a readable watch state (${(err as Error).message}) — point at an existing watch-state.json or leave the answer empty.`,
          );
        }
        config.stateFile = statePath;
        console.error(`Adopted: ${Object.keys(parsed.repos).length} repo(s) of history.`);
      } else {
        config.stateFile = "watch-state.json";
      }
    }

    // 3. Judge.
    const options = judgeOptions({ hasClaude: await commandExists("claude"), env: process.env });
    console.error("\nJudges this machine offers:\n");
    options.forEach((o, i) => console.error(`  ${i + 1}  ${o.engine.padEnd(10)} ${c.dim(o.note)}`));
    let judge: JudgeOption | undefined;
    while (!judge) {
      const pick = await ask(`Which judge? (1-${options.length})`, "1");
      if (pick === null) return cancelled();
      const n = Number(pick);
      if (Number.isInteger(n) && n >= 1 && n <= options.length) judge = options[n - 1];
      else console.error(`Expected a number 1-${options.length}.`);
    }
    config.defaults ??= {};
    applyJudgeChoice(config.defaults, judge);
    if (judge.engine === "openai") {
      const rc = await configureLocalJudge(config, judge.openaiUrl!, ask, yes);
      if (rc !== undefined) return rc;
    }

    // 4. Repos — the GitHub account picker stays `watch init`; here entries
    // arrive directly, slugs and forge URLs alike.
    if (!config.repos.length) {
      const ans = await ask(
        "Repos to watch — owner/repo (GitHub) or forge URLs, space/comma separated, empty to decide later",
        "",
      );
      if (ans === null) return cancelled();
      const hasGh = await commandExists("gh");
      for (const token of ans.split(/[\s,]+/).filter(Boolean)) {
        try {
          if (token.includes("://") || /^[\w.-]+@[\w.-]+:/.test(token)) {
            const probe = await probeForgeUrl(token);
            if (addRepoUrl(config, probe.url)) {
              console.error(`  + ${probe.owner}/${probe.repo} (${probe.kind} at ${probe.origin})`);
            }
          } else if (REPO_RE.test(token)) {
            // Canonical casing (and rename-following) when gh is here; the
            // syntactic add still works on a machine without it.
            const repo = hasGh
              ? (await ghApi<{ full_name: string }>(`repos/${token}`)).full_name
              : token;
            const { added } = addRepos(config, [repo]);
            if (added.length) console.error(`  + ${repo}${hasGh ? "" : " (not validated — gh is not installed)"}`);
          } else {
            console.error(`  ! "${token}" is neither owner/repo nor a forge URL — skipped.`);
          }
        } catch (err) {
          console.error(`  ! ${token}: ${(err as Error).message}`);
        }
      }
      console.error(`${config.repos.length} repo(s) in the list.`);
    }

    // 5. Schedule.
    let spec: { seconds: number; cron: string } | null = null;
    while (!spec) {
      const every = await ask('How often should watch run? ("30m", "6h", "daily")', "6h");
      if (every === null) return cancelled();
      spec = scheduleSpec(every);
      if (!spec) {
        console.error(
          'Expected "daily", hours dividing 24 ("1h", "6h", "12h"), or minutes dividing 60, at least 5 ("15m", "30m").',
        );
      }
    }

    // 6. Notify — fired once as a test against a throwaway JSON, so a typo'd
    // command fails here and not silently on the first flagged release.
    const notifyAns = await ask(
      "Notify command for flagged releases (runs as `cmd <json-report-path>`; e.g. \"ntfy publish releases\"), empty for none",
      config.notify ?? "",
    );
    if (notifyAns === null) return cancelled();
    if (notifyAns) {
      config.notify = notifyAns;
      const tmp = await mkdtemp(join(tmpdir(), "crii-setup-"));
      const testPath = join(tmp, "notify-test.json");
      await writeFile(
        testPath,
        JSON.stringify({ setupTest: true, note: "comparereleaseii watch setup — notify hook test" }, null, 2),
      );
      console.error("Firing the notify hook once as a test…");
      const ok = await runNotify(notifyAns, testPath);
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
      if (!ok) {
        // The test-fire exists so a typo fails HERE, not on the first
        // flagged release — a failing command must not slide into the config.
        const keep = await ask("The notify command failed — keep it in the config anyway? (y/n)", "n");
        if (keep === null) return cancelled();
        if (!yes(keep)) {
          delete config.notify;
          console.error('Notify hook dropped — add one later as "notify" in the config.');
        }
      }
    }

    // Every answer is in — now the writes, all of them under `dir`.
    await mkdir(dir, { recursive: true });
    await saveConfig(configPath, config);
    const node = process.execPath;
    const bin = fileURLToPath(new URL("../bin/comparerelease.mjs", import.meta.url));
    const logPath = join(dir, "watch.log");
    let schedulePath: string;
    let activate: string;
    let deactivate: string;
    if (process.platform === "darwin") {
      // The label carries the home dir's name so two watch homes can
      // coexist; the activation COPIES the plist into ~/Library/LaunchAgents
      // because that is the only place launchd reloads it from after a
      // reboot — bootstrapping the file here would last until logout.
      const label = `comparereleaseii.watch.${safeSegment(basename(dir))}`;
      const name = `${label}.plist`;
      schedulePath = join(dir, name);
      await writeFile(
        schedulePath,
        launchdPlist({ label, node, bin, config: configPath, logPath, seconds: spec.seconds }),
      );
      const uid = process.getuid?.() ?? "$(id -u)";
      const installed = join(homedir(), "Library", "LaunchAgents", name);
      activate =
        `cp ${shq(schedulePath)} ${shq(installed)} && launchctl bootstrap gui/${uid} ${shq(installed)}`;
      deactivate = `launchctl bootout gui/${uid}/${label} && rm ${shq(installed)}`;
    } else {
      schedulePath = join(dir, "watch.cron");
      await writeFile(schedulePath, cronLine({ node, bin, config: configPath, logPath, cron: spec.cron }) + "\n");
      // Guarded on the config path so pasting it twice cannot double the
      // schedule — cron happily runs the same line as often as it appears.
      activate = `crontab -l 2>/dev/null | grep -qF ${shq(configPath)} || ( crontab -l 2>/dev/null; cat ${shq(schedulePath)} ) | crontab -`;
      deactivate = "crontab -e   # delete the comparereleaseii line";
    }

    const prog = process.env.COMPARERELEASE_PROG ?? "comparerelease";
    console.error(
      `\nSetup complete — files written, nothing installed:\n` +
        `  config    ${configPath} (${config.repos.length} repo(s))\n` +
        `  state     ${resolve(dir, config.stateFile!)}\n` +
        `  reports   ${join(dir, "reports")} — index.html after the first run\n` +
        `  schedule  ${schedulePath}\n` +
        `\nFirst run — seeds the state and produces the index:\n` +
        `  ${shq(node)} ${shq(bin)} watch --config ${shq(configPath)}\n` +
        `\nActivate the schedule (this is the one thing setup does not do):\n` +
        `  ${activate}\n` +
        `  (undo: ${deactivate})\n` +
        `\nGrow the list anytime: ${prog} watch init --config ${shq(configPath)} (pick from\n` +
        `your GitHub account), ${prog} watch add owner/repo, ${prog} watch add --repo-url <url>.`,
    );
    return 0;
  } finally {
    rl.close();
  }
}

function cancelled(): number {
  console.error("\nCancelled — nothing written.");
  return 0;
}

/**
 * Model pick + calibration gate for an OpenAI-compatible server. Returns an
 * exit code to bubble up (cancel), or undefined to continue the flow.
 */
async function configureLocalJudge(
  config: WatchConfig,
  openaiUrl: string,
  ask: (q: string, def: string) => Promise<string | null>,
  yes: (s: string) => boolean,
): Promise<number | undefined> {
  config.defaults!.openaiUrl = openaiUrl;
  const found = await discoverLocalModels(openaiUrl);
  let model: string | undefined;
  if (found && !found.authRequired && found.models.length === 1) {
    model = found.models[0];
    console.error(`One model on the server: ${model}.`);
  } else if (found && !found.authRequired && found.models.length > 1 && found.models.length <= 30) {
    console.error("\nModels on the server:\n");
    found.models.forEach((m, i) => console.error(`  ${i + 1}  ${m}`));
    while (!model) {
      const pick = await ask(`Which model judges? (1-${found.models.length})`, "1");
      if (pick === null) return cancelled();
      const n = Number(pick);
      if (Number.isInteger(n) && n >= 1 && n <= found.models.length) model = found.models[n - 1];
      else console.error(`Expected a number 1-${found.models.length}.`);
    }
  } else {
    while (!model) {
      const name = await ask(`Model name on ${openaiUrl}`, "");
      if (name === null) return cancelled();
      if (name) model = name;
      else console.error("A local judge needs a model name — the server did not list any.");
    }
  }
  config.defaults!.model = model;

  const calAns = await ask(
    `Run the calibration gate on ${model} now? Answers fit / escalate-only / reject in one run (y/n)`,
    "y",
  );
  if (calAns === null) return cancelled();
  if (yes(calAns)) {
    const [cal] = await calibrateModels([model], {
      baseUrl: openaiUrl,
      apiKey: process.env.OPENAI_API_KEY,
      cache: true,
      concurrency: 4,
    });
    printCalibration(cal, await loadReference());
    const gate = gateCalibration(cal);
    if (gate.verdict === "not-recommended") {
      const keep = await ask(
        `${model} failed the gate (${gate.reasons[0] ?? "see above"}). Keep it anyway? (y/n)`,
        "n",
      );
      if (keep === null) return cancelled();
      if (!yes(keep)) {
        delete config.defaults!.model;
        delete config.defaults!.openaiUrl;
        delete config.defaults!.engine;
        config.defaults!.judge = "off";
        console.error("Falling back to deterministic checks (judge off) — re-run setup after changing the model.");
      }
    } else if (gate.verdict === "escalate-only") {
      console.error(
        "Usable with escalation: keeping escalate=auto — have the claude CLI or ANTHROPIC_API_KEY " +
          "available where watch runs, or its release-critical verdicts stay unreviewed.",
      );
    }
  }
  return undefined;
}
