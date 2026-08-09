// SPDX-License-Identifier: GPL-3.0-or-later
//
// Write a whole report to stdout, whatever stdout is.
//
// Three ways to get this wrong, all of them met on 2026-08-09 while trying to
// hand a full-corpus measurement to `pnpm sweep`:
//
//   console.log(big); process.exit()   loses everything past the pipe buffer.
//                                      Synchronous to a file, asynchronous to
//                                      a pipe, and exit does not wait.
//   write(big, () => process.exit())   the callback fires after the drain, so
//                                      every statement below it runs first —
//                                      the human report ended up appended to
//                                      the machine one.
//   writeSync(1, big)                  writes as much as the pipe takes and
//                                      RETURNS how much that was. Ignoring the
//                                      return value truncated a 130 KB report
//                                      at 65184 bytes and exited 0.
//
// The last one is the dangerous shape: a measurement that reports success and
// hands back a quarter of its answer. So the loop below is the whole point of
// this file — bytes, an offset, and no assumption that one call is enough.
import { writeSync } from "node:fs";

export function writeStdoutSync(text: string): void {
  const buf = Buffer.from(text, "utf8");
  let written = 0;
  while (written < buf.length) {
    try {
      written += writeSync(1, buf, written, buf.length - written);
    } catch (err) {
      // A pipe whose reader has not caught up yet; nothing to do but retry.
      if ((err as NodeJS.ErrnoException).code === "EAGAIN") continue;
      throw err;
    }
  }
}
