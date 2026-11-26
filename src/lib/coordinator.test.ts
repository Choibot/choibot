import { describe, expect, it } from "vitest";
import { coordinatorLine, coordinatorTone, type CoordinatorView } from "./coordinator";

const v = (o: Partial<CoordinatorView>): CoordinatorView => ({ id: "coordinator", state: "waiting", lastActivityAt: null, queuedEvents: 0, model: "sonnet", ...o });
const NOW = 10_000_000;

describe("the Coordinator's row", () => {
  it("says its state and its last activity in a few words", () => {
    expect(coordinatorLine(v({ state: "waiting", lastActivityAt: NOW - 180_000 }), NOW)).toBe("Waiting · last activity 3m ago");
    expect(coordinatorLine(v({ state: "working", lastActivityAt: NOW - 5_000 }), NOW)).toBe("Working · last activity 5s ago");
    expect(coordinatorLine(v({ state: "waiting" }), NOW)).toBe("Waiting · no activity yet");
    expect(coordinatorLine(v({ state: "not-started" }), NOW)).toBe("Not started · it starts with the first event");
    expect(coordinatorLine(v({ state: "stopped", lastActivityAt: NOW - 1 }), NOW)).toBe("Stopped · the console starts it again in a minute");
    expect(coordinatorLine(v({ state: "asks" }), NOW)).toBe("Needs you · Claude asks a question in its thread");
    expect(coordinatorLine(v({ state: "starting" }), NOW)).toBe("Starting · it reads the events when its session is ready");
  });
  it("has a quiet dot: green at rest, the run dot while it works, a ring when it is not up", () => {
    expect([coordinatorTone("waiting"), coordinatorTone("working"), coordinatorTone("stopped"), coordinatorTone("not-started")]).toEqual(["ok", "run", "off", "off"]);
    expect([coordinatorTone("asks"), coordinatorTone("starting")]).toEqual(["warn", "run"]);
  });
});

describe("the Coordinator that waits for the second sign-in", () => {
  const v = (over: Partial<CoordinatorView>): CoordinatorView => ({ id: "coordinator", state: "waits-sign-in", lastActivityAt: null, queuedEvents: 0, model: "x", ...over });
  it("says where it starts, with a quiet dot (never Needs you)", () => {
    expect(coordinatorLine(v({}))).toBe('Waits for its sign-in · it starts after "Sign in for your assistant" on the Set-up page');
    expect(coordinatorTone("waits-sign-in")).toBe("off");
  });
  it("a wait for a login that was signed out in Settings says so, not the second sign-in", () => {
    expect(coordinatorLine(v({ waitsLogin: true }))).toBe("Waits for its sign-in · it starts again when you log in again in Settings, Claude accounts");
  });
  it("names the events dropped while it waited, one time (gone when the count is 0)", () => {
    expect(coordinatorLine(v({ droppedEvents: 3 }))).toMatch(/ · 3 older events were dropped while it waited$/);
    expect(coordinatorLine(v({ droppedEvents: 1 }))).toMatch(/ · 1 older event was dropped while it waited$/);
    expect(coordinatorLine(v({ state: "waiting", lastActivityAt: null, droppedEvents: 2 }))).toBe("Waiting · no activity yet · 2 older events were dropped while it waited");
    expect(coordinatorLine(v({ state: "waiting", lastActivityAt: null, droppedEvents: 0 }))).toBe("Waiting · no activity yet");
  });
});
