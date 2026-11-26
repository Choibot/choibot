// server/files/browse.test.ts — the file browser of the Server page on a MADE-UP folder tree:
// every class of the refusal list is refused, by its own path, through "..", through an encoded
// form and through a link; a refused entry is a locked row with no detail; the routes are for the
// paired user only. No real key, login or settings file is opened here.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AGENT_HEADER, AGENT_TOKEN_HEADER, USER_HEADER } from "../chief/auth.js";
import { CHIEF_ERR, makeGate } from "../chief/gate.js";
import { cleanPath, MAX_ENTRIES, MAX_PATH, NO_PAIRING, registerBrowseApi, type ContentAnswer, type Entry, type ListAnswer } from "./browse.js";
import { looksLikeKey } from "./keylike.js";
import { CLASSES, passwdHomes, WHY, whyRefused, wideFor, type Wide } from "./wide.js";

const USER = "user-token";
const HOOK = "hook-token";
const MADE_UP = "made-up-text-not-a-real-key";

let T: string;
let home: string;
let shop: string;
let wide: Wide;

const put = (rel: string, content: string | Buffer = MADE_UP): string => {
  const p = join(T, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
  return p;
};

beforeAll(() => {
  T = realpathSync(mkdtempSync(join(tmpdir(), "browse-")));
  home = join(T, "home", "you");
  shop = join(home, "workspace", "shop");
  // The work folder: one repo, one agent's own copy of it.
  put("home/you/workspace/shop/README.md", "# shop\n");
  put("home/you/workspace/shop/src/app.ts", "export const price = 12;\n");
  put("home/you/workspace/shop/.env");
  put("home/you/workspace/shop/.env.production");
  put("home/you/workspace/shop/.env.example", "API_KEY=\n");
  put("home/you/workspace/shop/.git/config");
  put("home/you/workspace/shop/deploy-keypair.json");
  put("home/you/workspace/shop/src/WalletButton.tsx", "export {};\n");
  put("home/you/workspace/shop/certs/server.pem");
  put("home/you/workspace/shop/logo.bin", Buffer.from([1, 2, 0, 3]));
  put("home/you/workspace/shop/big.log", Buffer.alloc(1024 * 1024 + 1, "a"));
  put("home/you/workspace/shop/.agent-worktrees/agent-a1/.env", "DEMO=1\n");
  put("home/you/workspace/shop/.agent-worktrees/agent-a1/src/app.ts", "export const price = 13;\n");
  put("home/you/workspace/shop/.agent-worktrees/agent-a1/id_rsa");
  // The stores of the console's user.
  for (const f of [
    ".ssh/id_ed25519", ".gnupg/key.gpg", ".aws/credentials", ".docker/config.json", ".netrc", ".git-credentials", ".npmrc", ".pgpass",
    ".claude/.credentials.json", ".claude.json", ".claude-accounts/a/x", ".codex/auth", ".config/gh/hosts.yml", ".config/solana/id.json",
    ".config/gcloud/x", ".kube/config", ".password-store/x", ".mozilla/x", ".bash_history", ".config/choibot/x", ".config/choibot/x",
  ]) put(`home/you/${f}`);
  put("home/you/notes.txt", "a note\n");
  put("home/you/Downloads/token.json");
  put("home/you/Downloads/vault.kdbx");
  put("home/you/Downloads/my-wallet/seed.txt");
  // Another user, the console's checkout and data, a place the owner keeps private.
  put("home/other/file.txt");
  put("checkout/.env");
  put("checkout/.env.local");
  put("checkout/.env.example", "PORT=\n");
  put("checkout/.agent-data/a1.json");
  put("checkout/.widgets-data/a1/w/key");
  put("checkout/server/index.ts", "export {};\n");
  put("data/choibot/chief/devices.json");
  put("data/choibot/default-login.json");
  put("dtach/choibot-a1.scrollback");
  put("private-place/x.txt");
  // Links: to a key, to a key folder, to a plain file, to nothing.
  symlinkSync(join(home, ".ssh", "id_ed25519"), join(shop, "link-to-key"));
  symlinkSync(join(home, ".ssh"), join(shop, "link-to-keys"));
  symlinkSync(join(shop, "README.md"), join(shop, "link-to-readme"));
  symlinkSync(join(T, "not-there"), join(shop, "link-to-nothing"));
  wide = wideFor({
    env: { HOME: home, XDG_DATA_HOME: join(T, "data"), WIDGETS_DATA_DIR: join(T, "checkout", ".widgets-data"), FILES_REFUSED_EXTRA: `${join(T, "private-place")}:relative/ignored` },
    checkout: join(T, "checkout"), dtachDir: join(T, "dtach"), passwd: `root:x:0:0::/root:/bin/sh\nyou:x:1000:1000::${home}:/bin/sh\nother:x:1001:1001::${join(T, "home", "other")}:/bin/sh\npostgres:x:114:120::/var/lib/postgresql:/bin/sh\nnobody:x:65534:65534::/nonexistent:/bin/false\n`,
  });
});
afterAll(() => { rmSync(T, { recursive: true, force: true }); });

function app(o: { gate?: boolean; du?: Parameters<typeof registerBrowseApi>[1]["du"] } = {}) {
  const a = Fastify();
  const agents = { load: async (id: string) => (["w1", "lead-app", "fleet-master"].includes(id)
    ? { id, hookToken: HOOK, kind: id === "lead-app" ? "lead" : id === "fleet-master" ? "fleet-master" : undefined } as never : null) };
  const gate = makeGate({
    misconfigured: null, userAuth: "log",
    deps: { devices: { verify: async (t: string) => (t === USER ? { label: "laptop", createdAt: 1, lastUsedAt: 1 } : null) }, agents },
  });
  registerBrowseApi(a, { gate: o.gate === false ? undefined : gate, wide, workDir: join(home, "workspace"), du: o.du, now: () => 5000 });
  return a;
}
const asUser = { [USER_HEADER]: USER };
const q = (p: string) => encodeURIComponent(p);
let a: ReturnType<typeof app>;
beforeAll(() => { a = app(); });
afterAll(async () => { await a.close(); });
const list = (p?: string) => a.inject({ method: "GET", url: `/api/server/files/list${p === undefined ? "" : `?path=${q(p)}`}`, headers: asUser });
const content = (p: string) => a.inject({ method: "GET", url: `/api/server/files/content?path=${q(p)}`, headers: asUser });
const row = (items: Entry[], name: string) => items.find((i) => i.name === name);

describe("the refusal list (wide.ts)", () => {
  // One made-up path per class of secrets that the page must never serve.
  const REFUSED: [why: string, path: () => string][] = [
    ["key", () => join(home, ".ssh/id_ed25519")], ["key", () => join(home, ".ssh")], ["key", () => join(home, ".gnupg/key.gpg")],
    ["key", () => join(home, ".aws/credentials")], ["key", () => join(home, ".docker/config.json")], ["key", () => join(home, ".netrc")],
    ["key", () => join(home, ".git-credentials")], ["key", () => join(home, ".npmrc")], ["key", () => join(home, ".pgpass")],
    ["key", () => join(home, ".claude/.credentials.json")], ["key", () => join(home, ".claude.json")], ["key", () => join(home, ".claude-accounts/a/x")],
    ["key", () => join(home, ".codex/auth")], ["key", () => join(home, ".config/gh/hosts.yml")], ["key", () => join(home, ".config/choibot/x")],
    ["key", () => join(home, ".config/choibot/x")], ["key", () => join(home, ".config/solana/id.json")], ["key", () => join(home, ".config/gcloud/x")],
    ["key", () => join(home, ".kube/config")], ["key", () => join(home, ".password-store/x")], ["key", () => join(home, ".mozilla/x")],
    ["key", () => join(home, ".bash_history")], ["key", () => join(home, "Downloads/token.json")], ["key", () => join(home, "Downloads/vault.kdbx")],
    ["key", () => join(home, "Downloads/my-wallet/seed.txt")], ["key", () => join(home, "Downloads/my-wallet")],
    // More names: an .env under another name, password files, the start files of a shell, Git settings.
    ["key", () => join(shop, "prod.env")], ["key", () => join(shop, ".envrc")], ["key", () => join(home, "passwords.json")], ["key", () => join(home, "Passwords.txt")],
    ["key", () => join(home, "old.kdb")], ["key", () => join(home, ".bashrc")], ["key", () => join(home, ".bash_profile")], ["key", () => join(home, ".profile")],
    ["key", () => join(home, ".zshrc")], ["key", () => join(home, ".zshenv")], ["key", () => join(home, ".gitconfig")], ["key", () => join(home, "git-credentials.bak")],
    ["key", () => join(home, "backup/.git-credentials.old")],
    // The unit files of the user's service manager and their drop-ins.
    ["key", () => join(home, ".config/systemd/user/app.service")], ["key", () => join(home, ".config/systemd/user/app.service.d/override.conf")],
    ["key", () => join(home, ".config/systemd/user/default.target.wants/app.service")],
    // In a repo: .env files, Git internals, keypair, wallet and key files.
    ["key", () => join(shop, ".env")], ["key", () => join(shop, ".env.production")], ["key", () => join(shop, ".git/config")], ["key", () => join(shop, ".git")],
    ["key", () => join(shop, "deploy-keypair.json")], ["key", () => join(shop, "src/WalletButton.tsx")], ["key", () => join(shop, "certs/server.pem")],
    ["key", () => join(shop, ".agent-worktrees/agent-a1/id_rsa")],
    // The console's own settings and data.
    ["key", () => join(T, "checkout/.env")], ["key", () => join(T, "checkout/.env.local")], ["key", () => join(T, "checkout/.agent-data/a1.json")],
    ["console", () => join(T, "checkout/.widgets-data/a1/w/key")], ["console", () => join(T, "data/choibot/chief/devices.json")],
    ["console", () => join(T, "data/choibot/default-login.json")], ["console", () => join(T, "dtach/choibot-a1.scrollback")],
    // Other users, the owner's private place.
    ["other-user", () => join(T, "home/other/file.txt")], ["other-user", () => join(T, "home/other")], ["other-user", () => "/root"], ["other-user", () => "/root/.profile"],
    ["other-user", () => "/home/somebody-else/x"], ["private", () => join(T, "private-place/x.txt")],
    // The system.
    ["key", () => "/etc/shadow"], ["key", () => "/etc/shadow-"], ["key", () => "/etc/gshadow"], ["key", () => "/etc/sudoers"], ["key", () => "/etc/sudoers.d/90-x"],
    ["key", () => "/etc/ssh"], ["key", () => "/etc/ssh/ssh_host_ed25519_key"], ["key", () => "/etc/ssl/private/x"], ["key", () => "/etc/wireguard/wg0.conf"],
    ["key", () => "/etc/letsencrypt/live/x/privkey.pem"], ["key", () => "/var/lib/docker/volumes/x"], ["key", () => "/var/lib/postgresql/16/main"],
    ["system", () => "/proc/1234/environ"], ["system", () => "/proc/self/environ"], ["system", () => "/proc/1234/task/1234/environ"], ["system", () => "/proc/1234/cmdline"],
    ["system", () => "/proc"], ["system", () => "/sys/kernel"], ["system", () => "/dev/sda"], ["system", () => "/run/user/1000/keyring"],
  ];

  it.each(REFUSED.map(([why, p]) => [why, p] as const))("refuses (%s) %#", (why, path) => {
    expect([path(), whyRefused(path(), wide)]).toEqual([path(), why]);
  });

  it("serves what is not a secret", () => {
    for (const p of [
      "/", "/etc", "/etc/hostname", "/etc/passwd", "/usr/bin/git", "/var/log/syslog", "/home", "/tmp/x", T, home, join(home, "notes.txt"), join(home, "workspace"), shop,
      join(shop, "README.md"), join(shop, "src/app.ts"), join(shop, ".env.example"), join(T, "checkout/.env.example"), join(T, "checkout/server/index.ts"),
      // An agent's own copy of a repo: its .env is readable, as in the code explorer today.
      join(shop, ".agent-worktrees/agent-a1/.env"), join(shop, ".agent-worktrees/agent-a1/src/app.ts"),
      "/var/lib/other", "/var/lib/postgresql-common",
      // The folders of the user's units are listed (their files are not): the user sees what is there.
      join(home, ".config/systemd/user"), join(home, ".config/systemd/user/app.service.d"), join(home, ".config/systemd/user/default.target.wants"),
      join(shop, "environment.ts"), join(shop, "src/envelope.ts"), join(home, "password-rules.md"),
    ]) expect([p, whyRefused(p, wide)]).toEqual([p, null]);
  });

  it("an .env file is free only in an agent's own copy, and only its .env rule is lifted", () => {
    expect(whyRefused(join(shop, ".agent-worktrees/agent-a1/.env.local"), wide)).toBeNull();
    expect(whyRefused(join(shop, ".agent-worktrees/agent-a1/.env.keypair"), wide)).toBe("key");
    expect(whyRefused(join(shop, ".agent-worktrees/agent-a1/.ssh/.env"), wide)).toBe("key");
    expect(whyRefused(join(shop, "sub/.env"), wide)).toBe("key");
    const one = wideFor({ env: { HOME: home, AGENT_WORKTREE_ROOT: join(T, "copies") }, checkout: join(T, "checkout"), passwd: "" });
    expect(whyRefused(join(T, "copies/agent-a1/.env"), one)).toBeNull();
    expect(whyRefused(join(T, "copies/.env"), one)).toBeNull();
    expect(whyRefused(join(T, "elsewhere/.env"), one)).toBe("key");
  });

  it("reads the homes of people from the passwd file, not the homes of services", () => {
    expect(passwdHomes("root:x:0:0::/root:/bin/sh\nbin:x:2:2::/bin:/sbin/nologin\nann:x:1000:1000::/home/ann:/bin/sh\nsvc:x:1500:1500::/srv/svc:/bin/sh\nnobody:x:65534:65534::/:/bin/false\nbroken\n"))
      .toEqual(["/root", "/home/ann", "/srv/svc"]);
    // The console's own user is no "other user", also when it is root.
    const root = wideFor({ env: { HOME: "/root" }, checkout: join(T, "checkout"), passwd: "root:x:0:0::/root:/bin/sh\n" });
    expect(root.otherHomes).toEqual([]);
  });

  it("each class has its reason and its line for the table", () => {
    expect(CLASSES.map((c) => c.id)).toEqual(["console-data", "code-explorer-list", "other-user", "install-agent-list", "more-home-stores", "more-names", "user-units", "system-stores", "live-system", "owner-extra"]);
    for (const c of CLASSES) expect(WHY[c.why].startsWith("Not shown: ")).toBe(true);
    expect(WHY.key).toBe("Not shown: it holds a key or a login");
  });
});

describe("a path from the browser", () => {
  it("must be an absolute path of a sane length with no NUL", () => {
    expect(cleanPath("/a/b/../c")).toBe("/a/c");
    expect(cleanPath("/a//b/./")).toBe("/a/b");
    for (const bad of ["", "relative/x", "../x", "~/x", "/a\0b", `/${"a".repeat(MAX_PATH)}`, 7, null, undefined, ["/a"]]) expect(cleanPath(bad)).toBeNull();
  });

  it("is refused through \"..\", through an encoded form and through a long or odd path", async () => {
    const key = join(home, ".ssh/id_ed25519");
    // ".." in the path.
    expect((await content(join(shop, "../../.ssh/id_ed25519"))).statusCode).toBe(403);
    expect((await content(`${shop}/src/../../../.ssh/id_ed25519`)).json()).toMatchObject({ error: "refused", why: "key" });
    expect((await list(join(shop, "..", "..", ".ssh"))).statusCode).toBe(403);
    // Encoded one time: the server decodes it to "..". The refusal still holds.
    const enc = `${shop}/%2e%2e/%2e%2e/.ssh/id_ed25519`.replaceAll("/", "%2F");
    expect((await a.inject({ method: "GET", url: `/api/server/files/content?path=${enc}`, headers: asUser })).statusCode).toBe(403);
    expect((await a.inject({ method: "GET", url: `/api/server/files/content?path=${key.replaceAll("/", "%2f").replaceAll(".", "%2e")}`, headers: asUser })).statusCode).toBe(403);
    // Encoded two times: "%2e%2e" is then a plain name that is not there.
    expect((await content(`${shop}/%2e%2e/%2e%2e/.ssh/id_ed25519`)).statusCode).toBe(404);
    // No path, a relative path, a NUL, a very long path, a path given two times.
    expect((await a.inject({ method: "GET", url: "/api/server/files/content", headers: asUser })).statusCode).toBe(400);
    expect((await content("workspace/shop/README.md")).statusCode).toBe(400);
    expect((await a.inject({ method: "GET", url: `/api/server/files/content?path=${q(key)}%00.txt`, headers: asUser })).statusCode).toBe(400);
    expect((await content(`/${"a/".repeat(3000)}`)).statusCode).toBe(400);
    expect((await a.inject({ method: "GET", url: `/api/server/files/content?path=${q(join(shop, "README.md"))}&path=${q(key)}`, headers: asUser })).statusCode).toBe(400);
    expect((await content(join(T, "not-there"))).statusCode).toBe(404);
  });

  it("is refused through a link to a secret, and a link to a plain file is served", async () => {
    expect((await content(join(shop, "link-to-key"))).json()).toMatchObject({ error: "refused", why: "key" });
    expect((await list(join(shop, "link-to-keys"))).statusCode).toBe(403);
    expect((await content(join(shop, "link-to-keys", "id_ed25519"))).statusCode).toBe(403);
    const ok = (await content(join(shop, "link-to-readme"))).json() as ContentAnswer;
    expect(ok).toMatchObject({ kind: "text", content: "# shop\n", path: join(shop, "README.md") });
    expect((await content(join(shop, "link-to-nothing"))).statusCode).toBe(404);
  });
});

describe("the folder list", () => {
  it("starts at the home folder and shows a refused entry as a locked row with no detail", async () => {
    const res = await list();
    expect(res.statusCode).toBe(200);
    const body = res.json() as ListAnswer;
    expect(body).toMatchObject({ path: home, parent: join(T, "home"), home, truncated: false, sizes: { state: "none" } });
    expect(body.why.key).toBe("Not shown: it holds a key or a login");
    expect(row(body.items, "notes.txt")).toMatchObject({ kind: "file", size: 7 });
    expect(row(body.items, "notes.txt")!.mtime).toBeGreaterThan(0);
    expect(row(body.items, "workspace")).toMatchObject({ kind: "dir" });
    for (const name of [".ssh", ".aws", ".claude", ".claude.json", ".npmrc", ".bash_history", ".netrc", ".config"]) {
      const r = row(body.items, name)!;
      if (name === ".config") { expect(r.locked).toBeUndefined(); continue; } // only some folders in it are refused
      expect([name, Object.keys(r).sort()]).toEqual([name, ["kind", "locked", "name"]]);
      expect(r.locked).toBe("key");
    }
    // The whole answer holds no text of a refused file.
    expect(res.body).not.toContain(MADE_UP);
  });

  it("locks a link to a secret, another user's home and a secret in a repo; goes up to \"/\"", async () => {
    const repo = (await list(shop)).json() as ListAnswer;
    expect(row(repo.items, "link-to-key")).toEqual({ name: "link-to-key", kind: "file", link: true, locked: "key" });
    expect(row(repo.items, "link-to-keys")).toEqual({ name: "link-to-keys", kind: "dir", link: true, locked: "key" });
    expect(row(repo.items, "link-to-readme")).toMatchObject({ kind: "file", link: true, size: 7 });
    expect(row(repo.items, "link-to-nothing")).toEqual({ name: "link-to-nothing", kind: "link", link: true });
    for (const name of [".env", ".env.production", ".git", "deploy-keypair.json"]) expect(row(repo.items, name)).toMatchObject({ locked: "key" });
    expect(row(repo.items, ".env.example")!.locked).toBeUndefined();
    const homes = (await list(join(T, "home"))).json() as ListAnswer;
    expect(homes.items).toEqual([{ name: "other", kind: "dir", locked: "other-user" }, expect.objectContaining({ name: "you", kind: "dir" })]);
    expect((await list(join(T, "home", "other"))).json()).toMatchObject({ error: "refused", why: "other-user", text: "Not shown: the home folder of another user" });
    const top = (await list("/")).json() as ListAnswer;
    expect(top).toMatchObject({ path: "/", parent: null });
    for (const name of ["proc", "sys", "dev", "run"]) expect(row(top.items, name)).toEqual({ name, kind: "dir", locked: "system" });
    expect(row(top.items, "root")).toMatchObject({ locked: "other-user" });
    expect(row(top.items, "etc")!.locked).toBeUndefined();
  });

  it("shows a limited number of entries of a very big folder, and says so", async () => {
    const big = join(T, "many");
    mkdirSync(big);
    for (let i = 0; i < MAX_ENTRIES + 5; i += 1) writeFileSync(join(big, `f${String(i).padStart(5, "0")}`), "");
    const body = (await list(big)).json() as ListAnswer;
    expect([body.items.length, body.truncated, body.total]).toEqual([MAX_ENTRIES, true, MAX_ENTRIES + 5]);
    expect((await list(join(shop, "README.md"))).statusCode).toBe(400); // not a folder
  });
});

describe("a file", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("shows a text file, and only the facts of a binary, a big and a refused file", async () => {
    const text = (await content(join(shop, "src/app.ts"))).json() as ContentAnswer;
    expect(text).toMatchObject({ kind: "text", content: "export const price = 12;\n", size: 25, explorer: shop });
    const copy = (await content(join(shop, ".agent-worktrees/agent-a1/src/app.ts"))).json() as ContentAnswer;
    expect(copy.explorer).toBe(join(shop, ".agent-worktrees/agent-a1"));
    expect(((await content(join(home, "notes.txt"))).json() as ContentAnswer).explorer).toBeUndefined();
    const bin = (await content(join(shop, "logo.bin"))).json() as ContentAnswer;
    expect(bin).toMatchObject({ kind: "binary", size: 4 });
    expect(bin.content).toBeUndefined();
    const big = (await content(join(shop, "big.log"))).json() as ContentAnswer;
    expect(big).toMatchObject({ kind: "large", size: 1024 * 1024 + 1 });
    expect(big.content).toBeUndefined();
    expect((await content(shop)).statusCode).toBe(400); // a folder
    // An agent's own .env is readable (as in the code explorer); the repo's own is not.
    expect(((await content(join(shop, ".agent-worktrees/agent-a1/.env"))).json() as ContentAnswer).content).toBe("DEMO=1\n");
    for (const p of [join(shop, ".env"), join(shop, "deploy-keypair.json"), join(home, ".ssh/id_ed25519"), join(T, "checkout/.env"), join(T, "data/choibot/chief/devices.json"), join(T, "private-place/x.txt")]) {
      const res = await content(p);
      expect([p, res.statusCode]).toEqual([p, 403]);
      expect(res.body).not.toContain(MADE_UP);
    }
  });

  it("puts no file content and no path in a log", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    await content(join(shop, "src/app.ts"));
    await content(join(home, ".ssh/id_ed25519"));
    await list(shop);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
});

describe("who", () => {
  const ROUTES: ["GET" | "POST", string, unknown?][] = [
    ["GET", "/api/server/files/list"], ["GET", "/api/server/files/content?path=%2Fetc%2Fhostname"], ["POST", "/api/server/files/sizes", { path: "/tmp" }],
  ];

  it("refuses a browser that is not paired, an agent, a lead and the fleet master", async () => {
    for (const [method, url, payload] of ROUTES) {
      for (const headers of [{}, { [USER_HEADER]: "wrong" }, ...["w1", "lead-app", "fleet-master"].map((id) => ({ [AGENT_HEADER]: id, [AGENT_TOKEN_HEADER]: HOOK }))]) {
        const res = await a.inject({ method, url, headers, ...(payload ? { payload: payload as object } : {}) });
        expect([method, url, res.statusCode, res.json().error]).toEqual([method, url, 403, CHIEF_ERR.pairRequired]);
      }
    }
  });

  it("a console with no device pairing serves no file to any caller", async () => {
    const open = app({ gate: false });
    for (const [method, url, payload] of ROUTES) {
      for (const headers of [{}, asUser, { [AGENT_HEADER]: "w1", [AGENT_TOKEN_HEADER]: HOOK }]) {
        const res = await open.inject({ method, url, headers, ...(payload ? { payload: payload as object } : {}) });
        expect([url, res.statusCode, res.json()]).toEqual([url, 403, NO_PAIRING]);
      }
    }
    await open.close();
  });
});

describe("the sizes of the folders of a folder", () => {
  it("are measured in the background, one folder at a time, with no size for a refused folder", async () => {
    let release: () => void = () => {};
    const asked: string[] = [];
    const b = app({
      du: async (t) => {
        asked.push(`${t.path} d${t.depth}`);
        await new Promise<void>((r) => { release = r; });
        return new Map([[t.path, 900], [join(t.path, "workspace"), 500], [join(t.path, ".ssh"), 40], [join(t.path, "Downloads"), 30], [join(t.path, "workspace", "shop"), 400]]);
      },
    });
    const post = (p: string) => b.inject({ method: "POST", url: "/api/server/files/sizes", headers: asUser, payload: { path: p } });
    const get = async () => (await b.inject({ method: "GET", url: `/api/server/files/list?path=${q(home)}`, headers: asUser })).json() as ListAnswer;
    expect((await post(join(home, ".ssh"))).statusCode).toBe(403); // a refused folder is not measured
    expect((await post(join(home, "notes.txt"))).statusCode).toBe(400);
    expect((await post(home)).statusCode).toBe(202);
    expect((await get()).sizes).toEqual({ state: "measuring" });
    expect((await post(join(home, "workspace"))).statusCode).toBe(409); // one at a time
    release();
    await new Promise((r) => setTimeout(r, 10));
    const done = await get();
    expect(done.sizes).toEqual({ state: "done", checkedAt: 5000 });
    expect(row(done.items, "workspace")!.bytes).toBe(500);
    expect(row(done.items, "Downloads")!.bytes).toBe(30);
    expect(row(done.items, ".ssh")).toEqual({ name: ".ssh", kind: "dir", locked: "key" });
    expect(asked).toEqual([`${home} d1`]);
    await b.close();
  });
});

// Made-up values in the form of a key. None of them is a real key.
describe("a file whose content looks like a key", () => {
  const BLOCK = ["-----BEGIN OPENSSH PRIVATE KEY-----", "bWFkZS11cC1ub3QtYS1rZXk=", "-----END OPENSSH PRIVATE KEY-----", ""].join("\n");
  const KEYPAIR = JSON.stringify(Array.from({ length: 64 }, (_, i) => (i * 7) % 256));
  const WORDS = "apple river stone cloud green table window orange paper silver mountain garden";
  const GH = `ghp_${"A1b2C3d4E5".repeat(3)}`;
  const HEX64 = "0123456789abcdef".repeat(4);
  const B58 = "5Kd3NBUAdUnhyzenEwVLy9pBKxSwXvE9FMPyR4UKZvpe6E3AgLr".repeat(2).slice(0, 88);

  it("says yes for a key block, a keypair, a seed phrase and a named token; no for plain files", () => {
    for (const yes of [
      BLOCK, `notes\n${BLOCK}`, "-----BEGIN PRIVATE KEY-----\nx", "-----BEGIN PGP PRIVATE KEY BLOCK-----\nx", "-----BEGIN RSA PRIVATE KEY-----\nx",
      KEYPAIR, ` ${KEYPAIR.replaceAll(",", ", ")}\n`, WORDS, `${WORDS} ${WORDS}\n`, WORDS.split(" ").map((w, i) => `${i + 1}. ${w}`).join("\n"),
      `GITHUB_TOKEN=${GH}`, `  "apiKey": "sk-${"a1B2".repeat(8)}",`, `Authorization: Bearer ${GH}`, `export TS_AUTHKEY=tskey-auth-${"k1".repeat(8)}`, `bot_token: 123456789:${"Aa1_".repeat(9)}`,
      // One text and nothing else: a key as hex, a Solana secret key as base58.
      HEX64, `0x${HEX64}\n`, HEX64 + HEX64, B58,
      // The name of a secret and one long value, of no known kind.
      `PRIVATE_KEY=${B58}`, `secret_key: "${HEX64}"`, `  "mnemonic": "${"QWxhZGRpbjpvcGVuIHNlc2FtZQ".repeat(2)}",`, `export WALLET_PRIVATE_KEY='${HEX64}'`,
      `apiKey = ${B58.slice(0, 40)}`, `seed=${HEX64}`, `PASSPHRASE: ${B58.slice(0, 44)}==`,
    ]) expect([yes.slice(0, 24), looksLikeKey(yes)]).toEqual([yes.slice(0, 24), true]);
    for (const no of [
      "", "# shop\n", "export const price = 12;\n", JSON.stringify(Array.from({ length: 63 }, () => 1)), JSON.stringify(Array.from({ length: 64 }, () => 256)),
      JSON.stringify(Array.from({ length: 65 }, () => 1)), JSON.stringify({ data: Array.from({ length: 64 }, () => 1) }),
      "one two three four five six seven eight nine ten eleven", `${WORDS} More`, `${WORDS} and then a long sentence follows here`,
      "-----BEGIN CERTIFICATE-----\nx", "-----BEGIN PUBLIC KEY-----\nx", `see the commit ${GH.toLowerCase()} for it`, `the run id is ${GH}`, "token: expired", "API_KEY=\n",
      // A lock file, a list of hashes and a public key must still show.
      `  resolution: {integrity: sha512-${"Ab3+/".repeat(17)}==}`, `"integrity": "sha512-${"Ab3+/".repeat(17)}=="`, `checksum = "${HEX64}"`,
      `${HEX64}  shop-1.0.tar.gz\n${HEX64}  shop-1.1.tar.gz\n`, `sha256:${HEX64}`, `commit ${HEX64.slice(0, 40)}`,
      `public_key: ${B58.slice(0, 44)}`, `PUBLIC_KEY=${HEX64}`, `"pubkey": "${B58.slice(0, 44)}"`, `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${"x1Y2".repeat(10)} you@server`,
      `key_id = ${HEX64}`, `secret: short-value`, `private_key: `, `the seed of the plant grows`, `${HEX64} ${HEX64}`, HEX64.slice(0, 63), `${B58}${B58}`,
    ]) expect([no.slice(0, 24), looksLikeKey(no)]).toEqual([no.slice(0, 24), false]);
  });

  it("is refused by the content route under any name, with no part of it in the answer", async () => {
    const files: [string, string][] = [["payer.json", KEYPAIR], ["authority.json", KEYPAIR], ["notes.txt", `my server\n${BLOCK}`], ["words.txt", WORDS], ["deploy.sh", `export GITHUB_TOKEN=${GH}\n`]];
    for (const [name, text] of files) {
      const p = put(`home/you/plain/${name}`, text);
      expect(whyRefused(p, wide)).toBeNull(); // the name says nothing
      const res = await content(p);
      expect([name, res.statusCode, res.json()]).toEqual([name, 403, { error: "refused", why: "content", text: "Not shown: this file looks like it holds a key" }]);
    }
    // The list shows such a file as a plain row: the server does not read a file for a list.
    const rows = ((await list(join(home, "plain"))).json() as ListAnswer).items;
    expect(rows.map((r) => [r.name, r.locked])).toEqual(files.map(([n]) => [n, undefined]).sort());
    expect(((await content(put("home/you/plain/list.json", JSON.stringify([1, 2, 3])))).json() as ContentAnswer).kind).toBe("text");
  });
});

describe("the private places of the user", () => {
  const envText = () => readFileSync(join(T, "settings.env"), "utf8");
  const own = () => {
    writeFileSync(join(T, "settings.env"), "# the settings\nPORT=3100\n");
    const w = wideFor({ env: { HOME: home, XDG_DATA_HOME: join(T, "data") }, checkout: join(T, "checkout"), passwd: "" });
    const b = Fastify();
    const gate = makeGate({ misconfigured: null, userAuth: "log", deps: { devices: { verify: async (t: string) => (t === USER ? { label: "laptop", createdAt: 1, lastUsedAt: 1 } : null) }, agents: { load: async () => null } } });
    registerBrowseApi(b, { gate, wide: w, workDir: join(home, "workspace"), envFile: join(T, "settings.env") });
    const set = (places: unknown, headers: Record<string, string> = asUser) => b.inject({ method: "POST", url: "/api/server/files/private", headers, payload: { places } as object });
    const read = (p: string) => b.inject({ method: "GET", url: `/api/server/files/content?path=${q(p)}`, headers: asUser });
    return { b, set, read, w };
  };

  it("are refused at once, are kept in the settings file, and can be shown again", async () => {
    const { b, set, read } = own();
    const note = join(home, "notes.txt");
    expect((await read(note)).statusCode).toBe(200);
    expect((await b.inject({ method: "GET", url: "/api/server/files/private", headers: asUser })).json()).toEqual({ places: [], canChange: true });
    const res = await set([home + "/Downloads/../notes.txt", join(T, "many"), note]);
    expect(res.json()).toEqual({ places: [note, join(T, "many")], canChange: true });
    expect((await read(note)).json()).toMatchObject({ error: "refused", why: "private" });
    expect((await b.inject({ method: "GET", url: `/api/server/files/list?path=${q(join(T, "many"))}`, headers: asUser })).statusCode).toBe(403);
    const rows = ((await b.inject({ method: "GET", url: `/api/server/files/list?path=${q(home)}`, headers: asUser })).json() as ListAnswer).items;
    expect(row(rows, "notes.txt")).toEqual({ name: "notes.txt", kind: "file", locked: "private" });
    expect(envText()).toBe(`# the settings\nPORT=3100\nFILES_REFUSED_EXTRA=${note}:${join(T, "many")}\n`);
    // A new server reads the same list from its settings.
    const again = wideFor({ env: { HOME: home, FILES_REFUSED_EXTRA: `${note}:${join(T, "many")}` }, checkout: join(T, "checkout"), passwd: "" });
    expect(whyRefused(note, again)).toBe("private");
    expect((await set([])).json()).toEqual({ places: [], canChange: true });
    expect((await read(note)).statusCode).toBe(200);
    expect(envText()).toBe("# the settings\nPORT=3100\n");
    await b.close();
  });

  it("a link as a private place hides the place behind it too", async () => {
    const { b, set, read } = own();
    symlinkSync(join(home, "Downloads"), join(T, "dl-link"));
    await set([join(T, "dl-link")]);
    expect((await read(join(home, "Downloads", "token.json"))).statusCode).toBe(403);
    expect((await b.inject({ method: "GET", url: `/api/server/files/list?path=${q(join(home, "Downloads"))}`, headers: asUser })).json()).toMatchObject({ why: "private" });
    await b.close();
  });

  it("refuse a list that is not a list of plain full paths, and change nothing then", async () => {
    const { b, set } = own();
    for (const bad of [["/"], ["relative"], ["/a b"], ["/a:b"], ["/a\nB=1"], ["/a$HOME"], ["/a#x"], "/a", Array.from({ length: 51 }, (_, i) => `/p${i}`), [7]]) {
      const res = await set(bad);
      expect([JSON.stringify(bad).slice(0, 30), res.statusCode]).toEqual([JSON.stringify(bad).slice(0, 30), 400]);
    }
    expect(envText()).toBe("# the settings\nPORT=3100\n");
    await b.close();
  });

  it("are for the paired user only, and need a settings file", async () => {
    const { b, set } = own();
    for (const headers of [{}, { [AGENT_HEADER]: "w1", [AGENT_TOKEN_HEADER]: HOOK }] as Record<string, string>[]) {
      expect((await set(["/srv/x"], headers)).statusCode).toBe(403);
      expect((await b.inject({ method: "GET", url: "/api/server/files/private", headers })).statusCode).toBe(403);
    }
    await b.close();
    const open = app({ gate: false });
    expect((await open.inject({ method: "POST", url: "/api/server/files/private", headers: asUser, payload: { places: [] } })).json()).toEqual(NO_PAIRING);
    await open.close();
    expect((await a.inject({ method: "POST", url: "/api/server/files/private", headers: asUser, payload: { places: ["/srv/x"] } })).statusCode).toBe(409); // no settings file given
  });
});
