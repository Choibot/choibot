// Part 3 of design B: the console's push and pull request for an agent with its own clone. Real
// git in a throwaway folder, the real helper (upload-pack) behind a fake sudo, local bare repos for
// "GitHub" (the console's own config sends https://github.com/acme/myrepo.git there), and a fake
// gh. Never a real GitHub call, never the real gh, never the real sudo.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentRef, dropAgentRefs, fetchAgentBranch } from "../agents/agentclone.js";
import { BASE_FETCH_GAP_MS, ClonePrError, clonePrInput, clonePushAndPr, fetchBaseFromGitHub, githubRemote, resetBaseFetches } from "./clonepr.js";

const HELPER = fileURLToPath(new URL("../../deploy/choibot-agent-exec", import.meta.url));
const DTACH_BIN = (() => { try { return execFileSync("/bin/sh", ["-c", "command -v dtach || echo /home/dev/.local/bin/dtach"], { encoding: "utf8" }).trim(); } catch { return "/usr/bin/dtach"; } })();
const ID = "a1";
const BRANCH = "agent/a1";

let dir = "";
let repo = "";      // the console's own repo in the workspace
let github = "";    // the recorded remote (a local bare repo)
let evil = "";      // where the agent's config tries to send the push
let clone = "";     // the agent's own clone
let marks = "";     // each hostile command writes here
let folders = { clones: "", uploads: "", settings: "" };
let X = { sudo: "", helper: HELPER, uid: process.getuid?.() ?? 0 };
const ghCalls: { args: string[]; cwd?: string; input?: string }[] = [];
const fakeGh = async (args: string[], o?: { cwd?: string; input?: string }) => { ghCalls.push({ args, cwd: o?.cwd, input: o?.input }); return "https://github.com/acme/myrepo/pull/7\n"; };

const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "init.defaultBranch=main", ...a], { cwd, encoding: "utf8" }).trim();
const marked = () => (existsSync(marks) ? readdirSync(marks).sort() : []);
const rec = (o: Partial<{ branch: string; baseBranch: string; prUrl: string; prNumber: number }> = {}) => ({ id: ID, repo, branch: BRANCH, baseBranch: "main", ...o });
const deps = () => ({ exec: X, folders, gh: fakeGh, ghCwd: join(dir, "data") });

beforeEach(() => {
  ghCalls.length = 0;
  resetBaseFetches();
  dir = realpathSync(mkdtempSync(join(tmpdir(), "clonepr-")));
  marks = join(dir, "marks");
  mkdirSync(marks);
  mkdirSync(join(dir, "data"));
  github = join(dir, "github.git");
  evil = join(dir, "evil.git");
  git(dir, "init", "-q", "--bare", github);
  git(dir, "init", "-q", "--bare", evil);
  // The console's repo: origin is the GitHub address; the console's own config sends it to `github`.
  repo = join(dir, "ws", "myrepo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q");
  writeFileSync(join(repo, "README.md"), "hello\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-qm", "first");
  git(repo, "remote", "add", "origin", "https://github.com/acme/myrepo.git");
  git(repo, "config", `url.${github}.insteadOf`, "https://github.com/acme/myrepo.git");
  git(repo, "push", "-q", "origin", "main");
  git(repo, "fetch", "-q", "origin");
  git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  // The helper's roots and the agent's clone (as repo-clone makes it, by hand here).
  const homes = join(dir, "homes");
  folders = { clones: join(homes, "clones"), uploads: join(homes, "uploads"), settings: join(homes, "settings") };
  for (const d of Object.values(folders)) mkdirSync(d, { recursive: true });
  mkdirSync(join(dir, "dtach"));
  const conf = join(dir, "agent-exec.conf");
  writeFileSync(conf, [`DTACH_DIR=${join(dir, "dtach")}`, `DTACH_BIN=${DTACH_BIN}`, `WORKTREE_ROOT=${join(dir, "wt")}`, `WORKSPACE_DIR=${join(dir, "ws")}`, `AGENT_HOME_ROOT=${homes}`, ""].join("\n"));
  mkdirSync(join(dir, "wt"));
  clone = join(folders.clones, ID);
  git(dir, "clone", "-q", "--no-local", "--origin", "console", repo, clone);
  git(clone, "checkout", "-q", "-b", BRANCH);
  // A fake sudo: drops its own options and resets the env, as sudo does; then the real helper.
  const sudo = join(dir, "fake-sudo");
  writeFileSync(sudo, `#!/bin/sh\nshift 3\nexec /usr/bin/env -i PATH=/usr/bin:/bin CHOIBOT_AGENT_EXEC_CONF=${conf} "$@"\n`);
  chmodSync(sudo, 0o755);
  X = { sudo, helper: HELPER, uid: process.getuid?.() ?? 0 };
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

// The agent's work: a commit on its branch, made in its clone.
function agentCommit(file = "work.txt", text = "work\n"): string {
  writeFileSync(join(clone, file), text);
  git(clone, "add", file);
  git(clone, "commit", "-qm", `agent: ${file}`);
  return git(clone, "rev-parse", "HEAD");
}

// Every place where an agent's repo can name a command or another address. Set after the agent's
// own commits (its own git would run them), so a mark can only come from the console's actions.
function makeHostile(): void {
  const cmd = (name: string) => {
    const p = join(dir, `evil-${name}`);
    writeFileSync(p, `#!/bin/sh\ntouch ${join(marks, name)}\ncat >/dev/null 2>&1\nexit 0\n`);
    chmodSync(p, 0o755);
    return p;
  };
  const c = (k: string, v: string) => git(clone, "config", k, v);
  c("url." + evil + ".insteadOf", "https://github.com/");
  c("url." + evil + ".pushInsteadOf", "https://github.com/");
  c("remote.console.pushurl", evil);
  c("core.sshCommand", cmd("ssh"));
  c("credential.helper", `!${cmd("credential")}`);
  c("core.fsmonitor", cmd("fsmonitor"));
  c("filter.evil.clean", cmd("filter-clean"));
  c("filter.evil.smudge", cmd("filter-smudge"));
  c("diff.external", cmd("diff"));
  c("core.pager", cmd("pager"));
  c("alias.fetch", `!${cmd("alias-fetch")}`);
  c("alias.push", `!${cmd("alias-push")}`);
  c("uploadpack.packObjectsHook", cmd("pack-objects-hook"));
  c("core.hooksPath", join(clone, ".git", "hooks"));
  for (const h of ["pre-push", "reference-transaction", "post-update", "pre-receive", "update", "post-checkout", "pre-auto-gc", "push-to-checkout"]) {
    writeFileSync(join(clone, ".git", "hooks", h), `#!/bin/sh\ntouch ${join(marks, `hook-${h}`)}\n`);
    chmodSync(join(clone, ".git", "hooks", h), 0o755);
  }
}

describe("githubRemote: the push address from the console's own origin, written again", () => {
  it("takes the three github.com forms with a strict owner and name; anything else is no address", () => {
    expect(githubRemote("https://github.com/acme/myrepo.git")).toEqual({ slug: "acme/myrepo", pushUrl: "https://github.com/acme/myrepo.git" });
    expect(githubRemote("https://github.com/acme/my.repo")).toEqual({ slug: "acme/my.repo", pushUrl: "https://github.com/acme/my.repo.git" });
    expect(githubRemote("git@github.com:acme/myrepo.git")).toEqual({ slug: "acme/myrepo", pushUrl: "git@github.com:acme/myrepo.git" });
    expect(githubRemote("ssh://git@github.com/acme/myrepo")).toEqual({ slug: "acme/myrepo", pushUrl: "git@github.com:acme/myrepo.git" });
    for (const bad of ["https://github.com.evil.com/acme/myrepo", "https://user@github.com/acme/myrepo", "https://github.com:8443/acme/myrepo",
      "https://github.com/acme/myrepo/more", "https://github.com/acme/..", "https://github.com/-acme/myrepo", "file:///srv/x", "/srv/x", "",
      "https://gitlab.com/acme/myrepo", "git@github.com:acme/my repo"]) expect([bad, githubRemote(bad)]).toEqual([bad, null]);
  });

  it("clonePrInput: one line of title, a body of at most 64 KB, draft true or false; the branch when no title", () => {
    expect(clonePrInput({}, BRANCH)).toEqual({ title: BRANCH, body: "", draft: false });
    expect(clonePrInput({ title: " -x Fix ", body: "b", draft: true }, BRANCH)).toEqual({ title: "-x Fix", body: "b", draft: true });
    expect(clonePrInput({ title: "a\nb" }, BRANCH)).toMatch(/one line/);
    expect(clonePrInput({ title: "x".repeat(257) }, BRANCH)).toMatch(/one line/);
    expect(clonePrInput({ body: "x".repeat(65_537) }, BRANCH)).toMatch(/at most 65536 bytes/);
    expect(clonePrInput({ draft: "yes" }, BRANCH)).toMatch(/draft/);
  });
});

describe("the console fetches the agent's branch through upload-pack as the agent, then pushes it from its own repo", () => {
  it("a hostile clone: no command of it runs, the push lands in the recorded remote only, the PR has --repo and the body on stdin", async () => {
    writeFileSync(join(clone, ".gitattributes"), "* filter=evil diff=evil\n");
    git(clone, "add", ".gitattributes");
    const sha = agentCommit();
    makeHostile();
    expect(marked()).toEqual([]);
    const pr = await clonePushAndPr(rec(), { title: "-x title", body: "the body\nline 2", draft: true }, deps());
    expect(pr).toEqual({ url: "https://github.com/acme/myrepo/pull/7", number: 7, sha });
    expect(marked()).toEqual([]);
    // The commit is in the console's name space, never a branch of the console's repo.
    expect(git(repo, "rev-parse", agentRef(ID, BRANCH))).toBe(sha);
    expect(git(repo, "branch", "--format=%(refname:short)")).toBe("main");
    // GitHub (the recorded remote) has the branch; the agent's address got nothing.
    expect(git(github, "rev-parse", `refs/heads/${BRANCH}`)).toBe(sha);
    expect(git(evil, "for-each-ref")).toBe("");
    expect(ghCalls).toEqual([{
      args: ["pr", "create", "--repo=acme/myrepo", `--head=${BRANCH}`, "--base=main", "--title=-x title", "--body-file=-", "--draft"],
      cwd: join(dir, "data"), input: "the body\nline 2",
    }]);
  });

  it("links in the agent's repo (a reflog, a ref folder) do not make the console's fetch write outside its repo", async () => {
    agentCommit();
    const secret = join(dir, "console-secret.txt");
    writeFileSync(secret, "SECRET\n");
    const consoleDir = join(dir, "console-dir");
    mkdirSync(consoleDir);
    rmSync(join(clone, ".git", "logs", "refs", "heads", "agent", "a1"));
    symlinkSync(secret, join(clone, ".git", "logs", "refs", "heads", "agent", "a1"));
    symlinkSync(consoleDir, join(clone, ".git", "refs", "heads", "feature"));
    await fetchAgentBranch(X, folders, repo, ID, BRANCH);
    expect(readFileSync(secret, "utf8")).toBe("SECRET\n");
    expect(readdirSync(consoleDir)).toEqual([]);
    expect(git(repo, "for-each-ref", "--format=%(refname)", "refs/agents/")).toBe(agentRef(ID, BRANCH));
  });

  it("clones/<id> as a bundle file, or as a link to one: the console's git never reads it (a file:// address runs the helper, which refuses); no ref, nothing pushed", async () => {
    agentCommit();
    const bundle = join(dir, "agent.bundle");
    git(clone, "bundle", "create", "-q", bundle, BRANCH);
    rmSync(clone, { recursive: true });
    for (const shape of ["link", "file"] as const) {
      if (shape === "link") symlinkSync(bundle, clone);
      else writeFileSync(clone, readFileSync(bundle));
      const e = await clonePushAndPr(rec(), { title: "t", body: "", draft: false }, deps()).catch((x: unknown) => x);
      expect([shape, (e as ClonePrError).code, (e as Error).message]).toEqual([shape, 502, expect.stringMatching(/no clone of a1/)]);
      expect(git(repo, "for-each-ref", "refs/agents/")).toBe("");
      expect(git(github, "for-each-ref", `refs/heads/${BRANCH}`)).toBe("");
      rmSync(clone, { force: true });
    }
    expect(ghCalls).toEqual([]);
  });

  it("a path of the agent's copy with a character outside [A-Za-z0-9._/-] is refused before any git", async () => {
    await expect(fetchAgentBranch(X, { ...folders, clones: join(dir, "odd clones") }, repo, ID, BRANCH)).rejects.toThrow(/does not give git/);
    expect(git(repo, "for-each-ref", "refs/agents/")).toBe("");
  });

  it("fetch.fsckObjects: a broken commit from the agent's repo is refused; nothing is pushed", async () => {
    const tree = git(clone, "rev-parse", "HEAD^{tree}");
    const parent = git(clone, "rev-parse", "HEAD");
    const bad = execFileSync("git", ["hash-object", "-t", "commit", "--literally", "-w", "--stdin"], { cwd: clone, input: `tree ${tree}\nparent ${parent}\nauthor no email 1700000000 +0000\ncommitter t <t@t.invalid> 1700000000 +0000\n\nbad\n`, encoding: "utf8" }).trim();
    git(clone, "update-ref", `refs/heads/${BRANCH}`, bad);
    const e = await clonePushAndPr(rec(), { title: "t", body: "", draft: false }, deps()).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ClonePrError);
    expect((e as ClonePrError).code).toBe(502);
    expect(git(github, "for-each-ref", `refs/heads/${BRANCH}`)).toBe("");
    expect(ghCalls).toEqual([]);
  });

  it("fast-forward only: a later call pushes new commits to the same pull request; GitHub commits that the branch lacks give 409, never a force push", async () => {
    agentCommit("one.txt");
    const first = await clonePushAndPr(rec(), { title: "t", body: "", draft: false }, deps());
    const two = agentCommit("two.txt");
    const again = await clonePushAndPr(rec({ prUrl: first.url, prNumber: first.number }), { title: "t", body: "", draft: false }, deps());
    expect(again).toEqual({ ...first, sha: two });
    expect(git(github, "rev-parse", `refs/heads/${BRANCH}`)).toBe(two);
    expect(ghCalls).toHaveLength(1);
    // Someone else pushes to the branch on GitHub; the agent's next commit is not a fast-forward.
    const other = join(dir, "other");
    git(dir, "clone", "-q", github, other);
    git(other, "checkout", "-q", BRANCH);
    writeFileSync(join(other, "x.txt"), "x\n");
    git(other, "add", "x.txt");
    git(other, "commit", "-qm", "other");
    git(other, "push", "-q", "origin", BRANCH);
    const otherSha = git(other, "rev-parse", "HEAD");
    agentCommit("three.txt");
    const e = await clonePushAndPr(rec({ prUrl: first.url, prNumber: first.number }), { title: "t", body: "", draft: false }, deps()).catch((x: unknown) => x);
    expect([(e as ClonePrError).code, (e as Error).message]).toEqual([409, expect.stringMatching(/never force-pushes/)]);
    expect(git(github, "rev-parse", `refs/heads/${BRANCH}`)).toBe(otherSha);
  });

  it("refuses before any fetch: a kept branch, the base itself, the default branch, no GitHub address, no base on GitHub; and a branch with no new commit", async () => {
    agentCommit();
    const refused = async (r: ReturnType<typeof rec>, why: RegExp, code = 409) => {
      const e = await clonePushAndPr(r, { title: "t", body: "", draft: false }, deps()).catch((x: unknown) => x);
      expect([r.branch, (e as ClonePrError).code, (e as Error).message]).toEqual([r.branch, code, expect.stringMatching(why)]);
    };
    for (const b of ["main", "master", "release/1.0", "gh-pages", "Production"]) await refused(rec({ branch: b }), /does not push to/);
    await refused(rec({ branch: "feature", baseBranch: "feature" }), /does not push to/);
    await refused(rec({ branch: "-x" }), /name that the console does not push/, 400);
    git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/agent/a1");
    await refused(rec(), /default branch/);
    git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    await refused(rec({ baseBranch: "nope" }), /not on GitHub/);
    git(repo, "config", "remote.origin.url", "https://gitlab.com/acme/myrepo.git");
    await refused(rec(), /no GitHub address/, 400);
    git(repo, "config", "remote.origin.url", "https://github.com/acme/myrepo.git");
    expect(git(repo, "for-each-ref", "refs/agents/")).toBe("");
    // The agent's branch at the base: nothing to push.
    git(clone, "reset", "-q", "--hard", git(repo, "rev-parse", "main"));
    await refused(rec(), /no commit that main does not have/);
    expect(git(github, "for-each-ref", `refs/heads/${BRANCH}`)).toBe("");
    expect(ghCalls).toEqual([]);
  });

  it("the agent's refs of the console go when the agent is deleted", async () => {
    agentCommit();
    await fetchAgentBranch(X, folders, repo, ID, BRANCH);
    await dropAgentRefs(repo, ID);
    expect(git(repo, "for-each-ref", "refs/agents/")).toBe("");
  });
});

describe("fetch-base: the console fetches the base from GitHub into its own repo, one at a time, at most once in the gap", () => {
  it("N calls at once = 1 fetch; a call in the gap = no fetch; after the gap = a fetch; the agent then gets it with git fetch console", async () => {
    // Count the fetches of the console's repo from "GitHub".
    const log = join(dir, "fetches.log");
    const up = join(dir, "counting-upload-pack");
    writeFileSync(up, `#!/bin/sh\necho x >> ${log}\nexec git upload-pack "$@"\n`);
    chmodSync(up, 0o755);
    git(repo, "config", "remote.origin.uploadpack", up);
    const count = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0);
    // A new commit on GitHub's main.
    const other = join(dir, "other");
    git(dir, "clone", "-q", github, other);
    writeFileSync(join(other, "new.txt"), "n\n");
    git(other, "add", "new.txt");
    git(other, "commit", "-qm", "new on main");
    git(other, "push", "-q", "origin", "main");
    const tip = git(other, "rev-parse", "HEAD");
    let t = 1_000_000;
    const now = () => t;
    const all = await Promise.all(Array.from({ length: 4 }, () => fetchBaseFromGitHub(repo, "main", now)));
    expect(count()).toBe(1);
    expect(all.map((r) => r.sha)).toEqual([tip, tip, tip, tip]);
    expect(all.filter((r) => r.fetched)).toHaveLength(1);
    expect((await fetchBaseFromGitHub(repo, "main", now)).fetched).toBe(false);
    t += BASE_FETCH_GAP_MS;
    expect((await fetchBaseFromGitHub(repo, "main", now)).fetched).toBe(true);
    expect(count()).toBe(2);
    expect(git(repo, "rev-parse", "refs/remotes/origin/main")).toBe(tip);
    await expect(fetchBaseFromGitHub(repo, "-x", now)).rejects.toThrow(/does not fetch/);
  });
});
