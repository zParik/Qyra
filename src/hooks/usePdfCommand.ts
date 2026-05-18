import { useRef } from "react";
import { useAppStore } from "../store/useAppStore";

export function usePdfCommand() {
  const { setIsProcessing, setError, setResult, setResultFiles, reset, setCancelFn } = useAppStore();
  const cancelledRef = useRef(false);

  function cancel() {
    cancelledRef.current = true;
    reset(); // clears isProcessing, progress, cancelFn
  }

  async function run<T>(
    fn: () => Promise<T>,
    onSuccess?: (result: T) => void
  ): Promise<T | null> {
    cancelledRef.current = false;
    reset();
    setIsProcessing(true);
    setCancelFn(cancel);

    try {
      const result = await fn();
      if (cancelledRef.current) return null;
      if (typeof result === "string") {
        setResult(result);
      } else if (Array.isArray(result)) {
        setResultFiles(result as string[]);
      }
      onSuccess?.(result);
      return result;
    } catch (e) {
      if (cancelledRef.current) return null;
      setError(String(e));
      return null;
    } finally {
      if (!cancelledRef.current) {
        setIsProcessing(false);
        setCancelFn(null);
      }
    }
  }

  return { run, cancel };
}
