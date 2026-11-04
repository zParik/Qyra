import { useGoToLibrary } from "../hooks/useGoToLibrary";
import { openFile as openFilePath, showInFolder } from "../lib/tauri";
import { IcCheck, IcFile } from "./Icons";
import { splitPath, shortenMiddle } from "../lib/paths";

interface FileResultProps {
  result?: string | null;
  resultFiles?: string[];
  message?: string;
  onDoMore?: () => void;
}

/** The finished sheet: what was written, where, and what to do next. */
export function FileResult({ result, resultFiles = [], message, onDoMore }: FileResultProps) {
  const goToLibrary = useGoToLibrary();
  const allFiles = result ? [result, ...resultFiles] : resultFiles;
  if (allFiles.length === 0) return null;

  async function openFile(path: string) {
    try { await openFilePath(path); } catch { /* ignore */ }
  }
  async function openFolder(path: string) {
    try { await showInFolder(path); } catch { /* ignore */ }
  }

  const isMac = /mac/i.test(navigator.platform);

  return (
    <section className="result" role="status" aria-live="polite">
      <div className="result-head">
        <span className="result-check" aria-hidden="true"><IcCheck size={14} /></span>
        <span className="result-title">
          {message ?? (allFiles.length > 1 ? `Done. ${allFiles.length} files saved.` : "Done. File saved.")}
        </span>
      </div>

      <ul className="result-list">
        {allFiles.slice(0, 5).map((path) => {
          const { name, dir } = splitPath(path);
          return (
            <li key={path} className="result-file" title={path}>
              <IcFile size={16} style={{ color: "var(--fg2)", flexShrink: 0 }} />
              <span className="result-name">{name}</span>
              {dir && <span className="result-dir" title={dir}>{shortenMiddle(dir, 56)}</span>}
            </li>
          );
        })}
        {allFiles.length > 5 && <li className="t-meta">and {allFiles.length - 5} more</li>}
      </ul>

      <div className="result-actions">
        <button type="button" className="btn-secondary" onClick={() => openFile(allFiles[0]!)}>Open file</button>
        <button type="button" className="btn-secondary" onClick={() => openFolder(allFiles[0]!)}>
          {isMac ? "Reveal in Finder" : "Show in folder"}
        </button>
        <span style={{ flex: 1 }} />
        {onDoMore ? (
          <button type="button" className="btn-primary" onClick={onDoMore}>Do more</button>
        ) : (
          <button type="button" className="btn-primary" onClick={goToLibrary}>Back to library</button>
        )}
      </div>
    </section>
  );
}
