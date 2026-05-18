import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

interface PageLink {
  uri: string;
  page: number | null; // 1-based, set for internal GoTo links
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface LinkLayerProps {
  pdfPath: string;
  pageNum: number;
  isDrawingMode?: boolean;
  enabled?: boolean;
  onPageJump?: (page: number) => void;
}

/**
 * Click-target overlay for link annotations from MuPDF.
 *
 * Sits above .textLayer (z-index 1) so link clicks aren't swallowed by the
 * transparent character spans. Container is pointer-events: none so it never
 * blocks text-selection drags that start outside a link rect; only the
 * individual link buttons opt back in.
 */
export function LinkLayer({
  pdfPath,
  pageNum,
  isDrawingMode,
  enabled = true,
  onPageJump,
}: LinkLayerProps) {
  const [links, setLinks] = useState<PageLink[]>([]);

  useEffect(() => {
    if (!enabled) {
      setLinks([]);
      return;
    }
    let cancelled = false;
    invoke<PageLink[]>("get_page_links", { path: pdfPath, page: pageNum })
      .then((data) => {
        if (!cancelled) setLinks(data);
      })
      .catch(() => {
        if (!cancelled) setLinks([]);
      });
    return () => {
      cancelled = true;
    };
  }, [pdfPath, pageNum, enabled]);

  if (!links.length || isDrawingMode) return null;

  function handleClick(link: PageLink, e: React.MouseEvent) {
    e.stopPropagation();
    if (link.page !== null && link.page !== undefined && onPageJump) {
      onPageJump(link.page);
      return;
    }
    if (link.uri && /^(https?|mailto):/i.test(link.uri)) {
      openUrl(link.uri).catch(() => {});
    }
  }

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        zIndex: 10,
      }}
    >
      {links.map((link, i) => (
        <button
          key={i}
          type="button"
          aria-label={link.uri || (link.page ? `Go to page ${link.page}` : "Link")}
          title={link.uri || (link.page ? `Page ${link.page}` : undefined)}
          onClick={(e) => handleClick(link, e)}
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            position: "absolute",
            left: `${link.x0 * 100}%`,
            top: `${link.y0 * 100}%`,
            width: `${(link.x1 - link.x0) * 100}%`,
            height: `${(link.y1 - link.y0) * 100}%`,
            background: "transparent",
            border: "none",
            padding: 0,
            margin: 0,
            cursor: "pointer",
            pointerEvents: "auto",
            userSelect: "none",
            WebkitUserSelect: "none",
          }}
          className="pdf-link-target"
        />
      ))}
    </div>
  );
}
