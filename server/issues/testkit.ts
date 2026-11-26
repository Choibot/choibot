// server/issues/testkit.ts — shared test doubles for the issues subsystem.
// vitest only collects *.test.ts, so this file is never run on its own; the
// issues tests import it. The fake speaks the real Bot API wire format, so the
// tests exercise createTelegramClient end to end.
import { createTelegramClient, type TelegramClient, type TgMessage, type TgUpdate } from "./telegram.js";
import type { Issue } from "./store.js";

export const USER_ID = 4242;

export function tgMessage(message_id: number, over: Partial<TgMessage> = {}): TgMessage {
  return {
    message_id, date: 0,
    from: { id: USER_ID, first_name: "Me" },
    chat: { id: USER_ID, type: "private" },
    ...over,
  };
}

export type BotCall = {
  method: string; body: Record<string, any>;
  /** Multipart calls only: the file parts by field name. */
  files?: Record<string, { filename: string; type: string; size: number }>;
};

export function fakeBotApi(opts: { files?: Record<string, Buffer> } = {}) {
  const updates: TgUpdate[] = [];
  const calls: BotCall[] = [];
  let nextMessageId = 1000;
  const failures: { status: number; description: string; retryAfter?: number }[] = [];
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const file = /\/file\/bot[^/]+\/(.+)$/.exec(url);
    if (file) {
      const buf = opts.files?.[file[1]];
      return buf ? new Response(new Uint8Array(buf)) : new Response("not found", { status: 404 });
    }
    const method = url.split("/").pop() ?? "";
    let body: Record<string, any> = {};
    let files: BotCall["files"];
    if (init?.body instanceof FormData) {
      files = {};
      for (const [k, v] of init.body.entries()) {
        if (typeof v === "string") body[k] = v;
        else files[k] = { filename: v.name, type: v.type, size: v.size };
      }
    } else if (init?.body) body = JSON.parse(String(init.body));
    calls.push(files ? { method, body, files } : { method, body });
    const f = failures.shift();
    if (f) {
      return json(f.status, {
        ok: false, error_code: f.status, description: f.description,
        ...(f.retryAfter !== undefined ? { parameters: { retry_after: f.retryAfter } } : {}),
      });
    }
    switch (method) {
      case "getUpdates":
        return json(200, { ok: true, result: updates.filter((u) => u.update_id >= (body.offset ?? 0)) });
      case "sendMessage":
        return json(200, {
          ok: true,
          result: { message_id: nextMessageId++, date: 0, chat: { id: body.chat_id, type: "private" }, text: body.text },
        });
      case "sendPhoto":
        return json(200, {
          ok: true,
          result: { message_id: nextMessageId++, date: 0, chat: { id: Number(body.chat_id), type: "private" }, photo: [] },
        });
      case "sendMediaGroup":
        return json(200, {
          ok: true,
          result: (JSON.parse(body.media) as unknown[]).map(() => (
            { message_id: nextMessageId++, date: 0, chat: { id: Number(body.chat_id), type: "private" }, photo: [] })),
        });
      case "getFile": {
        const path = `photos/${body.file_id}.jpg`;
        return json(200, { ok: true, result: { file_id: body.file_id, file_path: path, file_size: opts.files?.[path]?.length } });
      }
      default:
        return json(200, { ok: true, result: true });
    }
  }) as typeof fetch;

  return {
    fetch: fetchImpl,
    calls,
    sent: (method = "sendMessage") => calls.filter((c) => c.method === method).map((c) => c.body),
    push: (...u: TgUpdate[]) => { updates.push(...u); },
    // Queues one failure for the next call; call it twice to fail two calls.
    failNext: (status: number, description: string, retryAfter?: number) => { failures.push({ status, description, retryAfter }); },
  };
}

export type FakeBot = ReturnType<typeof fakeBotApi>;

export function clientFor(bot: FakeBot): TelegramClient {
  return createTelegramClient({ token: "TEST-TOKEN", fetch: bot.fetch, baseUrl: "http://tg.test" });
}

export function makeIssue(over: Partial<Issue> = {}): Issue {
  return {
    id: "t100", createdAt: 1, source: "telegram",
    text: "Login button broken", photos: [],
    repo: "choibot", repoConfidence: 0.9, repoChoices: ["app-shop", "choibot"],
    summary: "Login button broken", status: "pending", chatMessageIds: [100],
    ...over,
  };
}
