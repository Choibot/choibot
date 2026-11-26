// Push-to-talk through the browser's own Web Speech API. The browser's speech service may send
// the audio to its vendor's cloud (Chrome does); the console adds no route and no third-party script.
type ResultLike = ArrayLike<{ transcript: string }> & { isFinal: boolean };
export interface SpeechRecognitionLike {
  lang: string; continuous: boolean; interimResults: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ResultLike> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  start(): void; stop(): void; abort(): void;
}
type Ctor = new () => SpeechRecognitionLike;

export function speechCtor(w: { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown } | undefined): Ctor | null {
  const c = w?.SpeechRecognition ?? w?.webkitSpeechRecognition;
  return typeof c === "function" ? (c as Ctor) : null;
}

export function appendTranscript(current: string, transcript: string): string {
  return [current.trim(), transcript.trim()].filter(Boolean).join(" ");
}

export type VoiceHandle = { stop(): void; abort(): void };
export type VoiceStart = { ok: true; handle: VoiceHandle } | { ok: false; error: string };

// One recognition session. A constructor or start() that throws (or an end before start()
// returned) gives {ok: false} and never calls onEnd. After that, onEnd runs exactly once, with the
// browser's error code when there is one. stop() lets the last final result arrive; abort() drops
// everything still to come (no late onText, no onEnd).
export function startPushToTalk(ctor: Ctor, o: { lang?: string; onText(t: string): void; onEnd(err?: string): void }): VoiceStart {
  let phase = "starting" as "starting" | "running" | "done";
  let early: string | undefined;
  const end = (err?: string) => {
    if (phase === "done") return;
    if (phase === "starting") { early = err; phase = "done"; return; }
    phase = "done";
    o.onEnd(err);
  };
  let r: SpeechRecognitionLike;
  try {
    r = new ctor();
    if (o.lang) r.lang = o.lang;
    r.continuous = true;
    r.interimResults = false;
    r.onresult = (e) => {
      if (phase !== "running") return;
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res?.isFinal && res[0]) o.onText(res[0].transcript);
      }
    };
    r.onend = () => end();
    r.onerror = (e) => end(e?.error ?? "error");
    r.start();
  } catch {
    phase = "done";
    return { ok: false, error: "start-failed" };
  }
  if ((phase as string) === "done") return { ok: false, error: early ?? "start-failed" }; // ended inside start()
  phase = "running";
  const rec = r;
  return {
    ok: true,
    handle: {
      stop() { if (phase !== "running") return; try { rec.stop(); } catch { end(); } },
      abort() { if (phase === "done") return; phase = "done"; try { rec.abort(); } catch { /* already gone */ } },
    },
  };
}

// A short plain-text status for the indicator slot; null for a clean end, `aborted` and `no-speech`.
const VOICE_ERRORS: Record<string, string> = {
  "not-allowed": "voice: not allowed",
  "service-not-allowed": "voice: service not allowed",
  network: "voice: network error",
  "audio-capture": "voice: no microphone",
  "language-not-supported": "voice: language not supported",
  "start-failed": "voice: could not start",
};
export function voiceErrorText(err?: string): string | null {
  if (!err || err === "aborted" || err === "no-speech") return null;
  return Object.hasOwn(VOICE_ERRORS, err) ? VOICE_ERRORS[err] : "voice: error";
}

export type VoiceView = { listening: boolean; error: string | null };
export type PushToTalk = { active(): boolean; start(o: { lang?: string; onText(t: string): void }): boolean; stop(): void; abort(): void };

// The session lifecycle the Queue tab uses: at most one session; `listening` and active() turn
// true only after a successful start, and every end turns them false once (with a status for a
// real error). abort() is for forced stops (blur, hidden tab, item change, unmount).
export function pushToTalk(ctor: Ctor | null, onView: (v: VoiceView) => void): PushToTalk {
  let cur: VoiceHandle | null = null;
  return {
    active: () => cur !== null,
    start(o) {
      if (!ctor || cur) return false;
      let mine: VoiceHandle | null = null;
      const r = startPushToTalk(ctor, {
        ...(o.lang ? { lang: o.lang } : {}), onText: o.onText,
        onEnd: (err) => { if (cur !== mine) return; cur = null; onView({ listening: false, error: voiceErrorText(err) }); },
      });
      if (!r.ok) { onView({ listening: false, error: voiceErrorText(r.error) }); return false; }
      cur = mine = r.handle;
      onView({ listening: true, error: null });
      return true;
    },
    stop() { cur?.stop(); },
    abort() {
      const h = cur;
      if (!h) return;
      cur = null;
      h.abort();
      onView({ listening: false, error: null });
    },
  };
}

// The running browser's constructor, or null (also in node, where there is no window).
export function browserSpeech(): Ctor | null {
  return speechCtor(typeof window === "undefined" ? undefined : (window as unknown as Parameters<typeof speechCtor>[0]));
}
