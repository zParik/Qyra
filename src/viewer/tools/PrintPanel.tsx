import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { printUrl } from "../../render/renderClient";

/** The print job being prepared, shown as a toast. One job at a time. */
interface PrintJob {
  name: string;
  done: number;
  total: number;
}

interface PrintState {
  job: PrintJob | null;
  cancel: (() => void) | null;
}

export const usePrintJob = create<PrintState>(() => ({ job: null, cancel: null }));

const PAGE_CSS = `
  @page { margin: 0; size: auto; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; overflow: hidden; }
  .page {
    width: 100%;
    height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    page-break-after: always;
    page-break-inside: avoid;
    break-after: page;
    break-inside: avoid;
  }
  .page:last-child { page-break-after: avoid; break-after: avoid; }
  img { max-width: 100%; max-height: 100%; object-fit: contain; display: block; }
`;

/** A print dialog is open or a job is being prepared. */
let busy = false;

/**
 * Print a PDF. On Linux the backend opens GTK's print dialog and renders each
 * page as it prints. Elsewhere the pages go through the webview's dialog.
 */
export async function triggerPrint(path: string): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    if (await invoke<boolean>("print_pdf", { path })) return;
    await printInWebview(path, path.split(/[\\/]/).pop() ?? path);
  } catch (e) {
    console.error("print failed", e);
  } finally {
    busy = false;
  }
}

async function printInWebview(path: string, name: string): Promise<void> {
  usePrintJob.setState({ job: { name, done: 0, total: 0 } });
  let cancelled = false;
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.cssText = "position:fixed;width:0;height:0;border:0;opacity:0";
  const cleanup = () => {
    iframe.remove();
    usePrintJob.setState({ job: null, cancel: null });
  };
  usePrintJob.setState({
    cancel: () => {
      cancelled = true;
      cleanup();
    },
  });

  try {
    const total = await invoke<number>("get_page_count", { path });
    if (cancelled) return;
    usePrintJob.setState({ job: { name, done: 0, total } });

    document.body.appendChild(iframe);
    const doc = iframe.contentDocument ?? iframe.contentWindow?.document;
    if (!doc) throw new Error("print frame has no document");
    const pages = Array.from({ length: total }, (_, i) =>
      `<div class="page"><img src="${printUrl(path, i + 1)}" alt="" /></div>`,
    ).join("\n");
    doc.open();
    doc.write(`<!DOCTYPE html><html><head><style>${PAGE_CSS}</style></head><body>${pages}</body></html>`);
    doc.close();

    let done = 0;
    await Promise.all(
      Array.from(doc.querySelectorAll("img")).map(
        (img) =>
          new Promise<void>((resolve) => {
            const finish = () => {
              done += 1;
              if (!cancelled) usePrintJob.setState({ job: { name, done, total } });
              resolve();
            };
            if (img.complete) finish();
            else img.onload = img.onerror = finish;
          }),
      ),
    );
    if (cancelled) return;

    usePrintJob.setState({ job: null, cancel: null });
    iframe.contentWindow?.focus();
    iframe.contentWindow?.print();
    // The dialog is closed once the main window has focus again.
    window.addEventListener("focus", () => iframe.remove(), { once: true });
  } catch (e) {
    console.error("print failed", e);
    cleanup();
  }
}
