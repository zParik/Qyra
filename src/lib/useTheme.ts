import { useEffect, useState, useCallback } from "react";

export type ThemeChoice = "light" | "dark" | "system";

const STORAGE_KEY = "qyra-theme";

function readStored(): ThemeChoice {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch { /* localStorage may be unavailable */ }
  return "system";
}

function apply(choice: ThemeChoice) {
  const root = document.documentElement;
  if (choice === "system") {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = choice;
  }
  syncNativeTitleBar(choice);
}

// Keep the native OS window chrome (Windows title bar, macOS traffic-light bar)
// in step with the in-app theme. Without this the title bar follows only the OS
// theme and clashes with an explicit in-app light/dark choice. "system" passes
// null so Tauri defers to the OS. Tauri-only: in a plain browser or the test
// runner the dynamic import / IPC call rejects and we silently no-op.
function syncNativeTitleBar(choice: ThemeChoice) {
  const theme = choice === "system" ? null : choice;
  import("@tauri-apps/api/webviewWindow")
    .then(({ getCurrentWebviewWindow }) => getCurrentWebviewWindow().setTheme(theme))
    .catch(() => { /* not running under Tauri */ });
}

// Apply once at module load so the first paint matches the stored choice.
if (typeof document !== "undefined") apply(readStored());

export function useTheme(): {
  theme: ThemeChoice;
  setTheme: (t: ThemeChoice) => void;
  cycle: () => void;
  resolved: "light" | "dark";
} {
  const [theme, setThemeState] = useState<ThemeChoice>(readStored);
  const [resolved, setResolved] = useState<"light" | "dark">(() =>
    resolveTheme(readStored())
  );

  const setTheme = useCallback((next: ThemeChoice) => {
    setThemeState(next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* ignore */ }
    apply(next);
    setResolved(resolveTheme(next));
  }, []);

  const cycle = useCallback(() => {
    setTheme(theme === "light" ? "dark" : theme === "dark" ? "system" : "light");
  }, [theme, setTheme]);

  // Track system changes when in "system" mode so resolved stays accurate.
  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setResolved(mq.matches ? "dark" : "light");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  return { theme, setTheme, cycle, resolved };
}

function resolveTheme(choice: ThemeChoice): "light" | "dark" {
  if (choice === "light") return "light";
  if (choice === "dark") return "dark";
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
