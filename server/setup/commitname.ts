// server/setup/commitname.ts — the name and the e-mail for commits on a new box. When git has
// none, the Connect GitHub step offers the ones of the GitHub login: the name of the account
// and its "noreply" address at GitHub (so the commits are the user's, and no private address
// goes into a repo). A value that git has is never changed: only a key with no value is set.
// Nothing here runs by itself: the row shows what it will set, and the user confirms.
import { runGit } from "../agents/git.js";
import { deadline } from "../chief/deadline.js";
import { gh } from "../gh/exec.js";

const TOOL_MS = 15_000;
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

export type CommitNameDeps = {
  // `git config --global <args>`: the output, or null when git gives none (a key with no value).
  gitConfig?: (args: string[]) => Promise<string | null>;
  // `gh api user`, as JSON text.
  ghUser?: () => Promise<string>;
};

export type CommitNameView = {
  // What git has now.
  name: boolean;
  email: boolean;
  // What the step will set for the keys with no value. Null: GitHub gave no login.
  suggest: { name: string; email: string } | null;
};

const realGitConfig = async (args: string[]): Promise<string | null> => {
  try {
    return (await runGit(process.cwd(), ["config", "--global", ...args], { timeout: TOOL_MS })).stdout;
  } catch {
    return null; // git gives exit 1 for a key that is not set
  }
};
const realGhUser = (): Promise<string> => deadline(gh(["api", "user"]), TOOL_MS, "the GitHub login");

// The name and the address from the answer of `gh api user`. Null: no usable login.
export function fromGithubUser(json: string): { name: string; email: string } | null {
  let u: { login?: unknown; id?: unknown; name?: unknown };
  try { u = JSON.parse(json) as typeof u; } catch { return null; }
  if (typeof u.login !== "string" || !LOGIN_RE.test(u.login)) return null;
  if (typeof u.id !== "number" || !Number.isSafeInteger(u.id) || u.id <= 0) return null;
  // The name of the account, in one line. An account with no name: its login.
  const shown = typeof u.name === "string" ? u.name.replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").replace(/^[-\s]+/, "").trim().slice(0, 100) : "";
  return { name: shown || u.login, email: `${u.id}+${u.login}@users.noreply.github.com` };
}

async function has(gitConfig: NonNullable<CommitNameDeps["gitConfig"]>, key: string): Promise<boolean> {
  return ((await gitConfig(["--get", key])) ?? "").trim() !== "";
}

export async function commitNameView(d: CommitNameDeps = {}): Promise<CommitNameView> {
  const gitConfig = d.gitConfig ?? realGitConfig;
  const [name, email] = [await has(gitConfig, "user.name"), await has(gitConfig, "user.email")];
  if (name && email) return { name, email, suggest: null };
  const suggest = await (d.ghUser ?? realGhUser)().then(fromGithubUser, () => null);
  return { name, email, suggest };
}

export type CommitNameResult =
  | { ok: true; wrote: ("name" | "email")[] }
  | { ok: false; reason: "no-login" | "failed" };

// Sets the keys that have no value. A key with a value stays as it is.
export async function setCommitName(d: CommitNameDeps = {}): Promise<CommitNameResult> {
  const gitConfig = d.gitConfig ?? realGitConfig;
  const view = await commitNameView(d);
  if (view.name && view.email) return { ok: true, wrote: [] };
  if (!view.suggest) return { ok: false, reason: "no-login" };
  const wrote: ("name" | "email")[] = [];
  for (const part of ["name", "email"] as const) {
    if (view[part]) continue;
    // Read again right before the write: a value that came in meanwhile stays.
    if (await has(gitConfig, `user.${part}`)) continue;
    if ((await gitConfig([`user.${part}`, view.suggest[part]])) === null) return { ok: false, reason: "failed" };
    wrote.push(part);
  }
  return { ok: true, wrote };
}

// The name and the e-mail that git has now, or null when one of them has no value.
export async function currentCommitName(d: CommitNameDeps = {}): Promise<{ name: string; email: string } | null> {
  const gitConfig = d.gitConfig ?? realGitConfig;
  const name = ((await gitConfig(["--get", "user.name"])) ?? "").trim();
  const email = ((await gitConfig(["--get", "user.email"])) ?? "").trim();
  return name && email ? { name, email } : null;
}

// Strong protection: the agents' account gets the same name (agentGitIdentity). False: the
// console has no name yet, or the helper did not set it.
export async function shareCommitName(give: (name: string, email: string) => Promise<boolean>, d: CommitNameDeps = {}): Promise<boolean> {
  const cur = await currentCommitName(d);
  return cur ? give(cur.name, cur.email) : false;
}
