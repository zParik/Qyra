import { useEffect, useState } from "react";
import type { Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { isAndroid } from "../lib/androidFileUtils";

export type UpdaterState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "available"; update: Update }
  | { status: "downloading"; progress: number }
  | { status: "ready" }
  | { status: "error"; message: string };

export function useUpdater() {
  const [state, setState] = useState<UpdaterState>({ status: "idle" });

  useEffect(() => {
    // Updater plugin is not registered on Android — skip entirely
    if (isAndroid()) return;
    // Delay the check so it doesn't compete with app startup
    const timer = setTimeout(() => checkForUpdates(), 3000);
    return () => clearTimeout(timer);
  }, []);

  async function checkForUpdates() {
    setState({ status: "checking" });
    try {
      // Dynamic import so the module isn't resolved on Android where the plugin is absent
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (update) {
        setState({ status: "available", update });
      } else {
        setState({ status: "idle" });
      }
    } catch {
      // Silently fail — update check should never surface as an error to the user
      setState({ status: "idle" });
    }
  }

  async function installUpdate() {
    if (state.status !== "available") return;
    const { update } = state;
    let downloaded = 0;
    let total = 0;
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
          setState({ status: "downloading", progress: 0 });
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          setState({ status: "downloading", progress: total > 0 ? Math.round((downloaded / total) * 100) : 0 });
        } else if (event.event === "Finished") {
          setState({ status: "ready" });
        }
      });
    } catch (e) {
      setState({ status: "error", message: String(e) });
    }
  }

  async function restartApp() {
    await relaunch();
  }

  function dismiss() {
    setState({ status: "idle" });
  }

  return { state, installUpdate, restartApp, dismiss, checkForUpdates };
}
