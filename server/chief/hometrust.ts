// server/chief/hometrust.ts — a console-made agent (the Coordinator, a lead, the fleet master)
// whose session shows a dialog that only the console can end.
//
// 1. The folder trust dialog of ITS OWN home. A new session never shows it (the home is marked
//    trusted before the start, runtimes/claude.ts). A session that was started before that
//    mark existed keeps the dialog for good: dtach keeps it across a console restart, the
//    console rightly types nothing into it (issues/reply.ts), and nothing restarts it because
//    it is up (the live console, 2026-11-20). Here the console writes the mark and starts that
//    session again. The session has no conversation yet: nothing is lost.
//    Never for a folder of the user: there the user answers, in the agent's pane.
// 2. The login picker ("Select login method"): the Claude login of the session is signed out.
//    The login gets its mark (agents/accounts.ts) and the session starts again; a console-made
//    agent then starts on a login that works (agents/recovery.ts).
//
// One try per agent and dialog for the life of the process: a dialog that comes back after
// the restart stays for the user (the Coordinator's row in Settings says "Needs you").
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentRecord, SessionStore } from "../agents/store.js";
import { CONSOLE_HOME_KINDS, type TrustOutcome } from "../agents/runtimes/claude-trust.js";
import type { EventHub } from "../events.js";

export type HomeDialogDeps = {
  hub: Pick<EventHub, "subscribe">;
  agents: Pick<SessionStore, "load">;
  // The dialog on the agent's screen now (PromptWatcher.state): its kind and, for the folder
  // trust dialog, the folder it names.
  prompt: (id: string) => Promise<{ kind: string; detail?: string } | null>;
  // Writes the trust mark of the agent's home into the config of its login (claude-trust.ts).
  trust: (rec: AgentRecord, home: string) => TrustOutcome;
  // Claude said that the login of `rec` is signed out. True when the mark is set.
  signedOut: (rec: AgentRecord) => Promise<boolean>;
  // Ends the session and starts the agent again its own way (kill, wait, ensure).
  restart: (rec: AgentRecord) => Promise<unknown>;
  // A hardened deployment writes nothing into an agent's config: no trust mark, no restart for it.
  hardened: boolean;
  workspaceDir: string;
  log?: (s: string) => void;
};

const real = (dir: string): string => { try { return realpathSync(dir); } catch { return resolve(dir); } };
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function watchHomeDialogs(d: HomeDialogDeps): () => void {
  const log = d.log ?? ((s: string) => console.warn(s));
  const tried = new Set<string>();

  const handle = async (id: string, kind: string): Promise<void> => {
    if (kind !== "folder-trust" && kind !== "login-method") return;
    const rec = await d.agents.load(id);
    if (!rec || !CONSOLE_HOME_KINDS.has(rec.kind ?? "")) return;
    const key = `${id}:${kind}`;
    if (tried.has(key)) return;
    // The screen now, not the event: the dialog can be gone.
    const now = await d.prompt(id);
    if (!now || now.kind !== kind) return;
    if (kind === "folder-trust") {
      if (d.hardened) return;
      const home = rec.cwd ?? (rec.repo ? rec.worktree : d.workspaceDir);
      // Only the dialog of its own home. A dialog that names another folder is not the console's to answer.
      if (!now.detail || real(now.detail) !== real(home)) return;
      tried.add(key);
      const outcome = d.trust(rec, home);
      if (outcome !== "written" && outcome !== "already") { log(`[chief] ${id} shows the folder trust dialog of its home; the mark was not written (${outcome}): the user answers it`); return; }
      log(`[chief] ${id} showed the folder trust dialog of its own home (a session from before the mark): marked trusted, the session starts again`);
    } else {
      tried.add(key);
      if (!(await d.signedOut(rec))) return;
      log(`[chief] ${id} shows the login picker: its Claude login is signed out; the session starts again on a login that works`);
    }
    await d.restart(rec);
  };

  return d.hub.subscribe((e) => {
    if (e.type !== "agent-prompt" || e.kind === null) return;
    void handle(e.agentId, e.kind).catch((err) => log(`[chief] home dialog of ${e.agentId}: ${errText(err)}`));
  });
}
