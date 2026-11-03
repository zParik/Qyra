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
import { thumbUrl } from "../render/renderClient";
import { Wordmark } from "../components/Wordmark";

const HOVER_DELAY_MS = 450;

/**
 * One document tab, drawn as a stock tag: a paper sheet with a colour edge on
 * top. The active sheet is the one lying on the counter (same colour as the
 * ground), the others sit back in the indigo cloth.
 */
function TabTag({
  id, label, active, dirty, isPdfPath, onActivate, onClose, onContextMenu,
}: {
  id: string; label: string; active: boolean; dirty: boolean; isPdfPath: boolean;
  onActivate: () => void; onClose: () => void;
  onContextMenu: (x: number, y: number) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id });

  const tagRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [previewPos, setPreviewPos] = useState<{ left: number; top: number } | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);

  function setRefs(node: HTMLDivElement | null) {
    setNodeRef(node);
    tagRef.current = node;
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
    if (!isPdfPath || isDragging) return;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(async () => {
      const rect = tagRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPreviewPos({ left: rect.left, top: rect.bottom + 6 });
      // Race guard — if the user left before the delay elapsed the timer was nulled.
      if (timerRef.current === null && tagRef.current?.matches(":hover") !== true) return;
      setPreviewSrc(thumbUrl(id, 1, 256));
    }, HOVER_DELAY_MS);
  }

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  // Hide preview when the tag enters drag state.
  useEffect(() => {
    if (isDragging) hidePreview();
  }, [isDragging]);

  const edge = !isPdfPath ? "library" : dirty ? "dirty" : active ? "active" : "rest";

  return (
    <div
      ref={setRefs}
      className="tab"
      data-active={active ? "true" : undefined}
      data-edge={edge}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
      }}
      onClick={onActivate}
      onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onClose(); } }}
      onContextMenu={(e) => { e.preventDefault(); onContextMenu(e.clientX, e.clientY); }}
      onMouseEnter={startPreviewTimer}
      onMouseLeave={hidePreview}
      {...attributes}
      {...listeners}
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onActivate(); return; }
        listeners?.onKeyDown?.(e);
      }}
    >
      <span className="tab-label">{label}</span>
      {dirty && <span className="tab-dot" aria-label="Unsaved changes" title="Unsaved changes" />}
      <button
        className="tab-close"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        aria-label={`Close ${label}`}
        tabIndex={-1}
      >
        <svg width={12} height={12} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      </button>

      {previewPos && (previewSrc || !previewFailed) && (
        <div
          role="tooltip"
          className="pop"
          style={{
            position: "fixed",
            left: previewPos.left,
            top: previewPos.top,
            zIndex: 8500,
            padding: 4,
            pointerEvents: "none",
            fontSize: "var(--fs-label)",
            color: "var(--fg1)",
            maxWidth: 240,
          }}
        >
          {previewSrc ? (
            <img
              src={previewSrc}
              alt=""
              style={{ display: "block", width: 200, height: "auto", borderRadius: 3, border: "1px solid var(--line2)" }}
              draggable={false}
              onError={() => { setPreviewSrc(null); setPreviewFailed(true); }}
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

export function TabBar({ onOpenFile, onCloseTab, onOpenExternalFile, onActivateTab }: {
  onOpenFile: () => void;
  onCloseTab: (index: number) => void;
  onOpenExternalFile: (path: string, name: string) => void;
  /** Called after a tab is activated by click or keyboard. */
  onActivateTab?: () => void;
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

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = openTabs.findIndex((t) => t.path === active.id);
    const to = openTabs.findIndex((t) => t.path === over.id);
    if (from !== -1 && to !== -1) reorderTab(from, to);
  }

  return (
    <div
      className="tabbar"
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
      <Wordmark />

      <div className="tabbar-tabs scroll-invisible" role="tablist" aria-label="Open documents">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={openTabs.map((t) => t.path)} strategy={horizontalListSortingStrategy}>
            {openTabs.map((tab, i) => (
              <TabTag
                key={tab.path}
                id={tab.path}
                label={tab.name}
                active={i === activeTabIndex}
                dirty={tabDirty[tab.path] ?? false}
                isPdfPath={tab.type !== "home"}
                onActivate={() => { activateTab(i); onActivateTab?.(); }}
                onClose={() => onCloseTab(i)}
                onContextMenu={(x, y) => setCtxMenu({ x, y, index: i })}
              />
            ))}
          </SortableContext>
        </DndContext>

        <button
          onClick={onOpenFile}
          className="shell-btn"
          title="New tab (Ctrl+T)"
          aria-label="Open new tab"
        >
          <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" aria-hidden="true">
            <path d="M8 3v10M3 8h10" />
          </svg>
        </button>
      </div>

      {ctxMenu && (() => {
        const tab = openTabs[ctxMenu.index];
        const isPdf = tab?.type !== "home";
        const items: Array<{ label: string; onSelect: () => void; disabled?: boolean }> = [
          { label: "Reveal in file explorer", onSelect: () => handleReveal(ctxMenu.index), disabled: !isPdf },
          { label: "Copy path", onSelect: () => handleCopyPath(ctxMenu.index), disabled: !isPdf },
          { label: "Close", onSelect: () => onCloseTab(ctxMenu.index) },
          { label: "Close other tabs", onSelect: () => handleCloseOthers(ctxMenu.index), disabled: openTabs.length <= 1 },
          { label: "Close tabs to the right", onSelect: () => handleCloseRight(ctxMenu.index), disabled: ctxMenu.index >= openTabs.length - 1 },
        ];
        return (
          <div
            role="menu"
            className="pop menu"
            onClick={(e) => e.stopPropagation()}
            style={{ position: "fixed", left: ctxMenu.x, top: ctxMenu.y, zIndex: 9000, minWidth: 220 }}
          >
            {items.map((it, idx) => (
              <div
                key={idx}
                role="menuitem"
                className="menu-item"
                data-disabled={it.disabled ? "" : undefined}
                onMouseEnter={(e) => { if (!it.disabled) e.currentTarget.setAttribute("data-highlighted", ""); }}
                onMouseLeave={(e) => e.currentTarget.removeAttribute("data-highlighted")}
                onClick={() => {
                  if (it.disabled) return;
                  setCtxMenu(null);
                  it.onSelect();
                }}
              >
                {it.label}
              </div>
            ))}
          </div>
        );
      })()}
    </div>
  );
}
