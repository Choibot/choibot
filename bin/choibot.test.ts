// bin/choibot.ts as a child process: the exit must not cut output that is still
// pending on a pipe, and must keep the exit codes.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHOIBOT = "./node_modules/.bin/tsx bin/choibot.ts";

// ~300 KB of queue items: well over one Linux pipe buffer (64 KB).
const ITEMS = Array.from({ length: 300 }, (_, i) => ({ id: `q_${String(i).padStart(8, "0")}`, title: `item ${i}`, body: "x".repeat(1000) }));

let server: Server;
let port = 0;
beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url?.includes("area=boom")) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: "boom" })); return; }
    res.end(JSON.stringify({ items: ITEMS }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => { server.close(); });

// Runs a bash script from the repo root. The child's stdout is a socket pair
// (large buffer), so a script that needs a real 64 KB pipe makes its own (`| cat`).
function sh(script: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", `set -o pipefail; ${script}`], {
      cwd: root, timeout: 30000,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", PORT: String(port), CHIEF_TEST: "1", CHOIBOT_AGENT_ID: "a1" } as unknown as NodeJS.ProcessEnv,
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d));
    child.stderr.on("data", (d: Buffer) => (stderr += d));
    child.on("error", (e) => resolve({ status: null, stdout, stderr: String(e) }));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

describe("the command names", () => {
  it("bin/choibot.ts runs the same CLI as bin/choibot.ts", async () => {
    const [a, b] = await Promise.all([sh(`${CHOIBOT} --help`), sh("./node_modules/.bin/tsx bin/choibot.ts --help")]);
    expect(b.status, b.stderr).toBe(0);
    expect(b.stdout).toBe(a.stdout);
    expect(b.stdout).toContain("Usage: pnpm choibot <command>");
    const r = await sh("./node_modules/.bin/tsx bin/choibot.ts queue list | head -c 1");
    expect(r.stdout).toBe("[");
  }, 40000);

  it("package.json has the scripts choibot and choi, and keeps choibot", () => {
    const scripts = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
    expect(scripts.choibot).toBe("tsx bin/choibot.ts");
    expect(scripts.choi).toBe("tsx bin/choibot.ts");
    expect(scripts.choibot).toBe("tsx bin/choibot.ts");
  });
});

describe("bin/choibot.ts exit", () => {
  it("writes all of a large output to a pipe before it exits", async () => {
    const r = await sh(`${CHOIBOT} queue list | cat`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(200_000);
    expect(JSON.parse(r.stdout)).toEqual(ITEMS);
  }, 40000);

  it("ends without a stack trace when the reader closes the pipe", async () => {
    const r = await sh(`${CHOIBOT} queue list | head -c 1`);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("[");
  }, 40000);

  it("keeps exit code 1 and the message on stderr for a failed command", async () => {
    const r = await sh(`${CHOIBOT} queue list --area boom | cat`);
    expect(r.status).toBe(1);
    expect(r.stderr.trim()).toBe("boom");
    expect(r.stdout).toBe("");
  }, 40000);

  it("keeps exit code 2 and the message on stderr for a thrown error", async () => {
    const r = await sh(`${CHOIBOT} status bogus | cat`);
    expect(r.status).toBe(2);
    expect(r.stderr.trim()).toMatch(/^unknown target: bogus/);
    expect(r.stderr).not.toMatch(/\n\s+at /);
  }, 40000);
});
