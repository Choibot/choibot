// server/chief/brain/apply.ts — apply, discard and roll back the brain
// (spec §6.3 step 6, §7). One chain per brain dir serializes the three
// writers; RuleStore takes its own lock, so it is called from the chain.
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { EventHub } from "../../events.js";
import { atomicWrite, onChain, readText } from "../files.js";
import type { ChiefPaths } from "../paths.js";
import { proposalFile, readProposal } from "./distill.js";
import { brainChainKey } from "./chain.js";
import { RuleError, type RuleStore } from "./store.js";

const KEEP_VERSIONS = 3;
const VERSION_ID = /^\d+$/;
type Hub = Pick<EventHub, "emitEvent">;

const versionFile = (p: ChiefPaths, id: string) => join(p.versionsDir, `${id}.md`);

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

// Version ids, newest first.
export async function listVersions(paths: ChiefPaths): Promise<string[]> {
  let names: string[];
  try { names = await readdir(paths.versionsDir); } catch { return []; }
  return names.filter((n) => /^\d+\.md$/.test(n)).map((n) => n.slice(0, -3))
    .sort((a, b) => Number(b) - Number(a) || (a < b ? 1 : -1));
}

async function removeProposal(paths: ChiefPaths): Promise<void> {
  await rm(paths.proposed, { force: true });
  await rm(proposalFile(paths), { force: true });
}

// Save the current BRAIN.md as a new version; null when there is none.
async function rotate(paths: ChiefPaths, now: number): Promise<string | null> {
  if (!(await exists(paths.brain))) return null;
  const text = await readText(paths.brain);
  await mkdir(paths.versionsDir, { recursive: true, mode: 0o700 });
  // Never older than the newest version: a clock that went back must not
  // make prune delete the version just made.
  const newest = (await listVersions(paths))[0];
  let n = newest === undefined ? now : Math.max(now, Number(newest) + 1);
  while (await exists(versionFile(paths, String(n)))) n += 1;
  await atomicWrite(versionFile(paths, String(n)), text);
  return String(n);
}

async function prune(paths: ChiefPaths): Promise<void> {
  for (const id of (await listVersions(paths)).slice(KEEP_VERSIONS)) await rm(versionFile(paths, id), { force: true });
}

// `expectSha256`: the hash of the proposal the caller showed the user; a
// proposal that changed since rejects with "changed" and nothing is written.
// `version`: the id the previous BRAIN.md was saved as (rollback restores
// it); null when nothing was saved (no BRAIN.md yet, or the same text).
export function applyProposal(d: { paths: ChiefPaths; rules: RuleStore; hub: Hub; now?: () => number; expectSha256?: string }): Promise<{ version: string | null }> {
  const { paths } = d;
  return onChain(brainChainKey(paths), async () => {
    const now = (d.now ?? Date.now)();
    const proposal = await readProposal(paths);
    if (!proposal) throw new Error("no proposal");
    if (d.expectSha256 !== undefined && d.expectSha256 !== proposal.sha256) throw new Error("changed");
    // Order matters for a crash: the proposal files go last, so a re-apply
    // finishes the retires. An unchanged BRAIN.md makes no new version.
    const same = (await exists(paths.brain)) && (await readText(paths.brain)) === proposal.text;
    const version = same ? null : await rotate(paths, now);
    if (!same) await atomicWrite(paths.brain, proposal.text);
    try {
      await prune(paths);
      for (const e of proposal.retire) {
        try {
          await d.rules.retire(e.id, { by: "distill", why: e.why });
        } catch (err) {
          if (!(err instanceof RuleError)) throw err;
          console.warn(`brain apply: retire ${e.id} skipped: ${err.message}`);
        }
      }
      await removeProposal(paths);
    } finally {
      d.hub.emitEvent({ type: "brain", updatedAt: now, proposed: false });
    }
    return { version };
  });
}

export function discardProposal(d: { paths: ChiefPaths; hub: Hub; now?: () => number; expectSha256?: string }): Promise<void> {
  return onChain(brainChainKey(d.paths), async () => {
    if (d.expectSha256 !== undefined) {
      const p = await readProposal(d.paths);
      if (p && p.sha256 !== d.expectSha256) throw new Error("changed");
    }
    await removeProposal(d.paths);
    d.hub.emitEvent({ type: "brain", updatedAt: (d.now ?? Date.now)(), proposed: false });
  });
}

// Restores `version` (default: the newest) into BRAIN.md; the current brain
// becomes a version. Resolves with the restored version id.
export function rollbackBrain(d: { paths: ChiefPaths; hub: Hub; now?: () => number }, version?: string): Promise<{ version: string }> {
  const { paths } = d;
  return onChain(brainChainKey(paths), async () => {
    const now = (d.now ?? Date.now)();
    const all = await listVersions(paths);
    const id = version ?? all[0];
    if (id === undefined || !VERSION_ID.test(id) || !all.includes(id)) throw new Error("unknown version");
    const text = await readText(versionFile(paths, id));
    await rotate(paths, now);
    await atomicWrite(paths.brain, text);
    await rm(versionFile(paths, id), { force: true });
    await prune(paths);
    d.hub.emitEvent({ type: "brain", updatedAt: now, proposed: (await readProposal(paths)) !== null });
    return { version: id };
  });
}
