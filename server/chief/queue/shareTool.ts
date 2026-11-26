// server/chief/queue/shareTool.ts — the contract between the console and a share tool: an add-on
// program of the server's owner that puts one HTML file on the internet behind a password
// (README, "Share outside"). The console never shares by itself: only the paired user's confirm
// in a ticket runs `add` (share.ts). The tool is set in Settings and kept as SHARE_TOOL.
//
//   <tool> scan <file.html>                     exit 0 or 1. Each stdout line "BLOCKED <text>" or
//                                               "warning <text>" names one thing that may be private.
//   <tool> add <file.html> [--allow-sensitive]  stdout has one "link: https://…" line (the page's
//                                               address) and can have "one-tap: https://…" (the same
//                                               address, the password after "#") and "password: …".
//                                               --allow-sensitive: the user said yes to each hit.
//   <tool> remove <id>                          exit 0 = the page is gone. <id> is the last part of
//                                               the link's path.
//
// The console runs the tool with a fixed argument list (no shell), a time limit, an env allowlist
// and HOME as its folder, and reads only the lines above. No other text of the tool is shown as a
// link. A tool that checks its own work can exit 1 after a "link:" line: the page is out, so the
// console keeps the share (Stop sharing must work) and opens the link once itself (checkLink).
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";

export const SHARE_TIMEOUT_MS = { scan: 30_000, add: 90_000, remove: 30_000 } as const;
const MAX_OUTPUT = 256 * 1024;
const MAX_HITS = 40;

// The env of the tool: what a program needs to run, never the console's secrets.
const ENV_PASS = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR"] as const;
export function toolEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ENV_PASS) if (env[k]) out[k] = env[k]!;
  if (!out.LANG && !out.LC_ALL) out.LANG = "C.UTF-8";
  return out;
}

export type ToolRun = { code: number | null; stdout: string; stderr: string; timedOut: boolean; spawnError?: string };
export type RunTool = (args: string[], timeoutMs: number) => Promise<ToolRun>;

// One run of the tool. Never a shell: `args` go to the program as they are.
export function runTool(tool: string, args: string[], o: { timeoutMs: number; env: Record<string, string>; cwd: string }): Promise<ToolRun> {
  return new Promise((resolve) => {
    execFile(tool, args, { timeout: o.timeoutMs, killSignal: "SIGKILL", env: o.env as NodeJS.ProcessEnv, cwd: o.cwd, maxBuffer: MAX_OUTPUT, encoding: "utf8", windowsHide: true },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: string | null }) | null;
        const out = { stdout: String(stdout ?? ""), stderr: String(stderr ?? "") };
        if (!e) return resolve({ code: 0, ...out, timedOut: false });
        if (typeof e.code === "string" && e.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return resolve({ code: null, ...out, timedOut: false, spawnError: e.code });
        const timedOut = !!e.killed && e.signal === "SIGKILL";
        resolve({ code: typeof e.code === "number" ? e.code : null, ...out, timedOut });
      });
  });
}

// The tool as the console runs it: the env allowlist, the user's home as its folder.
export const toolRunner = (tool: string): RunTool => (args, timeoutMs) =>
  runTool(tool, args, { timeoutMs, env: toolEnv(process.env), cwd: process.env.HOME || homedir() });

// --- the answers --------------------------------------------------------------------------

// Text of the tool that the user can read (a reason): one line, no control characters, short.
// `secret` (a password the same run printed) is cut out.
export function toolText(s: string, secret?: string | null): string {
  // eslint-disable-next-line no-control-regex
  let t = s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (secret) t = t.split(secret).join("…");
  return t.length > 200 ? `${t.slice(0, 199)}…` : t;
}
const lastLine = (s: string): string => s.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";

// Why a run failed, in plain words, from the run itself (never its stdout: that can hold a link).
export function runFailure(r: ToolRun, secret?: string | null): string {
  if (r.spawnError === "ENOENT") return "The share tool is not on your server any more.";
  if (r.spawnError === "EACCES") return "The share tool cannot run: it is not a program this user can start.";
  if (r.spawnError) return `The share tool could not start (${r.spawnError}).`;
  if (r.timedOut) return "The share tool did not finish in time.";
  const why = toolText(lastLine(r.stderr), secret);
  return why ? `The share tool said: ${why}` : `The share tool stopped with code ${r.code ?? "?"}.`;
}

export type Hit = { level: "blocked" | "warning"; text: string };
export type ScanResult = { ok: true; hits: Hit[] } | { ok: false; error: string };

// `scan`: exit 0 or 1, and on exit 1 at least one hit (else the check did not run to its end).
export function parseScan(r: ToolRun): ScanResult {
  if (r.spawnError || r.timedOut || (r.code !== 0 && r.code !== 1)) return { ok: false, error: runFailure(r) };
  const hits: Hit[] = [];
  for (const line of r.stdout.split("\n")) {
    const m = /^(BLOCKED|warning)\s+(\S.*)$/.exec(line.trimEnd());
    if (!m) continue;
    const text = toolText(m[2]!);
    if (!hits.some((h) => h.text === text)) hits.push({ level: m[1] === "BLOCKED" ? "blocked" : "warning", text });
    if (hits.length >= MAX_HITS) break;
  }
  if (r.code === 1 && hits.length === 0) return { ok: false, error: runFailure(r) };
  return { ok: true, hits };
}

// An https address with a host, no user name or password, no space or quote.
function httpsUrl(s: string): URL | null {
  if (s.length > 2000 || /[\s<>"'`\\]/.test(s)) return null;
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  return u.protocol === "https:" && u.hostname !== "" && u.username === "" && u.password === "" ? u : null;
}
const DOC_ID = /^[A-Za-z0-9._~-]{1,128}$/;

export type AddResult =
  | { ok: true; link: string; oneTap: string | null; password: string | null; docId: string; checked: boolean }
  | { ok: false; error: string };

// `add`: one "link:" line with an https address. A "one-tap:" line counts only when it is the same
// address with a "#" part. `checked`: the tool exited 0 (it says the page is out and works).
export function parseAdd(r: ToolRun): AddResult {
  const pick = (key: string): string[] => r.stdout.split("\n").flatMap((l) => {
    const m = new RegExp(`^${key}:\\s+(\\S+)\\s*$`).exec(l);
    return m ? [m[1]!] : [];
  });
  const passwords = pick("password");
  const password = passwords.length === 1 && /^[\x21-\x7e]{1,200}$/.test(passwords[0]!) ? passwords[0]! : null;
  if (r.spawnError || r.timedOut) return { ok: false, error: runFailure(r, password) };
  const links = pick("link");
  if (links.length !== 1) return { ok: false, error: links.length ? "The share tool gave more than one link. Nothing is kept." : runFailure(r, password) };
  const link = httpsUrl(links[0]!);
  if (!link || link.hash) return { ok: false, error: "The share tool gave a link that is not an https address. Nothing is kept." };
  const last = link.pathname.split("/").filter(Boolean).pop() ?? "";
  let docId = "";
  try { docId = decodeURIComponent(last); } catch { /* not an id */ }
  if (!DOC_ID.test(docId) || docId === "." || docId === "..") return { ok: false, error: "The share tool gave a link with no page id at its end. Nothing is kept." };
  const taps = pick("one-tap");
  const tap = taps.length === 1 ? httpsUrl(taps[0]!) : null;
  const sameDoc = !!tap && tap.origin === link.origin && tap.pathname === link.pathname && tap.search === link.search && tap.hash.length > 1;
  return { ok: true, link: link.href, oneTap: sameDoc ? tap.href : null, password, docId, checked: r.code === 0 };
}

export function parseRemove(r: ToolRun): { ok: true } | { ok: false; error: string } {
  return r.code === 0 && !r.timedOut && !r.spawnError ? { ok: true } : { ok: false, error: runFailure(r) };
}

// The console's own look at a link the tool did not check: one request, no redirect followed, a
// short time limit. Any answer 200–399 (a login page, a redirect to it) means the link opens.
export async function checkLink(url: string, f: typeof fetch = fetch, ms = 8_000): Promise<boolean> {
  try {
    const res = await f(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(ms), headers: { "user-agent": "console-share-check" } });
    await res.body?.cancel().catch(() => {});
    return res.status >= 200 && res.status < 400;
  } catch {
    return false;
  }
}

// --- the tool's file ------------------------------------------------------------------------

// The value rule of SHARE_TOOL (settings/envfile.ts): an absolute path of plain characters, with
// no empty, "." or ".." part.
export const PATH_RULE = "Give the full path of the program: it starts with \"/\" and has only letters, digits, \".\", \"_\", \"-\" and \"/\".";
export const SHARE_TOOL_RE = /^(?=.{2,500}$)(\/(?!\.\.?(\/|$))[A-Za-z0-9._-]+)+$/;

// Why the console will not run this file, or null. Checked at save and before each run: a
// regular file this user can run, owned by this user or root, that no other user can change.
export async function toolProblem(path: string, d: { uid?: number } = {}): Promise<string | null> {
  if (!SHARE_TOOL_RE.test(path)) return PATH_RULE;
  let st;
  try { st = await stat(path); } catch { return "There is no file at this path on your server."; }
  if (!st.isFile()) return "This path is not a file.";
  const uid = d.uid ?? process.getuid?.() ?? st.uid;
  if (st.uid !== uid && st.uid !== 0) return "This file belongs to another user of your server.";
  if (st.mode & 0o002) return "Any user of your server can change this file. Remove that right first (chmod o-w).";
  try { await access(path, constants.X_OK); } catch { return "This file is not a program this user can start (chmod +x)."; }
  return null;
}
