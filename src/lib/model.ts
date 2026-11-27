// src/lib/model.ts — the client of Settings > Model (server/settings/model.ts): the model of an
// agent that has none of its own.
import { chiefFetch, refusalSentence } from "./chief";

export type ModelSetting = {
  model: string; set: boolean; wrong: string | null; choices: string[]; canSave: boolean; why: string | null;
};
type Deps = { fetch?: typeof fetch; storage?: Pick<Storage, "getItem"> | null };

export async function fetchModelSetting(deps: Deps = {}): Promise<ModelSetting> {
  const res = await chiefFetch("/api/settings/model", undefined, deps);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as ModelSetting;
}

export async function saveModel(model: string, deps: Deps = {}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await chiefFetch("/api/settings/model", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model }),
    }, deps);
    if (res.ok) return { ok: true };
    const b = (await res.json().catch(() => null)) as { error?: string } | null;
    return { ok: false, error: refusalSentence(res.status, b, "Model") ?? (typeof b?.error === "string" ? b.error : `The console answered HTTP ${res.status}.`) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "network error" };
  }
}
