// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from "node:fs";
import { lstat, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const APP = "comparereleaseii";

/** This build's version — part of every cache key, so an upgrade never
 * serves a verdict produced by a different prompt or scoring rule. */
export const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

/**
 * Root of the on-disk caches. Deliberately NOT the system temp dir: on a
 * shared machine or CI runner /tmp is world-writable, and every cache entry
 * here is keyed by data an attacker can compute (the release notes and diff
 * are public). Anyone able to create the directory first could plant the
 * verdict for a release before it is ever checked.
 */
function cacheRoot(): string | null {
  const xdg = process.env.XDG_CACHE_HOME;
  if (xdg) return join(xdg, APP);
  const home = homedir();
  if (!home || home === "/") return null;
  return join(home, ".cache", APP);
}

let warned = false;

/**
 * Create (0700) and vet a cache subdirectory. Returns null — caching off,
 * everything still works — when there is no private place to put it, or when
 * what is there is not a plain directory of ours, or is group/other-writable.
 */
export async function cacheDir(sub: string): Promise<string | null> {
  const root = cacheRoot();
  if (!root) return null;
  const dir = join(root, sub);
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const st = await lstat(dir);
    const ours = process.getuid === undefined || st.uid === process.getuid();
    if (!st.isDirectory() || !ours || (st.mode & 0o022) !== 0) {
      throw new Error(
        st.isDirectory()
          ? `${dir} is writable by others or owned by another user`
          : `${dir} is not a directory`,
      );
    }
    return dir;
  } catch (err) {
    if (!warned) {
      warned = true;
      console.error(
        `warning: on-disk cache disabled — ${(err as Error).message}. ` +
          "Remove or fix that path, or set XDG_CACHE_HOME to a private directory.",
      );
    }
    return null;
  }
}

/** Make an arbitrary ref/repo name safe as one path component. */
export function safeSegment(name: string): string {
  return name.replace(/[^\w.@-]+/g, "_").slice(0, 120) || "_";
}

/**
 * The cache directory for a clone of `url` — the ONE key scheme for every
 * caller. --repo-url used to key by raw URL while the compare-truncation
 * fallback keyed by owner/repo slug: the same repository cloned twice into
 * two directories that could then drift. Trailing `.git` and `/` are
 * stripped so the spellings every forge prints land in the same clone.
 */
export async function cloneDirFor(url: string): Promise<string | null> {
  const clones = await cacheDir("clones");
  if (!clones) return null;
  return join(clones, safeSegment(url.replace(/\/+$/, "").replace(/\.git$/, "")));
}
