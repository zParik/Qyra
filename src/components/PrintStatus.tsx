import { usePrintJob } from "../viewer/tools/PrintPanel";

/** Progress of the print job being prepared, with a way out. */
export function PrintStatus() {
  const job = usePrintJob((s) => s.job);
  const cancel = usePrintJob((s) => s.cancel);
  if (!job) return null;
  const label = job.total
    ? `Preparing ${job.name} for print: ${job.done} of ${job.total} pages`
    : `Preparing ${job.name} for print`;
  return (
    <div className="toast toast-accent" role="status" aria-live="polite" style={{ right: 16 }}>
      <div className="toast-head">
        <span className="toast-dot" aria-hidden="true" />
        <span className="toast-title">{label}</span>
        {cancel && (
          <button type="button" onClick={cancel} className="btn-ghost btn-sm">Cancel</button>
        )}
      </div>
    </div>
  );
}
