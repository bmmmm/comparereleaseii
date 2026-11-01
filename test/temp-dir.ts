// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function tempDir(
  t: { after: (fn: () => Promise<void>) => void },
  prefix: string,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
