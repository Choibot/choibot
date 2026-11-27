// server/agents/host.ts — the seam of HOW the console holds an agent's program.
//
// AgentRuntime (runtimes/types.ts) says WHICH program runs (claude, codex). A host says how the
// console holds it. Today every agent has one host: the terminal (terminal.ts: dtach and
// node-pty), through the TerminalManager calls that the agent paths make. Another host (the
// headless workers: `claude -p` with a message stream, no terminal) registers here at boot. Then
// these paths ask it, for an agent that it owns, in the place of the terminal:
//   the send of a line (issues/reply.ts typeIntoAgentWhy), the composer's gate (composer.ts),
//   the sweep (sweep.ts), resume and the login switch (recovery.ts), stop, resume, the go-on
//   after a move, the sign-out stop, merge, discard, delete and close (api.ts), and the live
//   checks of a closed agent's resume, of the reminders and of the boot (index.ts).
// With no host registered, hostOf() answers null, and each path calls the terminal as before.
import type { TypeResult } from "../issues/reply.js";

export interface AgentHost {
  // True when this host holds the agent's program. Synchronous: a path asks it before each call.
  owns(id: string): boolean;
  // The questions of TerminalManager, for an agent that this host owns.
  has(id: string): boolean;                  // a live program that the console holds now
  hasSession(id: string): Promise<boolean>;  // a program that lives on, that reattach can take back
  reattach(id: string): Promise<boolean>;    // take it back after a console restart; true when it did
  inputReady(id: string): boolean;           // the program can take a line now
  dialogOn?(id: string): Promise<boolean>;   // a host that shows no screen has none
  kill(id: string): void;                    // end the program; no-op when it is not live
  // One line as a message of the user, in the place of the terminal's paste and Enter. The
  // caller holds withTypingLock(id, …), as for the terminal. Never rejects.
  send(id: string, text: string): Promise<HostSendResult>;
}

// A message above the host's limit (bytes as the host sends it): nothing was logged or written.
// The terminal has no such limit; each caller of a host's send() must handle it.
export type TooLarge = { refused: "too-large"; bytes: number; limit: number };
export type HostSendResult = Exclude<TypeResult, "dialog"> | TooLarge;

const hosts: AgentHost[] = [];

// Registers another host. Returns its removal (for tests).
export function addHost(h: AgentHost): () => void {
  hosts.push(h);
  return () => {
    const i = hosts.indexOf(h);
    if (i >= 0) hosts.splice(i, 1);
  };
}

// The host that owns the agent, or null: the terminal holds it.
export function hostOf(id: string): AgentHost | null {
  for (const h of hosts) if (h.owns(id)) return h;
  return null;
}
