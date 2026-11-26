// server/widgets/store.test.ts — WidgetStore list, read, state, ui and delete.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WidgetStore } from "./store.js";

let base: string;
let root: string;
let store: WidgetStore;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "widget-store-"));
  root = join(base, "root");
  await mkdir(root);
  store = new WidgetStore(root);
});
afterEach(async () => { await rm(base, { recursive: true, force: true }); });

async function widget(agentId: string, wid: string, files: Record<string, string> = {}): Promise<string> {
  const dir = join(root, agentId, wid);
  await mkdir(dir, { recursive: true });
  for (const [name, body] of Object.entries({ "widget.html": "<p>hi</p>", ...files })) {
    await mkdir(join(dir, name, ".."), { recursive: true });
    await writeFile(join(dir, name), body);
  }
  return dir;
}
const historyLines = async (dir: string) =>
  existsSync(join(dir, "history.jsonl"))
    ? (await readFile(join(dir, "history.jsonl"), "utf8")).split("\n").filter(Boolean)
    : [];

describe("list", () => {
  it("is empty for an agent with no folder and for a malformed agent id", async () => {
    expect(await store.list("a1")).toEqual([]);
    expect(await store.list("..")).toEqual([]);
  });
  it("lists folders with widget.html and a valid id, sorted, with meta and ui applied", async () => {
    await widget("a1", "b", { "meta.json": JSON.stringify({ title: "Beta", order: 2 }) });
    await widget("a1", "a", {
      "meta.json": JSON.stringify({ title: "Alpha", order: 2, width: 300 }),
      "ui.json": JSON.stringify({ width: "wide" }),
    });
    await widget("a1", "c", { "meta.json": JSON.stringify({ order: 1 }) });
    await widget("a1", "Bad.Name");
    await mkdir(join(root, "a1", "nohtml"), { recursive: true });
    const list = await store.list("a1");
    expect(list.map((w) => w.id)).toEqual(["c", "a", "b"]);
    expect(list[1]).toMatchObject({
      id: "a", title: "Alpha", width: "wide", height: 180, chrome: true, autoRefresh: null, order: 2,
      hasRefresh: false, dataMtime: null, status: null,
    });
    expect(typeof list[1].htmlMtime).toBe("number");
    expect(list[0].title).toBe("c");
  });
  it("reports hasRefresh when a refresh file exists", async () => {
    await widget("a1", "w", { refresh: "#!/bin/sh\necho '{}'\n" });
    expect((await store.list("a1"))[0].hasRefresh).toBe(true);
  });
  it("ingests agent-written data.json once, with an agent-mode ok status", async () => {
    const dir = await widget("a1", "w", { "data.json": '{"n":1}' });
    const [w] = await store.list("a1");
    expect(typeof w.dataMtime).toBe("number");
    expect(w.status).toMatchObject({ ok: true, mode: "agent" });
    await store.list("a1");
    expect(await historyLines(dir)).toHaveLength(1);
  });
  it("two parallel scans add the entry once", async () => {
    const dir = await widget("a1", "w", { "data.json": '{"n":1}' });
    await Promise.all([store.list("a1"), store.list("a1"), store.list("a1")]);
    expect(await historyLines(dir)).toHaveLength(1);
  });
  it("info is null for an unknown widget or a bad id", async () => {
    expect(await store.info("a1", "nope")).toBeNull();
    expect(await store.info("a1", "../x")).toBeNull();
  });
});

describe("get", () => {
  it("returns html, data, history and state", async () => {
    await widget("a1", "w", {
      "data.json": '{"n":3}',
      "history.jsonl": '{"at":1,"data":1}\n{"at":2,"data":2}\n',
      "state.json": '{"tab":"x"}',
    });
    expect(await store.get("a1", "w")).toEqual({
      html: "<p>hi</p>", data: { n: 3 }, history: [{ at: 1, data: 1 }, { at: 2, data: 2 }], state: { tab: "x" },
    });
  });
  it("with since: leaves out html and older history", async () => {
    await widget("a1", "w", { "history.jsonl": '{"at":1,"data":1}\n{"at":2,"data":2}\n' });
    const p = await store.get("a1", "w", 1);
    expect(p).toEqual({ data: null, history: [{ at: 2, data: 2 }], state: {} });
  });
  it("is null for an unknown widget and 413 for widget.html over 1 MB", async () => {
    expect(await store.get("a1", "nope")).toBeNull();
    await widget("a1", "big", { "widget.html": "x".repeat(1024 * 1024 + 1) });
    await expect(store.get("a1", "big")).rejects.toMatchObject({ code: 413 });
  });
});

describe("state and ui", () => {
  it("setState writes state.json; over 64 KB is 413; unknown widget is false", async () => {
    const dir = await widget("a1", "w");
    expect(await store.setState("a1", "w", { tab: "y" })).toBe(true);
    expect(JSON.parse(await readFile(join(dir, "state.json"), "utf8"))).toEqual({ tab: "y" });
    await expect(store.setState("a1", "w", "x".repeat(70_000))).rejects.toMatchObject({ code: 413 });
    expect(await store.setState("a1", "nope", {})).toBe(false);
  });
  it("setUi merges into ui.json and the list shows it", async () => {
    await widget("a1", "w", { "meta.json": JSON.stringify({ autoRefresh: 60 }) });
    expect(await store.setUi("a1", "w", { width: 400 })).toBe(true);
    expect(await store.setUi("a1", "w", { autoRefresh: null })).toBe(true);
    const [w] = await store.list("a1");
    expect(w).toMatchObject({ width: 400, autoRefresh: null });
  });
});

describe("remove and removeAgent", () => {
  it("remove deletes the widget folder once", async () => {
    const dir = await widget("a1", "w");
    expect(await store.remove("a1", "w")).toBe(true);
    expect(existsSync(dir)).toBe(false);
    expect(await store.remove("a1", "w")).toBe(false);
  });
  it("removeAgent removes the agent folder and ignores malformed ids", async () => {
    await widget("a1", "w");
    await writeFile(join(base, "keep.txt"), "keep");
    await store.removeAgent("..");
    await store.removeAgent(".");
    await store.removeAgent("");
    expect(existsSync(root)).toBe(true);
    expect(existsSync(join(base, "keep.txt"))).toBe(true);
    await store.removeAgent("a1");
    expect(existsSync(join(root, "a1"))).toBe(false);
  });
});
