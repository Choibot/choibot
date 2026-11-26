// src/lib/useQueue.ts — the Queue tab's data hook: one fetch on mount (retried while
// the view is "loading"), queue SSE upserts, the pairing flag from chiefFetch's state,
// and a server-anchored clock. No SSE is opened while the view is off or misconfigured.
"use client";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { fetchQueue, loadRetryDelay, type QueueResponse } from "./queue";
import { tabReducer, type TabEvent, type TabState } from "./queueState";
import { getChiefState, hasUserToken, subscribeChiefState } from "./chief";
import { useEvents } from "./useEvents";

export type QueueViewKind = "loading" | "off" | "misconfigured" | "on";
export type UseQueue = {
  view: QueueViewKind; state: TabState; data?: QueueResponse;
  dispatch(e: TabEvent): void; now(): number;
  refresh(): void; // re-fetch GET /api/queue (tab becomes active, stream (re)opens); a failure keeps the view
  seenJumps: { current: number }; // the last `state.jumps` the view acted on; outlives the view's unmount (I1)
};

export function useQueue(): UseQueue {
  const [view, setView] = useState<QueueViewKind>("loading");
  const viewRef = useRef(view);
  viewRef.current = view;
  const [data, setData] = useState<QueueResponse | undefined>(undefined);
  const [state, dispatch] = useReducer(tabReducer, undefined, (): TabState => ({
    items: [], focusId: null, pending: {}, error: null, readOnly: getChiefState().pairRequired || !hasUserToken(), arrived: {}, jumps: 0,
  }));
  const anchor = useRef({ serverNow: Date.now(), fetchedAt: Date.now() });
  const streamSeq = useRef(0); // stream upserts so far, in arrival order (the `loaded` marker, I2)
  const seenJumps = useRef(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  // One fetch: apply it and resolve true, or keep the current view and resolve false.
  const load = useCallback(async (): Promise<boolean> => {
    const since = streamSeq.current; // an upsert after this may be missing from the snapshot
    try {
      const v = await fetchQueue();
      if (!alive.current) return true;
      if (v.state === "on") {
        anchor.current = { serverNow: v.data.serverNow, fetchedAt: Date.now() };
        setData(v.data);
        dispatch({ t: "loaded", items: v.data.items, since, now: v.data.serverNow });
      }
      setView(v.state);
      return true;
    } catch { return false; }
  }, []);
  const refresh = useCallback(() => { void load(); }, [load]);

  // First fetch; while it fails and the view is still "loading" (no stream-open or tab refetch
  // landed meanwhile), retry with backoff: 2 s, 5 s, 15 s, then every 60 s. The Queue tab, and the
  // Brain panel inside it, exist only once a fetch succeeds.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const attempt = (n: number) => {
      void load().then((ok) => {
        if (ok || stopped || !alive.current || viewRef.current !== "loading") return;
        timer = setTimeout(() => { if (viewRef.current === "loading") attempt(n + 1); }, loadRetryDelay(n));
      });
    };
    attempt(0);
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [load]);

  useEffect(() => {
    const apply = (cs: ReturnType<typeof getChiefState>) => {
      dispatch({ t: "pairState", readOnly: cs.pairRequired || !hasUserToken() });
      if (cs.misconfigured) setView((cur) => (cur === "off" ? cur : "misconfigured"));
    };
    apply(getChiefState());
    return subscribeChiefState(apply);
  }, []);

  const now = useCallback(() => anchor.current.serverNow + (Date.now() - anchor.current.fetchedAt), []);
  // Each stream open (first open and every SSE reconnect) re-fetches: it closes the snapshot-to-stream gap.
  useEvents((e) => {
    if (e.type === "queue") dispatch({ t: "sse", item: e.item, seq: ++streamSeq.current, now: now() });
  }, view === "on", refresh);

  return { view, state, data, dispatch, now, refresh, seenJumps };
}
