// bin/lib/access.test.ts — `access`: the tunnel line and the server side of the private
// address. The exec seam is mocked: no Tailscale and no service manager runs.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const box = vi.hoisted(() => ({
  // none | signed-out | no-operator | no-https | no-address | ready
  tailscale: "none",
  active: true,
  calls: [] as string[],
}));

vi.mock("./exec.js", () => ({
  which: async (bin: string) => (bin === "tailscale" && box.tailscale === "none" ? null : `/usr/bin/${bin}`),
  run: async (cmd: string, args: string[]) => {
    const line = [cmd, ...args].join(" ");
    box.calls.push(line);
    const done = (code: number, stdout = "", stderr = "") => ({ code, stdout, stderr });
    if (line === "tailscale serve status") {
      if (box.tailscale === "signed-out") return done(1, "", "Logged out.");
      return done(0, box.tailscale === "ready" ? "https://server.example.ts.net (tailnet only)\n|-- / proxy http://127.0.0.1:4310\n" : "No serve config\n");
    }
    if (line.startsWith("tailscale serve --bg")) {
      if (box.tailscale === "no-operator") return done(1, "", "Access denied: serve config denied\nTo not require root, use 'sudo tailscale set --operator=$USER' once.");
      if (box.tailscale === "no-https") return done(1, "", "Serve is not enabled on your tailnet.\nTo enable, visit:\n\n  https://login.tailscale.com/f/serve?node=x");
      box.tailscale = "ready";
      return done(0, "Serve started and running in the background.");
    }
    if (line.includes("is-active")) return done(box.active ? 0 : 3);
    return done(0);
  },
}));

import { privateAddress, runAccess, tunnel } from "./access.js";

let repo: string, out: string[];
const text = (): string => out.join("\n");
const SSH = "198.51.100.7 50022 203.0.113.7 22";
const access = (env: Record<string, string> = { SSH_CONNECTION: SSH }): Promise<number> =>
  runAccess({ repoDir: repo, env, user: "ada", out: (s) => out.push(s), fetch: (async () => ({ status: 200 })) as unknown as typeof fetch, waitMs: 10 });
const settings = (url: string): void => writeFileSync(join(repo, ".env"), `PORT=4310\nCHIEF_CONSOLE_URL=${url}\n`);

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "access-"));
  settings("http://127.0.0.1:4310");
  Object.assign(box, { tailscale: "none", active: true, calls: [] });
  out = [];
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("the tunnel line", () => {
  it("has the real user, the address the laptop reached and the port of the console", () => {
    expect(tunnel({ user: "ada", port: "3101", ssh: SSH }).line).toBe("ssh -N -L 3101:127.0.0.1:3101 ada@203.0.113.7");
  });
  it("names the SSH port when it is not 22", () => {
    expect(tunnel({ user: "ada", port: "3100", ssh: "198.51.100.7 50022 203.0.113.7 2222" }).line).toBe("ssh -N -L 3100:127.0.0.1:3100 -p 2222 ada@203.0.113.7");
  });
  it("says so when the address is unknown or only works inside one network", () => {
    expect(tunnel({ user: "ada", port: "3100" })).toMatchObject({ known: false, line: "ssh -N -L 3100:127.0.0.1:3100 ada@<the address of your server>" });
    expect(tunnel({ user: "ada", port: "3100", ssh: "10.0.0.9 1 10.0.0.5 22" })).toMatchObject({ known: true, privateIp: true });
    expect(tunnel({ user: "ada", port: "3100", ssh: SSH }).privateIp).toBe(false);
    expect(tunnel({ user: "ada", port: "3100", ssh: "x y $(reboot) 22" }).known).toBe(false);
  });
});

describe("access", () => {
  it("always gives the way with no account: the tunnel line and the local address", async () => {
    await access();
    expect(text()).toContain("ssh -N -L 4310:127.0.0.1:4310 ada@203.0.113.7");
    expect(text()).toContain("Open http://localhost:4310 in the browser of your laptop.");
  });

  it("Tailscale is not there: shows the 2 commands that need root, and runs none", async () => {
    expect(await access()).toBe(1);
    expect(text()).toContain("curl -fsSL https://tailscale.com/install.sh | sh");
    expect(text()).toContain("sudo tailscale up --operator=ada");
    expect(box.calls).toEqual([]);
  });

  it("not signed in: shows the sign-in command, and runs only the check", async () => {
    box.tailscale = "signed-out";
    expect(await access()).toBe(1);
    expect(text()).toContain("sudo tailscale up --operator=ada");
    expect(text()).not.toContain("install.sh");
    expect(box.calls).toEqual(["tailscale serve status"]);
  });

  it("signed in: turns the private address on with no root, and the check decides", async () => {
    box.tailscale = "no-address";
    expect(await access()).toBe(0);
    expect(box.calls).toContain("tailscale serve --bg --https=443 4310");
    expect(box.calls.some((c) => c.startsWith("sudo"))).toBe(false);
    expect(text()).toContain("✔ The private address is ready: https://server.example.ts.net");
  });

  it("puts the private address into the console's links, and starts the console again", async () => {
    box.tailscale = "no-address";
    await access();
    expect(readFileSync(join(repo, ".env"), "utf8")).toContain("CHIEF_CONSOLE_URL=https://server.example.ts.net\n");
    expect(box.calls.some((c) => c.startsWith("systemctl --user try-restart "))).toBe(true);
    expect(text()).toContain("Its links use the private address now.");
  });

  it("never changes an address that a person set, and then restarts nothing", async () => {
    settings("https://console.example.ts.net");
    box.tailscale = "ready";
    expect(await access()).toBe(0);
    expect(readFileSync(join(repo, ".env"), "utf8")).toBe("PORT=4310\nCHIEF_CONSOLE_URL=https://console.example.ts.net\n");
    expect(box.calls.some((c) => c.startsWith("systemctl"))).toBe(false);
  });

  it("the user may not turn the address on: shows the one root command", async () => {
    box.tailscale = "no-operator";
    expect(await access()).toBe(1);
    expect(text()).toContain("sudo tailscale set --operator=ada");
  });

  it("HTTPS addresses are off in the account: shows what Tailscale said and the switch", async () => {
    box.tailscale = "no-https";
    expect(await access()).toBe(1);
    expect(text()).toContain("https://login.tailscale.com/f/serve?node=x");
    expect(text()).toContain("Enable HTTPS");
  });
});

describe("privateAddress", () => {
  it("reads the address of the first line", () => {
    expect(privateAddress("https://server.example.ts.net (tailnet only)\n|-- / proxy http://127.0.0.1:3100")).toBe("https://server.example.ts.net");
    expect(privateAddress("No serve config")).toBeNull();
  });
});
