import { useEffect, useRef, useState } from "react";
import {
  DndContext, PointerSensor, useSensor, useSensors,
  closestCenter, DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext, horizontalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useAppStore } from "../store/useAppStore";
import { UI } from "../lib/tokens";
import { useIsPhone } from "../hooks/useMediaQuery";
import { renderPage } from "../hooks/usePageThumbnails";

const HOVER_DELAY_MS = 450;
const PREVIEW_SCALE = 0.35;

function TabPill({
  id, label, active, dirty, isPdfPath, onActivate, onClose, onContextMenu, isPhone,
}: {
  id: string; label: string; active: boolean; dirty: boolean; isPdfPath: boolean;
  onActivate: () => void; onClose: () => void;
  onContextMenu: (x: number, y: number) => void;
  isPhone: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id });

  const height = isPhone ? 40 : 32;
  const fontSize = isPhone ? 13 : 12;
  const maxWidth = isPhone ? 160 : 200;

  const pillRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [previewPos, setPreviewPos] = useState<{ left: number; top: number } | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);

  function setPillRefs(node: HTMLDivElement | null) {
    setNodeRef(node);
    pillRef.current = node;
  }

  function hidePreview() {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setPreviewSrc(null);
    setPreviewPos(null);
    setPreviewFailed(false);
  }

  function startPreviewTimer() {
    if (isPhone || !isPdfPath || isDragging) return;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(async () => {
      const rect = pillRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPreviewPos({ left: rect.left, top: rect.bottom + 6 });
      try {
        const src = await renderPage(id, 1, PREVIEW_SCALE);
        // Race guard — if user left during render the timer was nulled.
        if (timerRef.current === null && pillRef.current?.matches(":hover") !== true) return;
        setPreviewSrc(src);
      } catch {
        setPreviewFailed(true);
      }
    }, HOVER_DELAY_MS);
  }

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  // Hide preview when the pill enters drag state.
  useEffect(() => {
    if (isDragging) hidePreview();
  }, [isDragging]);

  return (
    <div
      ref={setPillRefs}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
        display: "flex",
        alignItems: "center",
        gap: 4,
        padding: isPhone ? "0 6px 0 12px" : "0 10px 0 12px",
        height,
        borderRadius: 6,
        cursor: "pointer",
        flexShrink: 0,
        maxWidth,
        background: active ? "var(--bg3)" : "transparent",
        border: active ? "1px solid var(--line)" : "1px solid transparent",
        color: active ? "var(--fg0)" : "var(--fg2)",
        fontFamily: UI,
        fontSize,
        userSelect: "none",
        WebkitTapHighlightColor: "transparent",
      }}
      onClick={onActivate}
      onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onClose(); } }}
      onContextMenu={(e) => { e.preventDefault(); onContextMenu(e.clientX, e.clientY); }}
      onMouseEnter={startPreviewTimer}
      onMouseLeave={hidePreview}
      {...attributes}
      {...listeners}
    >
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
        {dirty ? "• " : ""}{label}
      </span>
      <button
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        style={{
          background: "none", border: "none", cursor: "pointer",
          color: "var(--fg2)",
          padding: 0, margin: 0,
          width: isPhone ? 32 : 22,
          height: isPhone ? 32 : 22,
          lineHeight: 1,
          fontSize: isPhone ? 20 : 14,
          borderRadius: 4,
          flexShrink: 0,
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          WebkitTapHighlightColor: "transparent",
        }}
        aria-label="Close tab"
      >
        ×
      </button>

      {previewPos && (previewSrc || !previewFailed) && (
        <div
          role="tooltip"
          style={{
            position: "fixed",
            left: previewPos.left,
            top: previewPos.top,
            zIndex: 8500,
            background: "var(--bg2)",
            border: "1px solid var(--line)",
            borderRadius: 6,
            padding: 4,
            boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
            pointerEvents: "none",
            fontFamily: UI,
            fontSize: 11,
            color: "var(--fg1)",
            maxWidth: 240,
          }}
        >
          {previewSrc ? (
            <img
              src={previewSrc}
              alt=""
              style={{ display: "block", width: 200, height: "auto", borderRadius: 3 }}
              draggable={false}
            />
          ) : (
            <div style={{ width: 200, height: 120, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--fg2)" }}>
              Loading…
            </div>
          )}
          <div style={{ marginTop: 4, padding: "2px 4px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {label}
          </div>
        </div>
      )}
    </div>
  );
}

export function TabBar({ onOpenFile, onCloseTab, onOpenExternalFile }: {
  onOpenFile: () => void;
  onCloseTab: (index: number) => void;
  onOpenExternalFile: (path: string, name: string) => void;
}) {
  const openTabs = useAppStore((s) => s.openTabs);
  const activeTabIndex = useAppStore((s) => s.activeTabIndex);
  const activateTab = useAppStore((s) => s.activateTab);
  const reorderTab = useAppStore((s) => s.reorderTab);
  const tabDirty = useAppStore((s) => s.tabDirty);
  const tabOriginal = useAppStore((s) => s.tabOriginal);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; index: number } | null>(null);

  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [ctxMenu]);

  function resolvePath(index: number): string | null {
    const tab = openTabs[index];
    if (!tab || tab.type === "home") return null;
    return tabOriginal[tab.path] ?? tab.path;
  }

  async function handleReveal(index: number) {
    const p = resolvePath(index);
    if (p) await revealItemInDir(p).catch(console.error);
  }

  async function handleCopyPath(index: number) {
    const p = resolvePath(index);
    if (p) await navigator.clipboard.writeText(p).catch(console.error);
  }

  function handleCloseOthers(index: number) {
    for (let i = openTabs.length - 1; i >= 0; i--) {
      if (i !== index) onCloseTab(i);
    }
  }

  function handleCloseRight(index: number) {
    for (let i = openTabs.length - 1; i > index; i--) onCloseTab(i);
  }

  const isPhone = useIsPhone();
  const sensors = useSensors(useSensor(PointerSensor, {
    activationConstraint: isPhone
      ? { delay: 200, tolerance: 8 }
      : { distance: 6 },
  }));

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = openTabs.findIndex((t) => t.path === active.id);
    const to = openTabs.findIndex((t) => t.path === over.id);
    if (from !== -1 && to !== -1) reorderTab(from, to);
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        padding: isPhone ? "6px 8px" : "4px 8px",
        paddingTop: `calc(env(safe-area-inset-top, 0px) + ${isPhone ? 6 : 4}px)`,
        borderBottom: "1px solid var(--line2)",
        background: "var(--bg1)",
        overflowX: "auto",
        WebkitOverflowScrolling: "touch",
        scrollbarWidth: "none",
        flexShrink: 0,
      }}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
      onDrop={(e) => {
        e.preventDefault();
        const file = e.dataTransfer.files[0];
        if (file && file.name.toLowerCase().endsWith(".pdf")) {
          const path = (file as File & { path?: string }).path ?? "";
          if (path) {
            const name = path.split(/[\\/]/).pop() ?? file.name;
            onOpenExternalFile(path, name);
          }
        }
      }}
    >
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={openTabs.map((t) => t.path)} strategy={horizontalListSortingStrategy}>
          {openTabs.map((tab, i) => (
            <TabPill
              key={tab.path}
              id={tab.path}
              label={tab.name}
              active={i === activeTabIndex}
              dirty={tabDirty[tab.path] ?? false}
              isPdfPath={tab.type !== "home"}
              onActivate={() => activateTab(i)}
              onClose={() => onCloseTab(i)}
              onContextMenu={(x, y) => setCtxMenu({ x, y, index: i })}
              isPhone={isPhone}
            />
          ))}
        </SortableContext>
      </DndContext>

      {ctxMenu && (() => {
        const tab = openTabs[ctxMenu.index];
        const isPdf = tab?.type !== "home";
        const items: Array<{ label: string; onSelect: () => void; disabled?: boolean; danger?: boolean }> = [
          { label: "Reveal in file explorer", onSelect: () => handleReveal(ctxMenu.index), disabled: !isPdf },
          { label: "Copy path", onSelect: () => handleCopyPath(ctxMenu.index), disabled: !isPdf },
          { label: "Close", onSelect: () => onCloseTab(ctxMenu.index) },
          { label: "Close other tabs", onSelect: () => handleCloseOthers(ctxMenu.index), disabled: openTabs.length <= 1 },
          { label: "Close tabs to the right", onSelect: () => handleCloseRight(ctxMenu.index), disabled: ctxMenu.index >= openTabs.length - 1 },
        ];
        return (
          <div
            role="menu"
            onClick={(e) => e.stopPropagation()}
            style={{
              position: "fixed",
              left: ctxMenu.x,
              top: ctxMenu.y,
              background: "var(--bg2, #181825)",
              border: "1px solid var(--line, #313244)",
              borderRadius: 6,
              padding: "4px 0",
              minWidth: 200,
              boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
              zIndex: 9000,
              fontFamily: UI,
              fontSize: 12,
            }}
          >
            {items.map((it, idx) => (
              <div
                key={idx}
                role="menuitem"
                onClick={() => {
                  if (it.disabled) return;
                  setCtxMenu(null);
                  it.onSelect();
                }}
                style={{
                  padding: isPhone ? "12px 16px" : "6px 12px",
                  minHeight: isPhone ? 44 : undefined,
                  fontSize: isPhone ? 14 : 12,
                  display: "flex", alignItems: "center",
                  color: it.disabled ? "var(--fg3, #45475a)" : "var(--fg0, #cdd6f4)",
                  cursor: it.disabled ? "default" : "pointer",
                  userSelect: "none",
                }}
                onMouseEnter={(e) => { if (!it.disabled) (e.currentTarget as HTMLElement).style.background = "var(--bg3, #313244)"; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
              >
                {it.label}
              </div>
            ))}
          </div>
        );
      })()}

      <button
        onClick={onOpenFile}
        title="Open file in new tab (Ctrl+T)"
        style={{
          background: "none", border: "none", cursor: "pointer",
          color: "var(--fg2)",
          fontSize: isPhone ? 24 : 18, lineHeight: 1,
          width: isPhone ? 40 : 28, height: isPhone ? 40 : 28,
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          borderRadius: 4, flexShrink: 0,
          WebkitTapHighlightColor: "transparent",
        }}
        aria-label="Open new tab"
      >
        +
      </button>
    </div>
  );
}
