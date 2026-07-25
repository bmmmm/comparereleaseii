// SPDX-License-Identifier: GPL-3.0-or-later
import { execFile } from "node:child_process";

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
