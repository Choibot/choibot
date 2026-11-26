// src/components/settings/TelegramSettings.tsx — the Telegram bot of the console (GET
// /api/settings/telegram), in plain words: is the bot connected, where the console posts (the
// fleet master chat, the queue cards, recurring results, agent notifications) with each one's state
// ("Ready", "Not set up", "Off") and "Send a test" (USER only), and how to pair a device.
//
// No key name in the main view. The "Set-up" form (TelegramSetupForm) writes the bot token and the
// chats; where a save cannot work (the chief is off), the closed "How to set this up" fold keeps
// the key names for the person who edits the box.
"use client";
import { useCallback, useEffect, useState } from "react";
import { fetchTelegram, sendTelegramTest, targetIds, targetState, targetWhere, telegramStatus, type Read, type Target, type TargetId, type TelegramView } from "../../lib/settings";
import { useRemembered, viewMemory } from "../../lib/viewCache";
import { RefreshIcon } from "../SideIcons";
import { Block, cx as s, Dot, Empty, HowTo, Row, StatusLine, type SectionProps } from "./kit";
import { TelegramSetupForm } from "./TelegramSetupForm";
import { TelegramConnect } from "./TelegramConnect";
import { USER_CLI } from "../../../server/brand";

const seen = viewMemory<Read<TelegramView>>(1);

type Sent = { target: TargetId; ok: boolean; text: string };

function TargetRow({ v, t, onTest, busy, sent }: { v: TelegramView; t: Target; onTest: (id: TargetId) => void; busy: boolean; sent: Sent | null }) {
  const st = targetState(t);
  return (
    <div className={`${s.row} ${s.rowTall}`}>
      <Dot tone={st.tone} title={st.word} />
      <span className={s.stack}>
        <span className={s.line}>
          <span className={s.rowName}>{t.label}</span>
          <span className={s.rowMeta}>{targetWhere(v, t)}</span>
          {t.testable && st.word === "Ready" && v.canTest && (
            <button type="button" className={`${s.btn} ${s.quiet}`} disabled={busy} onClick={() => onTest(t.id)}
              aria-label={`Send a test message to the ${t.label}`}>{busy ? "Sending…" : "Send a test"}</button>
          )}
          <span className={`${s.tag} ${st.word === "Ready" ? "" : s.tagOff}`}>{st.word}</span>
        </span>
        <span className={s.help}>{t.what}</span>
        {st.needs && <span className={st.word === "Off" ? s.help : s.missing}>{st.needs}</span>}
        {sent?.target === t.id && <span className={sent.ok ? s.ok : s.missing} role={sent.ok ? "status" : "alert"}>{sent.text}</span>}
      </span>
    </div>
  );
}

// The fold: which key of the console's .env file each part reads, and what it holds now.
function SetUpHelp({ v }: { v: TelegramView }) {
  const own = (t: Target) => t.keys.filter((k) => k !== "TELEGRAM_BOT_TOKEN" && k !== "TELEGRAM_ISSUES_USER_ID" && k !== "CHIEF_ENABLED");
  return (
    <HowTo>
      <p>The console reads these values from its <code>.env</code> file when it starts. Run <code>{USER_CLI} setup</code> on your server, or edit the file, then restart the console.</p>
      <ul>
        <li><code>TELEGRAM_BOT_TOKEN</code> · {v.token ? "set" : "not set: make a bot with @BotFather"}</li>
        <li><code>TELEGRAM_ISSUES_USER_ID</code> · {v.userId ? "set" : "not set: your own Telegram user id"}</li>
        {v.targets.filter((t) => !t.sameAs && own(t).length).map((t) => (
          <li key={t.id}>{t.label}: {own(t).map((k, i) => <span key={k}>{i ? ", " : ""}<code>{k}</code></span>)}
            {targetIds(t) ? ` · now ${targetIds(t)}` : " · not set"}</li>
        ))}
        <li>The fleet master chat is a topic of a forum group, and the bot must be an admin of that group. While its ids are not set, the console log prints them when you write in the topic.</li>
        <li>Recurring results go to the agent notifications chat unless they have a group and topic of their own. <code>TELEGRAM_NOTIFY_AGENTS=0</code> turns agent notifications off.</li>
        {v.chief === "off" && <li>Queue cards and pairing need the chief of staff: <code>CHIEF_ENABLED=1</code>.</li>}
        {v.chiefProblem && <li>The chief of staff does not start: {v.chiefProblem}.</li>}
      </ul>
    </HowTo>
  );
}

export function TelegramSettings({ go, has }: SectionProps) {
  const [read, setRead] = useRemembered(seen, "telegram", null);
  const [checking, setChecking] = useState(false);
  // quiet: the read of the connect steps while a code waits (no "Checking…" on the button).
  const load = useCallback(async (fresh = false, quiet = false) => {
    if (!quiet) setChecking(true);
    try {
      setRead({ rows: [await fetchTelegram(fresh)] });
    } catch {
      setRead((p) => (p && "rows" in p ? p : { error: "the console did not answer" }));
    } finally {
      setChecking(false);
    }
  }, [setRead]);
  useEffect(() => { void load(); }, [load]);
  const v = read && "rows" in read ? read.rows[0] : null;

  const [sending, setSending] = useState<TargetId | null>(null);
  const [sent, setSent] = useState<Sent | null>(null);
  const test = async (id: TargetId) => {
    if (sending) return;
    setSending(id); setSent(null);
    const r = await sendTelegramTest(id);
    setSending(null);
    setSent(r.ok ? { target: id, ok: true, text: "Sent. Look for it in Telegram." } : { target: id, ok: false, text: r.error });
  };

  const bot = !v ? "" : !v.token ? "Not connected" : v.bot?.ok ? `Connected as @${v.bot.username}` : v.bot ? `The token does not work: ${v.bot.error}` : "Checking…";

  return (
    <>
      <StatusLine status={telegramStatus(read)} />
      <Block title="Bot" right={(
        <button type="button" className={s.btn} disabled={checking || !v?.token} onClick={() => void load(true)}>
          <RefreshIcon size={14} />{checking ? "Checking…" : "Check again"}
        </button>
      )}>
        {!v && <Empty>{read === null ? "Reading the Telegram set-up…" : "Cannot read it."}</Empty>}
        {v && (
          <>
            <Row>
              <Dot tone={!v.token ? "off" : v.bot?.ok ? "ok" : "err"} title={bot} />
              <span className={s.rowName}>Bot</span>
              <span className={s.rowMeta}>{bot}{v.bot?.ok && v.bot.name ? ` · ${v.bot.name}` : ""}</span>
            </Row>
            <Row>
              <Dot tone={v.userId ? "ok" : "off"} />
              <span className={s.rowName}>Your account</span>
              <span className={s.rowMeta} title="The bot answers only this Telegram account">{v.userId ? "Set" : "Not set"}</span>
            </Row>
          </>
        )}
      </Block>

      {v?.link && v.token && v.bot?.ok && (
        <section className={s.block}>
          <div className={s.blockHead}><h3 className={s.blockTitle}>Your chats</h3></div>
          <TelegramConnect v={v} reload={() => load(false, true)} />
        </section>
      )}

      {v && (
        <Block title="Where it posts">
          {v.targets.map((t) => <TargetRow key={t.id} v={v} t={t} onTest={(id) => void test(id)} busy={sending === t.id} sent={sent} />)}
        </Block>
      )}

      {v && v.chief !== "off" && (
        <Block title="Pairing">
          <Row>
            <span className={s.rowName}>Paired devices</span>
            <span className={s.rowMeta}>{v.devices === null ? "Unknown" : v.devices}</span>
            {has("devices") && <button type="button" className={`${s.btn} ${s.quiet}`} onClick={() => go("devices")}>Open Devices</button>}
          </Row>
          <div className={`${s.row} ${s.rowTall}`}>
            <span className={s.help}>
              {v.userAuth === "telegram"
                ? <>To pair a new device, send <code>/pair &lt;name&gt;</code> in the fleet master chat. The bot answers with a link: open it on that device and press Pair.</>
                : <>To pair a new device, open Devices and press “Add a device”. Telegram does not add a device on this console.</>}
            </span>
          </div>
        </Block>
      )}

      {v?.setup?.canSave
        ? <TelegramSetupForm setup={v.setup} bootAt={v.bootAt ?? null} onDone={() => load(true)} />
        : v && <SetUpHelp v={v} />}
    </>
  );
}
