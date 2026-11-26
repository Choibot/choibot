// server/widgets/store.scripts.test.ts — WidgetStore script refresh (single flight) and actions.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WidgetStore } from "./store.js";
import { readHistory, readStatus } from "./history.js";

let base: string;
let store: WidgetStore;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "widget-scripts-"));
  store = new WidgetStore(join(base, "root"));
});
afterEach(async () => { await rm(base, { recursive: true, force: true }); });

async function widget(wid: string, scripts: Record<string, string>, files: Record<string, string> = {}, mode = 0o755): Promise<string> {
  const dir = join(store.root, "a1", wid);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "widget.html"), "<p>x</p>");
  for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body);
  for (const [name, body] of Object.entries(scripts)) {
    await mkdir(join(dir, name, ".."), { recursive: true });
    await writeFile(join(dir, name), `#!/bin/sh\n${body}\n`);
    await chmod(join(dir, name), mode);
  }
  return dir;
}

describe("refreshScript", () => {
  it("writes data.json, one history entry and an ok status; a later scan adds nothing", async () => {
    const dir = await widget("w", { refresh: "echo '{\"n\":1}'" });
    const r = await store.refreshScript("a1", "w", base, undefined);
    expect(r.data).toEqual({ n: 1 });
    expect(r.status).toMatchObject({ ok: true, mode: "script" });
    expect(JSON.parse(await readFile(join(dir, "data.json"), "utf8"))).toEqual({ n: 1 });
    await store.list("a1");
    expect((await readHistory(dir)).map((e) => e.data)).toEqual([{ n: 1 }]);
  });
  it("gives the script the widget's args on stdin, {} when none", async () => {
    await widget("w", { refresh: "cat" });
    expect((await store.refreshScript("a1", "w", base, { q: "x" })).data).toEqual({ q: "x" });
    expect((await store.refreshScript("a1", "w", base, undefined)).data).toEqual({});
  });
  it("on failure writes only status.json; the old data stays and is returned", async () => {
    const dir = await widget("w", { refresh: "echo nope >&2\nexit 2" }, { "data.json": '{"old":1}' });
    const r = await store.refreshScript("a1", "w", base, undefined);
    expect(r.status).toMatchObject({ ok: false, mode: "script" });
    expect(r.status.error).toContain("exit 2");
    expect(r.data).toEqual({ old: 1 });
    expect(await readFile(join(dir, "data.json"), "utf8")).toBe('{"old":1}');
    expect((await readStatus(dir)).last?.ok).toBe(false);
  });
  it("refuses a refresh file with no exec bit: 400 not runnable", async () => {
    await widget("w", { refresh: "echo '{}'" }, {}, 0o644);
    await expect(store.refreshScript("a1", "w", base, undefined)).rejects.toMatchObject({ code: 400, message: "not runnable" });
  });
  it("widget deleted while the script runs: 404 and no folder made again", async () => {
    const dir = await widget("w", { refresh: "sleep 0.3\necho '{\"n\":1}'" });
    const run = store.refreshScript("a1", "w", base, undefined);
    await new Promise((res) => setTimeout(res, 100));
    expect(await store.remove("a1", "w")).toBe(true);
    await expect(run).rejects.toMatchObject({ code: 404, message: "not found" });
    expect(existsSync(dir)).toBe(false);
  });
  it("single flight: a second call joins the running one", async () => {
    const dir = await widget("w", { refresh: "echo x >> \"$CHOIBOT_WIDGET_DIR/runs\"\nsleep 0.3\necho '{\"n\":1}'" });
    const [a, b] = await Promise.all([
      store.refreshScript("a1", "w", base, undefined),
      store.refreshScript("a1", "w", base, undefined),
    ]);
    expect(a).toBe(b);
    expect((await readFile(join(dir, "runs"), "utf8")).trim().split("\n")).toHaveLength(1);
  });
});

describe("action", () => {
  it("returns the JSON result and does not touch data.json or history", async () => {
    const dir = await widget("w", { "actions/echo": "cat" });
    expect(await store.action("a1", "w", "echo", base, { a: 1 })).toEqual({ a: 1 });
    expect(existsSync(join(dir, "data.json"))).toBe(false);
    expect(existsSync(join(dir, "history.jsonl"))).toBe(false);
  });
  it("a missing action is 400 not runnable; a failing one is 500 with the run error", async () => {
    await widget("w", { "actions/bad": "exit 4" });
    await expect(store.action("a1", "w", "nope", base, {})).rejects.toMatchObject({ code: 400 });
    await expect(store.action("a1", "w", "bad", base, {})).rejects.toMatchObject({ code: 500, message: "exit 4" });
  });
  it("runs at most 2 actions at once per widget: the third is 429", async () => {
    await widget("w", { "actions/slow": "sleep 0.4\necho '{}'" });
    const results = await Promise.allSettled([
      store.action("a1", "w", "slow", base, {}),
      store.action("a1", "w", "slow", base, {}),
      store.action("a1", "w", "slow", base, {}),
    ]);
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ code: 429 });
    expect(await store.action("a1", "w", "slow", base, {})).toEqual({});
  });
});

// Ruling F3: in a hardened deployment a widget script runs only through the
// agent exec helper (as the agent uid). Without agentExec (the probe failed)
// the store refuses it rather than run agent-written code as the console uid.
describe("hardened deployment without the agent helper (ruling F3)", () => {
  const HARDENED = {
    CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_CONSOLE_URL: "http://127.0.0.1:4999", CHIEF_AGENT_UID: "1001",
  };
  afterEach(() => { vi.unstubAllEnvs(); });
  const hardened = () => { for (const [k, v] of Object.entries(HARDENED)) vi.stubEnv(k, v); };

  it("refresh and actions: 503 widget scripts need the agent helper; the script never runs", async () => {
    const dir = await widget("w", {
      refresh: `touch "${base}/ran"; echo '{}'`, "actions/go": `touch "${base}/ran"; echo '{}'`,
    });
    hardened();
    const refused = { code: 503, message: "widget scripts need the agent helper" };
    await expect(store.refreshScript("a1", "w", base, undefined)).rejects.toMatchObject(refused);
    await expect(store.action("a1", "w", "go", base, undefined)).rejects.toMatchObject(refused);
    expect(existsSync(join(base, "ran"))).toBe(false);
    expect(existsSync(join(dir, "data.json"))).toBe(false);
  });

  it("not hardened (a uid alone): the script runs as before", async () => {
    await widget("w", { refresh: `touch "${base}/ran"; echo '{"n":2}'` });
    vi.stubEnv("CHIEF_AGENT_UID", "1001");
    expect((await store.refreshScript("a1", "w", base, undefined)).data).toEqual({ n: 2 });
    expect(existsSync(join(base, "ran"))).toBe(true);
  });
});
