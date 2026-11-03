import type { FallbackProps } from "react-error-boundary";
import { IcAlert } from "./Icons";

function message(error: unknown): string {
  return (error instanceof Error ? error.message : null) ?? "Unknown error";
}

export function ErrorFallback({ error, resetErrorBoundary }: FallbackProps) {
  return (
    <div className="fallback" role="alert">
      <span className="fallback-icon" aria-hidden="true"><IcAlert size={24} /></span>
      <div style={{ textAlign: "center", maxWidth: 480 }}>
        <p className="t-title" style={{ margin: "0 0 var(--space-2)" }}>Something went wrong</p>
        <p style={{ margin: 0, color: "var(--fg1)", wordBreak: "break-word" }}>{message(error)}</p>
      </div>
      <div style={{ display: "flex", gap: "var(--space-2)" }}>
        <button type="button" onClick={resetErrorBoundary} className="btn-primary">Try again</button>
        <button type="button" onClick={() => { window.location.hash = "/"; resetErrorBoundary(); }} className="btn-secondary">
          Back to library
        </button>
      </div>
    </div>
  );
}

export function ViewerErrorFallback({ error, resetErrorBoundary }: FallbackProps) {
  return (
    <div className="fallback" role="alert" style={{ height: "100%" }}>
      <span className="fallback-icon" aria-hidden="true"><IcAlert size={24} /></span>
      <div style={{ textAlign: "center", maxWidth: 480 }}>
        <p className="t-title" style={{ margin: "0 0 var(--space-2)" }}>This sheet could not be shown</p>
        <p style={{ margin: 0, color: "var(--fg1)", wordBreak: "break-word" }}>{message(error)}</p>
      </div>
      <button type="button" onClick={resetErrorBoundary} className="btn-primary">Try again</button>
    </div>
  );
}
