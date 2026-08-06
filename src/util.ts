// SPDX-License-Identifier: GPL-3.0-or-later
import { execFile, spawn } from "node:child_process";
import { access, constants, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { delimiter, join } from "node:path";

/** PATH lookup without spawning — instant, no side effects. */
export async function commandExists(cmd: string): Promise<boolean> {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    try {
      await access(join(dir, cmd), constants.X_OK);
      return true;
    } catch {
      // keep searching
    }
  }
  return false;
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

// Kernel-scale releases are out of scope (settled 2026-08-04, closing the
// 2026-07-27 bughunt FIXME): the 64 MB default maxBuffer is a deliberate
// ceiling. Hitting it names the cap and the way out instead of blaming the
// child process; the streaming diff parse stays unbuilt until a real
// target needs it.
export function run(
  cmd: string,
  args: string[],
  opts: { input?: string; cwd?: string; maxBuffer?: number } = {},
): Promise<RunResult> {
  const maxBuffer = opts.maxBuffer ?? 64 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      { cwd: opts.cwd, maxBuffer },
      (err, stdout, stderr) => {
        if (err) {
          if (/maxBuffer/i.test(err.message)) {
            const mb = Math.round(maxBuffer / (1024 * 1024));
            reject(
              new Error(
                `${cmd} produced more output than the ${mb} MB this tool parses in memory — ` +
                  `for a huge release diff, narrow the range with --base or check a smaller release.`,
              ),
            );
            return;
          }
          reject(
            new Error(
              `${cmd} ${args.slice(0, 3).join(" ")}… failed: ${stderr.trim() || err.message}`,
            ),
          );
        } else {
          resolve({ stdout, stderr });
        }
      },
    );
    if (opts.input !== undefined) {
      // A child that exits before draining stdin (e.g. a judge CLI erroring
      // at startup while a large prompt is being piped in) emits EPIPE here;
      // without a listener that is an unhandled 'error' event and kills the
      // whole process. The execFile callback above still reports the failure.
      child.stdin?.on("error", () => {});
      child.stdin?.write(opts.input);
      child.stdin?.end();
    }
  });
}

/** Minimal concurrency pool: run tasks with at most `limit` in flight. */
export async function pooled<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

/** A fenced-code-block delimiter line — between two of these, `#` is a
 * comment, not a heading (a shell example in a changelog must not end the
 * section). */
export const FENCE_LINE = /^\s{0,3}(?:```|~~~)/;

const HEADING_LINE = /^(#{1,4})\s+(.*)$/;

/**
 * Slice out the body under the first heading `matches` accepts, ending before
 * the next heading of the same or higher level. Both scans skip fenced code
 * blocks, so a `#` inside a shell example neither starts nor ends a section.
 *
 * The predicate sees the heading text without its marker and the marker's
 * level — callers decide what "the right heading" means (exact text, a version
 * somewhere in the line), the traversal is the same either way.
 */
export function sliceHeadingSection(
  text: string,
  matches: (heading: string, level: number) => boolean,
): string | null {
  const lines = text.split("\n");
  let start = -1;
  let level = 0;
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE_LINE.test(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = lines[i].match(HEADING_LINE);
    if (m && matches(m[2].trim(), m[1].length)) {
      start = i;
      level = m[1].length;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  inFence = false;
  for (let i = start + 1; i < lines.length; i++) {
    if (FENCE_LINE.test(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = lines[i].match(/^(#{1,4})\s/);
    if (m && m[1].length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n").trim();
}

/** Slice out one heading's body from markdown, matched by exact heading text. */
export function extractMarkdownSection(markdown: string, heading: string): string | null {
  return sliceHeadingSection(markdown, (h) => h === heading);
}

export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n… [truncated ${text.length - maxChars} chars]`;
}

/**
 * Strip terminal control characters from text of foreign origin (release
 * notes, commit subjects, judge output) before printing it. An escape
 * sequence smuggled into a note could otherwise rewrite the report line it
 * appears on: recolor a verdict, move the cursor, hide text. Keeps newline
 * and tab; strips the rest of C0, DEL, C1 (U+009B is a one-byte CSI), and
 * the invisible bidi/format characters of the Trojan-Source class — a note
 * that renders differently than it reads is this tool's own threat model.
 * Directional marks in honest RTL text are safe to drop: terminals run
 * their own bidi over the plain text.
 */
const CONTROL_CHARS = new RegExp(
  "[\\x00-\\x08\\x0b-\\x1f\\x7f-\\x9f\\u200b\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069\\u2028\\u2029\\ufeff]",
  "g",
);

export function stripControl(s: string): string {
  return s.replace(CONTROL_CHARS, "");
}

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

function ansi(code: string): (s: string) => string {
  return (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
}

export const c = {
  green: ansi("32"),
  yellow: ansi("33"),
  red: ansi("31"),
  magenta: ansi("35"),
  gray: ansi("90"),
  bold: ansi("1"),
  dim: ansi("2"),
  cyan: ansi("36"),
};

/**
 * HTML text escaping for the generated pages. Ampersand first, or the
 * entities the later rules introduce get escaped a second time.
 */
export function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * `cmd` is the operator's own shell string — running it is the feature. The
 * report path is not: it carries a repo key and a tag, both from the config
 * and the forge. It is therefore passed as a positional argument and read back
 * as `"$1"`, never interpolated — the shell parses the operator's command and
 * nothing else. Writing `${cmd} ${jsonPath}` here would hand a crafted tag a
 * shell; the two sanitizers upstream (`safeSegment`, `sanitizeTag`) would then
 * be the only thing left, and defence in depth is the point.
 */
export function runNotify(cmd: string, jsonPath: string): Promise<boolean> {
  return new Promise((done) => {
    const child = spawn("sh", ["-c", `${cmd} "$1"`, "sh", jsonPath], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("close", (code) => {
      if (code !== 0) console.error(`warning: notify command exited with ${code}`);
      done(code === 0);
    });
    child.on("error", (err) => {
      console.error(`warning: notify command failed to start: ${err.message}`);
      done(false);
    });
  });
}

/**
 * Write JSON where a crash must not leave a half-written file behind: the
 * whole document goes to a sibling first, then one rename, which is atomic
 * within a filesystem. `trailingNewline` for files a human opens in an editor.
 */
export async function writeJsonAtomic(
  path: string,
  value: unknown,
  trailingNewline = false,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + (trailingNewline ? "\n" : ""));
  await rename(tmp, path);
}
