// src/components/setup/SetupList.tsx — the Set-up checklist: every step of server/setup/steps.ts
// with its state (done, your turn, waits for a step before it, optional), its one line of why,
// and in the open step the form or the button that completes it. One step is open at a time.
//
// The page works with no model: each state is the answer of a machine check on the server (GET
// /api/setup/steps), and each action is a part the console has today (a form of Settings, the
// New agent dialog, the Queue). A step whose own form is not built yet says in one plain line
// what to do today: there is no dead button.
"use client";
import { useEffect, useState, type ReactNode } from "react";
import { DEFAULT_ACCOUNT, fetchAccountsState, PERSISTENT_LOGIN, type AccountInfo } from "../../lib/accounts";
import { PERSISTENT_FIX_COMMAND, PERSISTENT_NOT_READY } from "../../../server/setup/steps";
import { fetchTelegram, type TelegramView } from "../../lib/settings";
import { ACCESS_TODAY, firstTurn, progress, setupRows, stateWord, type SetupRow } from "../../lib/setup";
import type { SetupView } from "../../lib/useSetup";
import { CheckIcon, ChevronIcon, RefreshIcon } from "../SideIcons";
import { AddDevice } from "../settings/AddDevice";
import { ClaudeLogin } from "../settings/ClaudeLogin";
import { cx as k, Dot } from "../settings/kit";
import { TelegramSetupForm } from "../settings/TelegramSetupForm";
import { TelegramConnect } from "../settings/TelegramConnect";
import { DISPLAY_NAME, USER_CLI } from "../../../server/brand";
import type { StepId } from "../../../server/setup/steps";
import { FirstAgentStep } from "./FirstAgentStep";
import { FirstPrStep } from "./FirstPrStep";
import { Fold, More } from "./Fold";
import { GithubStep } from "./GithubStep";
import { RepoStep } from "./RepoStep";
import c from "./Setup.module.css";

// Where an action of a step goes. A way that the place of the list does not have is left out,
// and its button with it.
export type SetupNav = {
  // Open a section of Settings.
  go?: (section: string) => void;
  onNewAgent?: () => void;
  // Open the agent where its terminal shows: the first agent with no session (its pane shows the
  // terminal when it has no session). The set-up opens no agent thread.
  onOpenTerminal?: (id: string) => void;
  // Leave the Set-up page for the console (the button of the "done" screen).
  onLeave?: () => void;
};

// Text with `commands` in backticks.
const words = (text: string): ReactNode => text.split("`").map((t, n) => (n % 2 ? <code key={n}>{t}</code> : t));

function Today({ children }: { children: string }) {
  return <p className={c.today}>{words(children)}</p>;
}

function Open({ onClick, children }: { onClick?: () => void; children: string }) {
  return onClick ? <button type="button" className={k.btn} onClick={onClick}>{children}</button> : null;
}

// The Claude logins of the server, as the Claude accounts section of Settings reads them.
function ClaudeLogins() {
  const [rows, setRows] = useState<AccountInfo[] | null>(null);
  useEffect(() => {
    let live = true;
    // The second sign-in has its own row ("Sign in for your assistant"), not this one.
    void fetchAccountsState().then((s) => { if (live) setRows(s.accounts.filter((a) => !a.persistent)); }).catch(() => { if (live) setRows([]); });
    return () => { live = false; };
  }, []);
  if (!rows || rows.length === 0) return null;
  return (
    <ul className={c.logins} aria-label="Claude logins">
      {rows.map((a) => (
        <li key={a.id}>
          <Dot tone={a.loggedIn ? "ok" : "off"} />
          <span>{a.email ?? (a.isDefault ? "Main account" : a.id)}</span>
          <span className={k.help}>{a.loggedIn ? "Logged in" : "Not logged in"}</span>
        </li>
      ))}
    </ul>
  );
}

// The Telegram card: the bot token (the form of Settings, the token only), then "Connect your
// chat" and the fleet master chat with a one-time code each (TelegramConnect). Nobody types an
// id. Where the console cannot save from the page, the row says why and opens the Telegram
// section. `onDone` reads the step list again; it does not close the card (the card has more
// than one step, and the console restarts between them).
function TelegramStep({ nav, onDone }: { nav: SetupNav; onDone: () => Promise<void> }) {
  const [v, setV] = useState<TelegramView | null>(null);
  // The last good answer stays while the console restarts.
  const load = async (fresh = false) => { const next = await fetchTelegram(fresh).catch(() => null); if (next) setV(next); };
  useEffect(() => { void load(true); }, []);
  if (v?.setup?.canSave) {
    const botOk = v.token && v.bot?.ok === true;
    return (
      <div className={c.embed}>
        {!v.token && <Today>In Telegram, open @BotFather and send `/newbot`. Give the bot a name. BotFather answers with a token. Paste the token here: it goes straight to your server and is never shown again.</Today>}
        {v.token && v.bot && !v.bot.ok && <p className={c.error} role="alert">Telegram does not accept the bot token. Copy it again from @BotFather.</p>}
        <TelegramSetupForm tokenOnly botName={v.bot?.ok ? v.bot.username : undefined} setup={v.setup} bootAt={v.bootAt ?? null} onDone={async () => { await load(true); await onDone(); }} />
        {botOk && <TelegramConnect v={v} reload={() => load()} onChange={() => void onDone()} />}
      </div>
    );
  }
  return (
    <>
      <Today>{v?.setup?.why ? `${v.setup.why}.` : "Make a bot with @BotFather in Telegram. Then give its token in Settings."}</Today>
      <div className={c.acts}><Open onClick={nav.go && (() => nav.go?.("telegram"))}>Open Telegram in Settings</Open></div>
    </>
  );
}

// The form or the button of a step, or one plain line of what to do today. The row of the list
// (Settings, Set-up) and the card of the stage (Stage.tsx) both draw this one part.
// `auto`: the press that opened this part was the user's action for the step (the card of the
// done screen): a part that has one more button starts at once.
// `stage`: the part is on the stage: one live part, and the other help in a closed "More".
export function StepAction({ row, nav, onDone, auto = false, stage = false }: {
  row: SetupRow; nav: SetupNav; onDone: () => Promise<void>; auto?: boolean; stage?: boolean;
}) {
  const settings = (id: string) => nav.go && (() => nav.go?.(id));
  switch (row.id) {
    case "install":
      return <Today>{`Run \`${USER_CLI} setup\` on your server. It repairs what is missing and goes on where it stopped.`}</Today>;
    case "claude":
      // The whole login on the page: the sign-in link of Claude and its code. No terminal.
      if (stage) {
        return (
          <>
            <Today>You sign in on the page of Claude and paste its code here. Your agents then work with your Claude plan.</Today>
            <ClaudeLogin account={DEFAULT_ACCOUNT} onDone={onDone} />
            <More label="the logins">
              <ClaudeLogins />
              <div className={c.acts}><Open onClick={settings("accounts")}>More logins</Open></div>
            </More>
          </>
        );
      }
      return (
        <>
          <ClaudeLogins />
          <Today>You sign in on the page of Claude and paste its code here. Your agents then work with your Claude plan.</Today>
          <ClaudeLogin account={DEFAULT_ACCOUNT} onDone={onDone} />
          <div className={c.acts}><Open onClick={settings("accounts")}>More logins</Open></div>
        </>
      );
    case "persistent":
      // The second sign-in (only where the console has one): the fleet master, the leads and the
      // helper for tickets. The same Claude account and plan. A server that is not ready for it
      // gets the command, and no sign-in that would only fail.
      if (row.text === PERSISTENT_NOT_READY) return <Today>{`Run \`${PERSISTENT_FIX_COMMAND}\` on your server. It ends with "Strong protection is set up". Then press Check again.`}</Today>;
      return (
        <>
          <Today>It is a second sign-in, not a second plan.</Today>
          <ClaudeLogin account={PERSISTENT_LOGIN} onDone={onDone} />
        </>
      );
    case "access":
      return <Today>{ACCESS_TODAY}</Today>;
    case "pair":
      return (
        <>
          <Today>Devices in Settings shows the paired devices and says how this console pairs one.</Today>
          <div className={c.acts}><Open onClick={settings("devices")}>Open Devices</Open></div>
        </>
      );
    case "github":
      // The ChoiBot app: after the approval, the same row is the choice of the repo.
      return row.part === "repo" ? <RepoStep onDone={onDone} /> : <GithubStep row={row} onDone={onDone} />;
    case "repo":
      return <RepoStep onDone={onDone} />;
    case "agent":
      return <FirstAgentStep onDone={onDone} stage={stage} onOpenTerminal={nav.onOpenTerminal} />;
    case "merge":
      return <FirstPrStep onDone={onDone} stage={stage} />;
    case "phone":
      // The code picture for the phone, in the row. After the add: the row of the phone with Revoke.
      return <AddDevice what="phone" row auto={auto} onAdded={onDone} />;
    case "telegram":
      return <TelegramStep nav={nav} onDone={onDone} />;
    case "lead":
      return (
        <>
          <Today>Make a lead in Leads: give it a name and pick its repos. It starts at once.</Today>
          <div className={c.acts}><Open onClick={settings("leads")}>Open Leads</Open></div>
        </>
      );
  }
}

// The steps whose part stays open after they are done: the phone that was added, and the
// Telegram card (its second step, the fleet master chat, and "Disconnect").
export const STAYS: StepId[] = ["phone", "telegram"];

// The protection of this console, when it is strong (Settings, Devices says it in full).
export const STRONG_WORDS = "Protection: Strong. Your agents run under their own account on your server: they cannot read the keys of your devices or the settings of the console.";

function StepRow({ row, open, onToggle, nav, onDone }: { row: SetupRow; open: boolean; onToggle: () => void; nav: SetupNav; onDone: () => Promise<void> }) {
  // A step opens when the user can act on it now. The phone step and the Telegram step also
  // open when they are done (STAYS): the phone that was added, and the second step of Telegram
  // (the fleet master chat) with "Disconnect", are there.
  const canOpen = row.state === "turn" || row.state === "optional" || (row.state === "done" && STAYS.includes(row.id));
  const sub = row.state === "checking" || (row.state === "optional" && !open) ? row.why : row.text;
  const head = (
    <>
      <span className={c.mark} data-state={row.state} aria-hidden>{row.state === "done" && <CheckIcon size={12} />}</span>
      <span className={c.tt}>
        <span className={c.title}>{row.title}</span>
        {sub && <span className={c.sub}>{sub}</span>}
      </span>
      <span className={c.word}>{stateWord(row)}</span>
      {canOpen && <span className={c.caret}><ChevronIcon open={open} /></span>}
    </>
  );
  return (
    <div className={c.row} data-state={row.state} data-step={row.id}>
      {canOpen
        ? <button type="button" className={c.head} onClick={onToggle} aria-expanded={open}>{head}</button>
        : <div className={c.head}>{head}</div>}
      {/* The step that is done closes and the next opens in the same render: one motion each. */}
      <Fold open={canOpen && open} className={c.body}>
        <p className={c.why}>{row.why}</p>
        {row.error && <p className={c.error}>{row.error}</p>}
        <StepAction row={row} nav={nav} onDone={onDone} />
      </Fold>
    </div>
  );
}

// The "done" screen of the Set-up page: one calm line, then what the user can do next. Each
// card is one optional step of the list, with the part that exists for it today.
const NEXT_BUTTON: Partial<Record<StepId, string>> = { phone: "Add your phone", telegram: "Set up", lead: "Make a lead" };
// The steps whose part opens under the cards. The others open a section of Settings.
const INLINE: StepId[] = ["phone", "telegram"];

export function SetupDone({ setup, nav, phone = false, narrow = false }: { setup: SetupView; nav: SetupNav; phone?: boolean; narrow?: boolean }) {
  const extra = setupRows(setup.answer).filter((r) => r.optional);
  const [open, setOpen] = useState<StepId | null>(null);
  const [all, setAll] = useState(false);
  const press = (r: SetupRow) => {
    if (INLINE.includes(r.id)) setOpen(open === r.id ? null : r.id);
    else nav.go?.("leads");
  };
  // The part of the phone and the Telegram card stay after their step is done (STAYS).
  const row = open ? extra.find((r) => r.id === open && (r.state !== "done" || STAYS.includes(r.id))) : undefined;
  return (
    <div className={c.wrap} data-phone={phone ? "" : undefined} data-narrow={narrow ? "" : undefined} data-done="">
      <div className={c.hero}>
        <span className={c.heroMark} aria-hidden><CheckIcon size={16} /></span>
        <h2 className={c.heroTitle}>{DISPLAY_NAME} is set up</h2>
        <p className={c.heroLine}>Your first agent opened a pull request, and you merged it. From now on, each decision your agents need from you comes to the Queue as a ticket.</p>
        {nav.onLeave && <div className={c.acts}><button type="button" className={`${k.btn} ${k.primary}`} onClick={nav.onLeave}>Open the console</button></div>}
      </div>
      <div className={c.group}>
        <h3 className={c.groupTitle}>What next. Each one is optional.</h3>
        <div className={c.cards}>
          {extra.map((r) => (
            <article key={r.id} className={c.next} data-step={r.id} data-state={r.state}>
              <h4 className={c.title}>{r.title}</h4>
              <p className={c.sub}>{r.state === "done" || r.state === "waits" ? r.text : r.why}</p>
              {r.state === "done"
                ? (
                  <>
                    <span className={c.nextDone}><CheckIcon size={12} />Done</span>
                    {r.id === "telegram" && <button type="button" className={`${k.btn} ${k.quiet}`} aria-expanded={open === "telegram"} onClick={() => press(r)}>{open === "telegram" ? "Close" : "Open"}</button>}
                  </>
                )
                : (r.state === "optional" && (INLINE.includes(r.id) || nav.go)) && (
                  <button type="button" className={k.btn} aria-expanded={INLINE.includes(r.id) ? open === r.id : undefined} onClick={() => press(r)}>{NEXT_BUTTON[r.id]}</button>
                )}
            </article>
          ))}
        </div>
        {/* "Add your phone" was the press: the code picture shows at once. */}
        {row && <div className={c.nextBody}><StepAction row={row} nav={nav} auto onDone={async () => { if (!STAYS.includes(row.id)) setOpen(null); await setup.refresh(); }} /></div>}
      </div>
      <p className={c.foot}>
        The steps stay in Settings, under Set-up. <button type="button" className={`${k.btn} ${k.link}`} aria-expanded={all} onClick={() => setAll(!all)}>{all ? "Hide the steps" : "Show the steps"}</button>
      </p>
      {all && <SetupList setup={setup} nav={nav} phone={phone} narrow={narrow} counted />}
    </div>
  );
}

// `counted`: the place of the list says the count itself (the status line of Settings).
// `closed`: no step is open until the user opens one (next to the guide, whose thread has the
// card of the step to do now). `narrow`: the list is a column next to the guide.
export function SetupList({ setup, phone = false, nav, counted = false, closed = false, narrow = false }: {
  setup: SetupView; phone?: boolean; nav: SetupNav; counted?: boolean; closed?: boolean; narrow?: boolean;
}) {
  const rows = setupRows(setup.answer);
  const { done, total } = progress(rows);
  const next = firstTurn(rows)?.id ?? null;
  // The open step: the user's pick, else the step to do now. null: the user closed it.
  const [picked, setPicked] = useState<StepId | null | undefined>(undefined);
  const openId = picked === undefined ? (closed ? null : next) : picked;
  const main = rows.filter((r) => !r.optional), extra = rows.filter((r) => r.optional);
  const allDone = done === total;
  const list = (items: SetupRow[]) => (
    <div className={c.list}>
      {items.map((r) => (
        <StepRow key={r.id} row={r} open={openId === r.id} onToggle={() => setPicked(openId === r.id ? null : r.id)} nav={nav}
          // The phone step and the Telegram step stay open after their action (STAYS).
          onDone={async () => { setPicked(STAYS.includes(r.id) ? r.id : undefined); await setup.refresh(); }} />
      ))}
    </div>
  );
  return (
    <div className={c.wrap} data-phone={phone ? "" : undefined} data-narrow={narrow ? "" : undefined}>
      <div className={c.top}>
        <span className={c.count} role={counted ? undefined : "status"}>
          {counted ? null : setup.answer === null
            ? (setup.failed ? "The console did not answer. Press Check again." : "Checking the steps…")
            : allDone ? <span className={c.done}><i className={c.doneDot} aria-hidden />Set-up is done</span>
            : <><b>{done} of {total}</b> steps done</>}
        </span>
        <button type="button" className={k.btn} disabled={setup.checking} onClick={() => { setPicked(undefined); void setup.refresh(); }}>
          <RefreshIcon size={14} />{setup.checking ? "Checking…" : "Check again"}
        </button>
      </div>
      <div className={c.group}>{list(main)}</div>
      <div className={c.group}>
        <h3 className={c.groupTitle}>{allDone ? "Optional, when you want" : "After the first PR"}</h3>
        {list(extra)}
      </div>
      {setup.answer?.protection === "strong" && <p className={c.foot} data-protection="strong">{STRONG_WORDS}</p>}
      <p className={c.foot}>A step is done when its check passes on your server. Nothing else can mark a step done.</p>
    </div>
  );
}
