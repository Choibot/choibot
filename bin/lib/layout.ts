// bin/lib/layout.ts — where the console checkout sits relative to the agents'
// workspace. Agents work in WORKSPACE_DIR; a checkout inside it puts the
// console's .env and data next to their work. setup picks a default that
// keeps it out; doctor warns when it is in (the owner's box runs agents on the
// console repo itself, so that is a choice, not an error).
import { realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

const real = (p: string): string => {
  try { return realpathSync(p); } catch { return resolve(p); }
};

/** p is root or inside it: path boundaries, not string prefixes (real paths). */
export function inside(p: string, root: string): boolean {
  const rel = relative(real(root), real(p));
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel));
}

/** True when the console checkout is WORKSPACE_DIR or inside it. */
export function checkoutInWorkspace(checkout: string, workspaceDir: string): boolean {
  return inside(checkout, workspaceDir);
}

/** setup's default WORKSPACE_DIR: ~/workspace, or ~/agent-workspace when the checkout is in ~/workspace. */
export function defaultWorkspaceDir(home: string, checkout: string): string {
  const ws = join(home, "workspace");
  return checkoutInWorkspace(checkout, ws) ? join(home, "agent-workspace") : ws;
}
