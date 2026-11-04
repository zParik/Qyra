import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { MONO } from "../lib/tokens";
import { IcClose } from "./Icons";

interface CrashLog {
  path: string;
  filename: string;
  bytes: number;
  modifiedSecs: number;
  preview: string;
}

const REPO_ISSUES = "https://github.com/zParik/Qyra/issues/new";

export function CrashLogBanner() {
  const [logs, setLogs] = useState<CrashLog[]>([]);
  const [open, setOpen] = useState(false);

  async function reload() {
    try {
      const data = await invoke<CrashLog[]>("list_crash_logs");
      setLogs(data);
    } catch {
      setLogs([]);
    }
  }

  useEffect(() => { reload(); }, []);

  if (logs.length === 0) return null;
  const newest = logs[0]!;

  async function dismissAll() {
    await invoke("dismiss_all_crash_logs").catch(() => null);
    setLogs([]);
    setOpen(false);
  }

  async function dismissOne(path: string) {
    await invoke("dismiss_crash_log", { path }).catch(() => null);
    setLogs((arr) => arr.filter((l) => l.path !== path));
  }

  function report() {
    const body = encodeURIComponent(`Auto-generated from crash log.\n\nFile: ${newest.filename}\n\n\`\`\`\n${newest.preview}\n\`\`\``);
    const title = encodeURIComponent(`Crash: ${newest.filename}`);
    openUrl(`${REPO_ISSUES}?title=${title}&body=${body}`).catch(console.error);
  }

  return (
    <div className="toast toast-bad" role="status" style={{ left: 16, maxWidth: 420 }}>
      <div className="toast-head">
        <span className="toast-dot" aria-hidden="true" />
        <span className="toast-title">
          Qyra crashed last time{logs.length > 1 ? ` (${logs.length} logs)` : ""}
        </span>
        <button type="button" onClick={() => setOpen((o) => !o)} className="btn-secondary btn-sm">{open ? "Hide" : "View log"}</button>
        <button type="button" onClick={dismissAll} className="btn-ghost btn-sm">Dismiss</button>
      </div>
      {open && (
        <div className="toast-body">
          {logs.map((log) => (
            <div key={log.path} className="crash-log">
              <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                <span className="t-meta" style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {log.filename}
                </span>
                <button type="button" onClick={report} className="btn-secondary btn-sm">Report on GitHub</button>
                <button type="button" onClick={() => dismissOne(log.path)} className="btn-icon" style={{ width: 24, height: 24 }} aria-label={`Dismiss ${log.filename}`}>
                  <IcClose size={12} />
                </button>
              </div>
              <pre className="crash-pre" style={{ fontFamily: MONO }}>{log.preview}</pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
