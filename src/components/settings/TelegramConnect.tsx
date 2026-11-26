// src/components/settings/TelegramConnect.tsx — "Telegram with no ids": the two steps that come
// after the bot token, in the Telegram card of the Set-up page and in Settings > Telegram.
//
//   Connect your chat   a one-time code and "Open Telegram". The bot gets "/start <code>", and
//                       the account that sent it becomes the user's. A test message goes out.
//   Fleet master chat   optional. The user sends a second code in the topic they want; the
//                       console reads the group and the topic from that message.
//
// Nobody types an id here, and the page never gets one: it reads states (GET
// /api/settings/telegram: connected, the name, a code waits, what went wrong) and it gets a code
// only as the answer of its own press. Each button is a route for the paired user only.
"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  codeTimeLeft, disconnectTelegram, sendTelegramTest, startTelegramLink,
  type LinkCode, type LinkKind, type LinkView, type TelegramView,
} from "../../lib/settings";
import { CheckIcon, ExternalIcon } from "../SideIcons";
import { cx as k, Dot } from "./kit";
import c from "./TelegramConnect.module.css";

const POLL_MS = 2500;

// What a code that ended says, in plain words.
const ENDED: Record<Exclude<NonNullable<LinkView["last"]>["end"], "ok">, string> = {
  expired: "No message came in 10 minutes, so the code is off. Get a new code.",
  spent: "Too many wrong codes came in, so the code is off. Get a new code.",
  "not-saved": "Your server could not save it. Nothing changed. Try again.",
  refused: "Something is connected already, so nothing changed. Press the button again and confirm.",
};

type Ask = { act: "replace" | "disconnect"; kind: LinkKind };

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* the text can be selected by hand */ }
  };
  return <button type="button" className={k.btn} onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</button>;
}

function Waiting({ children }: { children: string }) {
  return <span className={c.waiting}><i className={c.pulse} aria-hidden />{children}</span>;
}

// One step: its mark (done, your turn, later), its title, and its body.
function Step({ n, title, tag, state, children }: { n: number; title: string; tag?: string; state: "done" | "turn" | "later"; children: ReactNode }) {
  return (
    <section className={c.step} data-state={state} aria-label={title}>
      <header className={c.head}>
        <span className={c.mark} aria-hidden>{state === "done" ? <CheckIcon size={12} /> : n}</span>
        <h4 className={c.title}>{title}</h4>
        {tag && <span className={c.tag}>{tag}</span>}
      </header>
      <div className={c.body}>{children}</div>
    </section>
  );
}

// `reload`: read the status again (the parent keeps the last good answer while the console
// restarts). `onChange`: a connection changed (the step list checks again).
export function TelegramConnect({ v, reload, onChange }: { v: TelegramView; reload: () => Promise<void>; onChange?: () => void }) {
  const link = v.link ?? null;
  const [code, setCode] = useState<LinkCode | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<{ kind: LinkKind; text: string } | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [sent, setSent] = useState<{ kind: LinkKind; ok: boolean; text: string } | null>(null);
  const [, setTick] = useState(0);

  // While a code waits, or the console restarts with a new value: read the status again.
  const waits = !!link?.pending || (!!link?.waitsRestart && !!v.setup?.restarting);
  const read = useRef(reload);
  read.current = reload;
  useEffect(() => {
    if (!waits) return;
    const t = setInterval(() => { setTick((n) => n + 1); void read.current(); }, POLL_MS);
    return () => clearInterval(t);
  }, [waits]);

  // A connection changed: the step list of the Set-up page checks again.
  const sig = link ? `${link.account.connected}:${link.account.tested}:${link.chat.connected}` : "";
  const told = useRef(sig);
  const changed = useRef(onChange);
  changed.current = onChange;
  useEffect(() => {
    if (told.current === sig) return;
    told.current = sig;
    changed.current?.();
  }, [sig]);

  if (!link) return null;
  // Where the ticket cards go now: with no fleet master chat, to the user's chat with the bot.
  const queue = v.targets.find((t) => t.id === "queue");
  const ticketsHere = !!queue && !queue.sameAs && !queue.missing.length && !queue.problem;
  const botName = v.bot?.ok && v.bot.username ? `@${v.bot.username}` : "the bot";
  const canAct = v.setup?.canSave === true && !v.setup.restarting;

  const start = async (kind: LinkKind, replace = false) => {
    if (busy) return;
    setBusy(`code-${kind}`); setErr(null); setSent(null);
    const r = await startTelegramLink(kind, replace);
    setBusy(null);
    if (r.ok) { setAsk(null); setCode(r.code); await reload(); return; }
    // Something is connected: the user confirms, then the same press goes again.
    if (r.exists) { setAsk({ act: "replace", kind }); return; }
    setErr({ kind, text: r.error });
  };
  const disconnect = async (kind: LinkKind) => {
    if (busy) return;
    setBusy(`off-${kind}`); setErr(null); setSent(null);
    const r = await disconnectTelegram(kind);
    setBusy(null); setAsk(null);
    if (!r.ok) { setErr({ kind, text: r.error }); return; }
    setCode(null);
    setSent({ kind, ok: true, text: !r.changed ? "Nothing was connected." : r.restart?.ok ? "Disconnected. The console restarts now; agents keep running." : `Disconnected. Start the console again to apply it (${r.restart?.why ?? "it cannot restart itself"}).` });
    await reload();
  };
  const test = async (kind: LinkKind) => {
    if (busy) return;
    setBusy(`test-${kind}`); setErr(null); setSent(null);
    const r = await sendTelegramTest(kind === "account" ? "account" : "master");
    setBusy(null);
    setSent(r.ok ? { kind, ok: true, text: "Sent. Look for it in Telegram." } : { kind, ok: false, text: r.error });
    if (r.ok) await reload();
  };

  // The code of this device for the code that waits on the server, else null (another device
  // asked for it, or the page was loaded again: a code shows one time).
  const mine = (kind: LinkKind): LinkCode | null =>
    (code && link.pending?.kind === kind && code.kind === kind && code.expiresAt === link.pending.expiresAt ? code : null);
  const lastOf = (kind: LinkKind) => (link.last?.kind === kind ? link.last : null);

  const restartLine = (r: { ok: true } | { ok: false; why: string } | null): string =>
    (!r ? "" : r.ok ? "The console restarts now to use it. Agents keep running." : `Start the console again to use it (${r.why}).`);

  const confirm = (kind: LinkKind): ReactNode => {
    if (ask?.kind !== kind) return null;
    const replace = ask.act === "replace";
    const text = replace
      ? (kind === "account"
        ? "A Telegram account is connected. The account that sends the new code replaces it."
        : "A fleet master chat is connected. The topic where you send the new code replaces it.")
      : (kind === "account"
        ? "The bot stops answering your account, no ticket comes to Telegram, and the fleet master chat is disconnected with it. The bot itself stays."
        : "The fleet master does not read this chat any more. Your account stays connected, and your tickets come to your own chat with the bot.");
    return (
      <div className={c.confirm} role="group" aria-label="Confirm">
        <p className={c.line}>{text}</p>
        <div className={c.acts}>
          <button type="button" className={`${k.btn} ${k.primary}`} disabled={!!busy}
            onClick={() => void (replace ? start(kind, true) : disconnect(kind))}>
            {busy ? "Working…" : replace ? "Replace it" : "Disconnect"}
          </button>
          <button type="button" className={`${k.btn} ${k.quiet}`} disabled={!!busy} onClick={() => setAsk(null)}>Cancel</button>
        </div>
      </div>
    );
  };
  const notes = (kind: LinkKind): ReactNode => (
    <>
      {err?.kind === kind && <p className={c.bad} role="alert">{err.text}</p>}
      {sent?.kind === kind && <p className={sent.ok ? c.good : c.bad} role={sent.ok ? "status" : "alert"}>{sent.text}</p>}
    </>
  );

  // ---- step 1: the account ----
  const acc = link.account;
  const accLast = lastOf("account");
  const accCode = mine("account");
  const accJustNow = accLast?.end === "ok" && link.waitsRestart && !acc.connected;
  const accDone = acc.connected || accJustNow;
  let account: ReactNode;
  if (accJustNow) {
    account = (
      <>
        <p className={c.line}><Dot tone="ok" /><span>Connected as <b>{accLast?.who || "your account"}</b>.</span></p>
        <p className={c.quiet}>{accLast?.test ? "The test message went out. Look at your phone." : "The test message did not go out."} {restartLine(accLast?.restart ?? null)}</p>
      </>
    );
  } else if (link.pending?.kind === "account") {
    account = accCode ? (
      <div className={c.card} data-part="code">
        <div className={c.cardHead}><span>Your code</span><Waiting>Waiting for your message</Waiting></div>
        <div className={c.codeLine}>
          <output className={c.code} aria-label="One-time code">{accCode.code}</output>
          <CopyButton text={accCode.send} />
        </div>
        <div className={c.acts}>
          <a className={`${k.btn} ${k.primary}`} href={accCode.url} target="_blank" rel="noopener noreferrer">Open Telegram<ExternalIcon /></a>
          <button type="button" className={`${k.btn} ${k.quiet}`} disabled={!!busy || !canAct} onClick={() => void start("account", acc.connected)}>New code</button>
        </div>
        <p className={c.line}>Press Start in Telegram. Or send <code>{accCode.send}</code> to {botName}.</p>
        <p className={c.quiet}>The code works one time, for {codeTimeLeft(accCode.expiresAt, Date.now())}. The account that sends it becomes yours: the bot answers only that account.</p>
      </div>
    ) : (
      <>
        <p className={c.line}><Waiting>A code waits for its message.</Waiting></p>
        <p className={c.quiet}>A code shows one time, on the device that asked for it. Get a new one here.</p>
        <div className={c.acts}><button type="button" className={k.btn} disabled={!!busy || !canAct} onClick={() => void start("account", acc.connected)}>New code</button></div>
      </>
    );
  } else if (acc.connected) {
    account = (
      <>
        <p className={c.line}><Dot tone="ok" /><span>{acc.name ? <>Connected as <b>{acc.name}</b>.</> : "Connected."} The bot answers only this account.{ticketsHere ? " Your tickets come to this chat with answer buttons." : ""}</span></p>
        {accLast && accLast.end !== "ok" && <p className={c.bad} role="status">{ENDED[accLast.end]}</p>}
        {acc.tested && <p className={c.quiet}>The test message went out.</p>}
        {ask?.kind !== "account" && (
          <div className={c.acts}>
            <button type="button" className={k.btn} disabled={!!busy || !v.canTest} onClick={() => void test("account")}>{busy === "test-account" ? "Sending…" : "Send a test message"}</button>
            <button type="button" className={`${k.btn} ${k.quiet}`} disabled={!!busy || !canAct} onClick={() => setAsk({ act: "replace", kind: "account" })}>Connect another account</button>
            <button type="button" className={`${k.btn} ${k.quiet}`} disabled={!!busy || !canAct} onClick={() => setAsk({ act: "disconnect", kind: "account" })}>Disconnect</button>
          </div>
        )}
      </>
    );
  } else {
    account = (
      <>
        <p className={c.line}>The bot must know which Telegram account is yours. You get a one-time code and send it to {botName}. No id to type.</p>
        {accLast && accLast.end !== "ok" && <p className={c.bad} role="status">{ENDED[accLast.end]}</p>}
        {link.waitsRestart && !v.setup?.restarting && <p className={c.quiet}>A change is saved. Start the console again to use it.</p>}
        <div className={c.acts}>
          <button type="button" className={`${k.btn} ${k.primary}`} disabled={!!busy || !canAct} onClick={() => void start("account")}>
            {busy === "code-account" ? "Making a code…" : accLast ? "New code" : "Connect your chat"}
          </button>
        </div>
      </>
    );
  }

  // ---- step 2: the fleet master chat ----
  const chat = link.chat;
  const chatLast = lastOf("chat");
  const chatCode = mine("chat");
  const chatJustNow = chatLast?.end === "ok" && link.waitsRestart && !chat.connected;
  const why = "Your tickets come to this chat with answer buttons, and you write to the fleet master there.";
  // Before it is connected: the tickets come to the user's own chat already.
  const whyLater = "A topic of a Telegram group where you write to the fleet master. Your tickets then come there, not to your own chat.";
  let master: ReactNode;
  if (!acc.connected) {
    master = <p className={c.quiet}>{whyLater} Connect your chat first.</p>;
  } else if (chatJustNow) {
    master = (
      <>
        <p className={c.line}><Dot tone="ok" /><span>Connected{chatLast?.who ? <> to <b>{chatLast.who}</b></> : ""}.</span></p>
        <p className={c.quiet}>{chatLast?.test ? "The test message went out in the topic." : "The test message did not go out: check that the bot can write in the topic."} {restartLine(chatLast?.restart ?? null)}</p>
      </>
    );
  } else if (link.pending?.kind === "chat") {
    master = chatCode ? (
      <div className={c.card} data-part="code">
        <ol className={c.steps}>
          <li>In Telegram, make a group and turn on <b>Topics</b> in its settings. Make a topic for the fleet master.</li>
          <li>Add <b>{botName}</b> to the group and make it an admin.</li>
          <li>Open the topic and send this message:</li>
        </ol>
        <div className={c.codeLine}>
          {/* On a narrow screen the line breaks before the code, never inside it. */}
          <output className={c.code} data-long="" aria-label="Message to send">{chatCode.send.slice(0, chatCode.send.lastIndexOf(" ") + 1)}<span className={c.nb}>{chatCode.code}</span></output>
          <CopyButton text={chatCode.send} />
        </div>
        <div className={c.cardHead}><Waiting>Waiting for your message in the topic</Waiting>
          <button type="button" className={`${k.btn} ${k.quiet}`} disabled={!!busy || !canAct} onClick={() => void start("chat", chat.connected)}>New code</button>
        </div>
        {link.pending.problem && <p className={c.bad} role="alert">{link.pending.problem}</p>}
        <p className={c.quiet}>Nothing happens? Check that {botName} is a member of the group, and send the message from the account you connected. The code works one time, for {codeTimeLeft(chatCode.expiresAt, Date.now())}.</p>
      </div>
    ) : (
      <>
        <p className={c.line}><Waiting>A code waits for its message in the topic.</Waiting></p>
        {link.pending.problem && <p className={c.bad} role="alert">{link.pending.problem}</p>}
        <p className={c.quiet}>A code shows one time, on the device that asked for it. Get a new one here.</p>
        <div className={c.acts}><button type="button" className={k.btn} disabled={!!busy || !canAct} onClick={() => void start("chat", chat.connected)}>New code</button></div>
      </>
    );
  } else if (chat.connected) {
    master = (
      <>
        <p className={c.line}><Dot tone="ok" /><span>Connected{chat.title ? <> to <b>{chat.title}</b></> : ""}. {why}</span></p>
        {chatLast && chatLast.end !== "ok" && <p className={c.bad} role="status">{ENDED[chatLast.end]}</p>}
        {ask?.kind !== "chat" && (
          <div className={c.acts}>
            <button type="button" className={k.btn} disabled={!!busy || !v.canTest} onClick={() => void test("chat")}>{busy === "test-chat" ? "Sending…" : "Send a test message"}</button>
            <button type="button" className={`${k.btn} ${k.quiet}`} disabled={!!busy || !canAct} onClick={() => setAsk({ act: "replace", kind: "chat" })}>Use another topic</button>
            <button type="button" className={`${k.btn} ${k.quiet}`} disabled={!!busy || !canAct} onClick={() => setAsk({ act: "disconnect", kind: "chat" })}>Disconnect</button>
          </div>
        )}
      </>
    );
  } else {
    master = (
      <>
        <p className={c.line}>{whyLater} You send one message there, and the console reads the group and the topic from it.</p>
        {chatLast && chatLast.end !== "ok" && <p className={c.bad} role="status">{ENDED[chatLast.end]}</p>}
        <div className={c.acts}>
          <button type="button" className={k.btn} disabled={!!busy || !canAct} onClick={() => void start("chat")}>
            {busy === "code-chat" ? "Making a code…" : chatLast ? "New code" : "Connect a topic"}
          </button>
        </div>
      </>
    );
  }

  return (
    <div className={c.wrap}>
      <Step n={1} title="Connect your chat" state={accDone ? "done" : "turn"}>
        {account}
        {confirm("account")}
        {notes("account")}
      </Step>
      <Step n={2} title="Fleet master chat" tag="Optional" state={chat.connected || chatJustNow ? "done" : acc.connected ? "turn" : "later"}>
        {master}
        {confirm("chat")}
        {notes("chat")}
      </Step>
      {!canAct && v.setup?.why && <p className={c.quiet}>{v.setup.why}.</p>}
    </div>
  );
}
