// server/agents/exit.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventHub, type ConsoleEvent } from "../events.js";
import type { AgentRecord } from "./store.js";
import { agentExitHandler } from "./exit.js";

// The id the fake service manager owns; every other id is an agent.
const SVC = "svc:db";

describe("agentExitHandler", () => {
  let patches: Array<{ id: string; fields: Partial<AgentRecord> }>;
  let events: ConsoleEvent[];
  let serviceExits: Array<[string, number, boolean]>;
  let relaunching: Set<string>;
  let quiet: Set<string>;
  let onExit: (id: string, code: number, killed: boolean) => void;

  beforeEach(() => {
    patches = [];
    events = [];
    serviceExits = [];
    relaunching = new Set();
    quiet = new Set();
    const hub = new EventHub();
    hub.subscribe((e) => { events.push(e); });
    onExit = agentExitHandler({
      services: () => ({
        handleExit: (id, code, killed) => { serviceExits.push([id, code, killed]); return id === SVC; },
      }),
      store: { patch: async (id, fields) => { patches.push({ id, fields }); } },
      hub,
      relaunching,
      quiet,
    });
  });

  it("a quiet exit (a sign-out ended it): the record is done, the event says quiet, the id leaves the set", () => {
    quiet.add("q");
    onExit("q", 0, true);
    expect(patches).toEqual([{ id: "q", fields: { status: "done" } }]);
    expect(events).toEqual([{ type: "agent-status", agentId: "q", status: "done", quiet: true }]);
    expect(quiet.has("q")).toBe(false);
    // The next exit of that id is a usual one.
    onExit("q", 0, true);
    expect(events.at(-1)).toEqual({ type: "agent-status", agentId: "q", status: "done" });
  });

  it("marks a killed agent done and emits the status event", () => {
    onExit("a", 1, true);
    expect(patches).toEqual([{ id: "a", fields: { status: "done" } }]);
    expect(events).toEqual([{ type: "agent-status", agentId: "a", status: "done" }]);
  });

  it("marks an agent that exited with code 0 done", () => {
    onExit("a", 0, false);
    expect(patches).toEqual([{ id: "a", fields: { status: "done" } }]);
    expect(events).toEqual([{ type: "agent-status", agentId: "a", status: "done" }]);
  });

  it("catches a rejected patch: the event is still emitted and no rejection escapes", async () => {
    // An unhandled rejection becomes an uncaughtException, and index.ts exits.
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => { unhandled.push(e); };
    process.on("unhandledRejection", onUnhandled);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const hub = new EventHub();
      hub.subscribe((e) => { events.push(e); });
      const failing = agentExitHandler({
        services: () => ({ handleExit: () => false }),
        store: { patch: async () => { throw new Error("disk full"); } },
        hub,
        relaunching,
      });
      failing("a", 1, false);
      expect(events).toEqual([{ type: "agent-status", agentId: "a", status: "error" }]);
      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).toEqual([]);
      expect(warn).toHaveBeenCalledWith("[exit] a patch failed:", "disk full");
    } finally {
      process.off("unhandledRejection", onUnhandled);
      warn.mockRestore();
    }
  });

  it("marks an agent that exited with a non-zero code error", () => {
    onExit("a", 137, false);
    expect(patches).toEqual([{ id: "a", fields: { status: "error" } }]);
    expect(events).toEqual([{ type: "agent-status", agentId: "a", status: "error" }]);
  });

  it("skips the patch and the event for an id in relaunching", () => {
    relaunching.add("a");
    onExit("a", 0, true);
    onExit("a", 1, false);
    expect(patches).toEqual([]);
    expect(events).toEqual([]);
  });

  it("only reads relaunching: other ids are still marked, the set is unchanged", () => {
    relaunching.add("a");
    onExit("b", 0, true);
    expect(patches).toEqual([{ id: "b", fields: { status: "done" } }]);
    expect(events).toEqual([{ type: "agent-status", agentId: "b", status: "done" }]);
    expect([...relaunching]).toEqual(["a"]);
  });

  it("leaves a service exit to the service manager", () => {
    onExit(SVC, 1, false);
    expect(serviceExits).toEqual([[SVC, 1, false]]);
    expect(patches).toEqual([]);
    expect(events).toEqual([]);
  });

  it("asks the service manager before reading relaunching", () => {
    relaunching.add("a");
    onExit("a", 0, true);
    expect(serviceExits).toEqual([["a", 0, true]]);
  });

  it("reads the managers through the getters at exit time, not at build time", () => {
    // index.ts assigns `services` after `new TerminalManager`.
    let services: { handleExit(id: string, code: number, killed: boolean): boolean } | undefined;
    const late = agentExitHandler({
      services: () => services!,
      store: { patch: async (id, fields) => { patches.push({ id, fields }); } },
      hub: new EventHub(),
      relaunching,
    });
    services = { handleExit: (id) => id === SVC };
    late(SVC, 1, false);
    expect(patches).toEqual([]);
  });
});
