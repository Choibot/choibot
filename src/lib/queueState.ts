// src/lib/queueState.ts — pure reducer for the Queue tab (spec §8b "Batch behaviour"):
// optimistic update per item, rollback on error, focus moves to the next Open row,
// a failure never touches neighbours. No React, no fetch.
//
// Two final-wave rules: a focus move the user did not cause (the focused row left Open by a
// server change) counts in `jumps`, and the view pauses commit keys on each new one (I1); a
// refetch keeps an item the stream delivered after that fetch started (I2).
import type { QueueItem } from "../../server/chief/queue/types"; // type-only
import { upsertItem } from "./queue";
import { sortOpen } from "../../server/chief/queue/priority";
import { openOrder } from "./queueInbox";

export type TabState = {
  items: QueueItem[]; focusId: string | null;
  pending: Record<string, QueueItem>; // id -> the item before the optimistic change
  error: string | null; readOnly: boolean;
  errorId?: string | null; // the item the error belongs to
  arrived: Record<string, number>; // id -> `seq` of its latest stream upsert (I2)
  jumps: number; // focus moves forced by a server change (I1)
};
// `seq` numbers stream upserts in arrival order; `since` is the last seq seen when the fetch started.
export type TabEvent =
  | { t: "loaded"; items: QueueItem[]; since: number; now: number } | { t: "sse"; item: QueueItem; seq: number; now: number }
  | { t: "focus"; id: string | null } | { t: "move"; by: 1 | -1; now: number }
  | { t: "optimistic"; id: string; next: QueueItem; now: number }
  | { t: "confirmed"; item: QueueItem; now: number } | { t: "dismissError" } | { t: "failed"; id: string; current?: QueueItem; error: string; now: number }
  | { t: "pairState"; readOnly: boolean };

function withoutPending(p: Record<string, QueueItem>, id: string): Record<string, QueueItem> {
  const { [id]: _drop, ...rest } = p;
  return rest;
}

// Focus after item `id` leaves Open: the next Open row, else the previous one, else none.
// "Next" is in the order the list shows (openOrder: the tickets that block an agent first).
function nextFocus(before: QueueItem[], after: QueueItem[], id: string, now: number): string | null {
  const open = openOrder(before, now);
  const at = open.findIndex((x) => x.id === id);
  const still = new Set(sortOpen(after, now).map((x) => x.id));
  const later = at < 0 ? [] : open.slice(at + 1), earlier = at < 0 ? [] : open.slice(0, at).reverse();
  return [...later, ...earlier].find((x) => still.has(x.id))?.id ?? null;
}

const isOpenIn = (items: QueueItem[], id: string | null, now: number): boolean => id !== null && sortOpen(items, now).some((x) => x.id === id);

// If the focused item was Open before and is not after, move focus off it.
function repairFocus(s: TabState, items: QueueItem[], id: string, now: number): string | null {
  if (s.focusId !== id) return s.focusId;
  return isOpenIn(s.items, id, now) && !isOpenIn(items, id, now) ? nextFocus(s.items, items, id, now) : s.focusId;
}

// A server change (stream or refetch) took the focused row out of Open: focus moves to the next
// row, as after a local answer, and the move counts as a jump (I1).
function serverFocus(s: TabState, items: QueueItem[], now: number): { focusId: string | null; jumps: number } {
  const id = s.focusId;
  if (id !== null && isOpenIn(s.items, id, now) && !isOpenIn(items, id, now)) {
    return { focusId: nextFocus(s.items, items, id, now), jumps: s.jumps + 1 };
  }
  return { focusId: id !== null && items.some((i) => i.id === id) ? id : null, jumps: s.jumps };
}

export function tabReducer(s: TabState, e: TabEvent): TabState {
  switch (e.t) {
    case "loaded": {
      // Per id the newer copy wins (as in `confirmed`): a snapshot older than an SSE update cannot reopen an answered item.
      // An item with a change in flight whose snapshot still has the pre-change status (the POST has not
      // landed; same rule as `sse`) keeps its optimistic copy and its saved original (the newer of the
      // saved and the snapshot copy), so a later failure can still roll back (F4). Pending entries of
      // items that left the snapshot, or whose status changed (the change landed), are dropped.
      const cur = new Map(s.items.map((i) => [i.id, i]));
      const pending: Record<string, QueueItem> = {};
      const items = e.items.map((i) => {
        const c = cur.get(i.id);
        const saved = s.pending[i.id];
        if (c && saved && saved.status === i.status) {
          pending[i.id] = i.updatedAt >= saved.updatedAt ? i : saved;
          return c;
        }
        return c && c.updatedAt > i.updatedAt ? c : i;
      });
      // I2: the server may have listed before an item the stream delivered after this fetch
      // started; such an item stays (with its change in flight). A later fetch decides again.
      const inSnapshot = new Set(e.items.map((i) => i.id));
      for (const i of s.items) {
        if (inSnapshot.has(i.id) || !((s.arrived[i.id] ?? -Infinity) > e.since)) continue;
        items.push(i);
        if (s.pending[i.id]) pending[i.id] = s.pending[i.id];
      }
      const kept = new Set(items.map((i) => i.id));
      const arrived = Object.fromEntries(Object.entries(s.arrived).filter(([id]) => kept.has(id)));
      return { ...s, items, pending, arrived, ...serverFocus(s, items, e.now) };
    }
    case "sse": {
      const saved = s.pending[e.item.id];
      const arrived = { ...s.arrived, [e.item.id]: e.seq };
      // The commit has not landed yet (status still the pre-change one): keep the optimistic item, refresh the saved copy.
      if (saved && saved.status === e.item.status) return { ...s, arrived, pending: { ...s.pending, [e.item.id]: e.item } };
      const items = upsertItem(s.items, e.item);
      const focus = s.focusId === e.item.id ? serverFocus(s, items, e.now) : { focusId: s.focusId, jumps: s.jumps };
      return { ...s, items, arrived, ...focus, pending: withoutPending(s.pending, e.item.id) };
    }
    case "confirmed": {
      const cur = s.items.find((i) => i.id === e.item.id);
      const stale = !!cur && cur.updatedAt > e.item.updatedAt;
      const items = stale ? s.items : upsertItem(s.items, e.item);
      const clearErr = s.errorId === e.item.id;
      return {
        ...s, items, focusId: repairFocus(s, items, e.item.id, e.now), pending: withoutPending(s.pending, e.item.id),
        ...(clearErr ? { error: null, errorId: null } : {}),
      };
    }
    case "dismissError":
      return { ...s, error: null, errorId: null };
    case "focus":
      return { ...s, focusId: e.id };
    case "move": {
      const open = openOrder(s.items, e.now);
      if (open.length === 0) return s;
      const i = open.findIndex((x) => x.id === s.focusId);
      if (i < 0) return { ...s, focusId: open[0].id };
      const j = Math.min(open.length - 1, Math.max(0, i + e.by));
      return { ...s, focusId: open[j].id };
    }
    case "optimistic": {
      if (s.readOnly) return s;
      const prev = s.items.find((i) => i.id === e.id);
      if (!prev) return s;
      const items = upsertItem(s.items, e.next);
      const stillOpen = new Set(sortOpen(items, e.now).map((x) => x.id));
      let focusId = s.focusId;
      if (focusId === e.id || focusId === null || !stillOpen.has(focusId)) {
        focusId = nextFocus(s.items, items, e.id, e.now);
      }
      // keep the oldest saved copy if a second optimistic change hits the same item
      return {
        ...s, items, focusId, pending: { ...s.pending, [e.id]: s.pending[e.id] ?? prev },
        ...(s.errorId === e.id ? { error: null, errorId: null } : {}),
      };
    }
    case "failed": {
      const saved = s.pending[e.id];
      // The newer copy wins, as in `confirmed`: a 409 body older than the server copy the tab
      // already holds (the saved original while a change is in flight, else the list copy, which
      // the stream may have replaced) never replaces it.
      const known = saved ?? s.items.find((i) => i.id === e.id);
      const restore = e.current && !(known && known.updatedAt > e.current.updatedAt) ? e.current : saved;
      const items = restore ? upsertItem(s.items, restore) : s.items;
      // With no focus, the restored item takes it only if it is in Open (sortOpen: a snooze that ended counts).
      const takesFocus = s.focusId === null && !!restore && sortOpen(items, e.now).some((x) => x.id === restore.id);
      return {
        ...s, items,
        focusId: takesFocus && restore ? restore.id : s.focusId,
        pending: withoutPending(s.pending, e.id), error: e.error, errorId: e.id,
      };
    }
    case "pairState":
      return { ...s, readOnly: e.readOnly };
  }
}
