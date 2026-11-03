import { IcAlert, IcClose } from "./Icons";

interface ErrorBannerProps {
  error: string;
  onDismiss?: () => void;
}

export function ErrorBanner({ error, onDismiss }: ErrorBannerProps) {
  return (
    <div className="alert alert-block" role="alert">
      <IcAlert size={16} style={{ flexShrink: 0, marginTop: 2 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <p className="alert-title">Error</p>
        <p className="alert-body">{error}</p>
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="btn-icon"
          style={{ width: 28, height: 28, color: "inherit" }}
          aria-label="Dismiss error"
        >
          <IcClose size={14} />
        </button>
      )}
    </div>
  );
}
