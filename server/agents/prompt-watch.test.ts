import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PromptWatcher } from "./prompt-watch.js";
import type { AgentPromptEvent } from "../events.js";

const file = (name: string): string => readFileSync(fileURLToPath(new URL(`./testdata/screens/${name}`, import.meta.url)), "utf8");
// A full repaint that shows a text fixture: clear, home, then its rows.
const paint = (name: string): string => "\x1b[2J\x1b[H" + file(`${name}.txt`).replace(/\n$/, "").split("\n").join("\r\n");
const TRUST = file("trust-2.1.322.raw");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await sleep(5);
  }
}

let watcher: PromptWatcher | undefined;
afterEach(() => { watcher?.dispose(); watcher = undefined; });

function setup(o: { settleMs?: number; maxWaitMs?: number } = {}) {
  const events: AgentPromptEvent[] = [];
  watcher = new PromptWatcher({ emit: (e) => events.push(e), settleMs: o.settleMs ?? 10, maxWaitMs: o.maxWaitMs ?? 200 });
  watcher.open("a1", { cols: 120, rows: 30 });
  return { w: watcher, events };
}

describe("PromptWatcher", () => {
  it("emits one agent-prompt event when a dialog appears, and none for a repaint of the same dialog", async () => {
    const { w, events } = setup();
    w.data("a1", TRUST);
    await waitFor(() => events.length === 1);
    expect(events[0]).toEqual({ type: "agent-prompt", agentId: "a1", kind: "folder-trust", rev: expect.stringMatching(/^[0-9a-f]{16}$/) });
    expect(w.list()).toEqual([{ agentId: "a1", kind: "folder-trust", rev: events[0].rev }]);
    w.data("a1", paint("trust-2.1.322"));
    await sleep(60);
    expect(events).toHaveLength(1);
  });

  it("emits again when the prompt changes and when it goes away", async () => {
    const { w, events } = setup();
    w.data("a1", paint("login-2.1.322"));
    await waitFor(() => events.length === 1);
    w.data("a1", paint("login-second-2.1.322"));
    await waitFor(() => events.length === 2);
    expect(events.map((e) => e.kind)).toEqual(["login-method", "login-method"]);
    expect(events[1].rev).not.toBe(events[0].rev);
    w.data("a1", paint("idle-input-2.1.322"));
    await waitFor(() => events.length === 3);
    expect(events[2]).toEqual({ type: "agent-prompt", agentId: "a1", kind: null, rev: "" });
    expect(w.list()).toEqual([]);
  });

  it("a normal screen and a spinner emit nothing", async () => {
    const { w, events } = setup();
    w.data("a1", paint("idle-input-2.1.322"));
    w.data("a1", paint("running-2.1.322"));
    await sleep(80);
    expect(events).toEqual([]);
    expect(await w.state("a1")).toBeNull();
  });

  it("dialogOn: true while the trust dialog is on the screen, false at the normal screen and with no PTY", async () => {
    const { w } = setup({ settleMs: 5000, maxWaitMs: 5000 });
    expect(await w.dialogOn("a1")).toBe(false);
    w.data("a1", TRUST);
    expect(await w.dialogOn("a1")).toBe(true);
    expect(await w.dialogOn("nobody")).toBe(false);
  });

  it("state() checks the screen now, without the settle wait", async () => {
    const { w, events } = setup({ settleMs: 5000, maxWaitMs: 5000 });
    w.data("a1", TRUST);
    const p = (await w.state("a1"))!;
    expect(p.kind).toBe("folder-trust");
    expect(p.options.map((o) => o.label)).toEqual(["No, exit", "Yes, I trust this folder"]);
    expect(events).toEqual([{ type: "agent-prompt", agentId: "a1", kind: "folder-trust", rev: p.rev }]);
    expect((await w.state("a1"))!.rev).toBe(p.rev);
    expect(events).toHaveLength(1);
  });

  it("under output that never settles a detection still runs within maxWaitMs", async () => {
    const { w, events } = setup({ settleMs: 50, maxWaitMs: 120 });
    w.data("a1", TRUST);
    // A repaint every 10 ms: the settle timer alone would never fire.
    const t = setInterval(() => w.data("a1", "\x1b[0m"), 10);
    try {
      await waitFor(() => events.length === 1, 1000);
    } finally {
      clearInterval(t);
    }
    expect(events[0].kind).toBe("folder-trust");
  });

  it("follows a resize", async () => {
    const { w } = setup();
    w.resize("a1", 80, 24);
    const s = (await w.screen("a1"))!;
    expect([s.cols, s.rows]).toEqual([80, 24]);
  });

  it("close: a null event only when a prompt was showing, and the screen is gone", async () => {
    const { w, events } = setup();
    w.data("a1", TRUST);
    await w.state("a1");
    w.close("a1");
    expect(events.map((e) => e.kind)).toEqual(["folder-trust", null]);
    expect(w.has("a1")).toBe(false);
    expect(await w.state("a1")).toBeNull();
    expect(await w.screen("a1")).toBeNull();
    expect(w.list()).toEqual([]);

    w.open("a2", { cols: 120, rows: 30 });
    w.data("a2", paint("idle-input-2.1.322"));
    await w.state("a2");
    w.close("a2");
    expect(events).toHaveLength(2);
    // Output and a close for an agent with no screen do nothing.
    w.data("nobody", "x");
    w.resize("nobody", 10, 10);
    w.close("nobody");
    expect(events).toHaveLength(2);
  });

  it("open for a live id starts a new screen (a resumed agent)", async () => {
    const { w, events } = setup();
    w.data("a1", TRUST);
    await w.state("a1");
    w.open("a1", { cols: 120, rows: 30 });
    expect(await w.state("a1")).toBeNull();
    expect(w.list()).toEqual([]);
    expect(events).toHaveLength(1);
  });

  it("a close during a check leaves no state and emits nothing more", async () => {
    const { w, events } = setup();
    w.data("a1", TRUST);
    const pending = w.state("a1");
    w.close("a1");
    expect(await pending).toBeNull();
    await sleep(40);
    expect(events).toEqual([]);
  });

  it("keeps a screen for agents only: never for a shell or a service PTY", async () => {
    const { w, events } = setup();
    for (const id of ["shell-0b5c2a8e-1111-4222-8333-444455556666", "svc:pusher", "../x"]) {
      w.open(id, { cols: 120, rows: 30 });
      w.data(id, TRUST);
      expect(w.has(id), id).toBe(false);
    }
    for (const id of ["fleet-master", "lead-console", "01b20a50-2205-4d22-a312-66fd55be883a"]) {
      w.open(id, { cols: 120, rows: 30 });
      expect(w.has(id), id).toBe(true);
    }
    await sleep(40);
    expect(events).toEqual([]);
  });
});
