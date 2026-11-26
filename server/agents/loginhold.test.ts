// server/agents/loginhold.test.ts — the persistent agents that a sign-out stopped wait for a login.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoginHold } from "./loginhold.js";

let dir = "";
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "loginhold-")); });
afterEach(() => rm(dir, { recursive: true, force: true }));

function hold(can: Record<string, boolean> = {}) {
  const logs: string[] = [];
  const h = new LoginHold({ file: join(dir, "held.json"), canStart: async (l) => can[l] === true, log: (s) => logs.push(s) });
  return { h, logs };
}

describe("LoginHold", () => {
  it("a held agent waits while its login cannot start it; one log line; nothing else is held", async () => {
    const { h, logs } = hold();
    await h.hold(["fleet-master", "lead-web"], "default");
    expect(await h.mayStart({ id: "fleet-master" })).toBe(false);
    expect(await h.mayStart({ id: "fleet-master", account: "default" })).toBe(false);
    expect(await h.mayStart({ id: "coordinator" })).toBe(true);
    expect(h.waitsFor("fleet-master")).toBe(true);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/fleet-master waits: its Claude login default was signed out on the page/);
  });

  it("the login can start it again (signed in, or another login works): the hold ends at the next start", async () => {
    const can: Record<string, boolean> = {};
    const { h } = hold(can);
    await h.hold(["fleet-master"], "work");
    expect(await h.mayStart({ id: "fleet-master", account: "work" })).toBe(false);
    can.work = true;
    expect(await h.mayStart({ id: "fleet-master", account: "work" })).toBe(true);
    expect(h.waitsFor("fleet-master")).toBe(false);
  });

  it("an agent that the user moved to another login since: not held", async () => {
    const { h } = hold();
    await h.hold(["lead-web"], "work");
    expect(await h.mayStart({ id: "lead-web", account: "other" })).toBe(true);
    expect(h.waitsFor("lead-web")).toBe(false);
  });

  it("releaseAll gives each held id once and ends the hold; release ends one", async () => {
    const { h } = hold();
    await h.hold(["lead-web", "fleet-master", "coordinator"], "default");
    await h.release(["coordinator"]);
    expect(await h.releaseAll()).toEqual(["fleet-master", "lead-web"]);
    expect(await h.releaseAll()).toEqual([]);
  });

  it("the file keeps the hold over a restart; a broken file holds nothing; an id or a login that is not valid is skipped", async () => {
    const a = hold().h;
    await a.hold(["fleet-master"], "default");
    expect(JSON.parse(await readFile(join(dir, "held.json"), "utf8"))).toEqual({ "fleet-master": "default" });
    const b = hold().h;
    await b.load();
    expect(b.waitsFor("fleet-master")).toBe(true);
    await writeFile(join(dir, "held.json"), JSON.stringify({ "../x": "default", "lead-web": "Bad Login", coordinator: "work" }));
    const c = hold().h;
    await c.load();
    expect([c.waitsFor("lead-web"), c.waitsFor("coordinator")]).toEqual([false, true]);
    await writeFile(join(dir, "held.json"), "{not json");
    const d = hold().h;
    await d.load();
    expect(d.waitsFor("coordinator")).toBe(false);
  });
});
