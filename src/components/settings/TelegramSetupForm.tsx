// src/components/settings/TelegramSetupForm.tsx — the Telegram set-up form: the bot token
// (write-only: the page never gets it back). A user never has to type an id: the account and the
// fleet master chat are connected with a one-time code (TelegramConnect). The ids by hand (your
// Telegram user id, the group and topic of the fleet master chat and of recurring results) stay in a
// closed fold of Settings; `tokenOnly` (the Set-up card) leaves them out.
// Plain labels, never an env key. Save goes to POST
// /api/settings/telegram/setup (paired device only); the server checks the token with Telegram,
// writes the console's settings file and restarts the console. The page waits for the restart,
// then reads the status again.
"use client";
import { useEffect, useRef, useState, type RefObject } from "react";
import { fetchTelegram, saveTelegramSetup, type SetupField, type SetupView } from "../../lib/settings";
import { Block, cx as s, ErrorLine, Field, Form, Note, Row } from "./kit";

type Values = Record<Exclude<SetupField, "token">, string>;
const RESTART_WAIT_MS = 90_000;

const LABELS: Record<SetupField, { label: string; help: string; placeholder: string }> = {
  token: { label: "Bot token", help: "Make a bot with @BotFather in Telegram and paste the token it gives you.", placeholder: "123456789:AA…" },
  account: { label: "Your Telegram user id", help: "The bot answers only this account. @userinfobot in Telegram tells you your id.", placeholder: "123456789" },
  masterGroup: { label: "Group for the fleet master", help: "A forum group with the bot as an admin. Its id starts with -100.", placeholder: "-1001234567890" },
  masterTopic: { label: "Topic", help: "The topic you talk to the fleet master in: the last number of a message link in it.", placeholder: "2" },
  cronGroup: { label: "Group for recurring results", help: "Optional. Empty: recurring results go to the agent notifications chat.", placeholder: "-1001234567890" },
  cronTopic: { label: "Topic", help: "Optional, with the group above.", placeholder: "4" },
};

function Input({ f, v, onChange, bad, disabled }: { f: Exclude<SetupField, "token">; v: string; onChange: (v: string) => void; bad: boolean; disabled: boolean }) {
  const l = LABELS[f];
  return (
    <Field label={l.label}>
      <input className={s.input} value={v} disabled={disabled} aria-invalid={bad || undefined} type="text" inputMode="numeric"
        autoComplete="off" spellCheck={false} placeholder={l.placeholder} onChange={(e) => onChange(e.target.value)} />
      <span className={s.help}>{l.help}</span>
    </Field>
  );
}

// The token field is uncontrolled: its value lives only in the input (React would copy a
// controlled value into the DOM attribute), is read once on Save and cleared right after.
function TokenInput({ inputRef, bad, disabled, tokenSet }: { inputRef: RefObject<HTMLInputElement | null>; bad: boolean; disabled: boolean; tokenSet: boolean }) {
  const l = LABELS.token;
  return (
    <Field label={l.label}>
      <input ref={inputRef} className={s.input} defaultValue="" disabled={disabled} aria-invalid={bad || undefined} type="password"
        autoComplete="new-password" spellCheck={false} placeholder={tokenSet ? "Set. Leave empty to keep it" : l.placeholder} />
      <span className={s.help}>{l.help}</span>
    </Field>
  );
}

// `bootAt`: the server's start time now (a new value after the restart). `onDone`: read the status.
// `tokenOnly`: the Set-up card (the token field only; it is open while there is no token).
// `botName`: the bot that answers with the token that is set, for the row.
export function TelegramSetupForm({ setup, bootAt, onDone, tokenOnly = false, botName }: { setup: SetupView; bootAt: number | null; onDone: () => Promise<void>; tokenOnly?: boolean; botName?: string }) {
  const fresh = (): Values => ({ ...setup.values });
  const tokenRef = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(tokenOnly && !setup.tokenSet && setup.canSave);
  const [vals, setVals] = useState<Values>(fresh);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ field: SetupField | null; error: string } | null>(null);
  const [done, setDone] = useState("");
  const [waiting, setWaiting] = useState(false);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);

  const start = () => { setVals(fresh()); setErr(null); setDone(""); setOpen(true); };
  const set = (f: keyof Values) => (v: string) => setVals((p) => ({ ...p, [f]: v }));

  // After a save that restarts the console: ask until the server's start time changes.
  const waitForRestart = async () => {
    setWaiting(true);
    const until = Date.now() + RESTART_WAIT_MS;
    while (live.current && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 2000));
      const v = await fetchTelegram().catch(() => null);
      if (v && v.bootAt && v.bootAt !== bootAt) {
        await onDone();
        if (live.current) { setWaiting(false); setDone(tokenOnly ? "" : "Restarted with the new set-up. Send a test message to check it."); }
        return;
      }
    }
    if (live.current) { setWaiting(false); setDone("The console is not back yet. Reload the page in a moment."); }
  };

  const submit = async () => {
    if (busy) return;
    setBusy(true); setErr(null); setDone("");
    const token = tokenRef.current?.value ?? "";
    // The token leaves the page at once, whatever the answer.
    if (tokenRef.current) tokenRef.current.value = "";
    const r = await saveTelegramSetup({ ...vals, token });
    setBusy(false);
    if (!r.ok) { setErr({ field: r.field, error: r.error }); return; }
    if (!r.saved) { setDone(r.text ?? "Nothing changed."); setOpen(false); return; }
    setOpen(false);
    if (r.restart?.ok) {
      setDone("Saved. The console restarts now; agents keep running.");
      void waitForRestart();
    } else {
      setDone(`Saved. Restart the console to use it (${r.restart?.why ?? "it cannot restart itself"}).`);
    }
  };

  const restartWords = setup.restart.ok
    ? "Save checks the token with Telegram, writes the console's settings file (the old one stays as a backup) and restarts the console. Agents keep running. New values reach agents after the restart."
    : `Save checks the token with Telegram and writes the console's settings file (the old one stays as a backup). Then restart the console: ${setup.restart.why}.`;
  const ids = (
    <>
      <Input f="account" v={vals.account} onChange={set("account")} bad={err?.field === "account"} disabled={busy} />
      <p className={s.label}>Fleet master chat</p>
      {(["masterGroup", "masterTopic"] as const).map((f) => <Input key={f} f={f} v={vals[f]} onChange={set(f)} bad={err?.field === f} disabled={busy} />)}
      <p className={s.label}>Recurring results</p>
      {(["cronGroup", "cronTopic"] as const).map((f) => <Input key={f} f={f} v={vals[f]} onChange={set(f)} bad={err?.field === f} disabled={busy} />)}
    </>
  );

  return (
    <>
      <Block title={tokenOnly ? "Bot" : "Set-up"}>
        <Row>
          <span className={s.rowName}>{tokenOnly ? "Bot token" : "Bot and chats"}</span>
          <span className={s.rowMeta}>{waiting ? "Restarting…" : tokenOnly ? (setup.tokenSet ? (botName ? `Set · @${botName} answers` : "Set") : "Paste the token of your bot") : setup.tokenSet ? "Change the bot token or where it posts" : "Connect a bot"}</span>
          {!open && (
            <button type="button" className={s.btn} disabled={!setup.canSave || waiting || setup.restarting} onClick={start}>
              {setup.tokenSet ? "Change" : "Set up"}
            </button>
          )}
        </Row>
        {open && (
          <Form label="Telegram set-up" onSubmit={() => void submit()}>
            <TokenInput inputRef={tokenRef} bad={err?.field === "token"} disabled={busy} tokenSet={setup.tokenSet} />
            {!tokenOnly && (
              // A field with an error opens the fold, so the error is next to its field.
              <details className={s.fold} open={!!err?.field && err.field !== "token" ? true : undefined}>
                <summary className={s.foldHead}>Type the ids by hand</summary>
                <div className={s.foldBody}>
                  <span className={s.help}>You do not need this: “Connect your chat” reads the ids from a message. Recurring results can have a group and topic of their own only here.</span>
                  {ids}
                </div>
              </details>
            )}
            <Note>{restartWords}</Note>
            {err && <ErrorLine text={err.field ? `${LABELS[err.field].label}: ${err.error}` : err.error} />}
            <div className={s.actions}>
              <button type="submit" className={`${s.btn} ${s.primary}`} disabled={busy}>{busy ? "Checking…" : setup.restart.ok ? "Save and restart" : "Save"}</button>
              <button type="button" className={`${s.btn} ${s.quiet}`} disabled={busy} onClick={() => { setOpen(false); setErr(null); setVals(fresh()); }}>Cancel</button>
            </div>
          </Form>
        )}
      </Block>
      {!setup.canSave && setup.why && <Note>{setup.why}.</Note>}
      {done && <p className={s.note} role="status">{done}</p>}
    </>
  );
}
