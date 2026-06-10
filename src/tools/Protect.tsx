import { useState } from "react";
import { ToolLayout } from "../components/ToolLayout";
import { DropZone } from "../components/DropZone";
import { useAppStore } from "../store/useAppStore";
import { usePdfCommand } from "../hooks/usePdfCommand";
import { protectPdf } from "../lib/tauri";

export default function Protect() {
  const files = useAppStore((s) => s.files);
  const clearFiles = useAppStore((s) => s.clearFiles);
  const isProcessing = useAppStore((s) => s.isProcessing);
  const { run } = usePdfCommand();
  const [userPassword, setUserPassword] = useState("");
  const [ownerPassword, setOwnerPassword] = useState("");
  const [show, setShow] = useState(false);
  const file = files[0]!;

  async function handleProtect() {
    if (!file || !userPassword) return;
    await run(() => protectPdf(file.path, userPassword, ownerPassword || undefined));
  }

  return (
    <ToolLayout title="Password Protect" description="Encrypt a PDF with a user password (AES-256)">
      {files.length === 0 ? (
        <DropZone multiple={false} />
      ) : (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 space-y-4">
          <div className="flex items-center justify-between">
            <p className="font-medium text-sm">{file.name}</p>
            <button onClick={clearFiles} className="text-xs text-gray-400 hover:text-red-500">Remove</button>
          </div>

          <div>
            <label className="text-xs text-gray-500 mb-1 block">User password (required to open)</label>
            <div className="relative">
              <input
                type={show ? "text" : "password"}
                value={userPassword}
                onChange={(e) => setUserPassword(e.target.value)}
                className="input w-full pr-10 text-sm"
                placeholder="Enter password"
              />
              <button
                type="button"
                onClick={() => setShow(!show)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400"
              >
                {show ? (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                  </svg>
                )}
              </button>
            </div>
          </div>

          <div>
            <label className="text-xs text-gray-500 mb-1 block">Owner password (optional — controls permissions)</label>
            <input
              type={show ? "text" : "password"}
              value={ownerPassword}
              onChange={(e) => setOwnerPassword(e.target.value)}
              className="input w-full text-sm"
              placeholder="Leave blank to use user password"
            />
          </div>

          <button
            disabled={!file || !userPassword || isProcessing}
            onClick={handleProtect}
            className="btn-primary w-full"
          >
            Protect PDF
          </button>
        </div>
      )}
    </ToolLayout>
  );
}
