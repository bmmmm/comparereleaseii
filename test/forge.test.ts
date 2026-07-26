// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchForgeReleases, parseRepoUrl, proxyBlindSpot } from "../src/sources/forge.ts";

test("parseRepoUrl splits every form a forge prints", () => {
  assert.deepEqual(parseRepoUrl("https://forgejo.example.com/your-org/app.git"), {
    origin: "https://forgejo.example.com",
    owner: "team",
    repo: "comparereleaseii",
  });
  assert.deepEqual(parseRepoUrl("https://forgejo.example.com/your-org/app"), {
    origin: "https://forgejo.example.com",
    owner: "team",
    repo: "comparereleaseii",
  });
  assert.deepEqual(parseRepoUrl("git@github.com:bmmmm/comparereleaseii.git"), {
    origin: "https://github.com",
    owner: "bmmmm",
    repo: "comparereleaseii",
  });
  assert.deepEqual(parseRepoUrl("http://localhost:3000/team/app.git"), {
    origin: "http://localhost:3000",
    owner: "team",
    repo: "app",
  });
  // GitLab nests groups; everything but the last segment is the owner.
  assert.deepEqual(parseRepoUrl("https://gitlab.example.com/group/sub/proj.git"), {
    origin: "https://gitlab.example.com",
    owner: "group/sub",
    repo: "proj",
  });
  // Nothing to address an API with.
  assert.equal(parseRepoUrl("https://git.example.com/app.git"), null);
  assert.equal(parseRepoUrl("file:///srv/mirrors/app.git"), null);
  assert.equal(parseRepoUrl("not a url"), null);
});

interface Reply {
  status?: number;
  body: unknown;
  contentType?: string;
}

/**
 * A stubbed `fetch` rather than a real listener: the assertions are about the
 * URL this builds, the header it sends and the shape it maps, none of which
 * needs a socket — and a test that binds a port fails wherever listening is
 * restricted, which is a bad reason for a red suite.
 */
async function withForge(
  handler: (url: string, headers: Record<string, string>) => Reply,
  run: (origin: string, seen: string[]) => Promise<void>,
): Promise<void> {
  const seen: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push(url);
    const out = handler(url, (init?.headers ?? {}) as Record<string, string>);
    const body = typeof out.body === "string" ? out.body : JSON.stringify(out.body);
    return new Response(body, {
      status: out.status ?? 200,
      headers: { "content-type": out.contentType ?? "application/json" },
    });
  }) as typeof fetch;
  try {
    await run("https://forge.example.com", seen);
  } finally {
    globalThis.fetch = real;
  }
}

test("fetchForgeReleases reads the Forgejo/Gitea shape", async () => {
  await withForge(
    (url, headers) => {
      if (!url.includes("/api/v1/repos/team/app/releases")) return { status: 404, body: {} };
      assert.equal(headers.Authorization, "token secret-forgejo");
      return {
        body: [
          { tag_name: "v2.0.0", name: "v2.0.0", body: "## New\n- thing (#12)", draft: false, prerelease: false },
          { tag_name: "v1.9.0", name: "v1.9.0", body: "older", draft: false, prerelease: false },
        ],
      };
    },
    async (origin) => {
      process.env.FORGEJO_TOKEN = "secret-forgejo";
      try {
        const out = await fetchForgeReleases({ origin, owner: "team", repo: "app" });
        assert.equal(out?.kind, "forgejo");
        assert.deepEqual(out?.releases.map((r) => r.tag_name), ["v2.0.0", "v1.9.0"]);
        assert.match(out!.releases[0].body, /thing \(#12\)/);
      } finally {
        delete process.env.FORGEJO_TOKEN;
      }
    },
  );
});

test("fetchForgeReleases falls through to GitLab, which spells it differently", async () => {
  await withForge(
    (url, headers) => {
      // GitLab addresses the project by its URL-encoded full path.
      if (url.includes("/api/v4/projects/group%2Fsub%2Fproj/releases")) {
        assert.equal(headers["PRIVATE-TOKEN"], "secret-gitlab");
        return {
          body: [
            { tag_name: "v3.1.0", name: "3.1", description: "- fixed (!44)", upcoming_release: false },
            { tag_name: "v3.2.0", name: "3.2", description: "planned", upcoming_release: true },
          ],
        };
      }
      return { status: 404, body: {} };
    },
    async (origin, seen) => {
      process.env.GITLAB_TOKEN = "secret-gitlab";
      try {
        const out = await fetchForgeReleases({ origin, owner: "group/sub", repo: "proj" });
        assert.equal(out?.kind, "gitlab");
        // `description` is GitLab's `body`, `upcoming_release` its prerelease.
        assert.equal(out?.releases[0].body, "- fixed (!44)");
        assert.equal(out?.releases[1].prerelease, true);
        assert.ok(seen[0].includes("/api/v1/repos/"), "Forgejo shape tried first");
      } finally {
        delete process.env.GITLAB_TOKEN;
      }
    },
  );
});

test("a host with no release API is not an error — the CHANGELOG still works", async () => {
  // A plain git host answers the login page with 200 and text/html for any
  // path. Parsing that as a release list would be worse than having none.
  await withForge(
    () => ({ body: "<!doctype html><title>Sign in</title>", contentType: "text/html" }),
    async (origin) => {
      assert.equal(await fetchForgeReleases({ origin, owner: "team", repo: "app" }), null);
    },
  );
  // And an unreachable host resolves to the same "no API", not a throw.
  assert.equal(
    await fetchForgeReleases({ origin: "http://127.0.0.1:1", owner: "team", repo: "app" }),
    null,
  );
});

test("proxyBlindSpot names the case where git reaches the forge and fetch does not", () => {
  // Node reads the proxy variables at startup only, so a process that finds
  // one set without NODE_USE_ENV_PROXY will clone fine and fail every API
  // request with a DNS error — which reads exactly like "no API here".
  assert.equal(proxyBlindSpot({ HTTPS_PROXY: "http://proxy.example:3128" }), true);
  assert.equal(proxyBlindSpot({ http_proxy: "http://proxy.example:3128" }), true);
  assert.equal(
    proxyBlindSpot({ HTTPS_PROXY: "http://proxy.example:3128", NODE_USE_ENV_PROXY: "1" }),
    false,
  );
  assert.equal(proxyBlindSpot({}), false);
});
