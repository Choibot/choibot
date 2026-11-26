// server/gh/appsetup.ts — after a ChoiBot app login: make git use gh's credential helper for
// github.com, as `gh auth login` did before (`gh auth setup-git`). The one gh child gets the app's
// GH_TOKEN (handoff.ts): gh 2.96 sets up the helper with it, and with no login and no GH_TOKEN it
// refuses ("You are not logged into the GitHub host"). A failure changes nothing; the copy of a
// repo tries the same call again (setup/repopick.ts).
import { githubEnv } from "./handoff.js";
import { ghSetupGit } from "./setupgit.js";

export async function setupGitForApp(o: { bin?: string; env?: NodeJS.ProcessEnv; log?: (s: string) => void } = {}): Promise<boolean> {
  const base = o.env ?? process.env;
  const env = await githubEnv(base);
  if (!env) return false;
  const ok = await ghSetupGit({ ...(o.bin ? { bin: o.bin } : {}), env });
  if (!ok) (o.log ?? ((s: string) => console.warn(s)))("[github] git does not use the app's key yet (gh auth setup-git failed)");
  return ok;
}
