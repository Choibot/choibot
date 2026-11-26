// src/components/ThemeToggle.tsx
"use client";
import { useTheme } from "../lib/theme";
import { MoonIcon, SunIcon } from "./SideIcons";
import s from "./ThemeToggle.module.css";

export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      className={s.toggle}
      onClick={toggle}
      title={`Switch to ${next} mode`}
      aria-label={`Switch to ${next} mode`}
    >
      {/* Both icons, picked by <html data-theme> in CSS: the theme script sets it before the
          first paint, while React learns the theme only after it starts (the server draws
          "dark"), so a picked icon changed from sun to moon on a light first load. */}
      <span className={s.sun}><SunIcon /></span>
      <span className={s.moon}><MoonIcon /></span>
    </button>
  );
}
