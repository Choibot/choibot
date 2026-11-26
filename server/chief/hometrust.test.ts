// server/chief/hometrust.test.ts — the live console, 2026-11-20: the Coordinator's session was
// started before the console marked its home as trusted. dtach kept it across the console
// restart of the fix, with the folder trust dialog on its screen, for 4 hours.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentRecord } from "../agents/store.js";
import type { TrustOutcome } from "../agents/runtimes/claude-trust.js";
import { EventHub } from "../events.js";
import { watchHomeDialogs } from "./hometrust.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "hometrust-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const flush = () => new Promise((r) => setTimeout(r, 15));

const rec = (id: string, o: Partial<AgentRecord> = {}): AgentRecord => ({
  id, label: id, repo: "", worktree: join(dir, id), cwd: join(dir, id), branch: "", baseBranch: "",
  sessionId: null, hookToken: "t", status: "idle", createdAt: 1, ...o,
});

function world(o: { hardened?: boolean; trust?: TrustOutcome; signedOut?: boolean } = {}) {
  const hub = new EventHub();
  const records = new Map<string, AgentRecord>([
    ["coordinator", rec("coordinator", { kind: "coordinator", account: "office" })],
    ["fleet-master", rec("fleet-master", { kind: "fleet-master" })],
    ["lead-app", rec("lead-app", { kind: "lead", area: "app" })],
    ["w1", rec("w1", { repo: "/ws/app", worktree: join(dir, "wt"), cwd: join(dir, "wt") })],
  ]);
  const screen = new Map<string, { kind: string; detail?: string }>();
  const log: string[] = [];
  const stop = watchHomeDialogs({
    hub, agents: { load: async (id) => records.get(id) ?? null }, hardened: o.hardened ?? false, workspaceDir: "/ws",
    prompt: async (id) => screen.get(id) ?? null,
    trust: (r, home) => { log.push(`trust:${r.id}:${r.account ?? "default"}:${home}`); return o.trust ?? "written"; },
    signedOut: async (r) => { log.push(`signedOut:${r.id}:${r.account ?? "default"}`); return o.signedOut ?? true; },
    // The restarted session has no dialog: its home is trusted now.
    restart: async (r) => { log.push(`restart:${r.id}`); screen.delete(r.id); },
    log: () => {},
  });
  // What the prompt watcher does when the screen of a (re)attached session is read.
  const shows = async (id: string, kind: string, detail?: string) => {
    screen.set(id, { kind, ...(detail ? { detail } : {}) });
    hub.emitEvent({ type: "agent-prompt", agentId: id, kind: kind as "folder-trust", rev: "r1" });
    await flush();
  };
  return { hub, log, shows, stop, records, home: (id: string) => records.get(id)!.cwd! };
}

describe("the folder trust dialog of a console-made home", () => {
  it("the live case: the old session is at the dialog after a console restart: the mark is written and it starts again", async () => {
    const w = world();
    await w.shows("coordinator", "folder-trust", w.home("coordinator"));
    expect(w.log).toEqual([`trust:coordinator:office:${w.home("coordinator")}`, "restart:coordinator"]);
  });

  it("the same for a lead and the fleet master", async () => {
    const w = world();
    await w.shows("lead-app", "folder-trust", w.home("lead-app"));
    await w.shows("fleet-master", "folder-trust", w.home("fleet-master"));
    expect(w.log.filter((l) => l.startsWith("restart:"))).toEqual(["restart:lead-app", "restart:fleet-master"]);
  });

  it("never a folder of the user: a worker's dialog, and a dialog that names another folder, stay for the user", async () => {
    const w = world();
    await w.shows("w1", "folder-trust", w.home("w1"));
    await w.shows("coordinator", "folder-trust", "/ws/app");
    await w.shows("lead-app", "folder-trust");
    expect(w.log).toEqual([]);
  });

  it("one try: a dialog that comes back after the restart stays for the user", async () => {
    const w = world();
    await w.shows("coordinator", "folder-trust", w.home("coordinator"));
    await w.shows("coordinator", "folder-trust", w.home("coordinator"));
    expect(w.log.filter((l) => l === "restart:coordinator")).toHaveLength(1);
  });

  it("no restart when the mark was not written, on a hardened deployment, or when the dialog is gone", async () => {
    const missing = world({ trust: "missing" });
    await missing.shows("coordinator", "folder-trust", missing.home("coordinator"));
    expect(missing.log.filter((l) => l.startsWith("restart"))).toEqual([]);
    const hard = world({ hardened: true });
    await hard.shows("coordinator", "folder-trust", hard.home("coordinator"));
    expect(hard.log).toEqual([]);
    const gone = world();
    gone.hub.emitEvent({ type: "agent-prompt", agentId: "coordinator", kind: "folder-trust", rev: "r1" });
    await flush();
    expect(gone.log).toEqual([]);
  });
});

describe("the login picker on a console-made agent", () => {
  it("its login is signed out: the login gets its mark and the session starts again", async () => {
    const w = world();
    await w.shows("coordinator", "login-method");
    expect(w.log).toEqual(["signedOut:coordinator:office", "restart:coordinator"]);
  });
  it("a worker's login picker, and another dialog, are not the console's to end", async () => {
    const w = world();
    await w.shows("w1", "login-method");
    await w.shows("coordinator", "picker");
    await w.shows("coordinator", "unknown");
    expect(w.log).toEqual([]);
  });
  it("no mark (the user signed in since): no restart", async () => {
    const w = world({ signedOut: false });
    await w.shows("coordinator", "login-method");
    expect(w.log).toEqual(["signedOut:coordinator:office"]);
  });
});
