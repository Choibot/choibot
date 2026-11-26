import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../../agents/store.js";
import type { Caller } from "../auth.js";
import { QueueStore } from "./store.js";
import { addItem, createdByOf, QueueAddError, type AddDeps } from "./add.js";

const URL1 = "https://github.com/example-org/app-shop/pull/7";
const rec = (o: Partial<AgentRecord> = {}): AgentRecord => ({
  id: "a1", label: "x", repo: "/ws/app-shop", worktree: "/ws/wt", branch: "agent/x", baseBranch: "main",
  sessionId: null, hookToken: "t", status: "running", createdAt: 1, ...o,
});
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "chief-queue-add-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("png-body")]);
function mk(o: { rec?: AgentRecord | null } & Partial<AddDeps> = {}) {
  const store = new QueueStore(join(root, "queue"), { log: () => {} });
  const r = o.rec === undefined ? rec() : o.rec;
  const prStatus = vi.fn(async () => ({
    prState: "OPEN", mergeable: "MERGEABLE", reviewDecision: "", url: URL1,
    checks: { total: 1, passed: 1, failed: 0, pending: 0, rollup: "success" as const },
  }));
  const isAncestor = vi.fn(async () => false);
  const d: AddDeps = {
    store, agents: { load: async () => r }, workspaceDir: "/ws", agentRoots: [root],
    listRepos: async () => [{ name: "app-shop", slug: "example-org/app-shop", path: "/ws/app-shop" }],
    prStatus, isAncestor, ...o,
  };
  return { d, store, prStatus, isAncestor };
}
const base = { title: "t", body: "b" };

describe("addItem", () => {
  it("stores checks and mergeable for a known slug", async () => {
    const { d, store, prStatus } = mk();
    const { id, created } = await addItem(d, "a1", { kind: "pr", ...base, pr: { url: URL1 } }, { agentId: "a1", kind: "worker" });
    expect(created).toBe(true);
    expect(prStatus).toHaveBeenCalledWith("/ws/app-shop", 7);
    const got = (await store.get(id))!;
    expect(got).toMatchObject({ agentId: "a1", createdBy: { agentId: "a1", kind: "worker" }, kind: "pr", title: "t", body: "b" });
    expect(got.pr).toEqual({ url: URL1, number: 7, checks: "success", mergeable: "MERGEABLE" });
    expect(got.repo).toBe("app-shop");
    expect(got.area).toBe("app-shop");
    expect(got.blocking).toBe(false);
  });
  it("unknown slug gives url and number only", async () => {
    const { d, store, prStatus } = mk({ listRepos: async () => [] });
    const { id } = await addItem(d, "a1", { kind: "pr", ...base, pr: { url: URL1 } }, { agentId: "a1", kind: "worker" });
    expect((await store.get(id))!.pr).toEqual({ url: URL1, number: 7 });
    expect(prStatus).not.toHaveBeenCalled();
  });
  it("gh failure stores no checks", async () => {
    const { d, store } = mk({ prStatus: async () => { throw new Error("gh down"); } });
    const { id } = await addItem(d, "a1", { kind: "pr", ...base, pr: { url: URL1 } }, { agentId: "a1", kind: "worker" });
    expect((await store.get(id))!.pr).toEqual({ url: URL1, number: 7 });
  });
  it("local branch uses the record repo basename and aheadAtAdd", async () => {
    const { d, store, isAncestor } = mk();
    const { id } = await addItem(d, "a1", { kind: "pr", ...base, pr: { branch: "agent/x" } }, { agentId: "a1", kind: "worker" });
    expect(isAncestor).toHaveBeenCalledWith("/ws/app-shop", "agent/x", "main");
    expect((await store.get(id))!.pr).toEqual({ local: { repo: "app-shop", branch: "agent/x", aheadAtAdd: true } });
  });
  it("aheadAtAdd is false when the branch is an ancestor of the base", async () => {
    const { d, store } = mk({ isAncestor: async () => true });
    const { id } = await addItem(d, "a1", { kind: "pr", ...base, pr: { branch: "agent/x" } }, { agentId: "a1", kind: "worker" });
    expect((await store.get(id))!.pr).toEqual({ local: { repo: "app-shop", branch: "agent/x", aheadAtAdd: false } });
  });
  it("a git failure leaves aheadAtAdd unset", async () => {
    const { d, store } = mk({ isAncestor: async () => { throw new Error("git"); } });
    const { id } = await addItem(d, "a1", { kind: "pr", ...base, pr: { branch: "agent/x" } }, { agentId: "a1", kind: "worker" });
    expect((await store.get(id))!.pr).toEqual({ local: { repo: "app-shop", branch: "agent/x" } });
  });
  it("no repo with a branch is an error", async () => {
    const { d } = mk({ rec: rec({ repo: "" }) });
    const e = await addItem(d, "a1", { kind: "pr", ...base, pr: { branch: "agent/x" } }, { agentId: "a1", kind: "worker" }).catch((x) => x);
    expect(e).toBeInstanceOf(QueueAddError);
    expect(e).toMatchObject({ status: 400, message: "no repo for a local pr" });
  });
  it("unknown agent is an error", async () => {
    const { d } = mk({ rec: null });
    const e = await addItem(d, "a1", { kind: "question", ...base }, { agentId: "a1", kind: "worker" }).catch((x) => x);
    expect(e).toBeInstanceOf(QueueAddError);
    expect(e).toMatchObject({ status: 404, message: "unknown agent" });
  });
  it("blocking defaults per kind and can be overridden", async () => {
    mkdirSync(join(root, "wt", ".choibot", "previews"), { recursive: true });
    writeFileSync(join(root, "wt", ".choibot", "previews", "a.png"), PNG);
    const { d, store } = mk({ rec: rec({ cwd: join(root, "wt") }) });
    const cb = { agentId: "a1", kind: "worker" as const };
    const opts = [{ key: "A", label: "a" }, { key: "B", label: "b" }];
    const q = await addItem(d, "a1", { kind: "question", ...base }, cb);
    const c = await addItem(d, "a1", { kind: "choice", ...base, options: opts }, cb);
    const o = await addItem(d, "a1", { kind: "choice", ...base, options: opts, blocking: false }, cb);
    const v = await addItem(d, "a1", { kind: "preview", ...base, preview: { images: [".choibot/previews/a.png"] } }, cb);
    expect((await store.get(q.id))!.blocking).toBe(true);
    expect((await store.get(c.id))!.blocking).toBe(true);
    expect((await store.get(o.id))!.blocking).toBe(false);
    expect((await store.get(v.id))!.blocking).toBe(false);
    expect((await store.get(c.id))!.choice).toEqual({ options: opts });
    expect((await store.get(v.id))!.preview).toEqual({ images: ["1.png"] });
  });
  it("a workspace agent gets repo workspace", async () => {
    const { d, store } = mk({ rec: rec({ repo: "" }) });
    const { id } = await addItem(d, "a1", { kind: "question", ...base }, { agentId: "a1", kind: "worker" });
    expect((await store.get(id))!.repo).toBe("workspace");
  });
  it("uses areaOf when given", async () => {
    const { d, store } = mk({ areaOf: async (r) => `area-${r}` });
    const { id } = await addItem(d, "a1", { kind: "question", ...base }, { agentId: "a1", kind: "worker" });
    expect((await store.get(id))!.area).toBe("area-app-shop");
  });
  it("matches the slug case-insensitively", async () => {
    const { d, store } = mk({ listRepos: async () => [{ name: "app-shop", slug: "Example-Org/App-shop", path: "/ws/app-shop" }] });
    const { id } = await addItem(d, "a1", { kind: "pr", ...base, pr: { url: URL1 } }, { agentId: "a1", kind: "worker" });
    expect((await store.get(id))!.pr).toMatchObject({ checks: "success" });
  });
  it("a repeated URL dedups", async () => {
    const { d } = mk();
    const cb = { agentId: "a1", kind: "worker" as const };
    const a = await addItem(d, "a1", { kind: "pr", ...base, pr: { url: URL1 } }, cb);
    const b = await addItem(d, "a1", { kind: "pr", ...base, pr: { url: URL1 } }, cb);
    expect(b).toEqual({ id: a.id, created: false });
  });
});

describe("addItem preview", () => {
  const cb = { agentId: "a1", kind: "worker" as const };
  const shot = (rel: string) => {
    const p = join(root, "wt", rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, PNG);
  };
  const mediaOf = (id: string) => join(root, "queue", "media", id);
  const withCwd = () => (mkdirSync(join(root, "wt"), { recursive: true }), mk)({ rec: rec({ cwd: join(root, "wt"), worktree: join(root, "other") }) });

  it("a pr item with screenshots (decision 65): one item with the pr and the copied images", async () => {
    shot(".choibot/previews/a-1.png");
    shot(".choibot/previews/a-2.png");
    const { d, store } = withCwd();
    const { id } = await addItem(d, "a1", { kind: "pr", ...base, pr: { branch: "agent/x" }, preview: { images: [".choibot/previews/a-1.png", ".choibot/previews/a-2.png"] } }, cb);
    const it = (await store.get(id))!;
    expect(it.kind).toBe("pr");
    expect(it.pr).toMatchObject({ local: { branch: "agent/x" } });
    expect(it.preview).toEqual({ images: ["1.png", "2.png"] });
    expect(readdirSync(mediaOf(id))).toEqual(["1.png", "2.png"]);
    expect(await store.list()).toHaveLength(1);
  });
  it("a pr item whose screenshot is outside the agent's folder is refused, and no item is made", async () => {
    const { d, store } = withCwd();
    const e = await addItem(d, "a1", { kind: "pr", ...base, pr: { branch: "agent/x" }, preview: { images: ["../../etc/passwd"] } }, cb).catch((x) => x);
    expect(e).toBeInstanceOf(QueueAddError);
    expect(await store.list()).toEqual([]);
  });

  it("copies a PNG from the agent cwd into the media folder", async () => {
    shot(".choibot/previews/a-1.png");
    const { d, store } = withCwd();
    const { id } = await addItem(d, "a1", { kind: "preview", ...base, preview: { images: [".choibot/previews/a-1.png"], url: "https://x.dev" } }, cb);
    expect((await store.get(id))!.preview).toEqual({ images: ["1.png"], url: "https://x.dev" });
    expect(readdirSync(mediaOf(id))).toEqual(["1.png"]);
  });
  it("falls back to the worktree when the record has no cwd", async () => {
    const { d, store } = mk({ rec: rec({ worktree: join(root, "wt") }) });
    shot("a.png");
    const { id } = await addItem(d, "a1", { kind: "preview", ...base, preview: { images: ["a.png"] } }, cb);
    expect((await store.get(id))!.preview!.images).toEqual(["1.png"]);
  });
  it("a bad path is a 400 with the reason, and no item or media is left", async () => {
    const { d, store } = withCwd();
    const e = await addItem(d, "a1", { kind: "preview", ...base, preview: { images: ["../../etc/passwd"] } }, cb).catch((x) => x);
    expect(e).toBeInstanceOf(QueueAddError);
    expect(e).toMatchObject({ status: 400 });
    expect(e.message).toContain("../../etc/passwd");
    expect(await store.list()).toEqual([]);
    expect(existsSync(join(root, "queue", "media")) ? readdirSync(join(root, "queue", "media")) : []).toEqual([]);
  });
  it("an agent whose cwd is outside the agent roots is a 400, and no item or media is left", async () => {
    shot("a.png");
    mkdirSync(join(root, "elsewhere"));
    const { d, store } = mk({ rec: rec({ cwd: join(root, "wt") }), agentRoots: [join(root, "elsewhere")] });
    const e = await addItem(d, "a1", { kind: "preview", ...base, preview: { images: ["a.png"] } }, cb).catch((x) => x);
    expect(e).toBeInstanceOf(QueueAddError);
    expect(e).toMatchObject({ status: 400, message: "agent folder outside the agent roots" });
    expect(await store.list()).toEqual([]);
    expect(existsSync(join(root, "queue", "media"))).toBe(false);
  });
  it("removes the media when the store write fails", async () => {
    shot("a.png");
    const { d, store } = withCwd();
    vi.spyOn(store, "add").mockRejectedValue(new Error("disk full"));
    await expect(addItem(d, "a1", { kind: "preview", ...base, preview: { images: ["a.png"] } }, cb)).rejects.toThrow("disk full");
    expect(readdirSync(join(root, "queue", "media"))).toEqual([]);
  });
  it("a media cleanup that fails after a failed store write logs one line with the item id and errno", async () => {
    shot("a.png");
    const { d, store } = withCwd();
    const media = join(root, "queue", "media");
    let id = "";
    vi.spyOn(store, "add").mockImplementation(async (_input, o) => {
      id = o!.id!;
      chmodSync(media, 0o500); // the media folder can no longer lose an entry
      throw new Error("disk full");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(addItem(d, "a1", { kind: "preview", ...base, preview: { images: ["a.png"] } }, cb)).rejects.toThrow("disk full");
    } finally {
      chmodSync(media, 0o700);
    }
    expect(warn.mock.calls).toEqual([[`[chief] queue add: media cleanup failed for ${id}: EACCES`]]);
    warn.mockRestore();
  });
});

describe("createdByOf", () => {
  const c = (level: Caller["level"]): Caller => ({ level, agentHeaders: true, agentId: "a1" });
  it("maps the caller", () => {
    expect(createdByOf(c("agent"), rec({ kind: "issue" }))).toEqual({ agentId: "a1", kind: "issue" });
    expect(createdByOf(c("lead"), rec())).toEqual({ agentId: "a1", kind: "lead" });
    expect(createdByOf(c("master"), rec({ kind: "fleet-master" }))).toEqual({ agentId: "a1", kind: "fleet-master" });
    expect(createdByOf(c("agent"), rec())).toEqual({ agentId: "a1", kind: "worker" });
    expect(createdByOf(c("agent"), null)).toEqual({ agentId: "a1", kind: "worker" });
    expect(() => createdByOf({ level: "agent", agentHeaders: true }, null)).toThrow("no agent id");
  });
});

describe("addItem with a rich part (html)", () => {
  const cb = { agentId: "a1", kind: "worker" as const };
  const wt = () => join(root, "wt");
  const write = (rel: string, text: string | Buffer) => {
    const p = join(wt(), rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, text);
  };
  const withCwd = () => (mkdirSync(wt(), { recursive: true }), mk)({ rec: rec({ cwd: wt() }) });
  const pageOf = (id: string) => join(root, "queue", "media", id, "page.html");
  const noFolders = () => !existsSync(join(root, "queue", "media")) || readdirSync(join(root, "queue", "media")).length === 0;
  const opts = [{ key: "A", label: "a" }, { key: "B", label: "b" }];
  const PAGE = `<style>.x{color:var(--ink-0)}</style><h2 class="x">Plan</h2><table><tr><td>1</td></tr></table>`;

  it("any kind carries one page: the item says so and the copy is in the queue's own store", async () => {
    write(".choibot/tickets/plan.html", PAGE);
    const { d, store } = withCwd();
    const c = await addItem(d, "a1", { kind: "choice", ...base, options: opts, html: { file: ".choibot/tickets/plan.html", height: 300 } }, cb);
    const q = await addItem(d, "a1", { kind: "question", ...base, html: { file: ".choibot/tickets/plan.html" } }, cb);
    expect((await store.get(c.id))!.html).toEqual({ bytes: Buffer.byteLength(PAGE), height: 300 });
    expect((await store.get(q.id))!.html).toEqual({ bytes: Buffer.byteLength(PAGE) });
    expect(readFileSync(pageOf(c.id), "utf8")).toBe(PAGE);
    expect(store.pagePath(c.id)).toBe(pageOf(c.id));
    // The ticket keeps its copy when the agent's file changes or goes.
    write(".choibot/tickets/plan.html", "<p>changed</p>");
    expect(readFileSync(pageOf(c.id), "utf8")).toBe(PAGE);
  });
  it("a pr item with screenshots and a page: both in the one folder", async () => {
    write(".choibot/previews/a-1.png", PNG);
    write("t.html", PAGE);
    const { d, store } = withCwd();
    const { id } = await addItem(d, "a1", { kind: "pr", ...base, pr: { branch: "agent/x" }, preview: { images: [".choibot/previews/a-1.png"] }, html: { file: "t.html" } }, cb);
    expect((await store.get(id))!).toMatchObject({ preview: { images: ["1.png"] }, html: { bytes: Buffer.byteLength(PAGE) } });
    expect(readdirSync(join(root, "queue", "media", id)).sort()).toEqual(["1.png", "page.html"]);
  });
  it("a refused page: 400 with the plain reason, no item and no folder", async () => {
    const { d, store } = withCwd();
    const bad: [string, string | Buffer, RegExp][] = [
      ["s.html", `<p>x</p><script>fetch("https://evil.example/")</script>`, /^html: <script> is not allowed: no script runs in a ticket page$/],
      ["h.html", `<img src="data:image/png;base64,AA" onerror="x()">`, /^html: the event handler "onerror"/],
      ["m.html", `<meta http-equiv="refresh" content="0;url=https://evil.example/">`, /^html: <meta> is not allowed/],
      ["big.html", `<p>${"a".repeat(300 * 1024)}</p>`, /^html: "big.html": larger than 300 KB \(the limit of a ticket page\)$/],
      ["bin.html", Buffer.from([0x3c, 0x70, 0x3e, 0xff, 0xfe]), /^html: the file is not UTF-8 text$/],
    ];
    for (const [name, text, re] of bad) {
      write(name, text);
      const e = await addItem(d, "a1", { kind: "question", ...base, html: { file: name } }, cb).catch((x) => x);
      expect(e).toBeInstanceOf(QueueAddError);
      expect(e.status).toBe(400);
      expect(e.message).toMatch(re);
    }
    expect(await store.list()).toEqual([]);
    expect(noFolders()).toBe(true);
  });
  it("the file has the boundary of an image: not outside the agent folder, not a symlink, not missing", async () => {
    writeFileSync(join(root, "secret.html"), "<p>secret</p>");
    const { d, store } = withCwd();
    symlinkSync(join(root, "secret.html"), join(wt(), "link.html"));
    for (const [file, re] of [["../secret.html", /outside the agent folder/], ["link.html", /outside the agent folder|is a symlink/], ["none.html", /not found/], [join(root, "secret.html"), /outside the agent folder/]] as const) {
      const e = await addItem(d, "a1", { kind: "question", ...base, html: { file } }, cb).catch((x) => x);
      expect(e).toBeInstanceOf(QueueAddError);
      expect(e.message).toMatch(re);
    }
    expect(await store.list()).toEqual([]);
    expect(noFolders()).toBe(true);
  });
  it("a refused page stops the add before any image is copied", async () => {
    write(".choibot/previews/a-1.png", PNG);
    write("s.html", "<script>1</script>");
    const { d } = withCwd();
    await expect(addItem(d, "a1", { kind: "pr", ...base, pr: { branch: "agent/x" }, preview: { images: [".choibot/previews/a-1.png"] }, html: { file: "s.html" } }, cb)).rejects.toThrow(/<script> is not allowed/);
    expect(noFolders()).toBe(true);
  });
  it("a second add for an open PR makes no item and leaves no folder", async () => {
    write("t.html", PAGE);
    const { d } = withCwd();
    const first = await addItem(d, "a1", { kind: "pr", ...base, pr: { url: URL1 }, html: { file: "t.html" } }, cb);
    const again = await addItem(d, "a1", { kind: "pr", ...base, pr: { url: URL1 }, html: { file: "t.html" } }, cb);
    expect(again).toEqual({ id: first.id, created: false });
    expect(readdirSync(join(root, "queue", "media"))).toEqual([first.id]);
  });
});
