import { BrowserRouter, Routes, Route } from "react-router-dom";
import { useEffect } from "react";
import { ErrorBoundary } from "react-error-boundary";
import { useAppStore } from "./store/useAppStore";
import Home from "./tools/Home";
import Merge from "./tools/Merge";
import ImagesToPdf from "./tools/ImagesToPdf";
import Ocr from "./tools/Ocr";
import ViewerShell from "./viewer/ViewerShell";
import { useOpenWithFile } from "./hooks/useOpenWithFile";
import { useUpdater } from "./hooks/useUpdater";
import { UpdateBanner } from "./components/UpdateBanner";
import { ErrorFallback } from "./components/ErrorFallback";

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

  return (
    <ErrorBoundary FallbackComponent={ErrorFallback}>
    <BrowserRouter>
      <OpenWithHandler />
      <UpdateBanner
        state={updaterState}
        onInstall={installUpdate}
        onRestart={restartApp}
        onDismiss={dismiss}
      />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/view" element={<ViewerShell />} />
        <Route path="/merge" element={<Merge />} />
        <Route path="/images-to-pdf" element={<ImagesToPdf />} />
        <Route path="/ocr" element={<Ocr />} />
      </Routes>
    </BrowserRouter>
    </ErrorBoundary>
  );
}
