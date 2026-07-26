// SPDX-License-Identifier: GPL-3.0-or-later
// The whole non-GitHub forge surface: a repository's list of releases.
//
// Everything else a check needs — the diff, the commits, their subjects and
// authors, the tags — a clone already answers, and `--repo-url` gets it from
// one. Two things do not live in a clone: the *published* release notes, and
// which tags are releases at all. Both come from a single flat endpoint that
// Forgejo/Gitea and GitLab each expose, so this file is the entire adapter.
import type { GhRelease } from "./github.ts";

export interface ForgeRepo {
  /** `https://git.example.com` — scheme and host, no path. */
  origin: string;
  owner: string;
  repo: string;
}

/**
 * Split a clone URL into the pieces an API path needs. Accepts the scheme
 * form and the scp-like form every forge prints, with or without `.git`, and
 * tolerates GitLab's nested groups (`group/sub/proj`) by keeping everything
 * but the last segment as the owner.
 */
export function parseRepoUrl(url: string): ForgeRepo | null {
  let origin: string;
  let path: string;
  const scp = url.match(/^[\w.-]+@([\w.-]+):(.+)$/);
  if (scp) {
    origin = `https://${scp[1]}`;
    path = scp[2];
  } else {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (!/^https?:$/.test(parsed.protocol)) return null;
    origin = parsed.origin;
    path = parsed.pathname;
  }
  const segments = path.replace(/\.git$/, "").split("/").filter(Boolean);
  if (segments.length < 2) return null;
  return { origin, owner: segments.slice(0, -1).join("/"), repo: segments[segments.length - 1] };
}

interface GiteaRelease {
  tag_name?: string;
  name?: string;
  body?: string;
  draft?: boolean;
  prerelease?: boolean;
  published_at?: string | null;
}

interface GitlabRelease {
  tag_name?: string;
  name?: string;
  description?: string;
  upcoming_release?: boolean;
  released_at?: string | null;
}

/**
 * Tokens come from the environment, never a config file: a checked-in path to
 * a credential is how one leaks, and the operator already has these exported
 * for their own CLI. A public repo needs none.
 */
function authHeaders(kind: "forgejo" | "gitlab"): Record<string, string> {
  if (kind === "gitlab") {
    const token = process.env.GITLAB_TOKEN;
    return token ? { "PRIVATE-TOKEN": token } : {};
  }
  const token = process.env.FORGEJO_TOKEN ?? process.env.GITEA_TOKEN;
  return token ? { Authorization: `token ${token}` } : {};
}

/**
 * True when the environment has a proxy that `git` will use and Node's
 * `fetch` will not.
 *
 * Node only reads the proxy variables when `NODE_USE_ENV_PROXY` is set at
 * startup — setting it from JS is too late. Behind a corporate proxy that
 * makes the clone succeed and every forge request fail with a DNS error,
 * which this file would otherwise report as "this host has no release API"
 * and quietly fall back to the CHANGELOG. Same shape as any other silent
 * downgrade: the tool did less than it said and nothing pointed at why.
 */
export function proxyBlindSpot(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_USE_ENV_PROXY) return false;
  return Boolean(env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy);
}

let proxyWarned = false;

async function getJson(url: string, headers: Record<string, string>): Promise<unknown | null> {
  let res;
  try {
    res = await fetch(url, { headers, redirect: "follow" });
  } catch {
    // Never print the proxy URL itself — it routinely carries credentials.
    if (proxyBlindSpot() && !proxyWarned) {
      proxyWarned = true;
      console.error(
        "warning: the forge API is unreachable and a proxy is configured in the environment. " +
          "Node ignores HTTP(S)_PROXY for outgoing requests unless NODE_USE_ENV_PROXY=1 is set " +
          "before it starts — `git` uses the proxy, this request did not. Re-run with " +
          "NODE_USE_ENV_PROXY=1 to check against the published release notes.",
      );
    }
    return null;
  }
  if (!res.ok) return null;
  // A forge that does not have this API often answers 200 with its login page.
  if (!/\bjson\b/i.test(res.headers.get("content-type") ?? "")) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Releases newest-first in the shape the GitHub path already speaks, so
 * base-picking and note selection stay one code path.
 *
 * Returns null — not an error — when no forge API answers. The caller then
 * falls back to the CHANGELOG section, which is what `--local` has always
 * done, and says so. A missing API is an ordinary situation (a plain git
 * host, an air-gapped mirror, a token the operator did not export), not a
 * failure worth stopping a check for.
 */
export async function fetchForgeReleases(
  target: ForgeRepo,
  opts: { limit?: number } = {},
): Promise<{ kind: "forgejo" | "gitlab"; releases: GhRelease[] } | null> {
  const limit = opts.limit ?? 100;
  const path = `${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;

  const gitea = await getJson(
    `${target.origin}/api/v1/repos/${path}/releases?limit=${limit}`,
    authHeaders("forgejo"),
  );
  if (Array.isArray(gitea)) {
    return {
      kind: "forgejo",
      releases: (gitea as GiteaRelease[])
        .filter((r) => typeof r.tag_name === "string")
        .map((r) => ({
          tag_name: r.tag_name!,
          name: r.name ?? r.tag_name!,
          body: r.body ?? "",
          draft: r.draft ?? false,
          prerelease: r.prerelease ?? false,
        })),
    };
  }

  // GitLab addresses a project by its URL-encoded full path, slash included.
  const project = encodeURIComponent(`${target.owner}/${target.repo}`);
  const gitlab = await getJson(
    `${target.origin}/api/v4/projects/${project}/releases?per_page=${limit}`,
    authHeaders("gitlab"),
  );
  if (Array.isArray(gitlab)) {
    return {
      kind: "gitlab",
      releases: (gitlab as GitlabRelease[])
        .filter((r) => typeof r.tag_name === "string")
        .map((r) => ({
          tag_name: r.tag_name!,
          name: r.name ?? r.tag_name!,
          body: r.description ?? "",
          draft: false,
          // GitLab's scheduled-but-unpublished release is its prerelease.
          prerelease: r.upcoming_release ?? false,
        })),
    };
  }

  return null;
}
