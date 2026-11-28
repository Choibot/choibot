// src/components/setup/RepoStep.tsx — the open "Pick a repo" row of the Set-up list: the repos
// of the GitHub login in a list with a search, and one button that copies the picked repo to
// the server. No address to type. A repo with no push access is in the list, off, with the
// reason. The copy runs on the server: a page that closes and comes back sees how far it is.
"use client";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { awayFrom, chooseCard, installUrl, moveTrip, onReturn, tripMoved, tripWaits } from "../../lib/githubTrip";
import {
  accessWord, canPick, cloneLine, cloneProblem, fetchClone, fetchRepoPage, repoChoice, repoLine, startClone,
  type CloneState, type PickRow, type RepoPage,
} from "../../lib/setupActions";
import { ExternalIcon, RefreshIcon } from "../SideIcons";
import { cx as k } from "../settings/kit";
import { Pending } from "./Fold";
import c from "./Setup.module.css";

const POLL_MS = 1000;
const TYPE_MS = 250;

type List = { q: string; rows: PickRow[]; page: number; last: RepoPage };

// The ChoiBot app reaches no repo yet: the one action of this step is to choose them on GitHub
// (chooseCard has the words). `moved`: the tab of the one trip went on to the install page.
export function ChooseCard({ appUrl, moved, emptyReads, reading, listErr, onRead }: {
  appUrl: string | null; moved: boolean; emptyReads: number; reading: boolean; listErr: string; onRead: () => void;
}) {
  const card = chooseCard(appUrl, moved);
  return (
    <>
      {listErr && <p className={c.error} role="alert">{listErr}</p>}
      <div className={c.card} data-part="choose">
        {card.link
          ? (
            <div className={c.acts}>
              <a className={`${k.btn} ${card.link.primary ? k.primary : k.quiet}`} href={card.link.href} target="_blank" rel="noopener noreferrer">{card.link.text}<ExternalIcon /></a>
              <span className={c.quiet}>{card.line}</span>
            </div>
          )
          : <p className={c.quiet}>{card.line}</p>}
        {emptyReads > 0 && (
          <p className={c.today} role="status">ChoiBot still reaches no repo. On GitHub, check that you picked your repos and pressed Install or Save.</p>
        )}
        <div className={c.acts}>
          <button type="button" className={`${k.btn} ${k.quiet}`} disabled={reading} onClick={onRead}>
            {reading ? "Reading…" : "Read the list again"}
          </button>
        </div>
      </div>
    </>
  );
}

export function RepoStep({ onDone }: { onDone: () => Promise<void> }) {
  const [q, setQ] = useState("");
  const [list, setList] = useState<List | null>(null);
  const [listErr, setListErr] = useState("");
  const [reading, setReading] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [clone, setClone] = useState<CloneState>({ state: "idle" });
  const [err, setErr] = useState("");
  const [now] = useState(() => Date.now());
  const asked = useRef(0);
  const done = useRef(onDone);
  done.current = onDone;

  // One read of the list. An answer to an older search is dropped.
  const read = useCallback(async (query: string, page: number, o: { fresh?: boolean; prev?: List | null } = {}) => {
    const mine = ++asked.current;
    setReading(true);
    try {
      const got = await fetchRepoPage({ q: query, page, fresh: o.fresh });
      if (mine !== asked.current) return;
      setList({ q: query, page, last: got, rows: page > 0 && o.prev ? [...o.prev.rows, ...got.repos] : got.repos });
      setListErr("");
    } catch (e) {
      if (mine === asked.current) setListErr((e as Error).message);
    } finally {
      if (mine === asked.current) setReading(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => { void read(q.trim(), 0); }, q ? TYPE_MS : 0);
    return () => clearTimeout(t);
  }, [q, read]);

  // A copy that runs (started here, or before this page opened).
  const take = useCallback((next: CloneState) => {
    setClone(next);
    if (next.state === "done") void done.current();
  }, []);
  useEffect(() => {
    let live = true;
    void fetchClone().then((s) => { if (live && s.state === "copying") setClone(s); }, () => {});
    return () => { live = false; };
  }, []);
  // The ChoiBot app reaches no repo yet: the person chooses its repos on GitHub in another tab.
  // When this page shows again, the list is read again ("Read the list again" does the same).
  // `emptyReads`: the reads that still gave no repo, after the first one.
  const waitsForRepos = repoChoice(list?.last ?? null) === "choose";
  const appUrl = list?.last.app?.appUrl ?? null;
  const [moved, setMoved] = useState(tripMoved);
  const [emptyReads, setEmptyReads] = useState(0);
  const lastRead = useRef(list);
  useEffect(() => {
    if (list === lastRead.current) return;
    const before = lastRead.current;
    lastRead.current = list;
    if (!waitsForRepos) { setEmptyReads(0); return; }
    if (before !== null) setEmptyReads((n) => n + 1);
  }, [list, waitsForRepos]);
  useEffect(() => {
    if (!waitsForRepos) return;
    return onReturn(() => { void read(q.trim(), 0, { fresh: true }); });
  }, [waitsForRepos, read, q]);
  // The one trip: the person approved in the GitHub tab of press 1 and is still there. That tab
  // goes on to the app's install page (once). A person who looks at this tab presses the link.
  useEffect(() => {
    if (!waitsForRepos || !appUrl || !tripWaits() || !awayFrom()) return;
    void moveTrip(installUrl(appUrl)).then((ok) => { if (ok) setMoved(true); });
  }, [waitsForRepos, appUrl]);

  const copying = clone.state === "copying";
  useEffect(() => {
    if (!copying) return;
    const tick = setInterval(() => { void fetchClone().then(take, () => {}); }, POLL_MS);
    return () => clearInterval(tick);
  }, [copying, take]);

  const use = async () => {
    if (!picked) return;
    setErr("");
    try { take(await startClone(picked)); } catch (e) { setErr((e as Error).message); }
  };

  if (clone.state === "copying") {
    return (
      <div className={c.card} data-part="copy" role="status">
        <p className={c.today}>{cloneLine(clone)}</p>
        <div className={c.bar} aria-hidden><i style={{ width: `${clone.percent ?? 4}%` }} data-unknown={clone.percent === null ? "" : undefined} /></div>
        <p className={c.quiet}>You can close this page. The copy goes on.</p>
      </div>
    );
  }
  if (clone.state === "done") return <p className={c.today}>{clone.repo} is on your server. The check runs now.</p>;

  if (waitsForRepos && list?.last.app) {
    return <ChooseCard appUrl={appUrl} moved={moved} emptyReads={emptyReads} reading={reading} listErr={listErr} onRead={() => void read(q.trim(), 0, { fresh: true })} />;
  }

  const rows = list?.rows ?? [];
  const none = list !== null && list.last.listed === 0;
  // The ChoiBot GitHub app: the list holds only the repos that the app reaches.
  const app = list?.last.app ?? null;
  const pick = rows.find((r) => r.slug === picked && canPick(r)) ?? null;
  return (
    <>
      {clone.state === "failed" && <p className={c.error} role="alert">{clone.repo}: {cloneProblem(clone.reason)}</p>}
      {err && <p className={c.error} role="alert">{err}</p>}
      <div className={c.card} data-part="repos">
        <div className={c.search}>
          <input className={k.input} type="search" value={q} placeholder="Search your repos" aria-label="Search your repos"
            autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={(e) => { setQ(e.target.value); setPicked(null); }} />
          <button type="button" className={`${k.btn} ${k.quiet}`} disabled={reading} title="Read the list from GitHub again" aria-label="Read the list from GitHub again"
            onClick={() => void read(q.trim(), 0, { fresh: true })}><RefreshIcon size={14} /></button>
        </div>
        {listErr && <p className={c.error} role="alert">{listErr} Press the arrows to read it again.</p>}
        {list === null && !listErr && <Pending className={c.listNote}>Reading your repos from GitHub…</Pending>}
        {none && <p className={c.listNote}>GitHub shows no repo for this account. Make a repo on github.com, or ask the owner of a repo for push access. Then press the arrows to read the list again.</p>}
        {list !== null && !none && rows.length === 0 && <p className={c.listNote}>No repo has “{list.q}” in its name.</p>}
        {rows.length > 0 && (
          <div className={c.repos} role="radiogroup" aria-label="Your repos">
            {rows.map((r) => {
              const on = canPick(r);
              return (
                <button key={r.slug} type="button" role="radio" className={c.repo} aria-checked={picked === r.slug} disabled={!on}
                  onClick={() => setPicked(r.slug)}>
                  <span className={c.radio} aria-hidden />
                  <span className={c.repoTt}>
                    <span className={c.repoName}>{r.slug}</span>
                    <span className={c.repoSub}>{repoLine(r, now)}</span>
                  </span>
                  <span className={`${k.tag} ${on ? "" : k.tagOff}`}>{accessWord(r)}</span>
                </button>
              );
            })}
            {list?.last.more && (
              <button type="button" className={c.moreRow} disabled={reading} onClick={() => void read(list.q, list.page + 1, { prev: list })}>
                {reading ? "Reading…" : `Show more (${list.last.total - rows.length} more)`}
              </button>
            )}
          </div>
        )}
      </div>
      <div className={c.acts}>
        <button type="button" className={`${k.btn} ${k.primary}`} disabled={!pick} onClick={() => void use()}>{pick ? `Use ${pick.slug}` : "Pick a repo"}</button>
        <span className={c.quiet}>{pick?.here ? "This repo is on your server already." : "The repo is copied to your server. You can add more repos later."}</span>
      </div>
      {list?.last.capped && <p className={c.quiet}>The list holds the 500 repos you pushed to last.</p>}
      {app ? (
        <>
          <p className={c.quiet}>
            {(app.manage.length > 0 || app.appUrl) && <>Change the repos on GitHub: {[
              ...app.manage.map((m) => ({ url: m.url, text: m.account })),
              ...(app.appUrl ? [{ url: app.appUrl, text: "another account" }] : []),
            ].map((l, i) => (
              <Fragment key={l.url}>{i > 0 && " · "}<a href={l.url} target="_blank" rel="noopener noreferrer">{l.text}</a></Fragment>
            ))}. Then press the arrows.</>}
          </p>
        </>
      ) : (
        // No ChoiBot app here: the login is `gh auth login` (server/setup/ghlogin.ts), whose app on
        // GitHub is "GitHub CLI". With the app, this line never shows (the links above instead).
        <p className={c.quiet}>Is a repo of an organisation not in the list? An owner of the organisation must allow “GitHub CLI” first: <a href="https://github.com/settings/applications" target="_blank" rel="noopener noreferrer">github.com/settings/applications</a>.</p>
      )}
    </>
  );
}
