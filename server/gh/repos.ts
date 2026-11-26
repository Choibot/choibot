import { runGit } from "../agents/git.js";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

export type Repo = { name: string; slug: string; path: string };

// git@github.com:owner/repo.git | https://github.com/owner/repo(.git)
export function parseSlug(url: string): string | null {
  const m = url.match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?$/);
  return m ? m[1] : null;
}

export async function listRepos(workspaceDir: string): Promise<Repo[]> {
  let entries: import("node:fs").Dirent[];
  try { entries = await readdir(workspaceDir, { withFileTypes: true }); }
  catch { return []; }
  const repos: Repo[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const path = join(workspaceDir, e.name);
    try {
      const { stdout } = await runGit(path, ["-C", path, "remote", "get-url", "origin"], undefined, path);
      const slug = parseSlug(stdout.trim());
      if (slug) repos.push({ name: e.name, slug, path });
    } catch { /* not a git repo, or no github origin */ }
  }
  return repos.sort((a, b) => a.name.localeCompare(b.name));
}
