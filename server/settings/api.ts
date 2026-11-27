// server/settings/api.ts — the Settings page's add-on routes (status and safe actions only).
//   GET  /api/settings/telegram        any session: what is set up (booleans, ids, key names)
//   POST /api/settings/telegram/test   USER (gateUser): one test message to a target
//   POST /api/settings/telegram/setup  USER (gateUser): write the bot token and the chat ids to the
//                                      console's .env (write-only token), then restart the console
//   POST /api/settings/telegram/link        USER: a one-time code that connects the account (or
//                                           the fleet master chat) from one message (link.ts)
//   POST /api/settings/telegram/disconnect  USER: remove the account or the fleet master chat
//   GET  /api/settings/github[?fresh]  any session: the gh login, repo access, rate limit
// Reads stay open while the chief is misconfigured: this is where the user looks for what is
// wrong. No secret value is ever in an answer or a log line: the bot token is a boolean and every
// error text is scrubbed.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { DeviceStore } from "../chief/auth.js";
import { gateUser, type ChiefGate } from "../chief/gate.js";
import type { Repo } from "../gh/repos.js";
import type { AppTokenView } from "../gh/appapi.js";
import { githubStatus, type GhRun, type GitHubStatus } from "./github.js";
import { z } from "zod";
import { BotCheck, checkToken, scrub, sendTest, telegramConfig, type Env, type TargetId, type TelegramDeps } from "./telegram.js";
import { envFileWritable, envWriteBusy, EnvWriteError, readEnvFileKeys, writeEnvFile } from "./envfile.js";
import { planSetup, SETUP_FIELDS, setupValues, type Restarter } from "./setup.js";
import { TelegramLink, type Restart } from "./link.js";

export type SettingsApiDeps = {
  env: Env;
  // With the chief: its gate (actions are USER only), paired devices and sign-in mode. Without it
  // there is no user identity, so no action route answers (403 needs-chief).
  chief?: { gate: ChiefGate; active: boolean; devices: Pick<DeviceStore, "list"> };
  telegram?: TelegramDeps;
  gh: GhRun;
  ghRepos: () => Promise<Repo[]>;
  // The ChoiBot GitHub app switch is on: the state of its key (gh/appapi.ts appTokenView).
  githubApp?: () => Promise<AppTokenView>;
  // The set-up form (PR C): the console's .env and the restart that applies a save. Without
  // envFile the form route answers 404.
  envFile?: string;
  restarter?: Restarter;
  // When this server started (epoch ms): the page sees a restart as a new value.
  bootAt?: number;
  // What the page shows of a connection made with a one-time code (link.ts). With envFile and
  // the chief it turns on the link routes; without it they answer 404.
  linkStateFile?: string;
  // The steps of the Set-up page read the state again.
  onLinkChange?: () => void;
  now?: () => number;
  log?: (s: string) => void;
};

const linkBody = z.object({ kind: z.enum(["account", "chat"]), replace: z.boolean().optional() }).strict();
const disconnectBody = z.object({ what: z.enum(["account", "chat"]) }).strict();
const setupBody = z.object(Object.fromEntries(Object.keys(SETUP_FIELDS).map((f) => [f, z.string().max(200).optional()])) as Record<keyof typeof SETUP_FIELDS, z.ZodOptional<z.ZodString>>).strict();

const TEST_GAP_MS = 15_000;  // one test message per target per 15 s
const GH_TTL_MS = 60_000;    // the GitHub check is cached for a minute
const GH_FRESH_GAP_MS = 10_000;
const BOT_FRESH_GAP_MS = 10_000; // ?fresh=1 is open to any session: getMe at most every 10 s

export const NEEDS_CHIEF = { error: "needs-chief", text: "Actions need a paired device: turn on the chief (CHIEF_ENABLED=1) first" };

export function registerSettingsApi(app: FastifyInstance, d: SettingsApiDeps): { link: TelegramLink | null; forgetGithub(): void } {
  const now = d.now ?? Date.now;
  const log = d.log ?? ((s: string) => console.warn(s));
  const bot = new BotCheck(d.telegram);
  const token = (): string => (d.env.TELEGRAM_BOT_TOKEN ?? "").trim();
  const lastTest = new Map<TargetId | "account", number>();

  // The restart that applies a save: one for the form and the link codes.
  let restarting = false;
  const noRestart = (why: string): Restart => ({ ok: false, why });
  const armedNow = async (): Promise<Restart> => (d.restarter
    ? d.restarter.armed().catch(() => noRestart("the restart check failed"))
    : noRestart("this console cannot restart itself"));
  const restartAfterSave = async (): Promise<Restart> => {
    const armed = await armedNow();
    if (!armed.ok) return armed;
    try {
      await d.restarter!.schedule();
      restarting = true;
      return { ok: true };
    } catch {
      return noRestart("the restart could not be started");
    }
  };
  const link = d.envFile && d.chief && d.linkStateFile
    ? new TelegramLink({ env: d.env, envFile: d.envFile, stateFile: d.linkStateFile, telegram: d.telegram, afterSave: restartAfterSave, onChange: d.onLinkChange, now, log })
    : null;
  let lastFresh = -Infinity;
  const chiefOf = () => ({ active: !!d.chief?.active, problem: d.chief?.gate.misconfigured ?? null });

  app.get("/api/settings/telegram", async (req) => {
    const askFresh = (req.query as { fresh?: string }).fresh === "1";
    const fresh = askFresh && now() - lastFresh >= BOT_FRESH_GAP_MS;
    if (fresh) lastFresh = now();
    const cfg = telegramConfig(d.env, chiefOf());
    const t = token();
    const devices = d.chief ? (await d.chief.devices.list().catch(() => null))?.length ?? null : null;
    return {
      ...cfg,
      bot: t ? await bot.info(t, fresh) : null,
      chief: d.chief ? (d.chief.gate.misconfigured === null ? "on" : "misconfigured") : "off",
      // A fixed sentence of server/chief/paths.ts chiefMisconfigured (key names, no value).
      chiefProblem: d.chief?.gate.misconfigured ?? null,
      userAuth: d.chief?.gate.userAuth ?? null,
      devices,
      canTest: !!d.chief,
      setup: await setupState(),
      // The connection made with a one-time code: states only, never a code or an id.
      link: link ? await link.view() : null,
      bootAt: d.bootAt ?? null,
    };
  });

  // What the form shows: the ids now (never the token), whether a save can work, and whether the
  // console can restart itself after it.
  const setupState = async () => {
    if (!d.envFile) return null;
    const file = await envFileWritable(d.envFile);
    const restart = await armedNow();
    return {
      values: setupValues(d.env),
      tokenSet: token() !== "",
      canSave: !!d.chief && d.chief.gate.misconfigured === null && file.ok,
      why: !d.chief ? "Saving needs a paired device: the chief of staff is off" : file.ok ? null : `Saving is off: ${file.why}`,
      restart: restart.ok ? { ok: true } : { ok: false, why: restart.why },
      restarting,
    };
  };

  app.post("/api/settings/telegram/setup", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!d.envFile) return reply.code(404).send({ error: "not found" });
    if (!d.chief) return reply.code(403).send(NEEDS_CHIEF);
    const caller = await gateUser(d.chief.gate, req, reply);
    if (!caller) return reply;
    if (envWriteBusy()) return reply.code(409).send({ error: "Another save is running. Try again in a moment." });
    if (restarting) return reply.code(409).send({ error: "The console restarts now. Try again after it is back." });
    const b = setupBody.safeParse(req.body ?? {});
    if (!b.success) return reply.code(400).send({ field: null, error: "The form was not understood." });
    const file = await envFileWritable(d.envFile);
    if (!file.ok) return reply.code(409).send({ field: null, error: `Saving is off: ${file.why}` });
    let current;
    try { current = await readEnvFileKeys(d.envFile); } catch { return reply.code(409).send({ field: null, error: "Saving is off: the settings file cannot be read" }); }
    const plan = planSetup(b.data, d.env, current);
    if ("error" in plan) return reply.code(400).send(plan);
    if (plan.newToken) {
      const c = await checkToken(d.telegram ?? {}, plan.newToken);
      if (!c.ok) {
        return reply.code(400).send(c.refused
          ? { field: "token", error: "Telegram does not accept this token. Copy it again from @BotFather." }
          : { field: "token", error: "Telegram did not answer, so the token is not checked. Nothing was saved." });
      }
    }
    const keys = Object.keys(plan.changes);
    if (!keys.length) return { saved: false, text: "Nothing changed." };
    try {
      await writeEnvFile(d.envFile, plan.changes);
    } catch (e) {
      const text = e instanceof EnvWriteError ? e.message : "the write failed";
      log(`[settings] telegram set-up not saved: ${text}`);
      return reply.code(500).send({ field: null, error: `Not saved: ${text}` });
    }
    // Key names only, never a value.
    log(`[settings] telegram set-up saved by device ${caller.device ?? "?"}: ${keys.join(", ")}`);
    return { saved: true, restart: await restartAfterSave() };
  });

  // The checks every link action shares. Returns the caller's device, or null after a refusal.
  const linkGate = async (req: FastifyRequest, reply: FastifyReply): Promise<{ device: string } | null> => {
    if (!d.envFile || !d.linkStateFile) { reply.code(404).send({ error: "not found" }); return null; }
    if (!d.chief || !link) { reply.code(403).send(NEEDS_CHIEF); return null; }
    const caller = await gateUser(d.chief.gate, req, reply);
    if (!caller) return null;
    if (restarting) { reply.code(409).send({ error: "The console restarts now. Try again after it is back." }); return null; }
    const file = await envFileWritable(d.envFile);
    if (!file.ok) { reply.code(409).send({ error: `Saving is off: ${file.why}` }); return null; }
    return { device: caller.device ?? "?" };
  };

  // A one-time code, on the user's press. The code is in this answer only (never in the status,
  // never in a log). The bot's public name makes the "Open Telegram" link.
  app.post("/api/settings/telegram/link", async (req: FastifyRequest, reply: FastifyReply) => {
    const by = await linkGate(req, reply);
    if (!by || !link) return reply;
    const b = linkBody.safeParse(req.body ?? {});
    if (!b.success) return reply.code(400).send({ error: "The request was not understood." });
    if (!token()) return reply.code(409).send({ error: "Add the bot token first." });
    const info = await bot.info(token());
    if (!info.ok || !info.username) return reply.code(409).send({ error: "The bot does not answer. Check its token first." });
    const r = await link.start(b.data.kind, b.data.replace === true);
    if (!r.ok) return reply.code(409).send({ error: r.error, ...(r.exists ? { exists: true } : {}) });
    log(`[settings] telegram ${b.data.kind} code made by device ${by.device}`);
    return {
      kind: b.data.kind, code: r.code, expiresAt: r.expiresAt, bot: info.username,
      ...(b.data.kind === "account"
        ? { url: `https://t.me/${info.username}?start=${r.raw}`, send: `/start ${r.code}` }
        : { send: `/connect@${info.username} ${r.code}` }),
    };
  });

  app.post("/api/settings/telegram/disconnect", async (req: FastifyRequest, reply: FastifyReply) => {
    const by = await linkGate(req, reply);
    if (!by || !link) return reply;
    const b = disconnectBody.safeParse(req.body ?? {});
    if (!b.success) return reply.code(400).send({ error: "The request was not understood." });
    if (envWriteBusy()) return reply.code(409).send({ error: "Another save is running. Try again in a moment." });
    const r = await link.disconnect(b.data.what);
    if (!r.ok) return reply.code(409).send({ error: r.error });
    if (r.changed) log(`[settings] telegram ${b.data.what} disconnected by device ${by.device}`);
    return { changed: r.changed, restart: r.restart };
  });

  app.post("/api/settings/telegram/test", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!d.chief) return reply.code(403).send(NEEDS_CHIEF);
    if (!(await gateUser(d.chief.gate, req, reply))) return reply;
    const want = (req.body as { target?: unknown } | null)?.target;
    // The connected account's own chat with the bot (link.ts): the test of the Telegram step.
    if (want === "account" && link) {
      if (!(await link.view()).account.connected) return reply.code(409).send({ error: "No Telegram account is connected." });
      const at = now();
      if (at - (lastTest.get("account") ?? -Infinity) < TEST_GAP_MS) return reply.code(429).send({ error: "Wait a few seconds before the next test" });
      lastTest.set("account", at);
      try {
        await link.testAccount();
        return { ok: true };
      } catch (e) {
        const text = scrub(e instanceof Error ? e.message : String(e), token());
        log(`[settings] telegram test to the account failed: ${text}`);
        // 500, never 502: Cloudflare (the hosted console's edge) puts its own page in place of the body of an origin 502 or 504.
        return reply.code(500).send({ error: `Telegram refused it: ${text}` });
      }
    }
    const target = telegramConfig(d.env, chiefOf()).targets.find((x) => x.id === want);
    if (!target) return reply.code(400).send({ error: "target must be master, cron or notify" });
    if (!target.testable) return reply.code(409).send({ error: `${target.label} has no chat of its own` });
    if (target.missing.length) return reply.code(409).send({ error: `Not set: ${target.missing.join(", ")}` });
    const at = now();
    const last = lastTest.get(target.id) ?? -Infinity;
    if (at - last < TEST_GAP_MS) return reply.code(429).send({ error: "Wait a few seconds before the next test" });
    lastTest.set(target.id, at);
    try {
      await sendTest(d.telegram ?? {}, token(), target);
      return { ok: true };
    } catch (e) {
      const text = scrub(e instanceof Error ? e.message : String(e), token());
      log(`[settings] telegram test to ${target.id} failed: ${text}`);
      return reply.code(500).send({ error: `Telegram refused it: ${text}` });
    }
  });

  let ghCache: GitHubStatus | null = null;
  let ghInflight: Promise<GitHubStatus> | null = null;
  app.get("/api/settings/github", async (req) => {
    const fresh = (req.query as { fresh?: string }).fresh === "1";
    const t = now();
    const age = ghCache ? t - ghCache.checkedAt : Infinity;
    if (ghCache && (age < (fresh ? GH_FRESH_GAP_MS : GH_TTL_MS))) return ghCache;
    ghInflight ??= githubStatus({ gh: d.gh, repos: d.ghRepos, now, ...(d.githubApp ? { app: d.githubApp } : {}) })
      .then((s) => { ghCache = s; return s; })
      .finally(() => { ghInflight = null; });
    return ghInflight;
  });

  // forgetGithub: the GitHub login changed (the code login ended well): the next read asks
  // GitHub again, also inside the gap that a "fresh" read keeps.
  return { link, forgetGithub: () => { ghCache = null; } };
}
