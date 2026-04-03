import { useNavigate } from "react-router-dom";
import { openFile as openFilePath, showInFolder, shareFile } from "../lib/tauri";
import { isAndroid } from "../lib/androidFileUtils";

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
    try {
      await openFilePath(path);
    } catch (e) {
      console.error("openFile failed:", e);
    }
  }

  async function openFolder(path: string) {
    try {
      await showInFolder(path);
    } catch (e) {
      console.error("openFolder failed:", e);
    }
  }

  return (
    <div className="rounded-xl border border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950 p-4 space-y-3">
      <div className="flex items-center gap-2 text-green-700 dark:text-green-400 font-medium">
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
        <span>{message ?? `Done! ${allFiles.length > 1 ? `${allFiles.length} files created` : "File created"}`}</span>
      </div>

      {allFiles.slice(0, 5).map((path) => (
        <div key={path} className="text-xs text-gray-500 dark:text-gray-400 truncate" title={path}>
          {path}
        </div>
      ))}
      {allFiles.length > 5 && (
        <p className="text-xs text-gray-400">...and {allFiles.length - 5} more</p>
      )}

      <div className="flex flex-wrap gap-2">
        {isAndroid() ? (
          <button
            onClick={() => shareFile(allFiles[0]).catch(console.error)}
            className="btn-secondary text-sm"
          >
            Save to Downloads
          </button>
        ) : (
          <>
            <button onClick={() => openFile(allFiles[0])} className="btn-secondary text-sm">
              Open File
            </button>
            <button onClick={() => openFolder(allFiles[0])} className="btn-secondary text-sm">
              Open Folder
            </button>
          </>
        )}
        {onDoMore ? (
          <button onClick={onDoMore} className="btn-primary text-sm">
            Do More
          </button>
        ) : (
          <button onClick={() => navigate("/")} className="btn-primary text-sm">
            Back to Home
          </button>
        )}
      </div>
    </div>
  );
}
