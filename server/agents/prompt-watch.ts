// server/agents/prompt-watch.ts — the live prompt state of every agent.
// One ScreenMirror per agent PTY, fed by the TerminalManager's observer hook.
// After output settles the screen is read and detectPrompt runs; a change of
// the result goes out as one `agent-prompt` event on the hub.
//
// Cost per agent: the mirror (agents/screen.ts) and one detection per burst of
// output. The Claude TUI repaints all the time while it works (the spinner),
// so a detection waits for SETTLE_MS without output and, under constant
// output, runs at most once per MAX_WAIT_MS. A detection reads `rows` lines.
import type { AgentPromptEvent } from "../events.js";
import { isAgentId } from "../ids.js";
import { detectPrompt, promptRev, type Prompt, type PromptKind } from "./prompt.js";
import { ScreenMirror, type Screen } from "./screen.js";
import type { TerminalObserver } from "./terminal.js";

export const SETTLE_MS = 150;
export const MAX_WAIT_MS = 1000;

// What GET /api/agents/:id/prompt gives: the prompt and the id of this exact
// card (agents/prompt.ts promptRev). A keys request names the rev it answers.
export type PromptState = Prompt & { rev: string };
export type PromptSummary = { agentId: string; kind: PromptKind; rev: string };

type Entry = {
  mirror: ScreenMirror;
  prompt: PromptState | null;
  timer: ReturnType<typeof setTimeout> | null;
  // When the output that the pending detection waits on began.
  dirtySince: number | null;
};

// Agent PTYs only: a shell id (`shell-<uuid>`) and a service (`svc:<id>`)
// run no Claude TUI.
const isAgentPty = (id: string): boolean => isAgentId(id) && !id.startsWith("shell-");

export class PromptWatcher implements TerminalObserver {
  private entries = new Map<string, Entry>();

  constructor(private d: {
    emit: (e: AgentPromptEvent) => void;
    accept?: (id: string) => boolean;
    settleMs?: number;
    maxWaitMs?: number;
    now?: () => number;
  }) {}

  open(id: string, size: { cols: number; rows: number }): void {
    if (!(this.d.accept ?? isAgentPty)(id)) return;
    this.drop(id); // a resumed agent is a new screen
    this.entries.set(id, { mirror: new ScreenMirror(size.cols, size.rows), prompt: null, timer: null, dirtySince: null });
  }

  data(id: string, chunk: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.mirror.write(chunk);
    this.schedule(id, e);
  }

  resize(id: string, cols: number, rows: number): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.mirror.resize(cols, rows);
    this.schedule(id, e);
  }

  close(id: string): void {
    const had = this.drop(id);
    if (had) this.d.emit({ type: "agent-prompt", agentId: id, kind: null, rev: "" });
  }

  // Whether a screen exists for this agent (its PTY is live in this process).
  has(id: string): boolean {
    return this.entries.has(id);
  }

  // The agent's screen now, null without a live PTY.
  async screen(id: string): Promise<Screen | null> {
    const e = this.entries.get(id);
    if (!e) return null;
    const s = await e.mirror.read();
    return this.entries.get(id) === e ? s : null;
  }

  // The agent's prompt now: every byte received so far is on the screen that
  // is checked. Null without a prompt or without a live PTY.
  async state(id: string): Promise<PromptState | null> {
    const e = this.entries.get(id);
    if (!e) return null;
    await this.check(id, e);
    return this.entries.get(id) === e ? e.prompt : null;
  }

  // The TerminalObserver's question (terminal.ts dialogOn): is a prompt on its screen now?
  async dialogOn(id: string): Promise<boolean> {
    return (await this.state(id)) !== null;
  }

  // Every agent with a prompt, as of the last detection.
  list(): PromptSummary[] {
    const out: PromptSummary[] = [];
    for (const [agentId, e] of this.entries) {
      if (e.prompt) out.push({ agentId, kind: e.prompt.kind, rev: e.prompt.rev });
    }
    return out;
  }

  // Drop every screen and timer (server shutdown, tests). No event.
  dispose(): void {
    for (const id of [...this.entries.keys()]) this.drop(id);
  }

  // Removes the entry; true when it showed a prompt.
  private drop(id: string): boolean {
    const e = this.entries.get(id);
    if (!e) return false;
    this.entries.delete(id);
    if (e.timer) clearTimeout(e.timer);
    e.mirror.dispose();
    return e.prompt !== null;
  }

  private schedule(id: string, e: Entry): void {
    const now = (this.d.now ?? Date.now)();
    e.dirtySince ??= now;
    const settle = this.d.settleMs ?? SETTLE_MS;
    const left = e.dirtySince + (this.d.maxWaitMs ?? MAX_WAIT_MS) - now;
    if (e.timer) clearTimeout(e.timer);
    e.timer = setTimeout(() => {
      e.timer = null;
      void this.check(id, e).catch((err: unknown) => console.warn(`[prompt] check ${id} failed:`, err instanceof Error ? err.message : err));
    }, Math.max(0, Math.min(settle, left)));
    e.timer.unref?.();
  }

  private async check(id: string, e: Entry): Promise<void> {
    e.dirtySince = null;
    const screen = await e.mirror.read();
    if (this.entries.get(id) !== e) return; // closed or replaced while parsing
    const prompt = detectPrompt(screen);
    const rev = promptRev(prompt);
    const changed = rev !== (e.prompt?.rev ?? "");
    e.prompt = prompt ? { ...prompt, rev } : null;
    if (changed) this.d.emit({ type: "agent-prompt", agentId: id, kind: prompt?.kind ?? null, rev });
  }
}
