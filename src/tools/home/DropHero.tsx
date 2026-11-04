import React, { useState } from "react";
import { IcUpload } from "../../components/Icons";
import { shortcutLabel } from "../../lib/platform";
import { thumbUrl } from "../../render/renderClient";
import { useDocVersion } from "../../render/docVersion";
import type { RecentFile } from "../../lib/schemas";
import { formatRelativeTime } from "./types";

function Spinner() {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" style={{ animation: "spin 0.8s linear infinite", color: "var(--rose)" }} aria-hidden="true">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth={1.5} strokeOpacity={0.2} />
      <path d="M8 2a6 6 0 016 6" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
    </svg>
  );
}

function ContinueSheet({ file, onOpen }: { file: RecentFile; onOpen: () => void }) {
  const [failed, setFailed] = useState(false);
  useDocVersion(file.path);
  const thumb = failed ? null : thumbUrl(file.path, 1, 256);
  return (
    <button type="button" className="continue" onClick={onOpen} title={`Open ${file.name} again`}>
      <span className="sheet-thumb continue-thumb" aria-hidden="true">
        {thumb && <img src={thumb} alt="" loading="lazy" onError={() => setFailed(true)} />}
      </span>
      <span className="continue-text">
        <span className="continue-name">{file.name.replace(/\.pdf$/i, "")}</span>
        <span className="t-meta">Opened {formatRelativeTime(file.openedAt)} · pick up where you left off</span>
      </span>
    </button>
  );
}

/**
 * The counter: where a sheet is dropped. One primary action; the most recent
 * sheet waits at the side so the common case is one click.
 */
export function DropCounter({ drag, onDragOver, onDragLeave, onDrop, onOpen, loading, last, onContinue }: {
  drag: boolean;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
  onOpen: () => void;
  loading: string | null;
  last: RecentFile | null;
  onContinue: (f: RecentFile) => void;
}) {
  return (
    <section
      className="counter"
      data-drag={drag ? "true" : undefined}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      aria-label="Open a document"
    >
      <div className="counter-text">
        <h1 className="t-display" style={{ margin: 0 }}>
          {drag ? "Let go to open it." : <>Drop a PDF here, <span style={{ color: "var(--fg2)" }}>or pick one from your files.</span></>}
        </h1>
        <p className="counter-sub">
          It opens instantly, you mark it up in place, and it never leaves this computer.
        </p>
        {loading ? (
          <div className="counter-loading" role="status">
            <Spinner />
            <span className="truncate">Opening {loading}…</span>
          </div>
        ) : (
          <div className="counter-actions">
            <button type="button" onClick={onOpen} className="btn-primary">
              <IcUpload size={16} />
              Open document
              <kbd className="kbd">{shortcutLabel("O")}</kbd>
            </button>
            <span className="t-meta">PDF and PDF/A</span>
          </div>
        )}
      </div>
      {last && !loading && <ContinueSheet file={last} onOpen={() => onContinue(last)} />}
    </section>
  );
}
