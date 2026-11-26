import React from "react";
import type { Viewport } from "next";
import "./globals.css";
import { ThemeProvider } from "../lib/theme";
import { geistMono, geistSans } from "./fonts";
import { DISPLAY_NAME } from "../../server/brand";

// The tab icon and the phone home-screen icon are the files icon.svg and apple-icon.png here.
export const metadata = { title: DISPLAY_NAME };

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

// Runs before first paint to set <html data-theme> from the stored choice (or the
// OS preference if none), so there's no dark-then-light flash on load.
const themeBoot = `(function(){try{var t=localStorage.getItem('choibot-theme');if(t!=='light'&&t!=='dark'){t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}document.documentElement.dataset.theme=t;}catch(e){document.documentElement.dataset.theme='dark';}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBoot }} />
      </head>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
