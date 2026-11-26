import { timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionStore } from "../agents/store.js";
import {
  AGENT_HEADER, AGENT_TOKEN_HEADER, USER_HEADER, DeviceStore, callerOf, levelOfKind, type CallerDeps,
} from "./auth.js";

vi.mock("node:crypto", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:crypto")>();
  return { ...real, timingSafeEqual: vi.fn(real.timingSafeEqual) };
});

let root: string;
let agentsDir: string;
let devices: DeviceStore;
let agents: SessionStore;
let deps: CallerDeps;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "chief-caller-"));
  agentsDir = join(root, "agents");
  mkdirSync(agentsDir);
  devices = new DeviceStore(join(root, "user-devices.json"), { setTimer: () => ({ clear: () => {} }) });
  agents = new SessionStore(agentsDir);
  deps = { devices, agents };
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

// Write a record file the way SessionStore lays them out (<dir>/<file>.json).
// Raw JSON, so a test can plant any kind (e.g. "lead") or a mismatched id.
function plant(file: string, rec: Record<string, unknown>, dir = agentsDir): void {
  writeFileSync(join(dir, `${file}.json`), JSON.stringify({
    label: file, repo: "", worktree: "", branch: "", baseBranch: "", sessionId: null,
    status: "idle", createdAt: 1, ...rec,
  }));
}

const agentHeaders = (id: string, token: string) => ({ [AGENT_HEADER]: id, [AGENT_TOKEN_HEADER]: token });

describe("header names", () => {
  it("are the spec's lower-case names", () => {
    expect(USER_HEADER).toBe("x-choibot-user");
    expect(AGENT_HEADER).toBe("x-choibot-agent");
    expect(AGENT_TOKEN_HEADER).toBe("x-choibot-agent-token");
  });
});

describe("levelOfKind", () => {
  it("maps fleet-master → master, lead → lead, everything else → agent", () => {
    expect(levelOfKind("fleet-master")).toBe("master");
    expect(levelOfKind("lead")).toBe("lead");
    expect(levelOfKind("cron-master")).toBe("agent");
    expect(levelOfKind("issue")).toBe("agent");
    expect(levelOfKind(undefined)).toBe("agent");
    expect(levelOfKind("")).toBe("agent");
  });
});

describe("callerOf — user", () => {
  it("no headers → none, no agent headers", async () => {
    expect(await callerOf({}, deps)).toEqual({ level: "none", agentHeaders: false });
  });

  it("a valid user token → user with the device label", async () => {
    const token = await devices.add("laptop");
    expect(await callerOf({ [USER_HEADER]: token }, deps))
      .toEqual({ level: "user", device: "laptop", agentHeaders: false });
  });

  it("a bad user token → none", async () => {
    await devices.add("laptop");
    expect(await callerOf({ [USER_HEADER]: "x".repeat(43) }, deps)).toEqual({ level: "none", agentHeaders: false });
    expect(await callerOf({ [USER_HEADER]: "" }, deps)).toEqual({ level: "none", agentHeaders: false });
  });

  it("an array-valued x-choibot-user → none", async () => {
    const token = await devices.add("laptop");
    expect(await callerOf({ [USER_HEADER]: [token] }, deps)).toEqual({ level: "none", agentHeaders: false });
    expect(await callerOf({ [USER_HEADER]: [token, token] }, deps)).toEqual({ level: "none", agentHeaders: false });
  });
});

describe("callerOf — agent", () => {
  it("a worker record + the right token → agent, kind undefined", async () => {
    plant("w1", { id: "w1", hookToken: "tok-w1" });
    expect(await callerOf(agentHeaders("w1", "tok-w1"), deps))
      .toEqual({ level: "agent", agentHeaders: true, agentId: "w1", kind: undefined });
  });

  it("a fleet-master record → master", async () => {
    plant("fleet-master", { id: "fleet-master", kind: "fleet-master", hookToken: "tok-fm" });
    expect(await callerOf(agentHeaders("fleet-master", "tok-fm"), deps))
      .toEqual({ level: "master", agentHeaders: true, agentId: "fleet-master", kind: "fleet-master" });
  });

  it("a lead record → lead", async () => {
    plant("lead-web", { id: "lead-web", kind: "lead", hookToken: "tok-l" });
    expect(await callerOf(agentHeaders("lead-web", "tok-l"), deps))
      .toEqual({ level: "lead", agentHeaders: true, agentId: "lead-web", kind: "lead" });
  });

  it("a cron-master record → agent", async () => {
    plant("cron-master", { id: "cron-master", kind: "cron-master", hookToken: "tok-cm" });
    expect(await callerOf(agentHeaders("cron-master", "tok-cm"), deps))
      .toEqual({ level: "agent", agentHeaders: true, agentId: "cron-master", kind: "cron-master" });
  });

  it("a wrong agent token → none with agent headers", async () => {
    plant("fleet-master", { id: "fleet-master", kind: "fleet-master", hookToken: "tok-fm" });
    for (const t of ["tok-fX", "tok-fm2", "tok-f", "", "TOK-FM"]) {
      expect(await callerOf(agentHeaders("fleet-master", t), deps)).toEqual({ level: "none", agentHeaders: true });
    }
  });

  it("a missing token header → none with agent headers", async () => {
    plant("w1", { id: "w1", hookToken: "tok-w1" });
    expect(await callerOf({ [AGENT_HEADER]: "w1" }, deps)).toEqual({ level: "none", agentHeaders: true });
  });

  it("a record without a non-empty string hookToken → none", async () => {
    plant("w1", { id: "w1" });
    plant("w2", { id: "w2", hookToken: 42 });
    plant("w3", { id: "w3", hookToken: "" });
    expect(await callerOf(agentHeaders("w1", "undefined"), deps)).toEqual({ level: "none", agentHeaders: true });
    expect(await callerOf(agentHeaders("w2", "42"), deps)).toEqual({ level: "none", agentHeaders: true });
    expect(await callerOf(agentHeaders("w3", ""), deps)).toEqual({ level: "none", agentHeaders: true });
  });

  it("compares the agent token with crypto.timingSafeEqual", async () => {
    plant("w1", { id: "w1", hookToken: "tok-w1" });
    vi.mocked(timingSafeEqual).mockClear();
    await callerOf(agentHeaders("w1", "tok-w1"), deps);
    expect(timingSafeEqual).toHaveBeenCalled();
    vi.mocked(timingSafeEqual).mockClear();
    await callerOf(agentHeaders("w1", "tok-zz"), deps);
    expect(timingSafeEqual).toHaveBeenCalled();
  });

  it("cron:<job> with no record → none, load never called", async () => {
    const load = vi.spyOn(agents, "load");
    expect(await callerOf(agentHeaders("cron:j1", "anything"), deps)).toEqual({ level: "none", agentHeaders: true });
    expect(load).not.toHaveBeenCalled();
  });

  it("path traversal: ../x is refused before the store, and the store refuses it too", async () => {
    plant("x", { id: "x", kind: "fleet-master", hookToken: "t" }, root);
    // The store refuses the id too (it never joins it into a path), and
    // callerOf checks it first, so load is not even called.
    expect(existsSync(join(root, "x.json"))).toBe(true);
    expect(await agents.load("../x")).toBeNull();
    const load = vi.spyOn(agents, "load");
    for (const id of ["../x", "../../x", "..", "./x", "/x", "a/../../x", `${root}/x`]) {
      expect(await callerOf(agentHeaders(id, "t"), deps)).toEqual({ level: "none", agentHeaders: true });
    }
    expect(load).not.toHaveBeenCalled();
  });

  it("refuses ids outside the pattern without a load", async () => {
    const load = vi.spyOn(agents, "load");
    for (const id of ["", "-w1", "_w1", "w 1", "w1\n", "w.1", "w1:x", "a".repeat(65)]) {
      expect(await callerOf(agentHeaders(id, "t"), deps)).toEqual({ level: "none", agentHeaders: true });
    }
    expect(load).not.toHaveBeenCalled();
  });

  it("accepts a 64-char id (pattern upper bound)", async () => {
    const id = `a${"b".repeat(63)}`;
    plant(id, { id, hookToken: "t64" });
    expect(await callerOf(agentHeaders(id, "t64"), deps))
      .toEqual({ level: "agent", agentHeaders: true, agentId: id, kind: undefined });
  });

  it("a record whose id differs from its file name → none", async () => {
    plant("w1", { id: "fleet-master", kind: "fleet-master", hookToken: "t" });
    expect(await callerOf(agentHeaders("w1", "t"), deps)).toEqual({ level: "none", agentHeaders: true });
  });

  it("an array-valued agent header counts as absent but still marks agent headers", async () => {
    plant("w1", { id: "w1", hookToken: "tok-w1" });
    const load = vi.spyOn(agents, "load");
    expect(await callerOf({ [AGENT_HEADER]: ["w1"], [AGENT_TOKEN_HEADER]: "tok-w1" }, deps))
      .toEqual({ level: "none", agentHeaders: true });
    expect(await callerOf({ [AGENT_HEADER]: "w1", [AGENT_TOKEN_HEADER]: ["tok-w1"] }, deps))
      .toEqual({ level: "none", agentHeaders: true });
    expect(load).not.toHaveBeenCalled();
  });
});

describe("callerOf — agent headers are never user", () => {
  it("a valid user token plus agent headers with a wrong token → none", async () => {
    const token = await devices.add("laptop");
    plant("w1", { id: "w1", hookToken: "tok-w1" });
    expect(await callerOf({ [USER_HEADER]: token, ...agentHeaders("w1", "nope") }, deps))
      .toEqual({ level: "none", agentHeaders: true });
  });

  it("a valid user token plus valid agent headers → the agent's level, not user", async () => {
    const token = await devices.add("laptop");
    plant("w1", { id: "w1", hookToken: "tok-w1" });
    expect(await callerOf({ [USER_HEADER]: token, ...agentHeaders("w1", "tok-w1") }, deps))
      .toEqual({ level: "agent", agentHeaders: true, agentId: "w1", kind: undefined });
  });

  it("a valid user token plus cron:<job> → none", async () => {
    const token = await devices.add("laptop");
    expect(await callerOf({ [USER_HEADER]: token, [AGENT_HEADER]: "cron:j1" }, deps))
      .toEqual({ level: "none", agentHeaders: true });
  });

  it("an x-choibot-agent key with a non-string value still blocks user", async () => {
    const token = await devices.add("laptop");
    expect(await callerOf({ [USER_HEADER]: token, [AGENT_HEADER]: undefined }, deps))
      .toEqual({ level: "none", agentHeaders: true });
    expect(await callerOf({ [USER_HEADER]: token, [AGENT_HEADER]: [] }, deps))
      .toEqual({ level: "none", agentHeaders: true });
  });

  it("an x-choibot-agent-token key alone also blocks user", async () => {
    const token = await devices.add("laptop");
    expect(await callerOf({ [USER_HEADER]: token, [AGENT_TOKEN_HEADER]: "t" }, deps))
      .toEqual({ level: "none", agentHeaders: true });
  });

  it("does not verify the user token when agent headers are present", async () => {
    const token = await devices.add("laptop");
    const verify = vi.spyOn(devices, "verify");
    await callerOf({ [USER_HEADER]: token, ...agentHeaders("w1", "t") }, deps);
    expect(verify).not.toHaveBeenCalled();
  });
});
