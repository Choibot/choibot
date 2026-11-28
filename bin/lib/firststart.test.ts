// bin/lib/firststart.test.ts — `first-start <file>` (as the console's user) and the root step
// deploy/choibot-first-boot (with fake system commands in a throwaway root folder).
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeviceStore } from "../../server/chief/auth.js";
import { NEW_NAMES, OLD_NAMES } from "../../server/names.mjs";
import { parseEnv } from "./env.js";
import { CONSOLE_URL_RE, makeProxyTls, runFirstStart } from "./firststart.js";

let dir: string;
let chief: string;
const NOW = 1_795_000_000_000;
const HASH = createHash("sha256").update("A".repeat(43)).digest("hex");
const OLD_SECRET = "s".repeat(43);
const fileText = (o: Record<string, unknown> = {}) => JSON.stringify({ v: 1, server: "srv42", claim: { sha256: HASH, expiresAt: NOW + 3_600_000 }, url: "https://mira.choibot.example", ...o });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "firststart-"));
  chief = join(dir, "data", "chief");
  writeFileSync(join(dir, ".env"), [
    "PORT=3100", `CONSOLE_COOKIE_SECRET=${OLD_SECRET}`, "CHIEF_ENABLED=1", "CHIEF_USER_AUTH=log",
    "CHIEF_CONSOLE_URL=http://127.0.0.1:3100", `CHIEF_DATA_DIR=${chief}`, "",
  ].join("\n"), { mode: 0o600 });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function run(o: { text?: string; env?: Record<string, string>; legacy?: boolean; makeTls?: (dir: string) => { ok: true } | { ok: false; why: string } } = {}) {
  writeFileSync(join(dir, "fs.json"), o.text ?? fileText());
  const out: string[] = [];
  const err: string[] = [];
  const code = await runFirstStart({
    repoDir: dir, file: join(dir, "fs.json"), env: o.env ?? {}, names: o.legacy ? OLD_NAMES : NEW_NAMES, now: () => NOW,
    out: (s) => out.push(s), err: (s) => err.push(s), ...(o.makeTls ? { makeTls: o.makeTls } : {}),
  });
  return { code, out: out.join("\n"), err: err.join("\n"), env: Object.fromEntries(parseEnv(readFileSync(join(dir, ".env"), "utf8"))) };
}

describe("first-start (as the console's user)", () => {
  it("a new cookie secret, the address, the claim link in the data folder; the codes of the image build go; nothing of the hash is printed", async () => {
    mkdirSync(chief, { recursive: true });
    for (const f of ["pair-code.json", "add-device-code.json", "claim-link.json"]) writeFileSync(join(chief, f), "{}");
    const r = await run();
    expect(r.code).toBe(0);
    expect(r.env.CONSOLE_COOKIE_SECRET).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.env.CONSOLE_COOKIE_SECRET).not.toBe(OLD_SECRET);
    expect(r.env).toMatchObject({ PORT: "3100", CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_CONSOLE_URL: "https://mira.choibot.example", CHIEF_DATA_DIR: chief });
    expect(statSync(join(dir, ".env")).mode & 0o777).toBe(0o600);
    expect(readdirSync(chief).sort()).toEqual(["first-start.json"]);
    expect(readFileSync(join(chief, "first-start.json"), "utf8")).toBe(fileText());
    expect(statSync(join(chief, "first-start.json")).mode & 0o777).toBe(0o600);
    expect(r.out).toContain(`The claim link works until ${new Date(NOW + 3_600_000).toISOString()}.`);
    expect(r.out).toContain("The address of ChoiBot: https://mira.choibot.example");
    expect(`${r.out}${r.err}`).not.toContain(HASH);
  });

  it("with no url: the address stays as it is", async () => {
    const r = await run({ text: fileText({ url: undefined }) });
    expect(r.code).toBe(0);
    expect(r.env.CHIEF_CONSOLE_URL).toBe("http://127.0.0.1:3100");
  });

  it("refuses: an agent's shell, the old names, a console that pairs through Telegram, a paired device; nothing changes", async () => {
    const before = readFileSync(join(dir, ".env"), "utf8");
    expect((await run({ env: { CHOIBOT_AGENT_ID: "a1" } })).err).toMatch(/not in an agent's shell/);
    expect((await run({ env: { CLAUDECODE: "1" } })).code).toBe(1);
    writeFileSync(join(dir, ".env"), before.replace("CHIEF_USER_AUTH=log", "CHIEF_USER_AUTH=telegram"));
    expect((await run()).code).toBe(1);
    writeFileSync(join(dir, ".env"), before);
    await new DeviceStore(join(chief, "user-devices.json")).add("laptop");
    const r = await run();
    expect([r.code, r.err]).toEqual([1, expect.stringMatching(/has a paired device: this is not its first start/)]);
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(before);
    expect(existsSync(join(chief, "first-start.json"))).toBe(false);
  });

  it("refuses a console where a device was paired once (all devices revoked since): the claim state stays, nothing changes", async () => {
    const before = readFileSync(join(dir, ".env"), "utf8");
    mkdirSync(chief, { recursive: true });
    const used = JSON.stringify({ ended: "used", hosted: true });
    writeFileSync(join(chief, "claim-link.json"), used, { mode: 0o600 });
    writeFileSync(join(chief, "user-devices.json"), "[]");
    const r = await run();
    expect([r.code, r.err]).toEqual([1, "✖ A device was paired on this ChoiBot once: this is not its first start. Nothing is changed."]);
    expect(readFileSync(join(chief, "claim-link.json"), "utf8")).toBe(used);
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(before);
    expect(existsSync(join(chief, "first-start.json"))).toBe(false);
    // An ended link that was never used (too old, too many tries) is no pairing: the first start goes on.
    writeFileSync(join(chief, "claim-link.json"), JSON.stringify({ ended: "expired", hosted: true }));
    expect((await run()).code).toBe(0);
    expect(existsSync(join(chief, "claim-link.json"))).toBe(false);
  });

  it("refuses a file that the console would refuse, and a url of another shape, naming the field only", async () => {
    const before = readFileSync(join(dir, ".env"), "utf8");
    for (const [text, why] of [
      [fileText({ v: 2 }), "v is not 1"], [fileText({ claim: { sha256: "x" } }), "claim.sha256"], ["{", "not JSON"],
      [fileText({ url: "http://mira.choibot.example" }), "url"], [fileText({ url: "https://mira.choibot.example/x" }), "url"],
      [fileText({ url: "https://mira.choibot.example\nCONSOLE_COOKIE_SECRET=x" }), "url"], [fileText({ url: 5 }), "url"],
    ] as const) {
      const r = await run({ text });
      expect([why, r.code, r.err]).toEqual([why, 1, `✖ The first-start file is refused (${why}).`]);
    }
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(before);
  });

  it("the address: https, a host name with a dot, an optional port, no path", () => {
    for (const u of ["https://mira.choibot.example", "https://a-1.b.example:8443"]) expect([u, CONSOLE_URL_RE.test(u)]).toEqual([u, true]);
    for (const u of ["https://localhost", "https://Mira.example", "https://mira.example/", "https://-a.example", "https://a.example:", "ftp://a.example"]) expect([u, CONSOLE_URL_RE.test(u)]).toEqual([u, false]);
  });
});

// ---------------------------------------------------------- the root step, with fakes

const SCRIPT = join(__dirname, "../../deploy/choibot-first-boot");

describe("first-start with a front proxy (server/frontproxy.ts)", () => {
  const TOKEN_SHA = createHash("sha256").update("door-token").digest("hex");
  const proxy = { from: "10.0.0.2", network: "10.0.0.0/16", port: 3443, tokenSha256: TOKEN_SHA };
  const haveOpenssl = spawnSync("openssl", ["version"]).status === 0;

  it.skipIf(!haveOpenssl)("writes the proxy's settings and a new TLS key (0600 in a 0700 folder) before the console starts; prints the certificate's fingerprint", async () => {
    const r = await run({ text: fileText({ proxy }) });
    expect([r.code, r.err]).toEqual([0, ""]);
    const tls = join(chief, "proxy-tls");
    expect(r.env).toMatchObject({
      CONSOLE_PROXY_FROM: "10.0.0.2", CONSOLE_PROXY_NETWORK: "10.0.0.0/16", CONSOLE_PROXY_PORT: "3443",
      CONSOLE_PROXY_TOKEN_SHA256: TOKEN_SHA, CONSOLE_PROXY_TLS_DIR: tls,
    });
    expect(statSync(tls).mode & 0o777).toBe(0o700);
    for (const f of ["key.pem", "cert.pem"]) expect(statSync(join(tls, f)).mode & 0o777, f).toBe(0o600);
    expect(r.out).toMatch(/The front proxy: from 10\.0\.0\.2, port 3443\. The private listener's certificate: sha256 ([0-9A-F]{2}:){31}[0-9A-F]{2}/);
    expect(`${r.out}${r.err}`).not.toContain(TOKEN_SHA);
    expect(readFileSync(join(tls, "key.pem"), "utf8")).toMatch(/BEGIN PRIVATE KEY/);
  });

  it.skipIf(!haveOpenssl)("a key that cannot be made keeps the key of before (a second run)", () => {
    const tls = join(dir, "tls");
    expect(makeProxyTls(tls)).toEqual({ ok: true });
    const key = readFileSync(join(tls, "key.pem"), "utf8");
    expect(makeProxyTls(tls, "false")).toEqual({ ok: false, why: "openssl failed" });
    expect(readFileSync(join(tls, "key.pem"), "utf8")).toBe(key);
    expect(readdirSync(dir).filter((f) => f.startsWith(".proxy-tls-new-") || f.includes(".old-"))).toEqual([]);
    expect(makeProxyTls(tls)).toEqual({ ok: true });
    expect(readFileSync(join(tls, "key.pem"), "utf8")).not.toBe(key);
    expect(statSync(tls).mode & 0o777).toBe(0o700);
  });

  it.skipIf(!haveOpenssl)("a data folder given as a relative path: the TLS folder is absolute, in the install's folder", async () => {
    writeFileSync(join(dir, ".env"), readFileSync(join(dir, ".env"), "utf8").replace(`CHIEF_DATA_DIR=${chief}`, "CHIEF_DATA_DIR=data/chief"), { mode: 0o600 });
    const r = await run({ text: fileText({ proxy }) });
    expect(r.code).toBe(0);
    expect(r.env.CONSOLE_PROXY_TLS_DIR).toBe(join(dir, "data", "chief", "proxy-tls"));
    expect(existsSync(join(dir, "data", "chief", "proxy-tls", "cert.pem"))).toBe(true);
    // The claim link goes to the same folder, never to the folder that the command ran in.
    expect(existsSync(join(dir, "data", "chief", "first-start.json"))).toBe(true);
    expect(existsSync(join(process.cwd(), "data"))).toBe(false);
  });

  it.skipIf(!haveOpenssl)("makes a new key each time: no two servers of one image share it", () => {
    const a = join(dir, "a"), b = join(dir, "b");
    expect(makeProxyTls(a)).toEqual({ ok: true });
    expect(makeProxyTls(b)).toEqual({ ok: true });
    expect(readFileSync(join(a, "key.pem"), "utf8")).not.toBe(readFileSync(join(b, "key.pem"), "utf8"));
  });

  it("refuses a proxy value that the console would refuse, naming the field only; nothing changes", async () => {
    const before = readFileSync(join(dir, ".env"), "utf8");
    for (const [bad, field] of [
      [{ ...proxy, from: "10.1.0.2" }, "proxy.from"], [{ ...proxy, network: "8.8.0.0/16" }, "proxy.network"], [{ ...proxy, port: 80 }, "proxy.port"],
      [{ ...proxy, tokenSha256: "x" }, "proxy.tokenSha256"], ["10.0.0.2", "proxy"], [null, "proxy"],
    ] as const) {
      const r = await run({ text: fileText({ proxy: bad }), makeTls: () => { throw new Error("must not be called"); } });
      expect([r.code, r.err], JSON.stringify(bad)).toEqual([1, `✖ The first-start file is refused (${field}).`]);
    }
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(before);
    expect(existsSync(join(chief, "first-start.json"))).toBe(false);
  });

  it("when the TLS key cannot be made: nothing changes", async () => {
    const before = readFileSync(join(dir, ".env"), "utf8");
    const r = await run({ text: fileText({ proxy }), makeTls: () => ({ ok: false, why: "openssl failed" }) });
    expect([r.code, r.err]).toEqual([1, "✖ The key of the private listener could not be made (openssl failed). Nothing is changed."]);
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(before);
    expect(existsSync(join(chief, "first-start.json"))).toBe(false);
  });

  it("with no proxy key: no proxy setting stays (not one from the image build either), and no key is made", async () => {
    writeFileSync(join(dir, ".env"), `${readFileSync(join(dir, ".env"), "utf8")}CONSOLE_PROXY_FROM=10.0.0.2\nCONSOLE_PROXY_TOKEN_SHA256=${TOKEN_SHA}\n`, { mode: 0o600 });
    const r = await run({ makeTls: () => { throw new Error("must not be called"); } });
    expect(r.code).toBe(0);
    expect(Object.keys(r.env).filter((k) => k.startsWith("CONSOLE_PROXY_"))).toEqual([]);
    expect(existsSync(join(chief, "proxy-tls"))).toBe(false);
  });
});

describe("deploy/choibot-first-boot (root, with fake system commands)", () => {
  let root: string;
  let bin: string;
  const fake = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  const log = () => (existsSync(join(root, "log")) ? readFileSync(join(root, "log"), "utf8") : "");
  const runStep = () => spawnSync("sh", [SCRIPT], { encoding: "utf8", env: { CHOIBOT_FIRST_BOOT_ROOT: root, CHOIBOT_FIRST_BOOT_PATH: `${bin}:/usr/bin:/bin` } as unknown as NodeJS.ProcessEnv });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "firstboot-"));
    bin = join(root, "fakebin");
    for (const d of ["etc/choibot", "run", "fakebin"]) mkdirSync(join(root, d), { recursive: true });
    writeFileSync(join(root, "etc/choibot/first-boot.conf"), `CONSOLE_USER=choibot\nCLI=${root}/cli\nUNIT=choibot.service\n`);
    writeFileSync(join(root, "etc/choibot/first-start.json"), fileText(), { mode: 0o600 });
    const L = `${root}/log`;
    fake("getent", `echo "choibot:x:1000:1000::${root}/home:/bin/bash"`);
    fake("id", "echo 1000");
    fake("chown", `echo "chown $*" >> ${L}`);
    // install -o <user> -m <mode> <src> <dest>: the owner is the test's own user here.
    fake("install", `echo "install $*" >> ${L}; shift 2; exec /usr/bin/install "$@"`);
    // runuser -u <user> -- <cmd…>: the command runs as the test's own user.
    fake("runuser", `echo "runuser $1 $2" >> ${L}; shift 3; exec "$@"`);
    fake("systemctl", `echo "systemctl $*" >> ${L}; [ "$1" = is-active ] && exit 0; exit 0`);
    // The command of the install: it records what it got, and the file it was given.
    writeFileSync(join(root, "cli"), `#!/bin/sh\necho "cli $1 $(stat -c %a "$2") HOME=$HOME" >> ${L}\ncat "$2" > ${root}/got.json\n`);
    chmodSync(join(root, "cli"), 0o755);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("copies the file for the console's user, removes it from /etc, runs first-start as that user, restarts the console", () => {
    const r = runStep();
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(root, "got.json"), "utf8")).toBe(fileText());
    expect(existsSync(join(root, "etc/choibot/first-start.json"))).toBe(false);
    // The copy is made before the user may enter root's folder; the folder goes at the end.
    const lines = log().split("\n");
    const at = (p: string) => lines.findIndex((l) => l.startsWith(p));
    expect(at("install -o choibot -m 0600")).toBeLessThan(at("chown choibot"));
    expect(lines).toContain("runuser -u choibot");
    expect(log()).toMatch(new RegExp(`cli first-start 600 HOME=${root}/home`));
    expect(log()).toContain("systemctl --user -M choibot@ try-restart choibot.service");
    expect(readdirSync(join(root, "run"))).toEqual([]);
  });

  it("takes the test's root folder and PATH only when it does not run as root", () => {
    const text = readFileSync(SCRIPT, "utf8");
    expect(text).toMatch(/^ROOT=\nPATH=\/usr\/sbin:\/usr\/bin:\/sbin:\/bin\nif \[ "\$\(\/usr\/bin\/id -u\)" != 0 \]; then\n {2}ROOT=\$\{CHOIBOT_FIRST_BOOT_ROOT:-\}\n {2}PATH=\$\{CHOIBOT_FIRST_BOOT_PATH:-\$PATH\}\nfi$/m);
    // As root (a fake id that says 0, first on a PATH that the script then drops): the fixed /etc, where no file is.
    const asRoot = join(root, "rootbin");
    mkdirSync(asRoot);
    writeFileSync(join(asRoot, "id"), "#!/bin/sh\necho 0\n");
    chmodSync(join(asRoot, "id"), 0o755);
    const text2 = text.replace('"$(/usr/bin/id -u)"', `"$(${asRoot}/id -u)"`);
    writeFileSync(join(root, "step-as-root"), text2);
    const r = spawnSync("sh", [join(root, "step-as-root")], { encoding: "utf8", env: { CHOIBOT_FIRST_BOOT_ROOT: root, CHOIBOT_FIRST_BOOT_PATH: `${bin}:/usr/bin:/bin` } as unknown as NodeJS.ProcessEnv });
    expect(r.status).toBe(0);
    expect(log()).toBe("");   // no fake ran: /etc/choibot/first-start.json of this machine does not exist
    expect(existsSync(join(root, "etc/choibot/first-start.json"))).toBe(true);
  });

  it("does nothing when there is no first-start file", () => {
    rmSync(join(root, "etc/choibot/first-start.json"));
    expect(runStep().status).toBe(0);
    expect(log()).toBe("");
  });

  it("refuses a config of another shape (a user name with a space, a CLI that is not a full path), and runs nothing", () => {
    for (const conf of ["CONSOLE_USER=choibot root\nCLI=/x\nUNIT=choibot.service\n", "CONSOLE_USER=choibot\nCLI=/x;id\nUNIT=choibot.service\n", "CONSOLE_USER=choibot\nCLI=cli\nUNIT=choibot.service\n", "CONSOLE_USER=Choibot\nCLI=/x\nUNIT=choibot.service\n"]) {
      writeFileSync(join(root, "etc/choibot/first-boot.conf"), conf);
      const r = runStep();
      expect([conf, r.status]).toEqual([conf, 1]);
      expect(r.stderr).toMatch(/needs CONSOLE_USER, CLI and UNIT/);
    }
    expect(log()).not.toMatch(/runuser|install/);
    expect(existsSync(join(root, "etc/choibot/first-start.json"))).toBe(true);
  });

  it("a first-start that fails: the code goes out, the file in /etc is gone, nothing is restarted", () => {
    writeFileSync(join(root, "cli"), "#!/bin/sh\nexit 3\n");
    const r = runStep();
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/first-start ended with code 3/);
    expect(existsSync(join(root, "etc/choibot/first-start.json"))).toBe(false);
    expect(log()).not.toContain("try-restart");
  });

  it("the units: after cloud-init, before the user sessions, only with a file; the path unit for a file that comes later", () => {
    const service = readFileSync(join(__dirname, "../../deploy/choibot-first-boot.service"), "utf8");
    expect(service).toMatch(/^After=cloud-init\.service cloud-init-network\.service cloud-config\.service$/m);
    expect(service).toMatch(/^Before=systemd-user-sessions\.service$/m);
    expect(service).toMatch(/^ConditionPathExists=\/etc\/choibot\/first-start\.json$/m);
    expect(service).toMatch(/^ExecStart=\/usr\/local\/sbin\/choibot-first-boot$/m);
    const path = readFileSync(join(__dirname, "../../deploy/choibot-first-boot.path"), "utf8");
    expect(path).toMatch(/^PathExists=\/etc\/choibot\/first-start\.json$/m);
    expect(execFileSync("sh", ["-n", SCRIPT]).toString()).toBe("");
  });
});
