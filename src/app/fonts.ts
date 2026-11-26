// src/app/fonts.ts — Geist and Geist Mono, self-hosted (variable woff2 from
// the geist 1.7.1 package, SIL OFL 1.1: fonts/OFL.txt). next/font/local needs
// no network at build time. The CSS variables feed --font-sans / --font-mono
// in globals.css; XtermTerminal reads geistMono.style.fontFamily, because its
// canvas cannot resolve CSS variables.
import localFont from "next/font/local";

export const geistSans = localFont({
  src: "./fonts/Geist-Variable.woff2",
  variable: "--font-geist",
  weight: "100 900",
  display: "swap",
});

export const geistMono = localFont({
  src: "./fonts/GeistMono-Variable.woff2",
  variable: "--font-geist-mono",
  weight: "100 900",
  display: "swap",
  adjustFontFallback: false,
});
