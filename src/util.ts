// SPDX-License-Identifier: GPL-3.0-or-later
import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
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

export function run(
  cmd: string,
  args: string[],
  opts: { input?: string; cwd?: string; maxBuffer?: number } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      { cwd: opts.cwd, maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
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

/** Slice out one heading's body from markdown, matched by exact heading text. */
export function extractMarkdownSection(markdown: string, heading: string): string | null {
  const lines = markdown.split("\n");
  const headingRe = /^(#{1,4})\s+(.*)$/;
  let start = -1;
  let level = 0;
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE_LINE.test(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = lines[i].match(headingRe);
    if (m && m[2].trim() === heading) {
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

export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n… [truncated ${text.length - maxChars} chars]`;
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
