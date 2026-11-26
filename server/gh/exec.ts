// server/gh/exec.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { gitOpts } from "../agents/git.js";
import { githubEnv } from "./handoff.js";

const run = promisify(execFile);
const GH_MAX_BUFFER = 32 * 1024 * 1024;

export type ErrorKind =
  | "not_authed" | "no_github_remote" | "not_fast_forward"
  | "rate_limited" | "not_found" | "already_exists" | "unknown";

export class GhError extends Error {
  constructor(public kind: ErrorKind, message: string, public url?: string) {
    super(message);
    this.name = "GhError";
  }
}

const RULES: Array<[RegExp, ErrorKind]> = [
  [/not logged in|gh auth login|authentication required|no oauth token/i, "not_authed"],
  [/non-fast-forward|tip of your current branch is behind|updates were rejected/i, "not_fast_forward"],
  [/already exists/i, "already_exists"],
  [/does not appear to be a git repository|no such remote|remote origin/i, "no_github_remote"],
  [/rate limit/i, "rate_limited"],
  [/could not resolve to a|not found|no pull requests found/i, "not_found"],
];

export function classifyError(stderr: string): ErrorKind {
  for (const [re, kind] of RULES) if (re.test(stderr)) return kind;
  return "unknown";
}

export function extractPrUrl(text: string): string | undefined {
  return text.match(/https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/)?.[0];
}

// Run `gh` with the ambient token env (inherited from the server process).
// gh runs git in cwd: in a hardened deployment it gets the console git
// overrides (gitOpts), so that git runs no repo hook or driver either. Every
// caller's cwd is a main repo (a workspace repo or a record's `repo`), pinned
// as the common dir (ruling 2c-6-d).
// `input`: written to gh's stdin (a PR body with --body-file -).
// With the GitHub app switch on and an app token, the one gh child gets GH_TOKEN (handoff.ts);
// else its env is exactly as before.
export async function gh(args: string[], opts: { cwd?: string; input?: string } = {}): Promise<string> {
  try {
    const tokenEnv = await githubEnv(process.env);
    const base = tokenEnv ? { cwd: opts.cwd, maxBuffer: GH_MAX_BUFFER, env: tokenEnv } : { cwd: opts.cwd, maxBuffer: GH_MAX_BUFFER };
    if (opts.input === undefined) {
      const { stdout } = await run("gh", args, gitOpts(opts.cwd ?? process.cwd(), base, process.env, opts.cwd));
      return stdout;
    }
    const input = opts.input;
    return await new Promise<string>((res, rej) => {
      const child = execFile("gh", args, gitOpts(opts.cwd ?? process.cwd(), base, process.env, opts.cwd),
        (err, stdout, stderr) => (err ? rej(Object.assign(err, { stdout, stderr })) : res(String(stdout))));
      child.stdin?.on("error", () => { /* gh exited before reading */ });
      child.stdin?.end(input);
    });
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message?: string };
    const text = String(err.stderr || err.stdout || err.message || e);
    throw new GhError(classifyError(text), text.trim().slice(0, 600), extractPrUrl(text));
  }
}

export async function ghJson<T>(args: string[], opts: { cwd?: string } = {}): Promise<T> {
  return JSON.parse(await gh(args, opts)) as T;
}
