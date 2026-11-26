// src/components/settings/GitHubSettings.tsx — the gh login of the box (GET /api/settings/github):
// who it is, whether it can read each repo the GitHub section lists, the API calls left, and
// "Re-check". With no login, the section has the login itself: the code login of the Connect
// GitHub step (a code typed on github.com), the same part as in Set-up. No command on the server.
// With the ChoiBot GitHub app switch on (the status has `app`): the app's key, the repos that it
// reaches, the repos that the agents used in the last 14 days, and Disconnect.
"use client";
import { Fragment, useCallback, useEffect, useState } from "react";
import {
  daysAgo, disconnectApp, fetchAppRepos, fetchGitHub, githubStatusLine, rateLine, usedFrom,
  type AppReposView, type AppTokenView, type GitHubStatus, type Read,
} from "../../lib/settings";
import { useRemembered, viewMemory } from "../../lib/viewCache";
import { ExternalIcon, RefreshIcon } from "../SideIcons";
import type { SetupRow } from "../../lib/setup";
import { GithubStep } from "../setup/GithubStep";
import { Block, cx as s, Dot, Empty, ErrorLine, Note, Row, StatusLine, type SectionProps } from "./kit";

// The login part of the Connect GitHub step, for a console with no GitHub login (its text is
// not about the name for commits, so the part shows the code login).
const NO_LOGIN_ROW: SetupRow = { id: "github", title: "Connect GitHub", why: "", optional: false, state: "turn", text: "GitHub is not connected." };

const seen = viewMemory<Read<GitHubStatus>>(1);

// The ChoiBot key in one line.
function keyLine(k: AppTokenView): string {
  if (k.state === "none") return "Not connected";
  if (k.state === "signed-out") return k.why === "refused" ? "GitHub no longer takes this key. Connect again." : "This key ran out. Connect again.";
  return k.unsaved ? "The new key is not saved: after a restart, connect again" : "The key renews itself";
}

// The two lists of the app: the repos that ChoiBot reaches, and the ones the agents used.
function AppLists({ connected, tick }: { connected: boolean; tick: number }) {
  const [v, setV] = useState<AppReposView | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let live = true;
    void fetchAppRepos(tick > 0).then((x) => { if (live) { setV(x); setErr(""); } }, () => { if (live) setErr("The console did not give the lists of repos."); });
    return () => { live = false; };
  }, [tick, connected]);
  if (!v) return err ? <ErrorLine text={err} /> : null;
  const reach = v.reach;
  const links = reach ? [
    ...reach.manage.map((m) => ({ url: m.url, text: m.account })),
    ...(reach.appUrl ? [{ url: reach.appUrl, text: "another account" }] : []),
  ] : [];
  return (
    <>
      {connected && (
        <Block title="Repos ChoiBot can reach">
          {v.why === "refused" && <ErrorLine text="GitHub refused the key of your server. Connect again." />}
          {v.why === "no-answer" && <ErrorLine text="GitHub did not give the list. Press Re-check." />}
          {reach && reach.repos.length === 0 && <Empty>ChoiBot reaches no repo yet. Choose its repos on GitHub.</Empty>}
          {reach?.repos.map((r) => (
            <Row key={r.slug}>
              <span className={`${s.rowName} ${s.mono}`}>{r.slug}</span>
              <span className={s.rowMeta}>{r.private ? "Private" : "Public"}</span>
              <span className={`${s.tag} ${r.push ? "" : s.tagOff}`}>{r.push ? "Read and push" : "Read only"}</span>
            </Row>
          ))}
        </Block>
      )}
      {connected && reach && reach.repos.length === 0 && reach.appUrl && (
        <div className={s.actions}>
          <a className={s.btn} href={reach.appUrl} target="_blank" rel="noopener noreferrer">Choose repos on GitHub<ExternalIcon /></a>
          <span className={s.rowMeta}>On GitHub, pick “Only select repositories”, then your repos.</span>
        </div>
      )}
      <Block title={`Repos your agents used in the last ${v.days} days`}>
        {v.used.length === 0 && <Empty>No agent used a GitHub repo in the last {v.days} days.</Empty>}
        {v.used.map((u) => (
          <Row key={u.slug}>
            <span className={`${s.rowName} ${s.mono}`}>{u.slug}</span>
            <span className={s.rowMeta}>{usedFrom(u.from)} · {daysAgo(u.agoMs)}</span>
            {u.reach !== null && <span className={`${s.tag} ${u.reach ? "" : s.tagOff}`}>{u.reach ? "ChoiBot reaches it" : "ChoiBot cannot reach it"}</span>}
          </Row>
        ))}
      </Block>
      <Note>
        {connected ? "Is a repo here that ChoiBot cannot reach? Add it on GitHub" : "Choose these repos for ChoiBot on GitHub."}
        {connected && (links.length > 0 ? <>: {links.map((l, i) => (
          <Fragment key={l.url}>{i > 0 && " · "}<a href={l.url} target="_blank" rel="noopener noreferrer">{l.text}</a></Fragment>
        ))}. Then press Re-check.</> : ", then press Re-check.")}
        {" "}The list holds the repos of your agents, Recurring tasks and tickets. A gh call that an agent makes by hand to another repo is not in it.
      </Note>
    </>
  );
}

// Disconnect on this server, after one more press. GitHub's side stays the person's.
// `onDone`: GitHub's side, in words, for the line that stays after the row is gone.
function Disconnect({ onDone }: { onDone: (github: string) => void }) {
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const go = async () => {
    setBusy(true); setErr("");
    const r = await disconnectApp();
    setBusy(false); setAsk(false);
    if (!r.ok) { setErr(r.error); return; }
    onDone(r.github);
  };
  return (
    <Row>
      <span className={s.rowName}>This server</span>
      <span className={s.rowMeta}>
        {err || (ask ? "Your server then has no ChoiBot key. Your agents keep their own login." : "It holds the ChoiBot key")}
      </span>
      {ask ? (
        <>
          <button type="button" className={s.btn} disabled={busy} onClick={() => void go()}>{busy ? "Disconnecting…" : "Disconnect"}</button>
          <button type="button" className={s.btn} disabled={busy} onClick={() => setAsk(false)}>Cancel</button>
        </>
      ) : (
        <button type="button" className={s.btn} onClick={() => setAsk(true)}>Disconnect ChoiBot</button>
      )}
    </Row>
  );
}

export function GitHubSettings(_: SectionProps) {
  const [read, setRead] = useRemembered(seen, "github", null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async (fresh = false) => {
    setBusy(true);
    try {
      setRead({ rows: [await fetchGitHub(fresh)] });
    } catch {
      setRead((p) => (p && "rows" in p ? p : { error: "the console did not answer" }));
    } finally {
      setBusy(false);
    }
  }, [setRead]);
  useEffect(() => { void load(); }, [load]);
  const st = read && "rows" in read ? read.rows[0] : null;
  const [tick, setTick] = useState(0);
  // After a Disconnect: GitHub's side, which stays the person's.
  const [revoke, setRevoke] = useState("");
  const recheck = () => { void load(true); setTick((n) => n + 1); };

  if (st?.app) {
    const key = st.app.key;
    const connected = key.state === "ok";
    return (
      <>
        <StatusLine status={githubStatusLine(read)} />
        {revoke && !connected && <Note>ChoiBot is disconnected on your server. {revoke}</Note>}
        <Block title="Account" right={(
          <button type="button" className={s.btn} disabled={busy} onClick={recheck}>
            <RefreshIcon size={14} />{busy ? "Checking…" : "Re-check"}
          </button>
        )}>
          <Row>
            <span className={s.rowName}>ChoiBot app</span>
            <span className={s.rowMeta}>{keyLine(key)}</span>
            <span className={`${s.tag} ${connected && st.login ? "" : s.tagOff}`}>{connected ? st.login ?? "…" : "Not connected"}</span>
          </Row>
          {connected && (
            <Row>
              <span className={s.rowName}>API calls</span>
              <span className={s.rowMeta}>{st.login ? rateLine(st.rate) : "—"}</span>
            </Row>
          )}
          {connected && <Disconnect onDone={(g) => { setRevoke(g); recheck(); }} />}
        </Block>
        {!connected && (
          <Block title="Connect GitHub">
            <div className={s.form}>
              <GithubStep row={NO_LOGIN_ROW} place="settings" onDone={async () => { recheck(); }} />
            </div>
          </Block>
        )}
        <AppLists connected={connected} tick={tick} />
        <Note>The console uses the ChoiBot key for its own GitHub calls: pull requests, checks and merges. Your agents do not use it yet: they keep the GitHub login of your server, if it has one.</Note>
      </>
    );
  }

  return (
    <>
      <StatusLine status={githubStatusLine(read)} />
      <Block title="Account" right={(
        <button type="button" className={s.btn} disabled={busy} onClick={() => void load(true)}>
          <RefreshIcon size={14} />{busy ? "Checking…" : "Re-check"}
        </button>
      )}>
        <Row>
          <span className={s.rowName}>Login</span>
          <span className={s.rowMeta}>The GitHub login of your server</span>
          <span className={`${s.tag} ${st?.login ? "" : s.tagOff}`}>{st ? st.login ?? "Not logged in" : "…"}</span>
        </Row>
        <Row>
          <span className={s.rowName}>API calls</span>
          <span className={s.rowMeta}>{st?.login ? rateLine(st.rate) : "—"}</span>
        </Row>
      </Block>
      {st && !st.login && (
        <Block title="Connect GitHub">
          <div className={s.form}>
            <GithubStep row={NO_LOGIN_ROW} onDone={() => load(true)} />
          </div>
        </Block>
      )}
      {st?.login && (
        <Block title="Repos of the GitHub section">
          {st.repos.length === 0 && <Empty>No workspace repo has a GitHub origin.</Empty>}
          {st.repos.map((r) => (
            <Row key={r.slug} title={r.error}>
              <Dot tone={r.read ? "ok" : "err"} title={r.read ? "Can read" : "Cannot read"} />
              <span className={s.rowName}>{r.name}</span>
              <span className={`${s.rowMeta} ${s.mono}`}>{r.slug}</span>
              <span className={`${s.tag} ${r.read ? "" : s.tagOff}`}>
                {!r.read ? (r.error ?? "No access") : r.push ? "Read and push" : r.push === false ? "Read only" : "Read"}
              </span>
            </Row>
          ))}
        </Block>
      )}
      <Note>The console uses the GitHub login of your server for pull requests, checks and merges.</Note>
    </>
  );
}
