import type { UpdaterState } from "../hooks/useUpdater";
import { IcClose } from "./Icons";

interface UpdateBannerProps {
  state: UpdaterState;
  onInstall: () => void;
  onRestart: () => void;
  onDismiss: () => void;
}

/** A small card in the corner: an update is available, downloading, or ready. */
export function UpdateBanner({ state, onInstall, onRestart, onDismiss }: UpdateBannerProps) {
  if (state.status === "idle" || state.status === "checking") return null;

  if (state.status === "error") {
    return (
      <div className="toast" role="status" style={{ right: 16 }}>
        <div className="toast-head">
          <span className="toast-title" style={{ color: "var(--fg1)", fontWeight: 500 }}>Could not check for updates</span>
          <button type="button" onClick={onDismiss} className="btn-icon" style={{ width: 24, height: 24 }} aria-label="Dismiss">
            <IcClose size={12} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="toast toast-accent" role="status" aria-live="polite" style={{ right: 16 }}>
      <div className="toast-head">
        <span className="toast-dot" aria-hidden="true" />
        <span className="toast-title">
          {state.status === "available" && `Qyra ${state.update.version} is available`}
          {state.status === "downloading" && "Downloading the update…"}
          {state.status === "ready" && "Update downloaded"}
        </span>
        {state.status === "available" && (
          <button type="button" onClick={onDismiss} className="btn-icon" style={{ width: 24, height: 24 }} aria-label="Not now">
            <IcClose size={12} />
          </button>
        )}
      </div>

      {state.status === "downloading" && (
        <div className="progress">
          <div className="progress-track"><div className="progress-fill" style={{ width: `${state.progress}%` }} /></div>
          <span className="t-meta">{state.progress}%</span>
        </div>
      )}

      {state.status === "available" && (
        <div className="toast-actions">
          <button type="button" onClick={onDismiss} className="btn-ghost btn-sm">Not now</button>
          <button type="button" onClick={onInstall} className="btn-primary btn-sm">Install update</button>
        </div>
      )}
      {state.status === "ready" && (
        <div className="toast-actions">
          <button type="button" onClick={onRestart} className="btn-primary btn-sm">Restart to apply</button>
        </div>
      )}
    </div>
  );
}
