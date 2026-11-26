import { describe, it, expect } from "vitest";
import { appendTranscript, pushToTalk, speechCtor, startPushToTalk, voiceErrorText, type SpeechRecognitionLike, type VoiceView } from "./voice";

class Fake implements SpeechRecognitionLike {
  static last: Fake;
  lang = ""; continuous = false; interimResults = false;
  started = 0; stopped = 0; aborted = 0;
  onresult: SpeechRecognitionLike["onresult"] = null;
  onend: SpeechRecognitionLike["onend"] = null;
  onerror: SpeechRecognitionLike["onerror"] = null;
  constructor() { Fake.last = this; }
  start() { this.started++; }
  stop() { this.stopped++; }
  abort() { this.aborted++; }
}
class StartThrows extends Fake { override start(): void { throw new Error("busy"); } }
class CtorThrows extends Fake { constructor() { super(); throw new Error("no mic"); } }
const result = (text: string, isFinal: boolean) => Object.assign([{ transcript: text }], { isFinal });

describe("speechCtor", () => {
  it("is null without support", () => {
    expect(speechCtor({})).toBeNull();
    expect(speechCtor(undefined)).toBeNull();
    expect(speechCtor({ SpeechRecognition: 5 })).toBeNull();
  });
  it("prefers the standard name, falls back to webkit", () => {
    class F {}
    class G {}
    expect(speechCtor({ webkitSpeechRecognition: F })).toBe(F);
    expect(speechCtor({ SpeechRecognition: G, webkitSpeechRecognition: F })).toBe(G);
  });
});

describe("appendTranscript", () => {
  it("joins with one space and trims", () => {
    expect(appendTranscript("fix it", " and test ")).toBe("fix it and test");
    expect(appendTranscript("", "hi")).toBe("hi");
    expect(appendTranscript("hi", "")).toBe("hi");
    expect(appendTranscript("  ", "  ")).toBe("");
  });
});

describe("startPushToTalk", () => {
  it("starts, delivers final results only, stops", () => {
    const texts: string[] = [];
    let ended = 0;
    const r = startPushToTalk(Fake, { lang: "en-US", onText: (t) => texts.push(t), onEnd: () => { ended++; } });
    expect(r.ok).toBe(true);
    const f = Fake.last;
    expect(f.started).toBe(1);
    expect(f.lang).toBe("en-US");
    f.onresult?.({ resultIndex: 0, results: [result("hel", false)] });
    expect(texts).toEqual([]);
    f.onresult?.({ resultIndex: 0, results: [result("hello there", true)] });
    expect(texts).toEqual(["hello there"]);
    if (r.ok) r.handle.stop();
    expect(f.stopped).toBe(1);
    f.onend?.();
    expect(ended).toBe(1);
  });
  it("a start() that throws gives no handle and never calls onEnd (I5)", () => {
    let ended = 0;
    const r = startPushToTalk(StartThrows, { onText() {}, onEnd: () => { ended++; } });
    expect(r).toEqual({ ok: false, error: "start-failed" });
    expect(ended).toBe(0);
  });
  it("a constructor that throws gives no handle and does not throw (I5)", () => {
    let ended = 0;
    expect(() => startPushToTalk(CtorThrows, { onText() {}, onEnd: () => { ended++; } })).not.toThrow();
    expect(startPushToTalk(CtorThrows, { onText() {}, onEnd: () => { ended++; } })).toEqual({ ok: false, error: "start-failed" });
    expect(ended).toBe(0);
  });
  it("an error inside start() is a failed start: no handle, no onEnd, its code returned", () => {
    class EndsAtOnce extends Fake { override start(): void { this.onerror?.({ error: "not-allowed" }); this.onend?.(); } }
    let ended = 0;
    expect(startPushToTalk(EndsAtOnce, { onText() {}, onEnd: () => { ended++; } })).toEqual({ ok: false, error: "not-allowed" });
    expect(ended).toBe(0);
  });
  it("passes the error to onEnd once (I7)", () => {
    const errs: (string | undefined)[] = [];
    startPushToTalk(Fake, { onText() {}, onEnd: (e) => { errs.push(e); } });
    Fake.last.onerror?.({ error: "not-allowed" });
    Fake.last.onend?.();
    expect(errs).toEqual(["not-allowed"]);
  });
  it("abort() calls abort and no late result or end arrives", () => {
    const texts: string[] = [];
    let ended = 0;
    const r = startPushToTalk(Fake, { onText: (t) => texts.push(t), onEnd: () => { ended++; } });
    const f = Fake.last;
    if (r.ok) r.handle.abort();
    expect(f.aborted).toBe(1);
    f.onresult?.({ resultIndex: 0, results: [result("late", true)] });
    f.onend?.();
    expect(texts).toEqual([]);
    expect(ended).toBe(0);
  });
});

describe("voiceErrorText (I7)", () => {
  it("a short plain status for real errors; nothing for aborted, no-speech or a clean end", () => {
    expect(voiceErrorText("not-allowed")).toBe("voice: not allowed");
    expect(voiceErrorText("service-not-allowed")).toBe("voice: service not allowed");
    expect(voiceErrorText("network")).toBe("voice: network error");
    expect(voiceErrorText("audio-capture")).toBe("voice: no microphone");
    expect(voiceErrorText("start-failed")).toBe("voice: could not start");
    expect(voiceErrorText("<b>odd</b>")).toBe("voice: error");
    expect(voiceErrorText("aborted")).toBeNull();
    expect(voiceErrorText("no-speech")).toBeNull();
    expect(voiceErrorText(undefined)).toBeNull();
  });
});

describe("pushToTalk session lifecycle (I5, I7)", () => {
  const views = () => {
    const seen: VoiceView[] = [];
    return { seen, on: (v: VoiceView) => { seen.push(v); } };
  };
  it("listening and active only after a successful start; an end clears both", () => {
    const v = views();
    const p = pushToTalk(Fake, v.on);
    expect(p.active()).toBe(false);
    expect(p.start({ onText() {} })).toBe(true);
    expect(p.active()).toBe(true);
    expect(v.seen).toEqual([{ listening: true, error: null }]);
    p.stop();
    Fake.last.onend?.();
    expect(p.active()).toBe(false);
    expect(v.seen.at(-1)).toEqual({ listening: false, error: null });
  });
  it("a start() that throws never shows listening, leaves no session, and a later start works", () => {
    const v = views();
    const bad = pushToTalk(StartThrows, v.on);
    expect(bad.start({ onText() {} })).toBe(false);
    expect(bad.active()).toBe(false);
    expect(v.seen).toEqual([{ listening: false, error: "voice: could not start" }]);
    const ok = pushToTalk(Fake, v.on);
    expect(ok.start({ onText() {} })).toBe(true);
    expect(ok.active()).toBe(true);
  });
  it("a constructor that throws never shows listening", () => {
    const v = views();
    const p = pushToTalk(CtorThrows, v.on);
    expect(p.start({ onText() {} })).toBe(false);
    expect(p.active()).toBe(false);
    expect(v.seen.some((x) => x.listening)).toBe(false);
  });
  it("an error ends the session with its status; aborted ends it quietly", () => {
    const v = views();
    const p = pushToTalk(Fake, v.on);
    p.start({ onText() {} });
    Fake.last.onerror?.({ error: "network" });
    expect(p.active()).toBe(false);
    expect(v.seen.at(-1)).toEqual({ listening: false, error: "voice: network error" });
    p.start({ onText() {} });
    Fake.last.onerror?.({ error: "aborted" });
    expect(v.seen.at(-1)).toEqual({ listening: false, error: null });
  });
  it("one session at a time; no ctor means no session", () => {
    const p = pushToTalk(Fake, () => {});
    expect(p.start({ onText() {} })).toBe(true);
    const first = Fake.last;
    expect(p.start({ onText() {} })).toBe(false);
    expect(Fake.last).toBe(first);
    expect(pushToTalk(null, () => {}).start({ onText() {} })).toBe(false);
  });
  it("abort() ends at once, quietly, and drops a late result", () => {
    const v = views();
    const texts: string[] = [];
    const p = pushToTalk(Fake, v.on);
    p.start({ onText: (t) => texts.push(t) });
    const f = Fake.last;
    p.abort();
    expect(f.aborted).toBe(1);
    expect(p.active()).toBe(false);
    expect(v.seen.at(-1)).toEqual({ listening: false, error: null });
    f.onresult?.({ resultIndex: 0, results: [result("late", true)] });
    expect(texts).toEqual([]);
    p.abort(); // no session: a no-op
    expect(f.aborted).toBe(1);
  });
});
