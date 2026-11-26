// src/lib/useEvents.ts
"use client";
import { useEffect, useRef } from "react";
import type { QueueItem } from "../../server/chief/queue/types";
import { openEventStream } from "./sse";

export type ConsoleEvent =
  | { type: "service-status"; serviceId: string; status: "stopped" | "running" | "crashed"; restartCount?: number; lastExitCode?: number | null; autoRestartDisabled?: boolean }
  | { type: "cron-run"; name: string; ok: boolean; summary: string }
  // Mirror AgentEvent, AgentTurnEndEvent and AgentHookEvent in server/events.ts.
  | { type: "agent-status"; agentId: string; status: "running" | "idle" | "done" | "error" }
  | { type: "agent-error"; agentId: string; message: string }
  | { type: "agent-notify"; agentId: string; level: "info" | "attention" | "error"; text: string }
  | { type: "agent-reopened"; agentId: string }
  | { type: "agent-closed"; agentId: string }
  | { type: "agent-turn-end"; agentId: string; lastMessage: string }
  | { type: "agent-hook"; agentId: string; event: string; source?: string }
  // Mirrors AgentPromptEvent in server/events.ts. A terminal dialog appeared,
  // changed (new rev) or went away (kind null, rev ""). The event has no screen
  // text: the card then reads GET /api/agents/:id/prompt.
  | { type: "agent-prompt"; agentId: string; kind: "folder-trust" | "login-method" | "picker" | "unknown" | null; rev: string }
  // Mirrors BrainEvent in server/events.ts.
  | { type: "brain"; updatedAt: number; proposed: boolean }
  // Mirrors QueueEvent in server/events.ts (type-only import of the item).
  | { type: "queue"; item: QueueItem }
  // Mirrors RemindersEvent in server/events.ts: reminders.json changed.
  | { type: "reminders" };

// `enabled` false opens no EventSource (a view that is off must not hold a stream).
// `onOpen` fires when the stream opens, including each automatic reconnect.
export function useEvents(onEvent: (e: ConsoleEvent) => void, enabled = true, onOpen?: () => void) {
  const cb = useRef(onEvent);
  cb.current = onEvent;
  const open = useRef(onOpen);
  open.current = onOpen;
  useEffect(() => {
    if (!enabled) return;
    // A fetch reader in place of EventSource (src/lib/sse.ts): it sends the paired device's token.
    const stream = openEventStream("/api/events", {
      open: () => open.current?.(),
      event: (data) => {
        let e: ConsoleEvent;
        try { e = JSON.parse(data) as ConsoleEvent; } catch { return; }
        cb.current(e);
      },
    });
    return () => stream.close();
  }, [enabled]);
}
