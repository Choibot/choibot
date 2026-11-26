// src/components/AgentLauncher.tsx
"use client";
import { useEffect, useRef, useState } from "react";
import { fetchRepos, fetchBranches, spawnAgent, type RepoInfo } from "../lib/agents";
import { RUNTIMES, type RuntimeId } from "../lib/runtimes";
import { fetchAccountsState, accountShort, DEFAULT_ACCOUNT, type AccountInfo } from "../lib/accounts";
import { Dropdown } from "./Dropdown";
import { CloseIcon, PlusIcon } from "./SideIcons";
import s from "./AgentSidebar.module.css";

// `heading` false: the dialog's own header names the form. Adding a repo or a Claude login is in
// Settings now: `onManage` opens its section ("repos", "accounts"). `reloadSignal`: read the repos
// and the logins again (the dialog bumps it on each open, so one added in Settings shows).
export function AgentLauncher({ onSpawned, heading = true, onManage, reloadSignal = 0 }: {
  onSpawned: (id: string) => void; heading?: boolean; onManage?: (section: "repos" | "accounts") => void; reloadSignal?: number;
}) {
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [repoPath, setRepoPath] = useState("");
  const [localBranches, setLocalBranches] = useState<string[]>([]);
  const [remoteBranches, setRemoteBranches] = useState<string[]>([]);
  const [baseBranch, setBaseBranch] = useState("");
  // The branch the agent commits to (push/PR this). Blank → server defaults to
  // a generated agent/<id> branch, so naming it stays optional.
  const [workBranch, setWorkBranch] = useState("");
  // Claude is the server-side default, so starting here keeps an untouched
  // launcher behaving exactly as it did before runtimes existed.
  const [runtime, setRuntime] = useState<RuntimeId>("claude");
  // Claude logins on the box. The default is the server-side default too, so a
  // console with one login launches exactly as before and never sees the row.
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [account, setAccount] = useState(DEFAULT_ACCOUNT);
  const [spawnErr, setSpawnErr] = useState("");
  // "+ New branch" form
  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newFrom, setNewFrom] = useState("");

  useEffect(() => { void fetchRepos().then((r) => setRepos(r.repos)).catch(() => {}); }, [reloadSignal]);
  // The first read picks the preferred login; a later one (the dialog opened again) keeps the pick
  // while that login still exists.
  const acctRead = useRef(false);
  useEffect(() => {
    void fetchAccountsState().then(({ accounts: a, preferred }) => {
      setAccounts(a);
      const first = !acctRead.current;
      acctRead.current = true;
      setAccount((cur) => (!first && a.some((x) => x.id === cur) ? cur : a.some((x) => x.id === preferred) ? preferred : DEFAULT_ACCOUNT));
    }).catch(() => {});
  }, [reloadSignal]);

  // A "no repo" agent that runs at the workspace root, spanning every repo.
  // This is the default: with nothing chosen (or the explicit entry picked) the
  // agent launches at the workspace root.
  const WORKSPACE = "__workspace__";
  const isWorkspace = !repoPath || repoPath === WORKSPACE;

  // When a repo is picked, load its branches and default to the repo's default
  // branch (main/master), so agents fork from the mainline rather than whatever
  // the local checkout happens to be on; the checkout is the fallback when no
  // default exists. The workspace agent has no single repo/branch, so skip.
  useEffect(() => {
    setNewOpen(false); setNewName(""); setWorkBranch(""); setSpawnErr("");
    if (!repoPath || repoPath === WORKSPACE) { setLocalBranches([]); setRemoteBranches([]); setBaseBranch(""); return; }
    let live = true;
    void fetchBranches(repoPath)
      .then((b) => {
        if (!live) return;
        const preselect = b.defaultBranch ?? b.current;
        setLocalBranches(b.local); setRemoteBranches(b.remote);
        setBaseBranch(preselect); setNewFrom(preselect);
      })
      .catch(() => { if (live) { setLocalBranches([]); setRemoteBranches([]); setBaseBranch(""); } });
    return () => { live = false; };
  }, [repoPath]);

  const selectedRepo = repos.find((r) => r.path === repoPath);

  const branchOptions = [
    ...localBranches.map((b) => ({ value: b, label: b, group: "local" })),
    ...remoteBranches.map((b) => ({ value: b, label: b, group: "remote" })),
  ];

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setSpawnErr("");
        try {
          const work = workBranch.trim() || undefined;
          // Accounts are a Claude login. The choice is always sent, so picking
          // "default" means the box's own login even when the server has a
          // different preferred account (CLAUDE_DEFAULT_ACCOUNT).
          const acct = runtime === "claude" ? account : undefined;
          if (isWorkspace) {
            // No repo, branch, or base — the server spawns the agent at the
            // workspace root and it works across the live repos.
            onSpawned(await spawnAgent({ repo: WORKSPACE, runtime, account: acct }));
            return;
          }
          if (newOpen) {
            const name = newName.trim();
            if (!name) { setSpawnErr("enter a branch name"); return; }
            onSpawned(await spawnAgent({
              repo: repoPath, baseBranch: name,
              createFrom: newFrom || baseBranch || selectedRepo?.branch,
              branch: work, runtime, account: acct,
            }));
          } else {
            // Blank base (branch fetch failed) → let the server pick the repo's
            // default branch rather than pinning the stale local checkout here.
            onSpawned(await spawnAgent({ repo: repoPath, baseBranch: baseBranch || undefined, branch: work, runtime, account: acct }));
          }
        } catch (err) {
          setSpawnErr(err instanceof Error ? err.message : "failed to start");
        }
      }}
      className={s.launcher}
    >
      {heading && <h3 className={s.h}>New agent</h3>}
      {/* Plain segmented control — deliberately NOT the ARIA tab pattern (that
          contract wants tabpanel wiring + arrow-key focus); toggle buttons with
          aria-pressed describe exactly what these are. The group carries the
          label, since the buttons only read as runtime names on their own. */}
      <div className={s.runtimes} role="group" aria-label="Runtime">
        {/* Visible name for the field; hidden from AT because the group's
            aria-label already says it, and a second "runtime" is just noise. */}
        <span className={s.runtimesLabel} aria-hidden="true">runtime</span>
        {RUNTIMES.map((r) => (
          <button
            key={r.id}
            type="button"
            aria-pressed={runtime === r.id}
            className={`${s.runtime} ${runtime === r.id ? s.runtimeActive : ""}`}
            onClick={() => setRuntime(r.id)}
          >
            {r.label}
          </button>
        ))}
      </div>
      {/* Which Claude login the agent runs under. Only shown once the box has a
          second login (or while adding one): a one-login console keeps the
          launcher exactly as dense as it was. */}
      {runtime === "claude" && accounts.length > 1 && (
        <div className={s.acctRow}>
          <span className={s.acctLabel}>account</span>
          <Dropdown
            value={account}
            placeholder="account…"
            options={accounts.map((a) => ({ value: a.id, label: accountShort(a) }))}
            onChange={setAccount}
          />
        </div>
      )}
      {runtime === "claude" && account !== DEFAULT_ACCOUNT && !accounts.find((a) => a.id === account)?.loggedIn && (
        <p className={s.hint}>This login is not logged in yet. Log in to it first: Settings, Claude accounts.</p>
      )}
      <Dropdown
        value={repoPath}
        placeholder="no repo — workspace root (default)"
        // Just the repo name — the base-branch picker below shows the branch
        // (defaulted to the repo's current one), so repeating it here is noise.
        // The workspace entry spawns an agent at the root with no repo selected.
        options={[
          { value: WORKSPACE, label: "Workspace (no repo)" },
          ...repos.map((r) => ({ value: r.path, label: r.name })),
        ]}
        onChange={setRepoPath}
      />
      {isWorkspace && (
        <p className={s.hint}>Runs at the workspace root across all repos — no branch or worktree.</p>
      )}
      {repoPath && !isWorkspace && branchOptions.length > 0 && !newOpen && (
        <Dropdown
          value={baseBranch}
          placeholder="base branch (fork from / merge to)…"
          options={branchOptions}
          onChange={setBaseBranch}
        />
      )}
      {repoPath && !isWorkspace && !newOpen && (
        <input
          className={s.control}
          value={workBranch}
          placeholder="branch to work on (optional, e.g. feat/add-login)"
          onChange={(e) => setWorkBranch(e.target.value)}
        />
      )}
      {repoPath && !isWorkspace && (newOpen ? (
        <div className={s.newBranch}>
          <input
            className={s.control}
            value={newName}
            autoFocus
            placeholder="new branch name"
            onChange={(e) => setNewName(e.target.value)}
          />
          <Dropdown
            value={newFrom}
            placeholder="from…"
            options={branchOptions}
            onChange={setNewFrom}
          />
          <button type="button" className={s.addCancel} onClick={() => { setNewOpen(false); setNewName(""); setSpawnErr(""); }}>
            Cancel
          </button>
        </div>
      ) : (
        <button type="button" className={s.addRepo} onClick={() => { setNewOpen(true); setSpawnErr(""); }}>
          <PlusIcon size={14} />New branch
        </button>
      ))}
      {spawnErr ? <p className={s.addErr}>{spawnErr}</p> : null}
      {/* Adding a repo or a Claude login is in Settings (its Repos and Claude accounts sections). */}
      {onManage && (
        <div className={s.manage}>
          <button type="button" className={s.manageLink} onClick={() => onManage("repos")}>Manage repos</button>
          {runtime === "claude" && <button type="button" className={s.manageLink} onClick={() => onManage("accounts")}>Manage accounts</button>}
        </div>
      )}
      <button type="submit" className={s.start}>
        Start session{selectedRepo ? ` in ${selectedRepo.name}` : " in workspace"}
      </button>
    </form>
  );
}

// The desktop sidebar's "+": the same launcher in a modal <dialog>. It stays mounted, so the form
// keeps what you picked between opens. Escape and a click outside close it (Escape first closes an
// open dropdown inside it); on open the focus goes to the first field.
// `onManage`: a "Manage repos" / "Manage accounts" link was pressed (the page opens Settings there).
export function NewAgentDialog({ open, onClose, onSpawned, onManage }: {
  open: boolean; onClose: () => void; onSpawned: (id: string) => void; onManage?: (section: "repos" | "accounts") => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  // Bumped on each open: the launcher reads the repos and the logins again.
  const [opens, setOpens] = useState(0);
  useEffect(() => { if (open) setOpens((n) => n + 1); }, [open]);
  const downOnBackdrop = useRef(false);
  // Escape while a dropdown is open closes only the dropdown. Read in the capture phase: the
  // dropdown's own keydown listener closes it before the dialog's cancel event fires.
  const escForMenu = useRef(false);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      d.querySelector<HTMLElement>("form button, form input, form select, form textarea")?.focus();
    } else if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={s.dialog}
      aria-labelledby="new-agent-title"
      onClose={onClose}
      onKeyDownCapture={(e) => { escForMenu.current = e.key === "Escape" && !!ref.current?.querySelector("[data-dropdown-open]"); }}
      onCancel={(e) => { if (escForMenu.current) e.preventDefault(); escForMenu.current = false; }}
      // A click on the backdrop targets the <dialog> itself (its content fills the box). Only a
      // press that also started there closes it, so a drag out of a text field does not.
      onMouseDown={(e) => { downOnBackdrop.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (downOnBackdrop.current && e.target === e.currentTarget) onClose(); downOnBackdrop.current = false; }}
    >
      <div className={s.dialogHead}>
        <h2 id="new-agent-title" className={s.dialogTitle}>New agent</h2>
        <button type="button" className={s.dialogClose} aria-label="Close" title="Close (Esc)" onClick={onClose}><CloseIcon /></button>
      </div>
      <AgentLauncher heading={false} onSpawned={onSpawned} onManage={onManage} reloadSignal={opens} />
    </dialog>
  );
}
