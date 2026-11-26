// bin/lib/access.ts — `access`: how the console is opened from the user's own devices. The
// console listens on the server itself only, and there is no public door. Two ways in:
//   - an SSH tunnel from the laptop: no account, works now. This file prints the one line.
//   - a private address with Tailscale: laptop and phone. This file does the server side that
//     needs no root (it turns the address on). What needs root it shows and never runs: the
//     install of Tailscale and its sign-in.
// The machine check of the step "Open … from your devices" (server/setup/steps.ts, the `access`
// probe) decides if the private address is ready. This file marks nothing done.
//
// The Tailscale commands are the ones of its docs: the install line
// (https://tailscale.com/kb/1031/install-linux), `--operator` and `serve`
// (https://tailscale.com/kb/1080/cli, https://tailscale.com/kb/1242/tailscale-serve), the
// HTTPS switch of an account (https://tailscale.com/kb/1153/enabling-https).
import { existsSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { DISPLAY_NAME } from "../../server/brand.js";
import { deployUnit } from "../../server/chief/deploy/config.js";
import type { Env } from "../../server/defaults.js";
import { boxProbes, privateAddress } from "../../server/setup/probes.js";
import { cli } from "../../server/setup/steps.js";
import { parseEnv, writeEnvFile } from "./env.js";
import { run } from "./exec.js";
import { installEnv } from "./pair.js";

// An address that only works inside one network (a cloud server often sees itself under one).
const PRIVATE_IP = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|169\.254\.|f[cd][0-9a-f]{2}:|fe80:)/i;

// The tunnel line for the laptop, from the SSH session this shell came in with: the address
// and the port that the laptop reached. `known`: false when this shell has no SSH session.
export function tunnel(o: { user: string; port: string; ssh?: string }): { line: string; known: boolean; privateIp: boolean } {
  const [, , ip, sshPort] = (o.ssh ?? "").trim().split(/\s+/);
  const known = !!ip && /^[0-9a-f.:]+$/i.test(ip);
  const host = known ? ip : "<the address of your server>";
  const p = known && /^\d{1,5}$/.test(sshPort ?? "") && sshPort !== "22" ? ` -p ${sshPort}` : "";
  return { line: `ssh -N -L ${o.port}:127.0.0.1:${o.port}${p} ${o.user}@${host}`, known, privateIp: known && PRIVATE_IP.test(ip) };
}

// The private address in the answer of `tailscale serve status` (server/setup/probes.ts).
export { privateAddress };

type AccessDeps = { repoDir: string; env?: Env; user?: string; out?: (s: string) => void; fetch?: typeof fetch; waitMs?: number };

// 0: the private address is ready (the check of the step passes). 1: not yet.
export async function runAccess(d: AccessDeps): Promise<number> {
  const out = d.out ?? ((s: string) => console.log(s));
  const shell = d.env ?? process.env;
  const env = installEnv(d.repoDir, shell);
  const port = /^\d{1,5}$/.test(env.PORT ?? "") ? env.PORT! : "3100";
  const user = d.user ?? userInfo().username;
  const again = `Then run: ${cli("access")}`;

  const t = tunnel({ user, port, ssh: shell.SSH_CONNECTION });
  out("  From your laptop, now. No account is needed.");
  out("    1. Run this on your laptop, and keep it open:");
  out(`\n         ${t.line}\n`);
  if (!t.known) out("       Use the address that you use for ssh.");
  else if (t.privateIp) out("       If your ssh command uses another address for this server, use that one.");
  out(`    2. Open http://localhost:${port} in the browser of your laptop.`);
  out("");
  out("  From your phone and your laptop: a private address.");
  out("    Tailscale is a private network for your own devices: only they can open the address.");
  out("    It needs a free Tailscale account and its app on each device. About 5 minutes.");

  const access = (): Promise<{ state: string }> => boxProbes({ env, box: () => Promise.reject(new Error("not used")) }).access();
  let state = (await access()).state;

  if (state === "none" || state === "signed-out") {
    out(state === "none"
      ? "\n    Tailscale is not on your server. Only root can install it, so it is not done here. Run these 2 commands:"
      : "\n    Tailscale is on your server, but it is not signed in. Only root can do that, so it is not done here. Run:");
    out("");
    if (state === "none") out("         curl -fsSL https://tailscale.com/install.sh | sh");
    out(`         sudo tailscale up --operator=${user}`);
    out("");
    if (state === "none") out("    The first one installs Tailscale and asks for your sudo password.");
    out("    `tailscale up` shows a sign-in link: open it and sign in. Use the same account on each device.");
    out(`    The word --operator lets ${user} turn the private address on with no root.`);
    out(`    ${again}`);
    return 1;
  }

  if (state === "no-address") {
    // The server side that needs no root: Tailscale hands the console's port to the private network.
    const r = await run("tailscale", ["serve", "--bg", "--https=443", port], { timeoutMs: 30_000 });
    state = (await access()).state;
    if (state !== "ready") {
      const said = `${r.stdout}\n${r.stderr}`.trim();
      if (/access denied|operator|permission denied/i.test(said)) {
        out(`\n    Tailscale does not let ${user} turn the address on yet. Only root can change that. Run:`);
        out(`\n         sudo tailscale set --operator=${user}\n`);
      } else {
        out("\n    Tailscale did not turn the private address on. It said:");
        for (const l of said.split("\n").filter((x) => x.trim()).slice(0, 8)) out(`      ${l}`);
        out("    When it shows a link, open it: your Tailscale account must allow HTTPS addresses");
        out("    (in the Tailscale admin page: DNS, then HTTPS Certificates, then Enable HTTPS).");
      }
      out(`    ${again}`);
      return 1;
    }
  }

  const address = privateAddress((await run("tailscale", ["serve", "status"], { timeoutMs: 15_000 })).stdout);
  out(`\n  ✔ The private address is ready${address ? `: ${address}` : ""}`);
  out("    Open it on each device that has Tailscale with the same account.");
  if (address) await useAddress(d, env, port, address, out);
  return 0;
}

// The links that the console makes (a pairing link, a button in a message) start with the address
// in its settings. A set-up with no question wrote the address of the server itself there:
// only that value is replaced, and the console's own service starts again with the new one.
async function useAddress(d: AccessDeps, env: Env, port: string, address: string, out: (s: string) => void): Promise<void> {
  const file = join(d.repoDir, ".env");
  if (!existsSync(file)) return;
  const values = parseEnv(readFileSync(file, "utf8"));
  if (values.get("CHIEF_CONSOLE_URL") !== `http://127.0.0.1:${port}`) return;
  values.set("CHIEF_CONSOLE_URL", address);
  writeEnvFile(file, values);
  // A console that does not run reads the new value at its next start.
  const unit = deployUnit(env);
  if ((await run("systemctl", ["--user", "is-active", "--quiet", unit])).code !== 0) return;
  const r = await run("systemctl", ["--user", "try-restart", unit]);
  const doFetch = d.fetch ?? fetch;
  const end = Date.now() + (d.waitMs ?? 60_000);
  let up = false;
  while (r.code === 0 && !up) {
    try { up = (await doFetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(5_000) })).status === 200; } catch { /* not up yet */ }
    if (up || Date.now() >= end) break;
    await new Promise((res) => setTimeout(res, 1_000));
  }
  out(up
    ? `  ✔ ${DISPLAY_NAME} started again. Its links use the private address now.`
    : `  ○ ${DISPLAY_NAME} did not answer after its restart. For its state: ${cli("doctor")}`);
}
