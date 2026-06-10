import { useState, useEffect } from "react";
import { ToolLayout } from "../components/ToolLayout";
import { DropZone } from "../components/DropZone";
import { useAppStore } from "../store/useAppStore";
import { usePdfCommand } from "../hooks/usePdfCommand";
import { setMetadata, getMetadata, PdfMetadata } from "../lib/tauri";

export default function Metadata() {
  const files = useAppStore((s) => s.files);
  const clearFiles = useAppStore((s) => s.clearFiles);
  const isProcessing = useAppStore((s) => s.isProcessing);
  const { run } = usePdfCommand();
  const file = files[0]!;

  const [meta, setMeta] = useState<PdfMetadata>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!file) { setLoaded(false); return; }
    getMetadata(file.path).then((m) => {
      setMeta(m);
      setLoaded(true);
    }).catch(() => setLoaded(true));
  }, [file?.path]);

  const fields: { key: keyof PdfMetadata; label: string }[] = [
    { key: "title", label: "Title" },
    { key: "author", label: "Author" },
    { key: "subject", label: "Subject" },
    { key: "keywords", label: "Keywords" },
    { key: "creator", label: "Creator" },
  ];

  async function handleSave() {
    if (!file) return;
    await run(() => setMetadata(file.path, meta));
  }

  return (
    <ToolLayout title="Edit Metadata" description="View and edit PDF title, author, and more">
      {files.length === 0 ? (
        <DropZone multiple={false} />
      ) : (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 space-y-4">
          <div className="flex items-center justify-between">
            <p className="font-medium text-sm">{file.name}</p>
            <button onClick={clearFiles} className="text-xs text-gray-400 hover:text-red-500">Remove</button>
          </div>

          {loaded && (
            <div className="space-y-3">
              {fields.map(({ key, label }) => (
                <div key={key}>
                  <label className="text-xs text-gray-500 mb-1 block">{label}</label>
                  <input
                    value={meta[key] ?? ""}
                    onChange={(e) => setMeta((m) => ({ ...m, [key]: e.target.value || undefined }))}
                    className="input w-full text-sm"
                    placeholder={`${label}...`}
                  />
                </div>
              ))}
            </div>
          )}

          <button
            disabled={!file || !loaded || isProcessing}
            onClick={handleSave}
            className="btn-primary w-full"
          >
            Save Metadata
          </button>
        </div>
      )}
    </ToolLayout>
  );
}
