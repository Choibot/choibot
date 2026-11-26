// src/lib/theme-resolve.ts
// Pure theme helpers — no React/DOM, so they're trivially unit-testable.
export type Theme = "light" | "dark";
export const THEME_KEY = "choibot-theme";

// Decide the initial theme: an explicit stored choice wins; otherwise fall back
// to the OS preference.
export function resolveInitialTheme(stored: string | null, systemPrefersDark: boolean): Theme {
  if (stored === "light" || stored === "dark") return stored;
  return systemPrefersDark ? "dark" : "light";
}
