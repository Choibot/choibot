// server/gh/testkit.ts — a fake GitHub for the tests of the ChoiBot GitHub app login: the two
// endpoints of the device flow and of the refresh (server/gh/appflow.ts), on 127.0.0.1. Each test
// gives the answers in order; the fake keeps every request (path, query, form body, headers).
// Tests only: no token here is real.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type FakeAnswer = { status?: number; type?: string; body: unknown };
export type FakeRequest = { method: string; path: string; query: string; form: Record<string, string>; headers: IncomingMessage["headers"] };

export type FakeGithub = {
  base: string;
  requests: FakeRequest[];
  // Answers for a path, used in order; the last one repeats.
  answer(path: string, ...answers: FakeAnswer[]): void;
  close(): Promise<void>;
};

export const FAKE_ACCESS = "ghu_FAKEaccess0000000000000000000000";
export const FAKE_REFRESH = "ghr_FAKErefresh000000000000000000000000000000000000000000000000000000000";

export async function fakeGithub(): Promise<FakeGithub> {
  const queues = new Map<string, FakeAnswer[]>();
  const requests: FakeRequest[] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => { raw += c.toString("utf8"); });
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://fake");
      requests.push({
        method: req.method ?? "", path: url.pathname, query: url.search,
        form: Object.fromEntries(new URLSearchParams(raw)), headers: req.headers,
      });
      const q = queues.get(url.pathname) ?? [];
      const a = q.length > 1 ? q.shift()! : q[0];
      if (!a) { res.writeHead(404, { "content-type": "application/json" }); res.end('{"error":"not_found"}'); return; }
      const type = a.type ?? "application/json; charset=utf-8";
      res.writeHead(a.status ?? 200, { "content-type": type });
      res.end(typeof a.body === "string" ? a.body : JSON.stringify(a.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    requests,
    answer: (path, ...answers) => { queues.set(path, answers); },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

// GitHub's answers, as the docs give them (read 2026-11-26).
export const deviceCode = (base: string, o: { interval?: number; expiresIn?: number } = {}): FakeAnswer => ({
  body: {
    device_code: "3584d83530557fdd1f46af8289938c8ef79f9dc5", user_code: "WDJB-MJHT",
    verification_uri: `${base}/login/device`, expires_in: o.expiresIn ?? 900, interval: o.interval ?? 5,
  },
});
export const tokenPair = (o: { access?: string; refresh?: string } = {}): FakeAnswer => ({
  body: {
    access_token: o.access ?? FAKE_ACCESS, expires_in: 28800,
    refresh_token: o.refresh ?? FAKE_REFRESH, refresh_token_expires_in: 15897600,
    scope: "", token_type: "bearer",
  },
});
export const oauthError = (error: string, extra: Record<string, unknown> = {}): FakeAnswer => ({ body: { error, ...extra } });
