// bin/lib/client.ts — which identity a `choibot` CLI call sends (spec §3.1 step 4,
// Appendix A global flags) and where it sends it (§4.4 CHIEF_TEST).
// A request carries the user token or the agent headers, never both.
import { readFileSync } from "node:fs";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";
import { AGENT_HEADER, AGENT_TOKEN_HEADER, CONSOLE_HEADER, USER_HEADER } from "../../server/chief/auth.js";
import { readConsoleToken } from "../../server/chief/consoletoken.js";
import { chiefPaths, resolveChiefDataDir } from "../../server/chief/paths.js";
import type { Cli } from "./cli.js";
import { parseEnv } from "./env.js";
import { CLI_NAME } from "../../server/brand.js";
import { envKey, envRead, names } from "../../server/names.mjs";
import { settingsFile } from "../../server/layout.js";

export type CliEnv = Record<string, string | undefined>;
export class CliError extends Error {
  // Set when the console answered non-2xx (or ok:false): its status and JSON body.
  status?: number;
  body?: unknown;
}
const httpError = (message: string, status: number, body: unknown): CliError => Object.assign(new CliError(message), { status, body });

type Method = "GET" | "POST";
// console: the console's own account (strong protection): its token, a short list of routes.
type Identity = "user" | "agent" | "console" | "none";
type ReadFile = (p: string) => string | null;

export const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// The folder of the install that this command belongs to (this file is <folder>/bin/lib/client.ts).
const INSTALL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// The port of THIS install. The shell of a person has no PORT, and the console of an install
// can listen on another port than the default one (the set-up takes the next free port). So a
// command in that shell takes the port from the settings file of its own install: the folder
// of the command itself, never the folder the person is in (a repo there can have a settings
// file of its own). Only that one value is read: no other setting reaches a command. A shell
// that has a PORT (an agent of the console, a test instance) keeps it.
export function withInstallPort(
  env: CliEnv, dir: string = INSTALL_DIR,
  readFile: (p: string) => string | null = (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } },
): CliEnv {
  if (env.PORT) return env;
  const text = readFile(settingsFile(dir));
  const port = text === null ? undefined : parseEnv(text).get("PORT");
  return port && /^\d{1,5}$/.test(port) ? { ...env, PORT: port } : env;
}

// The process-bound IO every CLI subcommand runner shares.
export function defaultIo() {
  return {
    fetch,
    readStdin: async () => { process.stdin.setEncoding("utf8"); let s = ""; for await (const c of process.stdin) s += c; return s; },
    stdinIsTTY: Boolean(process.stdin.isTTY),
    stderrIsTTY: Boolean(process.stderr.isTTY),
    out: (s: string) => { process.stdout.write(`${s}\n`); },
    err: (s: string) => { process.stderr.write(`${s}\n`); },
    env: withInstallPort(process.env as CliEnv),
    flags: {} as Cli["flags"],
    readFile: (p: string): string | null => { try { return readFileSync(p, "utf8"); } catch { return null; } },
  };
}

// JSON from stdin: refused on a TTY; a parse error becomes a CliError.
export async function readStdinJson(d: { stdinIsTTY: boolean; readStdin: () => Promise<string> }, sub: string | undefined): Promise<unknown> {
  if (d.stdinIsTTY) throw new CliError(`${sub} reads JSON on stdin`);
  try { return JSON.parse(await d.readStdin()); }
  catch (e) { throw new CliError(`invalid JSON on stdin: ${msg(e)}`); }
}

const IDENTITY_HEADERS: readonly string[] = [USER_HEADER, AGENT_HEADER, AGENT_TOKEN_HEADER, CONSOLE_HEADER];

// The token of the console's own account (strong protection), when this process can read it: only
// that account can (a 0600 file in its 0700 data folder; server/chief/consoletoken.ts). Never in an
// agent: an agent marker in the env means another identity.
export function consoleTokenOf(env: CliEnv, readToken: (file: string) => string | undefined = readConsoleToken): string | undefined {
  if (envRead(env, "AGENT_ID") !== undefined) return undefined;
  return readToken(chiefPaths(resolveChiefDataDir(env)).consoleToken);
}

export function consoleBase(env: CliEnv): string {
  if (env.CHIEF_TEST === "1") {
    const port = env.PORT;
    if (!port || !/^\d+$/.test(port)) throw new CliError("CHIEF_TEST=1 requires PORT");
    if (Number(port) === 3100) throw new CliError("CHIEF_TEST=1 refuses port 3100 (the live console)");
    return `http://127.0.0.1:${port}`;
  }
  return `http://127.0.0.1:${env.PORT || "3100"}`;
}

// The one rule for CHOIBOT_USER_TOKEN and the token file: no agent marker in the
// env (set at all, even empty) and stderr a TTY. Stdin is not part of it, so a
// human can still pipe JSON into a command.
export function humanShell(env: CliEnv, stderrIsTTY: boolean): boolean {
  return envRead(env, "AGENT_ID") === undefined && env.CLAUDECODE === undefined && env.CODEX_HOME === undefined && stderrIsTTY;
}

export function userTokenPath(env: CliEnv): string {
  return `${env.HOME ?? homedir()}/.config/${names().configDir}/user-token`;
}

// --user-token (explicit, any shell) > CHOIBOT_USER_TOKEN > the token file; the
// last two only in a human shell. The file is not read otherwise.
export function resolveUserToken(o: { flags: Cli["flags"]; env: CliEnv; stderrIsTTY: boolean; readFile: ReadFile }): string | undefined {
  const flag = o.flags["user-token"];
  if (flag !== undefined) {
    if (flag === true || !flag.trim()) throw new CliError("--user-token needs a value");
    return flag.trim();
  }
  if (!humanShell(o.env, o.stderrIsTTY)) return undefined;
  const fromEnv = envRead(o.env, "USER_TOKEN")?.trim();
  if (fromEnv) return fromEnv;
  return o.readFile(userTokenPath(o.env))?.trim() || undefined;
}

export function agentHeadersFromEnv(env: CliEnv): Record<string, string> | undefined {
  const id = envRead(env, "AGENT_ID");
  if (!id) return undefined;
  const pass = envRead(env, "AGENT_PASS");
  return { [AGENT_HEADER]: id, ...(pass ? { [AGENT_TOKEN_HEADER]: pass } : {}) };
}

// Writes ~/.config/choibot/user-token (0600, dir 0700) for an explicit HOME only:
// never homedir(), so a scrubbed env cannot write the real home.
export async function writeUserToken(env: CliEnv, token: string): Promise<string> {
  if (!env.HOME) throw new CliError("HOME is not set: refusing to write the user token");
  if (typeof token !== "string" || !token.trim()) throw new CliError("empty user token");
  const path = userTokenPath(env);
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, `${token.trim()}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
  return path;
}

export const LONG_TIMEOUT_MS = 11 * 60_000;

// A fetch-shaped call over node:http with no header timeout (undici's fetch cuts
// at 300 s) and one total timeout. For `brain distill`, which runs up to 10 min.
export function nodeFetch(timeoutMs: number): typeof fetch {
  return ((url: string | URL, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    const req = httpRequest(new URL(String(url)), { method: init?.method ?? "GET", headers: init?.headers as Record<string, string> }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        clearTimeout(timer);
        const text = Buffer.concat(chunks);
        resolve(new Response(text.length ? text : null, { status: res.statusCode ?? 502 }));
      });
      res.on("error", (e) => { clearTimeout(timer); reject(e); });
    });
    const timer = setTimeout(() => req.destroy(new Error(`timed out after ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
    req.on("error", (e) => { clearTimeout(timer); reject(e); });
    req.end(init?.body === undefined ? undefined : String(init.body));
  })) as typeof fetch;
}

export type ConsoleClient = {
  base: string;
  call(method: Method, path: string, body?: unknown, extra?: Record<string, string>): Promise<any>;
  callAsUser(method: Method, path: string, body?: unknown): Promise<any>;
  // callAsUser over node:http with a long total timeout (distill).
  callAsUserLong(method: Method, path: string, body?: unknown): Promise<any>;
  callBare(method: Method, path: string, body?: unknown): Promise<any>;
  identity(): Promise<Identity>;
};

export function createConsoleClient(d: { fetch: typeof fetch; env: CliEnv; flags: Cli["flags"]; stderrIsTTY: boolean;
  readFile: ReadFile; longFetch?: typeof fetch; longTimeoutMs?: number; consoleToken?: () => string | undefined }): ConsoleClient {
  const base = consoleBase(d.env);
  const userToken = () => resolveUserToken({ flags: d.flags, env: d.env, stderrIsTTY: d.stderrIsTTY, readFile: d.readFile });

  async function request(method: Method, path: string, body: unknown, headers: Record<string, string>,
    doFetch: typeof fetch = d.fetch): Promise<any> {
    const h: Record<string, string> = { ...headers };
    if (body !== undefined) h["content-type"] = "application/json";
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) {
      throw new CliError(`console unreachable at ${base}: ${msg(e)}`);
    }
    let json: any = null;
    try { json = await res.json(); } catch { /* empty body (202) */ }
    if (!res.ok || json?.ok === false) throw httpError(json?.error ? String(json.error) : `HTTP ${res.status}`, res.status, json);
    return json ?? {};
  }

  const asUser = (token: string) => ({ [USER_HEADER]: token });

  // --agent <id>: fetch the record with only the user token (only USER gets
  // hookToken), then act with only that record's agent headers; CHOIBOT_AGENT_*
  // in the env is ignored. It needs a user token, from --user-token or the
  // human-shell sources.
  async function viaAgentFlag(id: string | true): Promise<Record<string, string>> {
    if (id === true || !id) throw new CliError("--agent needs an agent id");
    const token = userToken();
    if (!token) throw new CliError(`--agent needs a user token: --user-token <t>, or ${envKey("USER_TOKEN")} or the token file in a human shell`);
    const rec = await request("GET", `/api/agents/${encodeURIComponent(id)}`, undefined, asUser(token));
    if (typeof rec?.hookToken !== "string" || !rec.hookToken) {
      throw new CliError(`no hook token for agent ${id}: the console did not accept the user token`);
    }
    return { [AGENT_HEADER]: typeof rec.id === "string" && rec.id ? rec.id : id, [AGENT_TOKEN_HEADER]: rec.hookToken };
  }

  async function resolveIdentity(): Promise<{ kind: Identity; headers: Record<string, string> }> {
    if (d.flags.agent !== undefined) return { kind: "agent", headers: await viaAgentFlag(d.flags.agent) };
    if (d.flags["user-token"] !== undefined) return { kind: "user", headers: asUser(userToken()!) };
    const agent = agentHeadersFromEnv(d.env);
    if (agent) return { kind: "agent", headers: agent };
    const token = userToken();
    if (token) return { kind: "user", headers: asUser(token) };
    // The console's own account with no device token (doctor, the set-up, the install agent,
    // `brain pair`): its short list, never the user's rights.
    const own = d.consoleToken ? d.consoleToken() : consoleTokenOf(d.env);
    if (own) return { kind: "console", headers: { [CONSOLE_HEADER]: own } };
    return { kind: "none", headers: {} };
  }

  let resolved: ReturnType<typeof resolveIdentity> | undefined;
  const identityOnce = () => (resolved ??= resolveIdentity());

  return {
    base,
    async call(method, path, body, extra) {
      const { headers } = await identityOnce();
      // extra never carries an identity: only the resolved one goes out.
      const rest = Object.fromEntries(Object.entries(extra ?? {}).filter(([k]) => !IDENTITY_HEADERS.includes(k.toLowerCase())));
      return request(method, path, body, { ...rest, ...headers });
    },
    async callAsUser(method, path, body) {
      const token = userToken();
      if (!token) throw new CliError(`needs a user token: --user-token <t>, or run \`${CLI_NAME} brain claim <url>\` in a human shell`);
      return request(method, path, body, asUser(token));
    },
    async callAsUserLong(method, path, body) {
      const token = userToken();
      if (!token) throw new CliError(`needs a user token: --user-token <t>, or run \`${CLI_NAME} brain claim <url>\` in a human shell`);
      return request(method, path, body, asUser(token), d.longFetch ?? nodeFetch(d.longTimeoutMs ?? LONG_TIMEOUT_MS));
    },
    // No identity: the pairing paths (`brain claim`). `brain pair` mints a link, which is the
    // console's own account's action in strong protection: it sends the console token when it has one.
    async callBare(method, path, body) {
      const own = path === "/api/chief/pair/start" ? (d.consoleToken ? d.consoleToken() : consoleTokenOf(d.env)) : undefined;
      return request(method, path, body, own ? { [CONSOLE_HEADER]: own } : {});
    },
    async identity() {
      return (await identityOnce()).kind;
    },
  };
}
