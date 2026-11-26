// bin/lib/firststart.ts — `first-start <file>`: the first start of a server that was made from a
// prepared image (a hosted server). The image's first-boot step (deploy/choibot-first-boot, as
// root) gives the console's user a copy of the first-start data, and runs this as that user.
//
// It does what must differ from one server to the next of the same image:
//   - the console's cookie secret: `setup` wrote one into the settings at the image build, so
//     every server of the image would share it. A new one is made here;
//   - the console's address (CHIEF_CONSOLE_URL), from the `url` of the file;
//   - the pairing state: the codes left from the image build are removed, and the claim link of
//     the file is put where the console takes it (server/chief/claimlink.ts);
//   - with the file's `proxy` key (a console behind a front proxy, server/frontproxy.ts): the
//     proxy's settings, and a NEW TLS key and certificate for the private listener, made here
//     before the console listens. Its fingerprint goes to this output (the first-boot journal).
// The image clean-up (the recipe) removes the rest: the machine id, the SSH host keys, logins.
//
// It refuses a console that has a paired device (that is not a first start: a new secret would
// sign the person out), an install with the old names, a console that does not pair from the
// server, and a file that the console would refuse. It prints nothing of the hash.
import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { PROXY_ENV, parseProxySettings, type ProxySettings } from "../../server/frontproxy.js";
import { DISPLAY_NAME } from "../../server/brand.js";
import { DeviceStore } from "../../server/chief/auth.js";
import { parseFirstStart } from "../../server/chief/claimlink.js";
import { atomicWrite } from "../../server/chief/files.js";
import { firstRunOn } from "../../server/chief/firstrun.js";
import { chiefActive, chiefPaths, chiefUserAuth, resolveChiefDataDir, type Env } from "../../server/chief/paths.js";
import { envRead } from "../../server/names.mjs";
import { generateSecret, parseEnv, writeEnvFile } from "./env.js";

// The address of a console behind the door: https, a host name, an optional port. No path.
export const CONSOLE_URL_RE = /^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?::[0-9]{1,5})?$/;

export type FirstStartDeps = {
  repoDir: string; file: string; env?: Env; names?: { legacy: boolean };
  now?: () => number; out?: (s: string) => void; err?: (s: string) => void;
  // For the tests: how the TLS key is made (default: openssl).
  makeTls?: (dir: string) => { ok: true } | { ok: false; why: string };
};

// The private listener's key and certificate: Ed25519, self-signed, 10 years, files 0600 in a
// 0700 folder. The front proxy pins the certificate's fingerprint at its first contact. They are
// made in a new folder beside `dir` and take its place only when both are there: a failure keeps
// the key of before. `openssl`: the command (a test gives one that fails).
export function makeProxyTls(dir: string, openssl = "openssl"): { ok: true } | { ok: false; why: string } {
  const parent = dirname(dir);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const fresh = mkdtempSync(join(parent, ".proxy-tls-new-"));
  chmodSync(fresh, 0o700);
  const r = spawnSync(openssl, ["req", "-x509", "-newkey", "ed25519", "-nodes", "-days", "3650", "-subj", "/CN=console", "-keyout", join(fresh, "key.pem"), "-out", join(fresh, "cert.pem")], { stdio: ["ignore", "ignore", "pipe"], timeout: 30_000 });
  if (r.status !== 0 || !existsSync(join(fresh, "key.pem")) || !existsSync(join(fresh, "cert.pem"))) {
    rmSync(fresh, { recursive: true, force: true });
    return { ok: false, why: r.error ? r.error.message : "openssl failed" };
  }
  for (const f of ["key.pem", "cert.pem"]) chmodSync(join(fresh, f), 0o600);
  const old = existsSync(dir) ? `${dir}.old-${process.pid}` : null;
  if (old) renameSync(dir, old);
  renameSync(fresh, dir);
  if (old) rmSync(old, { recursive: true, force: true });
  return { ok: true };
}

export async function runFirstStart(d: FirstStartDeps): Promise<number> {
  const out = d.out ?? ((s: string) => console.log(s));
  const err = d.err ?? ((s: string) => console.error(s));
  const shell = d.env ?? process.env;
  // A mistake guard, not a wall: the first-boot step runs this, never an agent.
  if (envRead(shell, "AGENT_ID") !== undefined || shell.CLAUDECODE !== undefined) { err("first-start runs at the first boot of a server, not in an agent's shell."); return 1; }
  const envFile = join(d.repoDir, ".env");
  if (!existsSync(envFile)) { err(`✖ ${DISPLAY_NAME} has no settings here (${envFile}).`); return 1; }
  const values = parseEnv(readFileSync(envFile, "utf8"));
  const env: Env = { ...shell, ...Object.fromEntries(values) };
  if (!firstRunOn({ active: chiefActive(env), userAuth: chiefUserAuth(env) }, d.names)) {
    err(`✖ This ${DISPLAY_NAME} does not take a first-start file: it keeps the old names, or it does not pair its first device from the server.`);
    return 1;
  }
  // The console runs in the install's folder: a data folder given as a relative path is relative
  // to it, here too (and the console takes an absolute TLS folder only).
  const chiefDir = resolve(d.repoDir, resolveChiefDataDir(env));
  const paths = chiefPaths(chiefDir);
  if ((await new DeviceStore(paths.devices).list()).length > 0) {
    err(`✖ This ${DISPLAY_NAME} has a paired device: this is not its first start. Nothing is changed.`);
    return 1;
  }

  let text: string;
  try { text = readFileSync(d.file, "utf8"); } catch { err(`✖ The first-start file ${d.file} cannot be read.`); return 1; }
  const now = (d.now ?? Date.now)();
  const parsed = parseFirstStart(text, now);
  if ("refused" in parsed) { err(`✖ The first-start file is refused (${parsed.refused}).`); return 1; }
  const raw = JSON.parse(text) as { url?: unknown; proxy?: unknown };
  const url = raw.url;
  if (url !== undefined && (typeof url !== "string" || !CONSOLE_URL_RE.test(url))) { err("✖ The first-start file is refused (url)."); return 1; }
  let proxy: ProxySettings | null = null;
  if (raw.proxy !== undefined) {
    const p = raw.proxy !== null && typeof raw.proxy === "object" ? parseProxySettings(raw.proxy as Record<string, unknown>) : { refused: "proxy" };
    if ("refused" in p) { err(`✖ The first-start file is refused (${p.refused}).`); return 1; }
    proxy = p;
  }
  // The TLS key first: when it cannot be made, nothing is changed.
  const tlsDir = join(chiefDir, "proxy-tls");
  if (proxy) {
    const made = (d.makeTls ?? makeProxyTls)(tlsDir);
    if (!made.ok) { err(`✖ The key of the private listener could not be made (${made.why}). Nothing is changed.`); return 1; }
  }

  // The settings: a new cookie secret for this server, and its address.
  values.set("CONSOLE_COOKIE_SECRET", generateSecret());
  if (typeof url === "string") values.set("CHIEF_CONSOLE_URL", url);
  if (proxy) {
    values.set(PROXY_ENV.from, proxy.from);
    values.set(PROXY_ENV.network, proxy.network);
    values.set(PROXY_ENV.port, String(proxy.port));
    values.set(PROXY_ENV.tokenSha256, proxy.tokenSha256);
    values.set(PROXY_ENV.tlsDir, tlsDir);
  } else {
    // No front proxy for this server: no proxy setting stays from the image build.
    for (const k of Object.values(PROXY_ENV)) values.delete(k);
  }
  writeEnvFile(envFile, values);
  // The pairing state of the image build goes; the claim link of this server comes in.
  for (const f of [paths.pairCode, paths.addCode, paths.claimLink]) rmSync(f, { force: true });
  await atomicWrite(paths.firstStart, text);

  out([
    `✔ The first start of this server is ready.`,
    `  The claim link works until ${new Date(parsed.expiresAt).toISOString()}.`,
    ...(typeof url === "string" ? [`  The address of ${DISPLAY_NAME}: ${url}`] : []),
    `  A new cookie secret was made for this server. ${DISPLAY_NAME} uses the new settings at its next start.`,
    ...(proxy ? [`  The front proxy: from ${proxy.from}, port ${proxy.port}. The private listener's certificate: sha256 ${fingerprintOf(join(tlsDir, "cert.pem"))}`] : []),
  ].join("\n"));
  return 0;
}

function fingerprintOf(file: string): string {
  try { return new X509Certificate(readFileSync(file)).fingerprint256; } catch { return "(not readable)"; }
}
