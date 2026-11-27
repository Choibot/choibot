// src/lib/limit.ts — the buttons of the usage-limit ticket (server/chief/limit): one POST per
// press. The server checks the ticket, the row and the login again; the answer of "all" says how
// many it took. The route needs this device's user token (chiefFetch adds it).
import type { QueueItem } from "../../server/chief/queue/types"; // type-only
import type { LimitPress } from "../../server/chief/limit/ticket";
import { chiefFetch, refusalSentence } from "./chief";

export type LimitResult = { ok: true; item: QueueItem; text: string } | { ok: false; status: number; error: string };

type Deps = { fetch?: typeof fetch; storage?: Pick<Storage, "getItem"> | null };

export async function pressLimit(itemId: string, press: LimitPress, deps: Deps = {}): Promise<LimitResult> {
  try {
    const res = await chiefFetch(`/api/queue/${encodeURIComponent(itemId)}/limit`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(press),
    }, deps);
    const b = (await res.json().catch(() => null)) as { item?: QueueItem; text?: string; error?: string; userAuth?: string } | null;
    if (res.ok && b?.item) return { ok: true, item: b.item, text: typeof b.text === "string" ? b.text : "" };
    const fixed = refusalSentence(res.status, b, "This button");
    return { ok: false, status: res.status, error: fixed ?? (typeof b?.error === "string" ? b.error : `HTTP ${res.status}`) };
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : "network error" };
  }
}

// A time as this device shows it ("14:05").
export const limitClock = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
