// src/components/QueueRich.tsx — the rich part of a ticket: a page the agent wrote, shown in the
// ticket above the answer bar. The page is untrusted. It runs in a frame with an empty sandbox
// and a policy with no network (src/lib/richTicket.ts): no script, no request, no link, no form.
// The frame is a plain block in the flow of the ticket: it cannot cover the title, the options or
// the answer bar, which stay outside it, drawn by the console. Its head says "From the agent ·
// view only", so a button drawn inside the page reads as a picture: nothing in it can act.
"use client";
import { useEffect, useMemo, useState } from "react";
import type { QueueItem } from "../../server/chief/queue/types"; // type-only
import { geistMono, geistSans } from "../app/fonts";
import { chiefFetch } from "../lib/chief";
import { fetchRichPage, RICH_SANDBOX, RICH_TOKENS, richDoc, richHeight, type RichPageData } from "../lib/richTicket";
import { useTheme } from "../lib/theme";
import s from "./QueueRich.module.css";

// The copy of a ticket's page never changes: one fetch for each ticket in a session.
const pages = new Map<string, RichPageData>();

// The console's two fonts as @font-face rules with data: addresses, so the page has the console's
// letters with no request from the frame. Read once from the console's own style sheets; ""
// (the system's fonts) when they cannot be read.
let fontCss: Promise<string> | null = null;
const firstFamily = (list: string): string => (list.split(",")[0] ?? "").trim().replace(/^["']|["']$/g, "");
function fontUrl(family: string): string | null {
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try { rules = sheet.cssRules; } catch { continue; }
    for (const r of Array.from(rules)) {
      if (!(r instanceof CSSFontFaceRule) || firstFamily(r.style.getPropertyValue("font-family")) !== family) continue;
      const m = /url\(["']?([^"')]+)["']?\)/.exec(r.style.getPropertyValue("src"));
      if (m?.[1]?.startsWith("/") && !m[1].startsWith("//")) return m[1];
    }
  }
  return null;
}
const dataUrl = (b: Blob): Promise<string> => new Promise((resolve, reject) => {
  const fr = new FileReader();
  fr.onload = () => resolve(String(fr.result));
  fr.onerror = () => reject(fr.error);
  fr.readAsDataURL(b);
});
async function loadFontCss(): Promise<string> {
  const faces = await Promise.all(([["Console Sans", geistSans], ["Console Mono", geistMono]] as const).map(async ([name, font]) => {
    const url = fontUrl(firstFamily(font.style.fontFamily));
    const res = url ? await chiefFetch(url) : null;
    if (!res?.ok) return "";
    const data = await dataUrl(await res.blob());
    if (!/^data:[\w/+.-]*;base64,[A-Za-z0-9+/=]+$/.test(data)) return "";
    return `@font-face{font-family:"${name}";src:url(${data}) format("woff2");font-weight:100 900;font-display:block}`;
  }));
  return faces.join("");
}
const consoleFontCss = (): Promise<string> => (fontCss ??= loadFontCss().catch(() => ""));

function readTokens(): Record<string, string> {
  const cs = getComputedStyle(document.documentElement);
  return Object.fromEntries(RICH_TOKENS.map((t) => [t, cs.getPropertyValue(t).trim()]));
}

/** Give it `key={item.id}`: one mount for one ticket. */
export function RichPart({ item, className }: { item: QueueItem; className?: string }) {
  const { theme } = useTheme();
  const [page, setPage] = useState<RichPageData | "failed" | null>(() => pages.get(item.id) ?? null);
  const [fonts, setFonts] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let live = true;
    void consoleFontCss().then((css) => { if (live) setFonts(css); });
    if (!pages.has(item.id)) {
      fetchRichPage(item.id)
        .then((p) => { if (p) pages.set(item.id, p); if (live) setPage(p ?? "failed"); })
        .catch(() => { if (live) setPage("failed"); });
    }
    return () => { live = false; };
  }, [item.id]);
  // A new theme makes a new page text (the colours are in it): the frame follows the theme switch.
  const doc = useMemo(
    () => (page && page !== "failed" && fonts !== null ? richDoc(page, { theme, tokens: readTokens(), fontCss: fonts }) : null),
    [page, fonts, theme],
  );
  if (!item.html) return null;
  if (page === "failed") return <p className={`${s.failed} ${className ?? ""}`}>This ticket has a page, but it cannot be shown. The text above is the ticket.</p>;
  const height = richHeight(page ? page.height : item.html.height, open);
  return (
    <div className={`${s.rich} ${className ?? ""}`} data-queue-rich="">
      <div className={s.head}>
        <span className={s.from} title="The agent wrote this page. Nothing in it can answer, merge or open a link: the buttons of the ticket are outside this frame.">
          From the agent <span className={s.sep} aria-hidden>·</span> view only
        </span>
        <button type="button" className={s.expand} aria-expanded={open} onClick={() => setOpen((v) => !v)}>{open ? "Collapse" : "Expand"}</button>
      </div>
      {doc === null
        ? <div className={s.frame} style={{ height }} aria-busy="true" />
        : <iframe className={s.frame} style={{ height }} sandbox={RICH_SANDBOX} srcDoc={doc} title="Page from the agent" referrerPolicy="no-referrer" />}
    </div>
  );
}
