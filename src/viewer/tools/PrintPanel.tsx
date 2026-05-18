import { invoke } from "@tauri-apps/api/core";

/** Render every page of a PDF to image data-URLs via MuPDF Rust backend, then print via a hidden iframe. */
export async function triggerPrint(path: string): Promise<void> {
  const pageCount = await invoke<number>("get_page_count", { path });

  const images: string[] = [];
  for (let i = 1; i <= pageCount; i++) {
    const base64 = await invoke<string>("render_page", { path, page: i, scale: 2.0 });
    images.push(`data:image/jpeg;base64,${base64}`);
  }

  const iframe = document.createElement("iframe");
  iframe.style.cssText = "position:fixed;width:0;height:0;border:0;opacity:0";
  document.body.appendChild(iframe);

  const iframeDoc = iframe.contentDocument ?? iframe.contentWindow?.document;
  if (!iframeDoc) return;

  iframeDoc.open();
  iframeDoc.write(`<!DOCTYPE html>
<html><head><style>
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
</style></head><body>
  ${images.map((src) => `<div class="page"><img src="${src}" /></div>`).join("\n")}
</body></html>`);
  iframeDoc.close();

  // Wait for all images to finish loading before printing.
  const imgEls = Array.from(iframeDoc.querySelectorAll("img"));
  await Promise.all(
    imgEls.map(
      (img) =>
        img.complete
          ? Promise.resolve()
          : new Promise<void>((res) => {
              img.onload = img.onerror = () => res();
            })
    )
  );

  iframe.contentWindow?.focus();
  iframe.contentWindow?.print();
  window.addEventListener("focus", () => document.body.removeChild(iframe), {
    once: true,
  });
}
