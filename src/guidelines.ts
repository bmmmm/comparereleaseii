// SPDX-License-Identifier: GPL-3.0-or-later
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractMarkdownSection } from "./util.ts";

const GUIDE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "docs",
  "writing-release-notes.md",
);

const AGENT_SECTION_HEADING = "Rules for AI coding agents";

/**
 * docs/writing-release-notes.md is the single source of truth for both the
 * human-readable guide and the agent-ready checklist — this just extracts
 * the latter so the two can never drift apart.
 */
export async function loadGuidelines(opts: { full: boolean }): Promise<string> {
  const markdown = await readFile(GUIDE_PATH, "utf8");
  if (opts.full) return markdown.trim();
  const section = extractMarkdownSection(markdown, AGENT_SECTION_HEADING);
  if (!section) {
    throw new Error(
      `docs/writing-release-notes.md has no "${AGENT_SECTION_HEADING}" section — this is a packaging bug, please report it.`,
    );
  }
  return section;
}
