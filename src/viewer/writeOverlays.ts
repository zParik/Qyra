import { bakeAnnotations, fillForm, stampImages } from "../lib/tauri";
import type { Stroke, VirtualPage } from "../store/useNotesStore";
import type { Signature } from "./SignatureLayer";

/** Edits that live in viewer overlays until a save writes them into the file. */
export interface Overlays {
  fieldValues: Record<string, string>;
  signatures: Signature[];
  strokes: Stroke[];
  virtualPages: VirtualPage[];
}

const api = { fillForm, stampImages, bakeAnnotations };

/**
 * Write the overlays into copies of `path`, one command per kind, and return
 * the last copy (or `path` when there is nothing to write). Form fields and
 * signatures are placed by page number, so added pages go in last.
 */
export async function writeOverlays(path: string, o: Overlays, commands = api): Promise<string> {
  let out = path;

  const fields = Object.entries(o.fieldValues).map(([name, value]) => ({ name, value }));
  if (fields.length > 0) out = await commands.fillForm(out, fields, false);

  if (o.signatures.length > 0) {
    out = await commands.stampImages(out, o.signatures.map((s) => ({
      page: s.pageNum, x: s.x, y: s.y, width: s.width, height: s.height, dataUrl: s.dataUrl,
    })));
  }

  const byPage = new Map<number, Stroke[]>();
  const byVirtualId = new Map<string, Stroke[]>();
  for (const s of o.strokes) {
    if (s.pageSlotId.startsWith("pdf-")) {
      const page = parseInt(s.pageSlotId.slice(4), 10);
      if (isNaN(page)) continue;
      if (!byPage.has(page)) byPage.set(page, []);
      byPage.get(page)!.push(s);
    } else {
      if (!byVirtualId.has(s.pageSlotId)) byVirtualId.set(s.pageSlotId, []);
      byVirtualId.get(s.pageSlotId)!.push(s);
    }
  }
  const toStroke = (s: Stroke) => ({
    tool: s.tool,
    color: s.color,
    thickness: s.baseThickness,
    points: s.points.map(([x, y]) => [x, y] as [number, number]),
  });
  if (byPage.size > 0 || o.virtualPages.length > 0) {
    const annotations = Array.from(byPage.entries()).map(([page, list]) => ({
      page,
      strokes: list.map(toStroke),
    }));
    const virtualPageData = o.virtualPages.map((vp) => ({
      id: vp.id,
      template: vp.template,
      afterRealPage: vp.afterRealPage,
      strokes: (byVirtualId.get(vp.id) ?? []).filter((s) => s.tool !== "eraser").map(toStroke),
    }));
    out = await commands.bakeAnnotations(out, annotations, virtualPageData);
  }
  return out;
}
