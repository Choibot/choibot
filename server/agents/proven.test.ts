// Strong protection: the console's reads, writes and deletes in folders that an agent can write
// (the agents' Claude folder, the widgets folder) never reach a place outside them through a link
// (nofollow.ts openProven, removeEntry; widgets/files.ts). The agents' session files are read
// by the helper as the agent (sessionread.ts; sessionread.test.ts).
import { execFileSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { O_DIR, openProven, removeEntry } from "./nofollow.js";
import { setAgentHelper } from "../chief/hardened.js";
import { WidgetStore } from "../widgets/store.js";
import { mtimeOf, writeAtomic } from "../widgets/files.js";

const ME = process.getuid!();
let dir = "";
beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), "proven-"))); });
afterEach(() => { setAgentHelper(false); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });
const strong = (extra: Record<string, string> = {}) => {
  for (const [k, v] of Object.entries({ CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_CONSOLE_URL: "https://c.example", CHIEF_AGENT_UID: String(ME), AGENT_HOME_ROOT: join(dir, "homes"), ...extra })) vi.stubEnv(k, v);
};

describe("openProven: a read proven on the open fd", () => {
  it("opens a regular file of one link inside the root; refuses a link in the middle or at the end, a hard link, another owner, a FIFO", async () => {
    const root = join(dir, "root");
    mkdirSync(join(root, "a"), { recursive: true });
    mkdirSync(join(dir, "outside"));
    writeFileSync(join(root, "a", "ok"), "ok");
    writeFileSync(join(dir, "outside", "secret"), "secret");
    symlinkSync(join(dir, "outside"), join(root, "mid"));
    symlinkSync(join(dir, "outside", "secret"), join(root, "a", "last"));
    linkSync(join(root, "a", "ok"), join(root, "a", "hard"));
    writeFileSync(join(root, "a", "one"), "one");
    execFileSync("mkfifo", [join(root, "a", "fifo")]);
    const got = async (p: string, uid?: number) => { const fh = await openProven(p, { root, uid }); if (!fh) return null; const t = (await fh.readFile()).toString(); await fh.close(); return t; };
    expect(await got(join(root, "a", "one"))).toBe("one");
    expect(await got(join(root, "a", "one"), ME)).toBe("one");
    expect(await got(join(root, "mid", "secret"))).toBeNull();
    expect(await got(join(root, "a", "last"))).toBeNull();
    expect(await got(join(root, "a", "hard"))).toBeNull();
    expect(await got(join(root, "a", "one"), ME + 1)).toBeNull();
    expect(await got(join(root, "a", "fifo"))).toBeNull();
  });

  it("removeEntry removes a tree; a link in it is removed, never followed", async () => {
    const root = join(dir, "root");
    mkdirSync(join(root, "w", "sub"), { recursive: true });
    writeFileSync(join(root, "w", "sub", "f"), "x");
    mkdirSync(join(dir, "keep"));
    writeFileSync(join(dir, "keep", "f"), "keep");
    symlinkSync(join(dir, "keep"), join(root, "w", "link"));
    const fh = await open(root, O_DIR);
    try { await removeEntry(fh, "w"); await removeEntry(fh, "none"); } finally { await fh.close(); }
    expect(existsSync(join(root, "w"))).toBe(false);
    expect(readFileSync(join(dir, "keep", "f"), "utf8")).toBe("keep");
  });
});

describe("widgets with strong protection: no read, write or delete outside the widgets folder", () => {
  let root = "";
  beforeEach(() => {
    root = join(dir, "widgets");
    mkdirSync(join(root, "a1", "w-ok"), { recursive: true });
    writeFileSync(join(root, "a1", "w-ok", "widget.html"), "<p>ok</p>");
    // The console's own folder, with files of the names a widget uses.
    mkdirSync(join(dir, "console", "w-x"), { recursive: true });
    for (const f of ["widget.html", "data.json", "state.json"]) writeFileSync(join(dir, "console", "w-x", f), `"SECRET ${f}"`);
    writeFileSync(join(dir, "console", ".env"), '"TOKEN=SECRET"'); // valid JSON: a read would show
    strong({ WIDGETS_DATA_DIR: root });
  });

  it("a widget folder that is a link to a console folder: nothing read from it, no write into it", async () => {
    symlinkSync(join(dir, "console", "w-x"), join(root, "a1", "w-x"));
    const s = new WidgetStore(root);
    const got = await s.get("a1", "w-x");
    expect(JSON.stringify(got ?? {})).not.toContain("SECRET");
    expect(await s.setState("a1", "w-x", { n: 1 })).toBe(false); // the widget is not seen there
    await expect(writeAtomic(join(root, "a1", "w-x", "state.json"), "{}")).rejects.toThrow(); // nor written by path
    expect(readFileSync(join(dir, "console", "w-x", "state.json"), "utf8")).toBe('"SECRET state.json"');
    expect(readdirSync(join(dir, "console", "w-x")).sort()).toEqual(["data.json", "state.json", "widget.html"]);
  });

  it("a data.json that is a link to a console file: not read; a write replaces the link, never the file", async () => {
    symlinkSync(join(dir, "console", ".env"), join(root, "a1", "w-ok", "data.json"));
    const s = new WidgetStore(root);
    expect(JSON.stringify((await s.get("a1", "w-ok"))?.data ?? null)).not.toContain("SECRET");
    expect(await s.setState("a1", "w-ok", { n: 2 })).toBe(true);
    expect(readFileSync(join(root, "a1", "w-ok", "state.json"), "utf8")).toBe('{"n":2}');
    expect(readFileSync(join(dir, "console", ".env"), "utf8")).toBe('"TOKEN=SECRET"');
  });

  it("the change time of a data.json that is a link to a console file: none (not the console file's time)", async () => {
    writeFileSync(join(root, "a1", "w-ok", "data.json"), "{}");
    expect(typeof (await mtimeOf(join(root, "a1", "w-ok", "data.json")))).toBe("number");
    rmSync(join(root, "a1", "w-ok", "data.json"));
    symlinkSync(join(dir, "console", ".env"), join(root, "a1", "w-ok", "data.json"));
    expect(await mtimeOf(join(root, "a1", "w-ok", "data.json"))).toBeNull();
  });

  it("an agent's folder that is a link to a console folder: the list is empty and a delete removes only the link", async () => {
    rmSync(join(root, "a1"), { recursive: true });
    symlinkSync(join(dir, "console"), join(root, "a1"));
    const s = new WidgetStore(root);
    expect(await s.list("a1")).toEqual([]);
    await s.remove("a1", "w-x");
    await s.removeAgent("a1");
    expect(existsSync(join(root, "a1"))).toBe(false);
    expect(readdirSync(join(dir, "console", "w-x")).sort()).toEqual(["data.json", "state.json", "widget.html"]);
  });

  it("a normal widget works as before", async () => {
    const s = new WidgetStore(root);
    expect((await s.list("a1")).map((w) => w.id)).toEqual(["w-ok"]);
    expect((await s.get("a1", "w-ok"))?.html).toBe("<p>ok</p>");
    expect(await s.setState("a1", "w-ok", { n: 3 })).toBe(true);
    await s.removeAgent("a1");
    expect(existsSync(join(root, "a1"))).toBe(false);
  });
});
