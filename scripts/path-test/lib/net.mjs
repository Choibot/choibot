// scripts/path-test/lib/net.mjs — the two fake networks of the path test. Both listen on
// 127.0.0.1 only, on a port that the system picks, and live in the process of the test.
//
//   fakeTelegram()        the Bot API of Telegram: it accepts ONE made-up token, keeps what the
//                         bot sends, and hands the bot the updates that the test queues (a
//                         message of the person, a tap on a button).
//   fakePrivateAddress()  what `tailscale serve` does: it takes HTTPS for the private address
//                         and hands the bytes to the console's port. The certificate is made for
//                         the test and trusted by the test's browser only.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { join } from "node:path";
import tls from "node:tls";

const listen = (server) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve(server.address().port));
});

// The person of the test in Telegram.
export const TG_USER = { id: 700700700, is_bot: false, first_name: "Ada", username: "ada_on_telegram" };
const BOT = { id: 123123123, is_bot: true, first_name: "Path test bot", username: "path_test_bot", can_join_groups: true, can_read_all_group_messages: false };

export async function fakeTelegram() {
  // A token in the shape that BotFather gives. Made here, so no file holds one.
  const token = `${BOT.id}:${Array.from({ length: 35 }, (_, i) => "abcdefghijklmnopqrstuvwxyz"[(i * 7) % 26]).join("")}`;
  const sent = [];      // every call of the bot that writes: { method, ...params, at }
  const updates = [];   // what the bot will read with getUpdates
  let nextUpdate = 1000, nextMessage = 500;
  const waiters = [];
  const wake = () => { for (const w of waiters.splice(0)) w(); };

  const answer = async (method, p) => {
    if (method === "getMe") return BOT;
    if (method === "getUpdates") {
      const offset = Number(p.offset ?? 0);
      const ready = () => updates.filter((u) => u.update_id >= offset);
      // A long poll, cut short: the bot asks again at once, so 1 second keeps the test quick.
      if (ready().length === 0) await new Promise((r) => { waiters.push(r); setTimeout(r, Math.min(Number(p.timeout ?? 0), 1) * 1000); });
      return ready();
    }
    if (method === "getChatMember") return { status: "administrator", user: BOT };
    if (method === "getChat") return { id: Number(p.chat_id), type: Number(p.chat_id) > 0 ? "private" : "supergroup" };
    const row = { method, ...p, at: Date.now() };
    sent.push(row);
    if (method === "sendMessage" || method === "sendPhoto") {
      row.message_id = nextMessage++;
      return { message_id: row.message_id, date: Math.floor(Date.now() / 1000), chat: { id: Number(p.chat_id), type: "private" }, text: p.text ?? "" };
    }
    return true;
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const send = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
      const url = new URL(req.url, "http://127.0.0.1");
      const m = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(url.pathname);
      if (!m) return send(404, { ok: false, error_code: 404, description: "Not Found" });
      if (m[1] !== token) return send(401, { ok: false, error_code: 401, description: "Unauthorized" });
      let p = Object.fromEntries(url.searchParams);
      const text = Buffer.concat(chunks).toString("utf8");
      if (text) {
        try { p = { ...p, ...JSON.parse(text) }; } catch { p = { ...p, ...Object.fromEntries(new URLSearchParams(text)) }; }
      }
      for (const k of ["reply_markup"]) if (typeof p[k] === "string") { try { p[k] = JSON.parse(p[k]); } catch { /* as it is */ } }
      send(200, { ok: true, result: await answer(m[2], p) });
    });
  });
  const port = await listen(server);

  const push = (u) => { updates.push({ update_id: nextUpdate++, ...u }); wake(); };
  return {
    token,
    api: `http://127.0.0.1:${port}`,
    sent,
    // The person writes to the bot in their private chat.
    say(text) {
      const entities = text.startsWith("/") ? [{ type: "bot_command", offset: 0, length: text.split(/\s/)[0].length }] : undefined;
      push({ message: { message_id: nextMessage++, date: Math.floor(Date.now() / 1000), from: TG_USER, chat: { id: TG_USER.id, type: "private", first_name: TG_USER.first_name }, text, ...(entities ? { entities } : {}) } });
    },
    // The person taps a button under a message of the bot.
    tap(message, data) {
      push({ callback_query: { id: String(nextUpdate), from: TG_USER, chat_instance: "1", data, message: { message_id: message.message_id, date: Math.floor(message.at / 1000), chat: { id: Number(message.chat_id), type: "private" }, text: message.text ?? "" } } });
    },
    close: () => new Promise((r) => { wake(); server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

// HTTPS for `name` on 127.0.0.1:<port>, handed to the console's port byte for byte (so its
// sockets work too). `dir`: where the certificate of the test is made (needs openssl).
export async function fakePrivateAddress({ name, target, dir }) {
  const key = join(dir, "private-address.key"), cert = join(dir, "private-address.crt");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", `/CN=${name}`,
    "-addext", `subjectAltName=DNS:${name}`, "-keyout", key, "-out", cert], { stdio: "ignore" });
  const open = new Set();
  const server = tls.createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (socket) => {
    const up = net.connect(target, "127.0.0.1");
    for (const s of [socket, up]) { open.add(s); s.on("close", () => open.delete(s)); s.on("error", () => { socket.destroy(); up.destroy(); }); }
    socket.pipe(up).pipe(socket);
  });
  server.on("tlsClientError", () => {});
  const port = await listen(server);
  return { port, close: () => new Promise((r) => { for (const s of open) s.destroy(); server.close(() => r()); }) };
}
