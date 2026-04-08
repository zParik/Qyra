import * as pdfjsLib from "pdfjs-dist";
import { convertFileSrc } from "@tauri-apps/api/core";

/** Render every page of a PDF to image data-URLs via PDF.js, then print via a hidden iframe. */
export async function triggerPrint(path: string): Promise<void> {
  const url = convertFileSrc(path);
  const doc = await pdfjsLib.getDocument({ url }).promise;

  const images: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await page.render({
      canvasContext: canvas.getContext("2d")!,
      viewport,
      canvas,
    }).promise;
    images.push(canvas.toDataURL("image/png"));
  }
  doc.destroy();

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
  // (Setting iframe.onload before appendChild fires on about:blank; setting it
  // after iframeDoc.close() can miss the event. Waiting on the images directly
  // is reliable since data-URLs decode synchronously once the DOM is ready.)
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
