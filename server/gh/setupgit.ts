// server/gh/setupgit.ts — the one `gh auth setup-git` of the console: git then uses gh's
// credential helper for github.com (gh manual: `gh auth setup-git`). Every console path that
// writes the helper runs this: gh's own code login (setup/ghlogin.ts), the repo copy's second try
// (setup/repopick.ts) and the ChoiBot app login (gh/appsetup.ts).
// A hardened console (strong protection) reads the console user's global credential helpers once
// and keeps them for the process (agents/git.ts). So after a setup-git that ended well the kept
// list is dropped: the next console git call reads it again and sees gh's helper, with no restart.
// (A Disconnect of the app writes no helper: gh's helper stays, and it answers with no key.)
import { execFile } from "node:child_process";
import { gitOpts, resetCredentialHelpers } from "../agents/git.js";

export const SETUP_GIT_ARGS = ["auth", "setup-git", "--hostname", "github.com"];

export function ghSetupGit(o: { bin?: string; env: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<boolean> {
  return new Promise((done) => {
    execFile(o.bin ?? "gh", SETUP_GIT_ARGS, gitOpts(process.cwd(), { env: o.env, timeout: o.timeoutMs ?? 15_000 }), (err) => {
      if (!err) resetCredentialHelpers();
      done(!err);
    });
  });
}
