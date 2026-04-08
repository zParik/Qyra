import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

export interface ProgressData {
  current: number;
  total: number;
  message: string;
}

/** Map raw Rust / system error strings to user-readable messages. */
export function sanitizeError(e: unknown): string {
  const raw = String(e);

  if (/password|encrypted|decrypt|wrong password|incorrect password/i.test(raw))
    return 'This PDF is password-protected. Use "Unlock PDF" to remove the password first.';
  if (/permission denied|access is denied|read.only|readonly|cannot write/i.test(raw))
    return "Cannot write to this location. The file may be open in another application.";
  if (/invalid|corrupt|not a pdf|malformed|bad pdf/i.test(raw))
    return "This file does not appear to be a valid PDF.";
  if (/no such file|file not found|cannot open|path does not exist/i.test(raw))
    return "File not found. It may have been moved or deleted.";
  if (/no space|disk full|not enough space|storage/i.test(raw))
    return "Not enough disk space to complete this operation.";
  if (/timeout|timed out/i.test(raw))
    return "The operation took too long. Try with a smaller file.";

  // Strip Rust panic boilerplate: "thread 'main' panicked at '...', src/..."
  const cleaned = raw
    .replace(/thread '[^']*' panicked at '[^']*',\s*[^\n]*/g, "")
    .replace(/^Error:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length === 0) return "An error occurred while processing the file.";
  if (cleaned.length > 280) return cleaned.slice(0, 280) + "…";
  return cleaned;
}

export function usePanelCommand(onApplied?: (path: string) => void) {
  const [isProcessing, setIsProcessing] = useState(false);
  const [result, setResult] = useState<string | string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressData | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => { unlistenRef.current?.(); };
  }, []);

  async function run(fn: () => Promise<string | string[]>) {
    setResult(null);
    setError(null);
    setProgress(null);
    setIsProcessing(true);

    const unlisten = await listen<ProgressData>("operation-progress", (event) => {
      setProgress(event.payload);
    });
    unlistenRef.current = unlisten;

    try {
      const r = await fn();
      if (typeof r === "string" && onApplied) {
        onApplied(r);
      } else {
        setResult(r);
      }
    } catch (e) {
      setError(sanitizeError(e));
    } finally {
      setIsProcessing(false);
      setProgress(null);
      unlisten();
      unlistenRef.current = null;
    }
  }

  return {
    isProcessing,
    result,
    error,
    progress,
    run,
    clearResult: () => setResult(null),
    clearError: () => setError(null),
  };
}
