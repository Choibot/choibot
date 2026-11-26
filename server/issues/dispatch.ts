// server/issues/dispatch.ts — start the agent for an issue through the same
// spawnAgent the "new agent" button uses.
import type { Issue } from "./store.js";
import type { SpawnRequest, SpawnResult } from "../agents/spawn.js";
import { truncateChars } from "./text.js";

const TASK = "Fix this issue reported from Telegram. Investigate, fix, test,\nthen open a PR with `gh pr create`.";

export function issuePrompt(issue: Issue): string {
  const blocks = [TASK];
  const body = [issue.forwardedFrom ? `Forwarded from: ${issue.forwardedFrom}` : "", issue.text].filter(Boolean).join("\n");
  if (body) blocks.push(body);
  if (issue.photos.length) blocks.push(["Screenshots (read them with the Read tool):", ...issue.photos].join("\n"));
  return blocks.join("\n\n");
}

export type Dispatch = (issue: Issue) => Promise<string>;

export function makeDispatcher(deps: {
  spawn: (req: SpawnRequest) => Promise<SpawnResult>;
  listRepos: () => Promise<{ name: string; path: string }[]>;
}): Dispatch {
  return async (issue) => {
    if (!issue.repo) throw new Error("no repo chosen");
    const match = (await deps.listRepos()).find((r) => r.name === issue.repo);
    if (!match) throw new Error(`repo ${issue.repo} is not in the workspace`);
    const r = await deps.spawn({
      repo: match.path,
      prompt: issuePrompt(issue),
      runtime: "claude",
      kind: "issue",
      issueId: issue.id,
      label: truncateChars(`issue: ${issue.summary}`, 80),
    });
    if (!r.ok) throw new Error(r.error);
    return r.id;
  };
}
