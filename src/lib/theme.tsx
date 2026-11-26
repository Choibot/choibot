// src/lib/theme.tsx
"use client";
import { createContext, useCallback, useContext, useLayoutEffect, useState } from "react";
import { THEME_KEY, type Theme } from "./theme-resolve";

export { THEME_KEY, resolveInitialTheme, type Theme } from "./theme-resolve";

function apply(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

type Ctx = { theme: Theme; toggle: () => void; setTheme: (t: Theme) => void };
const ThemeContext = createContext<Ctx | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Start from whatever the pre-paint inline script already put on <html> so the
  // first client render matches the DOM (no flash, no hydration mismatch).
  const [theme, setThemeState] = useState<Theme>("dark");

  // Before the first paint of the started app (the toggle's label is right from its first frame).
  useLayoutEffect(() => {
    const current = (document.documentElement.dataset.theme as Theme) || "dark";
    setThemeState(current);
  }, []);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    apply(t);
    try { localStorage.setItem(THEME_KEY, t); } catch { /* private mode */ }
  }, []);

  const toggle = useCallback(() => setTheme(theme === "dark" ? "light" : "dark"), [theme, setTheme]);

  return <ThemeContext.Provider value={{ theme, toggle, setTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Ctx {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
