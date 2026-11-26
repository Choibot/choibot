// src/components/AuthedImg.tsx — an <img> of the console's API, read with the paired device's
// token (src/lib/authedMedia.ts). It loads when it comes near the screen if `loading="lazy"`, as
// a plain lazy <img> does; it revokes its object URL when it goes away and when `src` changes; a
// failed load shows the same broken picture as a failed <img>.
"use client";
import { useEffect, useRef, useState, type ImgHTMLAttributes } from "react";
import { BROKEN_SRC, loadMedia } from "../lib/authedMedia";

type Props = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & { src: string };

export function AuthedImg({ src, loading, ...rest }: Props) {
  const ref = useRef<HTMLImageElement>(null);
  const [shown, setShown] = useState<string | undefined>(undefined);
  const [near, setNear] = useState(loading !== "lazy");

  useEffect(() => {
    if (near) return undefined;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") { setNear(true); return undefined; }
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) setNear(true); }, { rootMargin: "1250px" });
    io.observe(el);
    return () => io.disconnect();
  }, [near]);

  useEffect(() => {
    setShown(undefined);
    if (!near) return undefined;
    const ctrl = new AbortController();
    let revoke: (() => void) | null = null;
    void loadMedia(src, ctrl.signal).then((r) => {
      if (ctrl.signal.aborted) { r?.revoke(); return; }
      revoke = r?.revoke ?? null;
      setShown(r ? r.url : BROKEN_SRC);
    });
    return () => { ctrl.abort(); revoke?.(); };
  }, [src, near]);

  // eslint-disable-next-line @next/next/no-img-element
  return <img ref={ref} src={shown} {...rest} />;
}
