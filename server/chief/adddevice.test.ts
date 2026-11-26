// server/chief/adddevice.test.ts — "Add a device": who can make the code, what a code pairs, and
// what it never does. One refusal test for each rule.
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentRecord } from "../agents/store.js";
import { AGENT_HEADER, AGENT_TOKEN_HEADER, DeviceStore, USER_HEADER, callerOf } from "./auth.js";
import { ADD_CLAIM_ROUTE, ADD_CODE_TTL_MS, ADD_DEVICE_ERR, ADD_DEVICE_ROUTE, addDeviceOn, freeLabel, registerAddDevice } from "./adddevice.js";
import { BOX_CODE_TRIES, BoxCodes, registerFirstRun } from "./firstrun.js";
import { ClaimLinks } from "./claimlink.js";
import { CHIEF_ERR, makeGate } from "./gate.js";

let dir: string;
let codeFile: string;
let now: number;
let app: FastifyInstance;
let devices: DeviceStore;
let laptop: string; // the token of the first paired device
let logs: string[];
let changes: number;

const MASTER: AgentRecord = {
  id: "fleet-master", label: "master", repo: "", worktree: "", branch: "", baseBranch: "", sessionId: null,
  hookToken: "tok-master", status: "idle", createdAt: 1, kind: "fleet-master",
};
const agents = { load: async (id: string) => (id === MASTER.id ? MASTER : null) };
const asAgent = { [AGENT_HEADER]: MASTER.id, [AGENT_TOKEN_HEADER]: MASTER.hookToken };
const PAIR = { error: CHIEF_ERR.pairRequired, userAuth: "log" };
const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

// A code that is not `code`: its first character changes.
const other = (code: string): string => (code[0] === "2" ? "3" : "2") + code.slice(1);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "adddevice-"));
  codeFile = join(dir, "chief", "add-device-code.json");
  now = 1_000_000;
  logs = [];
  changes = 0;
});
afterEach(async () => {
  await app?.close();
  rmSync(dir, { recursive: true, force: true });
});

async function build(o: { misconfigured?: string; lock?: boolean; paired?: boolean; address?: () => Promise<string | null> } = {}): Promise<void> {
  await app?.close();
  devices = new DeviceStore(join(dir, "chief", "user-devices.json"), { now: () => now });
  if (o.paired !== false) laptop = await devices.add("computer");
  const gate = makeGate({ misconfigured: o.misconfigured ?? null, userAuth: "log", deps: { devices, agents } });
  app = Fastify();
  if (o.lock) {
    registerFirstRun(app, {
      devices, codes: new BoxCodes(join(dir, "chief", "pair-code.json"), { now: () => now }),
      links: new ClaimLinks({ firstStart: join(dir, "chief", "first-start.json"), state: join(dir, "chief", "claim-link.json") }, { now: () => now }),
      caller: (req) => gate.caller(req), pageRoute: "/*",
    });
  }
  registerAddDevice(app, { gate, devices, file: codeFile, now: () => now, log: (s) => logs.push(s), changed: () => { changes++; }, address: o.address });
  app.all("/*", async (req) => ({ page: req.raw.url }));
  await app.ready();
}

const mint = (headers: Record<string, string> = { [USER_HEADER]: laptop }) => app.inject({ method: "POST", url: ADD_DEVICE_ROUTE, headers });
const claim = (code: unknown, label: unknown = "phone", headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url: ADD_CLAIM_ROUTE, headers, payload: { code, label } });
const newCode = async (): Promise<string> => (await mint()).json().code as string;
const labels = async (): Promise<string[]> => (await devices.list()).map((d) => d.label);
const levelOf = async (token: string) => (await callerOf({ [USER_HEADER]: token }, { devices, agents })).level;

describe("where the button exists", () => {
  it("only on a console that pairs devices from the box", () => {
    expect(addDeviceOn({ userAuth: "log" })).toBe(true);
    // The owner's console pairs through Telegram: index.ts registers no route there.
    expect(addDeviceOn({ userAuth: "telegram" })).toBe(false);
  });
});

describe("the code", () => {
  beforeEach(() => build());

  it("no code exists until a paired device asks for one", () => {
    expect(existsSync(codeFile)).toBe(false);
  });

  it("a paired device gets a code of 8 characters for 5 minutes; the file holds only its hash", async () => {
    const res = await mint();
    expect(res.statusCode).toBe(200);
    const { code, expiresAt, ttlMs } = res.json();
    expect(code).toMatch(CODE_RE);
    expect(ttlMs).toBe(300_000);
    expect(expiresAt).toBe(now + ADD_CODE_TTL_MS);
    const text = readFileSync(codeFile, "utf8");
    expect(text).not.toContain(code);
    expect(text).not.toContain(code.replace("-", ""));
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(["expiresAt", "sha256", "tries"]);
    expect(statSync(codeFile).mode & 0o777).toBe(0o600);
    // The log names the device, never the code.
    expect(logs.join("\n")).toContain("computer");
    expect(logs.join("\n")).not.toContain(code);
  });

  it("gives the private address of the console with the code: an HTTPS origin, or nothing", async () => {
    // A console that has no such address (no Tailscale, or the address is not known).
    expect((await mint()).json().address).toBeNull();
    await build({ address: async () => "https://server.example.ts.net" });
    expect((await mint()).json().address).toBe("https://server.example.ts.net");
    // Only an origin goes to the page: no path, no query, no other scheme. A read that fails: nothing.
    for (const bad of ["http://server.example.ts.net", "https://server.example.ts.net/pair?x=1", "https://evil.test/#@server", "javascript:alert(1)", ""]) {
      await build({ address: async () => bad });
      expect((await mint()).json().address, bad).toBeNull();
    }
    await build({ address: async () => { throw new Error("tailscale did not answer"); } });
    const res = await mint();
    expect(res.statusCode).toBe(200);
    expect(res.json().address).toBeNull();
    // A caller that is not paired gets no code and no address.
    await build({ address: async () => "https://server.example.ts.net" });
    expect((await mint({})).json()).toEqual(PAIR);
  });

  it("refuses a caller that is not paired: no token, a wrong token", async () => {
    const callers: Record<string, string>[] = [{}, { [USER_HEADER]: "not-a-token" }];
    for (const headers of callers) {
      const res = await mint(headers);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual(PAIR);
    }
    expect(existsSync(codeFile)).toBe(false);
  });

  it("refuses an agent: a valid agent, an agent header with a user token, a bare agent header", async () => {
    const callers: Record<string, string>[] = [asAgent, { ...asAgent, [USER_HEADER]: laptop }, { [AGENT_HEADER]: "x", [USER_HEADER]: laptop }, { [AGENT_TOKEN_HEADER]: "", [USER_HEADER]: laptop }];
    for (const headers of callers) {
      const res = await mint(headers);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual(PAIR);
    }
    expect(existsSync(codeFile)).toBe(false);
  });

  it("a misconfigured console makes no code and pairs nothing", async () => {
    await build({ misconfigured: "a setting is missing" });
    expect((await mint()).statusCode).toBe(503);
    expect((await claim("K7QF-2M9X")).statusCode).toBe(503);
    expect(existsSync(codeFile)).toBe(false);
  });

  it("a second code replaces the first", async () => {
    const first = await newCode();
    const second = await newCode();
    expect(second).not.toBe(first);
    expect((await claim(first)).statusCode).toBe(403);
    expect((await claim(second)).statusCode).toBe(200);
  });

  it("the paired device can forget its code; another caller cannot", async () => {
    const code = await newCode();
    expect((await app.inject({ method: "DELETE", url: ADD_DEVICE_ROUTE })).statusCode).toBe(403);
    expect((await app.inject({ method: "DELETE", url: ADD_DEVICE_ROUTE, headers: asAgent })).statusCode).toBe(403);
    expect(existsSync(codeFile)).toBe(true);
    expect((await app.inject({ method: "DELETE", url: ADD_DEVICE_ROUTE, headers: { [USER_HEADER]: laptop } })).statusCode).toBe(200);
    expect(existsSync(codeFile)).toBe(false);
    expect((await claim(code)).statusCode).toBe(410);
    expect(await labels()).toEqual(["computer"]);
  });
});

describe("the claim", () => {
  beforeEach(() => build());

  it("the right code pairs one more normal device; the first device stays paired", async () => {
    const code = await newCode();
    now += 1_000;
    const res = await claim(code.toLowerCase().replace("-", " "));
    expect(res.statusCode).toBe(200);
    const { token, label } = res.json();
    expect(label).toBe("phone");
    expect(await levelOf(token)).toBe("user");
    expect(await levelOf(laptop)).toBe("user");
    expect(await labels()).toEqual(["computer", "phone"]);
    expect(res.body).not.toContain(code);
    expect(existsSync(codeFile)).toBe(false);
    expect(logs.join("\n")).not.toContain(token);
    // The set-up list checks again: its phone step is done now.
    expect(changes).toBe(1);
  });

  it("a name that a device has does not replace that device", async () => {
    const res = await claim(await newCode(), "computer");
    expect(res.json().label).toBe("computer-2");
    expect(await levelOf(laptop)).toBe("user");
    expect(await levelOf(res.json().token)).toBe("user");
    expect((await claim(await newCode(), "computer")).json().label).toBe("computer-3");
    expect(freeLabel("a".repeat(32), ["a".repeat(32)])).toBe(`${"a".repeat(30)}-2`);
  });

  it("refuses a used code", async () => {
    const code = await newCode();
    expect((await claim(code)).statusCode).toBe(200);
    const again = await claim(code, "tablet");
    expect(again.statusCode).toBe(410);
    expect(again.json()).toEqual({ error: ADD_DEVICE_ERR.gone });
    expect(await labels()).toEqual(["computer", "phone"]);
  });

  it("refuses a code that is older than 5 minutes", async () => {
    const code = await newCode();
    now += ADD_CODE_TTL_MS;
    expect((await claim(code)).statusCode).toBe(410);
    expect(await labels()).toEqual(["computer"]);
  });

  it("refuses a wrong code, and says nothing of the code", async () => {
    const code = await newCode();
    const res = await claim(other(code));
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: ADD_DEVICE_ERR.wrong });
    expect(changes).toBe(0);
    expect(await labels()).toEqual(["computer"]);
    // The code still works after one wrong try.
    expect((await claim(code)).statusCode).toBe(200);
  });

  it("the try limit holds: the last wrong try ends the code", async () => {
    const code = await newCode();
    for (let i = 1; i < BOX_CODE_TRIES; i++) expect((await claim(other(code))).statusCode).toBe(403);
    expect((await claim(other(code))).statusCode).toBe(429);
    expect((await claim(code)).statusCode).toBe(410);
    expect(await labels()).toEqual(["computer"]);
  });

  it("no code was made, or no code in the body: gone", async () => {
    expect((await claim("K7QF-2M9X")).statusCode).toBe(410);
    const code = await newCode();
    expect((await claim(undefined)).statusCode).toBe(410);
    expect((await claim(42)).statusCode).toBe(410);
    expect((await claim(code)).statusCode).toBe(200);
  });

  it("a name that is not valid pairs nothing and costs no try", async () => {
    const code = await newCode();
    for (const label of ["My Phone", "", "-x", "a".repeat(33), 7, undefined]) {
      const res = await app.inject({ method: "POST", url: ADD_CLAIM_ROUTE, payload: { code, ...(label === undefined ? {} : { label }) } });
      expect(res.statusCode).toBe(400);
    }
    expect(await labels()).toEqual(["computer"]);
    expect((await claim(code)).statusCode).toBe(200);
  });

  it("refuses a request with an agent header, also with the right code", async () => {
    const code = await newCode();
    const callers: Record<string, string>[] = [asAgent, { [AGENT_HEADER]: "x" }, { [AGENT_TOKEN_HEADER]: "" }];
    for (const headers of callers) {
      const res = await claim(code, "phone", headers);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: ADD_DEVICE_ERR.agentHeaders });
    }
    expect(await labels()).toEqual(["computer"]);
  });

  it("two claims at the same time: one device", async () => {
    const code = await newCode();
    const both = await Promise.all([claim(code), claim(code)]);
    expect(both.map((r) => r.statusCode).sort()).toEqual([200, 410]);
    expect(await labels()).toEqual(["computer", "phone"]);
  });

  it("a revoke of the device that made the code ends the code", async () => {
    const tablet = await devices.add("tablet");
    const code = (await mint({ [USER_HEADER]: tablet })).json().code as string;
    await devices.revoke("tablet");
    expect((await claim(code)).statusCode).toBe(410);
    expect(existsSync(codeFile)).toBe(false);
    expect(await labels()).toEqual(["computer"]);
  });

  it("a code does not live through a restart, and a planted code file pairs nothing", async () => {
    const code = await newCode();
    await build({ paired: false }); // the same data dir, a new process
    expect(existsSync(codeFile)).toBe(true);
    expect((await claim(code)).statusCode).toBe(410);
    expect(existsSync(codeFile)).toBe(false);
    expect(await labels()).toEqual(["computer"]);
  });
});

describe("with the lock of a new install", () => {
  it("a console with no paired device makes no code and takes no claim", async () => {
    await build({ lock: true, paired: false });
    const locked = { ...PAIR, locked: true };
    expect((await mint({})).json()).toEqual(locked);
    expect((await claim("K7QF-2M9X")).json()).toEqual(locked);
    expect(existsSync(codeFile)).toBe(false);
  });

  it("after the first device is paired, that device adds the next one", async () => {
    await build({ lock: true });
    const res = await claim(await newCode());
    expect(res.statusCode).toBe(200);
    expect(await labels()).toEqual(["computer", "phone"]);
  });
});
