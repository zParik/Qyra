import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { useUpdater } from "../../hooks/useUpdater";
import { SectionTitle, SettingRow } from "./ui";

export function UpdatesSection() {
  const { state, checkForUpdates } = useUpdater();
  const [version, setVersion] = useState("");

  useEffect(() => {
    getVersion().then(setVersion).catch(() => setVersion("unknown"));
  }, []);

  const statusLabel =
    state.status === "checking" ? "Checking…" :
    state.status === "available" ? "Update available — see banner" :
    state.status === "downloading" ? "Downloading…" :
    state.status === "ready" ? "Ready — restart to apply" :
    "Up to date";

  return (
    <div>
      <SectionTitle>Updates</SectionTitle>
      <SettingRow label="Version" description={statusLabel}>
        <span className="text-sm" style={{ color: "var(--fg1)" }}>{version || "…"}</span>
      </SettingRow>
      <SettingRow label="Check for updates" description="Manually check GitHub releases now.">
        <button
          onClick={() => checkForUpdates()}
          disabled={state.status === "checking" || state.status === "downloading"}
          className="text-xs px-3 py-1.5 rounded"
          style={{ background: "var(--accent)", color: "#fff" }}
        >
          Check now
        </button>
      </SettingRow>
    </div>
  );
}
