// server/gh/handoff.ts — the hand-off of the ChoiBot GitHub app's token to the console's own
// gh and git calls (PR 1 of the GitHub app plan). The source is set once at start, and only
// when the switch is on (GITHUB_APP_LOGIN=1, server/gh/appconfig.ts). A call that asks gets a
// copy of its env with GH_TOKEN, for its one child. No source (the switch is off, the default)
// or no valid token: null, and the call runs exactly as before, with the stored login of the
// console user.
//
// gh: GH_TOKEN "takes precedence over previously stored credentials" (gh manual, `gh help
// environment`). git: the console user's credential helper for github.com is gh's (`gh auth
// setup-git`; in a hardened deployment gitEnv keeps it), and gh answers it with the username
// x-access-token and the GH_TOKEN of its env (gh 2.96: handoff.test.ts proves it with the real gh
// and the real git, offline). That is GitHub's form for an app's user token over HTTPS.
//
// The token is never in an argv, a log line or the console's own env: only in the env of the
// one child that asked. Who else can read it: see server/gh/appstore.ts.
export type TokenSource = () => Promise<string | null>;

let source: TokenSource | null = null;

// Set at start (server/index.ts), or null (tests).
export function setGithubTokenSource(s: TokenSource | null): void {
  source = s;
}

// A token goes into an env only in this form: no space, no line break.
export const TOKEN_RE = /^[A-Za-z0-9_]{16,255}$/;

// A copy of env with GH_TOKEN, or null when there is no source or no valid token.
export async function githubEnv(env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv | null> {
  if (!source) return null;
  let token: string | null;
  try { token = await source(); } catch { token = null; }
  if (!token || !TOKEN_RE.test(token)) return null;
  return { ...env, GH_TOKEN: token };
}

// The git subcommands that talk to a remote. Only these get the token.
const NETWORK = new Set(["fetch", "push", "pull", "ls-remote", "clone"]);
// Global options of git that take the next argument as their value.
const GLOBAL_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"]);

// The subcommand of a git argv (after the global options), or undefined.
export function gitSubcommand(args: readonly string[]): string | undefined {
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) i += GLOBAL_WITH_VALUE.has(args[i]) ? 2 : 1;
  return args[i];
}

export function gitTalksToRemote(args: readonly string[]): boolean {
  const sub = gitSubcommand(args);
  return sub !== undefined && NETWORK.has(sub);
}
