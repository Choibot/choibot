import { chiefFetch } from "./chief";
// src/lib/pr.ts — client for the PR diff API (server/pr/api.ts).

export type PrRepo = { name: string; slug: string };

export type PrDiff = {
  repo: string;
  slug: string;
  pr: number;
  base: string;
  diff: string;
  headSha: string;
  baseSha: string;
  mergeBase: string;
  tree: string[]; // every file path at the PR head
};

// Full content for one file: a full-context patch (changed) or raw text.
export type PrFile =
  | { changed: true; patch: string }
  | { changed: false; content: string };

export async function fetchPrRepos(): Promise<PrRepo[]> {
  const r = await chiefFetch("/api/pr/repos");
  if (!r.ok) throw new Error("failed to load repos");
  return (await r.json()).repos as PrRepo[];
}

export async function fetchPrDiff(
  input: { repo: string; pr: number; base?: string },
): Promise<{ ok: true; data: PrDiff } | { ok: false; error: string }> {
  const r = await chiefFetch("/api/pr/diff", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, error: body.error ?? `failed (${r.status})` };
  return { ok: true, data: body as PrDiff };
}

export async function fetchPrFile(
  input: { repo: string; path: string; headSha: string; mergeBase: string; changed: boolean },
): Promise<{ ok: true; data: PrFile } | { ok: false; error: string }> {
  const r = await chiefFetch("/api/pr/file", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, error: body.error ?? `failed (${r.status})` };
  return { ok: true, data: body as PrFile };
}

// Accept either a raw PR number ("64") or a GitHub PR URL
// (https://github.com/owner/repo/pull/64). Returns whatever it can extract.
export function parsePrRef(input: string): { slug?: string; pr?: number } {
  const text = input.trim();
  const url = text.match(/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/i);
  if (url) return { slug: url[1], pr: Number(url[2]) };
  const num = text.match(/(\d+)/);
  return num ? { pr: Number(num[1]) } : {};
}
