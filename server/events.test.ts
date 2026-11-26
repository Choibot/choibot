// server/events.test.ts
import { describe, it, expect } from "vitest";
import { EventHub, type ConsoleEvent } from "./events.js";

describe("EventHub", () => {
  it("delivers events to subscribers until unsubscribed", () => {
    const hub = new EventHub();
    const seen: ConsoleEvent[] = [];
    const off = hub.subscribe((e) => seen.push(e));
    hub.emitEvent({ type: "agent-status", agentId: "a1", status: "running" });
    off();
    hub.emitEvent({ type: "agent-status", agentId: "a1", status: "idle" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: "agent-status", status: "running" });
  });
});
