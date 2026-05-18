import { useNavigate } from "react-router-dom";
import { openFile as openFilePath, showInFolder, shareFile } from "../lib/tauri";
import { isAndroid } from "../lib/androidFileUtils";

import { UI, MONO } from "../lib/tokens";

interface FileResultProps {
  result?: string | null;
  resultFiles?: string[];
  message?: string;
  onDoMore?: () => void;
}

export function FileResult({ result, resultFiles = [], message, onDoMore }: FileResultProps) {
  const navigate = useNavigate();
  const allFiles = result ? [result, ...resultFiles] : resultFiles;
  if (allFiles.length === 0) return null;

  async function openFile(path: string) {
    try { await openFilePath(path); } catch { /* ignore */ }
  }
  async function openFolder(path: string) {
    try { await showInFolder(path); } catch { /* ignore */ }
  }

  return (
    <div style={{
      borderRadius: 6, border: "1px solid var(--ok-border)",
      background: "var(--ok-bg)", padding: "12px 14px",
      display: "flex", flexDirection: "column", gap: 10,
    }}>
      {/* Success header */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <svg width={16} height={16} fill="none" stroke="currentColor" strokeWidth={1.5}
          strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"
          style={{ color: "var(--ok-text)", flexShrink: 0 }}>
          <path d="M5 13l4 4L19 7" />
        </svg>
        <span style={{ fontFamily: UI, fontSize: 12, fontWeight: 600, color: "var(--ok-text)" }}>
          {message ?? (allFiles.length > 1 ? `Done — ${allFiles.length} files saved` : "Done")}
        </span>
      </div>

      {/* File paths */}
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        {allFiles.slice(0, 5).map((path) => (
          <p key={path} style={{
            fontFamily: MONO, fontSize: 10.5, color: "var(--fg2)",
            margin: 0, wordBreak: "break-all", lineHeight: 1.4,
          }} title={path}>{path}</p>
        ))}
        {allFiles.length > 5 && (
          <p style={{ fontFamily: MONO, fontSize: 10.5, color: "var(--fg3)", margin: 0 }}>
            + {allFiles.length - 5} more
          </p>
        )}
      </div>

      {/* Actions */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {isAndroid() ? (
          <ActionBtn onClick={() => shareFile(allFiles[0]).catch(() => {})}>Save to Downloads</ActionBtn>
        ) : (
          <>
            <ActionBtn onClick={() => openFile(allFiles[0])}>Open file</ActionBtn>
            <ActionBtn onClick={() => openFolder(allFiles[0])}>
              {/mac/i.test(navigator.platform) ? "Reveal in Finder" : "Show in Explorer"}
            </ActionBtn>
          </>
        )}
        {onDoMore ? (
          <ActionBtn primary onClick={onDoMore}>Do more</ActionBtn>
        ) : (
          <ActionBtn primary onClick={() => navigate("/")}>Back to Home</ActionBtn>
        )}
      </div>
    </div>
  );
}

function ActionBtn({ children, onClick, primary }: {
  children: React.ReactNode; onClick: () => void; primary?: boolean;
}) {
  return (
    <button onClick={onClick} className={primary ? "btn-primary" : "btn-secondary"}>
      {children}
    </button>
  );
}
