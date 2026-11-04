import { BrowserRouter, Routes, Route } from "react-router-dom";
import { useEffect } from "react";
import { ErrorBoundary } from "react-error-boundary";
import { useAppStore } from "./store/useAppStore";
import Merge from "./tools/Merge";
import ImagesToPdf from "./tools/ImagesToPdf";
import Ocr from "./tools/Ocr";
import RepairPdf from "./tools/RepairPdf";
import BatchOps from "./tools/BatchOps";
import Settings from "./tools/Settings";
import ViewerShell from "./viewer/ViewerShell";
import { useOpenWithFile } from "./hooks/useOpenWithFile";
import { useUpdater } from "./hooks/useUpdater";
import { UpdateBanner } from "./components/UpdateBanner";
import { CommandPalette } from "./components/CommandPalette";
import { PrintStatus } from "./components/PrintStatus";
import { CrashLogBanner } from "./components/CrashLogBanner";
import { ErrorFallback } from "./components/ErrorFallback";
import { installCloseGuard } from "./lib/closeGuard";

/** Handles "Open with" / double-click file association — must live inside BrowserRouter */
function OpenWithHandler() {
  useOpenWithFile();
  return null;
}

export default function App() {
  const clearFiles = useAppStore((s) => s.clearFiles);
  const reset = useAppStore((s) => s.reset);
  const { state: updaterState, installUpdate, restartApp, dismiss } = useUpdater();

  useEffect(() => {
    return () => {
      clearFiles();
      reset();
    };
  }, []);

  // The window's single close handler: asks about unsaved documents and waits
  // for every tab's pending writes.
  useEffect(() => {
    let off: (() => void) | undefined;
    let gone = false;
    installCloseGuard()
      .then((u) => { if (gone) u(); else off = u; })
      .catch(() => {});
    return () => { gone = true; off?.(); };
  }, []);

  return (
    <ErrorBoundary FallbackComponent={ErrorFallback}>
    <BrowserRouter>
      <OpenWithHandler />
      <CommandPalette />
      <CrashLogBanner />
      <PrintStatus />
      <UpdateBanner
        state={updaterState}
        onInstall={installUpdate}
        onRestart={restartApp}
        onDismiss={dismiss}
      />
      <Routes>
        {/* One shell: the tab bar stays on top of the library, the viewer and every tool page. */}
        <Route element={<ViewerShell />}>
          <Route path="/" element={null} />
          <Route path="/view" element={null} />
          <Route path="/merge" element={<Merge />} />
          <Route path="/images-to-pdf" element={<ImagesToPdf />} />
          <Route path="/ocr" element={<Ocr />} />
          <Route path="/repair" element={<RepairPdf />} />
          <Route path="/batch" element={<BatchOps />} />
          <Route path="/settings" element={<Settings />} />
        </Route>
      </Routes>
    </BrowserRouter>
    </ErrorBoundary>
  );
}
