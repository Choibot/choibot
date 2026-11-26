// src/lib/sse.ts — the console's event stream (GET /api/events) read with chiefFetch in place of
// EventSource: an EventSource cannot send a header, and a console behind a front proxy needs the
// paired device's token (x-choibot-user, chiefFetch) on every /api request. The behaviour is the
// one of EventSource for what the console sends (server/api.ts: `data:` lines and comment lines;
// no event ids, no `retry:`):
//   - each event is the `data:` lines of one block, joined with "\n"; comment lines and other
//     fields are ignored; LF, CRLF and CR end a line; UTF-8 split across chunks is joined;
//   - the end of the stream or a network error: open again after 3 s (EventSource's wait);
//   - an answer of 2xx that is not an event stream (a sign-in page), or a 4xx: stop, as
//     EventSource stops (it fails the connection);
//   - a handler that throws: its error is reported, and the stream goes on, as with EventSource;
//   - onOpen fires at each open; close() stops it all (the component went away).
// Two additions:
//   - a stream that is silent for 60 s is closed and opened again (the server sends a comment
//     line every 20 s, so a silent stream is a dead one);
//   - a 5xx (a proxy in front while the console restarts: tailscale serve, a hosted console's
//     door) is a try again in 3 s, not a stop: else the page would get no event until a reload.
import { chiefFetch } from "./chief";

export const RETRY_MS = 3_000;
export const SILENCE_MS = 60_000;

export class SseParser {
  private readonly decoder = new TextDecoder("utf-8");
  private buf = "";
  private data: string[] = [];
  private seenCR = false;

  // The complete events of this chunk (their data); a part of an event waits for the next chunk.
  feed(chunk: Uint8Array | string): string[] {
    let text = typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    // A CRLF split across two chunks: the LF of the next chunk belongs to the CR before it.
    if (text === "") return [];
    if (this.seenCR && text.startsWith("\n")) text = text.slice(1);
    this.seenCR = text.endsWith("\r");
    this.buf += text;
    const out: string[] = [];
    let at: number;
    while ((at = this.buf.search(/\r\n|\r|\n/)) !== -1) {
      const line = this.buf.slice(0, at);
      const sep = this.buf.startsWith("\r\n", at) ? 2 : 1;
      this.buf = this.buf.slice(at + sep);
      if (line === "") {
        if (this.data.length) out.push(this.data.join("\n"));
        this.data = [];
      } else if (line.startsWith(":")) {
        // A comment (the server's ping): nothing.
      } else {
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "data") this.data.push(value);
      }
    }
    return out;
  }
}

// A handler's error must not stop the stream: it is reported as an uncaught error would be.
function safely(fn: () => void): void {
  try { fn(); } catch (e) { console.error(e); }
}

export type StreamDeps = {
  fetch?: typeof chiefFetch;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (t: unknown) => void;
};

export function openEventStream(url: string, on: { event: (data: string) => void; open?: () => void }, deps: StreamDeps = {}): { close: () => void } {
  const doFetch = deps.fetch ?? chiefFetch;
  const later = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = deps.clearTimeout ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let closed = false;
  let ctrl: AbortController | null = null;
  let silence: unknown = null;
  let retry: unknown = null;

  const again = () => {
    if (closed) return;
    retry = later(() => { retry = null; void connect(); }, RETRY_MS);
  };
  const quiet = () => {
    if (silence !== null) cancel(silence);
    silence = later(() => { silence = null; ctrl?.abort(); }, SILENCE_MS);
  };

  async function connect(): Promise<void> {
    if (closed) return;
    const mine = new AbortController();
    ctrl = mine;
    const parser = new SseParser();
    let res: Response;
    try {
      res = await doFetch(url, { headers: { accept: "text/event-stream" }, cache: "no-store", signal: mine.signal });
    } catch {
      return again();
    }
    const stream = res.ok && !!res.body && (res.headers.get("content-type") ?? "").toLowerCase().startsWith("text/event-stream");
    if (!stream) {
      try { await res.body?.cancel(); } catch { /* gone */ }
      if (res.status >= 500) return again();
      // EventSource stops here too.
      return;
    }
    safely(() => on.open?.());
    quiet();
    const reader = res.body!.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        quiet();
        for (const data of parser.feed(value)) {
          if (closed) return;
          safely(() => on.event(data));
        }
      }
    } catch {
      // A network error, or the silence timer aborted it.
    } finally {
      if (silence !== null) { cancel(silence); silence = null; }
      // The connection goes in every case (a close, an end, an error).
      mine.abort();
      reader.cancel().catch(() => { /* gone */ });
    }
    again();
  }

  void connect();
  return {
    close() {
      closed = true;
      if (retry !== null) cancel(retry);
      if (silence !== null) cancel(silence);
      ctrl?.abort();
    },
  };
}
