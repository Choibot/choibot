// server/agents/sessionread.ts — the one reader of an agent's session files (its transcripts):
// the thread view (threadfile.ts), the stop reason (stopwhy.ts) and the subagent list
// (subagents.ts) read them only through openTranscript; the Plan rail (tasksread.ts) reads the
// agent's task files through helperRead.
//
// Basic mode: the console opens the file itself (O_NOFOLLOW, a regular file), as before.
// Strong protection with its helper: the agent's home is 0700, and Claude Code makes its session
// files 0600 in 0700 folders, so the console cannot open them. The helper reads them AS the
// agent (deploy/choibot-agent-exec read-thread): one call gives the file's facts (size, mtime,
// device, inode) and one byte range. The path is one that the console made from the agent's
// record (sessionFileFor: the Claude folder of its account, its cwd, its session id), never one
// from a request; the helper checks it again (its own real path, inside that account's
// projects/ folder, a regular file). What it gives is the agent's text: data, never an order.
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { chiefAccount } from "../chief/chiefaccount.js";
import { helperSpawn } from "../chief/hardened.js";
import { helperArgv, helperEnv, type AgentExec } from "./terminal.js";

type Env = Record<string, string | undefined>;

export type TranscriptFacts = { size: number; mtimeMs: number; dev: string; ino: string };

export type Transcript = {
  // The facts at the open; they stay fixed while it is open (a read past `size` is not made).
  readonly facts: TranscriptFacts;
  // Bytes [pos, pos + len), fewer at the end of the file. Throws TranscriptChanged when the
  // helper meets another file at the path (it was replaced since the open).
  read(pos: number, len: number): Promise<Buffer>;
  close(): Promise<void>;
};

export class TranscriptChanged extends Error {
  constructor() { super("the session file was replaced while it was read"); }
}

// The most bytes of one helper call (deploy/choibot-agent-exec READ_THREAD_MAX).
export const READ_THREAD_MAX = 4 << 20;
const CALL_MS = 25_000;

// At most this many helper calls at one time in the whole console: each one is sudo, bash and a
// few more programs, and a hosted console is one small server. The others wait their turn.
export const READ_CALLS_MAX = 4;
let active = 0;
const waiting: (() => void)[] = [];
let calls = 0;
// The helper calls made since the start (the subagent list counts its own: subagents.ts).
export const readCalls = (): number => calls;
async function gated<T>(fn: () => Promise<T>): Promise<T> {
  if (active < READ_CALLS_MAX) active++;
  else await new Promise<void>((r) => waiting.push(r)); // the slot of a call that ends is handed over
  try {
    calls++;
    return await fn();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}

// The helper call, for tests: the same shape as execFile with a buffer.
export type ThreadRun = (bin: string, args: string[], o: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number; encoding: "buffer" }, cb: (err: Error | null, stdout: Buffer, stderr: Buffer) => void) => unknown;
const realRun: ThreadRun = (bin, args, o, cb) => execFile(bin, args, o, (err, stdout, stderr) => cb(err, stdout as Buffer, stderr as Buffer));

// The helpers of the two accounts (index.ts sets them after their probes). Unset with strong
// protection: nothing is read (as when the helper's probe failed).
type Readers = { agent: AgentExec | null; chief: AgentExec | null; run?: ThreadRun; onCall?: (path: string) => void };
let readers: Readers = { agent: null, chief: null };
export function setTranscriptReaders(r: Readers): void { readers = r; }

// The account of a session file, by its path: the helper of that account and its Claude folder.
// A path in no account's Claude folder: null (nothing is read).
export function transcriptAccount(path: string, env: Env = process.env): { exec: AgentExec; claudeDir: string } | null {
  const inDir = (d: string) => d !== "" && path.startsWith(`${d.replace(/\/+$/, "")}/`);
  const chief = chiefAccount(env);
  if (chief && inDir(chief.claudeDir)) return readers.chief ? { exec: readers.chief, claudeDir: chief.claudeDir } : null;
  const agentDir = env.AGENT_CLAUDE_CONFIG_DIR?.trim() ?? "";
  if (inDir(agentDir)) return readers.agent ? { exec: readers.agent, claudeDir: agentDir } : null;
  return null;
}

type Answer = { facts: TranscriptFacts; bytes: Buffer } | "absent";

// One call of the helper: the facts line, then the bytes. Throws with the helper's own line.
function call(a: { exec: AgentExec; claudeDir: string }, path: string, pos: number, len: number, env: Env): Promise<Answer> {
  return gated(() => callNow(a, path, pos, len, env));
}

function callNow(a: { exec: AgentExec; claudeDir: string }, path: string, pos: number, len: number, env: Env): Promise<Answer> {
  const argv = helperArgv(a.exec, "read-thread", [path, String(pos), String(len)]);
  readers.onCall?.(path);
  return new Promise((resolve, reject) => {
    (readers.run ?? realRun)(argv[0], argv.slice(1), {
      env: helperEnv({ ...env, CLAUDE_CONFIG_DIR: a.claudeDir }) as unknown as NodeJS.ProcessEnv,
      timeout: CALL_MS, maxBuffer: len + 4096, encoding: "buffer",
    }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr.toString("utf8").trim().split("\n").pop()?.slice(0, 300) || err.message.split("\n")[0]));
      const nl = stdout.indexOf(10);
      const head = (nl < 0 ? stdout : stdout.subarray(0, nl)).toString("latin1");
      if (head === "absent") return resolve("absent");
      const m = /^(\d{1,15}) (\d{1,12})\.(\d{3}) (\d{1,20}) (\d{1,20})$/.exec(head);
      if (!m || nl < 0) return reject(new Error("read-thread: an answer of another shape"));
      const bytes = stdout.subarray(nl + 1);
      if (bytes.length > len) return reject(new Error("read-thread: more bytes than asked"));
      resolve({ facts: { size: Number(m[1]), mtimeMs: Number(m[2]) * 1000 + Number(m[3]), dev: m[4], ino: m[5] }, bytes });
    });
  });
}

// A session file through the helper. `first`: the range the caller reads first, in the same
// call as the facts (a live poll: the bytes after its cursor; one call in all).
async function helperTranscript(path: string, first: { pos: number; len: number } | undefined, env: Env): Promise<Transcript | null> {
  const a = transcriptAccount(path, env);
  if (!a) return null;
  const len0 = first ? Math.min(Math.max(0, first.len), READ_THREAD_MAX) : 0;
  const pos0 = first ? Math.max(0, first.pos) : 0;
  let got: Answer;
  try { got = await call(a, path, pos0, len0, env); } catch { return null; }
  if (got === "absent") return null;
  const { facts } = got;
  const held = { pos: pos0, bytes: got.bytes };
  return {
    facts,
    async read(pos, len) {
      const end = Math.min(pos + len, facts.size);
      if (pos >= end) return Buffer.alloc(0);
      // The range of the first call covers it (or the file ended there).
      if (pos >= held.pos && (end <= held.pos + held.bytes.length || held.pos + held.bytes.length >= facts.size)) {
        return held.bytes.subarray(pos - held.pos, end - held.pos);
      }
      const parts: Buffer[] = [];
      let at = pos;
      while (at < end) {
        const n = Math.min(end - at, READ_THREAD_MAX);
        const r = await call(a, path, at, n, env);
        if (r === "absent" || r.facts.dev !== facts.dev || r.facts.ino !== facts.ino) throw new TranscriptChanged();
        parts.push(r.bytes);
        at += r.bytes.length;
        if (r.bytes.length < n) break; // the file is shorter now
      }
      return Buffer.concat(parts);
    },
    async close() { /* nothing is held open */ },
  };
}

// The basic reader: the console's own open, never through a link, a regular file only.
async function ownTranscript(path: string): Promise<Transcript | null> {
  let fh: FileHandle;
  try { fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { return null; }
  try {
    const st = await fh.stat();
    if (!st.isFile()) { await fh.close().catch(() => {}); return null; }
    const facts = { size: st.size, mtimeMs: st.mtimeMs, dev: String(st.dev), ino: String(st.ino) };
    return {
      facts,
      async read(pos, len) {
        const want = Math.max(0, Math.min(len, facts.size - pos));
        const buf = Buffer.allocUnsafe(want);
        let got = 0;
        while (got < want) {
          const { bytesRead } = await fh.read(buf, got, want - got, pos + got);
          if (bytesRead === 0) break; // the file shrank under us
          got += bytesRead;
        }
        return got === want ? buf : buf.subarray(0, got);
      },
      close: () => fh.close().catch(() => {}),
    };
  } catch {
    await fh.close().catch(() => {});
    return null;
  }
}

// One more read of this reader for another file of the agent's Claude folder (tasksread.ts:
// read-tasks, the Plan rail): the same gate, the same helper of the account. Resolves to the
// helper's stdout; throws with the helper's own last line (an older helper: "unknown verb: ...").
export function helperRead(a: { exec: AgentExec; claudeDir: string }, verb: "read-tasks", args: string[], o: { maxBuffer: number; timeout: number }, env: Env = process.env): Promise<Buffer> {
  const argv = helperArgv(a.exec, verb, args);
  return gated(() => new Promise<Buffer>((resolve, reject) => {
    (readers.run ?? realRun)(argv[0], argv.slice(1), {
      env: helperEnv({ ...env, CLAUDE_CONFIG_DIR: a.claudeDir }) as unknown as NodeJS.ProcessEnv,
      timeout: o.timeout, maxBuffer: o.maxBuffer, encoding: "buffer",
    }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr.toString("utf8").trim().split("\n").pop()?.slice(0, 300) || err.message.split("\n")[0]));
      resolve(stdout);
    });
  }));
}

// The session file of a resume (runtimes/claude.ts canResume), with strong protection: the
// helper's session-ensure, as the file's account. `path` is the file that `claude --resume` looks
// for (the project folder of the cwd). "present"; "linked": it was in another project folder of
// that account and is linked here now; "absent": no such session. Throws when the helper failed
// or refused (its own line): that is not "absent".
export type SessionEnsure = "present" | "linked" | "absent";
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function ensureSessionAsAgent(path: string, env: Env = process.env): Promise<SessionEnsure> {
  const a = transcriptAccount(path, env);
  if (!a) return Promise.reject(new Error("no helper reads this Claude folder"));
  const m = /\/projects\/([A-Za-z0-9_-]{1,255})\/([^/]+)\.jsonl$/.exec(path);
  if (!m || !SESSION_ID.test(m[2]) || !path.startsWith(`${a.claudeDir.replace(/\/+$/, "")}/projects/${m[1]}/`)) {
    return Promise.reject(new Error("not the session file of a project folder"));
  }
  const argv = helperArgv(a.exec, "session-ensure", [m[2], m[1]]);
  return gated(() => new Promise<SessionEnsure>((resolve, reject) => {
    (readers.run ?? realRun)(argv[0], argv.slice(1), {
      env: helperEnv({ ...env, CLAUDE_CONFIG_DIR: a.claudeDir }) as unknown as NodeJS.ProcessEnv,
      timeout: CALL_MS, maxBuffer: 4096, encoding: "buffer",
    }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr.toString("utf8").trim().split("\n").pop()?.slice(0, 300) || err.message.split("\n")[0]));
      const out = stdout.toString("utf8").trim();
      if (out === "present" || out === "absent") return resolve(out);
      if (/^linked [A-Za-z0-9_-]{1,255}$/.test(out)) return resolve("linked");
      reject(new Error("session-ensure: an answer of another shape"));
    });
  }));
}

// A session file (or a subagent's, or its meta file) for reading; null when it cannot be read.
export function openTranscript(path: string, first?: { pos: number; len: number }, env: Env = process.env): Promise<Transcript | null> {
  return helperSpawn(env) ? helperTranscript(path, first, env) : ownTranscript(path);
}
