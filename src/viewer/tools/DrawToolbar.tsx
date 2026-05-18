import { useEffect, useRef, useState } from "react";
import { useNotesStore, PageTemplate, VirtualPage } from "../../store/useNotesStore";
import { removePages, getSetting, setSetting } from "../../lib/tauri";

const COLORS = [
  { label: "Black",  value: "#111111" },
  { label: "Blue",   value: "#1d4ed8" },
  { label: "Red",    value: "#ef4444" },
  { label: "Green",  value: "#16a34a" },
  { label: "Orange", value: "#f97316" },
  { label: "Purple", value: "#9333ea" },
  { label: "Pink",   value: "#ec4899" },
  { label: "Yellow", value: "#eab308" },
];

const THICKNESSES = [
  { label: "Fine",   value: 2  },
  { label: "Medium", value: 4  },
  { label: "Thick",  value: 8  },
  { label: "Brush",  value: 14 },
];

const TOOLS: { id: 'pen' | 'highlighter' | 'calligraphy' | 'bezier' | 'eraser'; label: string; icon: React.ReactNode }[] = [
  {
    id: 'pen', label: 'Pen',
    icon: <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
    </svg>,
  },
  {
    id: 'highlighter', label: 'Highlighter',
    icon: <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
    </svg>,
  },
  {
    id: 'calligraphy', label: 'Calligraphy',
    icon: <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
    </svg>,
  },
  {
    id: 'bezier', label: 'Curve',
    icon: <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 20 C8 4 16 4 20 20" fill="none" />
    </svg>,
  },
  {
    id: 'eraser', label: 'Eraser',
    icon: <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
    </svg>,
  },
];

const TEMPLATES: { id: PageTemplate; label: string; preview: string }[] = [
  { id: 'blank',  label: 'Blank',  preview: '□' },
  { id: 'ruled',  label: 'Ruled',  preview: '≡' },
  { id: 'grid',   label: 'Grid',   preview: '⊞' },
  { id: 'dotted', label: 'Dotted', preview: '⠿' },
];

const EMPTY_VIRTUAL_PAGES: VirtualPage[] = [];

function Divider() {
  return (
    <div className="shrink-0 self-stretch mx-1" style={{ width: "1px", background: "var(--viewer-border)" }} />
  );
}

function AddPageDropdown({ docPath, onClose }: { docPath: string; onClose: () => void }) {
  const virtualPages      = useNotesStore((s) => s.virtualPages[docPath] ?? EMPTY_VIRTUAL_PAGES);
  const addVirtualPage    = useNotesStore((s) => s.addVirtualPage);
  const removeVirtualPage = useNotesStore((s) => s.removeVirtualPage);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);

  function addPage(template: PageTemplate) {
    addVirtualPage(docPath, { id: crypto.randomUUID(), template, afterRealPage: 9999 });
  }

  return (
    <div
      ref={ref}
      className="absolute top-full right-0 mt-1 z-50 rounded-xl flex flex-col gap-3 p-4"
      style={{
        background: "var(--viewer-elevated)",
        border: "1px solid var(--viewer-border)",
        boxShadow: "0 8px 32px color-mix(in oklch, oklch(0% 0 0) 40%, transparent)",
        width: "260px",
      }}
    >
      <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--viewer-text-muted)" }}>
        Add Note Page
      </p>
      <p className="text-xs" style={{ color: "var(--viewer-text-muted)" }}>
        Appends at the end. Use the <strong>+</strong> buttons between pages to insert at a specific position.
      </p>
      <div className="grid grid-cols-2 gap-1.5">
        {TEMPLATES.map((tmpl) => (
          <button
            key={tmpl.id}
            onClick={() => addPage(tmpl.id)}
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors"
            style={{ background: "var(--viewer-surface)", border: "1px solid var(--viewer-border)", color: "var(--viewer-text)" }}
          >
            <span className="text-base leading-none">{tmpl.preview}</span>
            <span>{tmpl.label}</span>
          </button>
        ))}
      </div>
      {virtualPages.length > 0 && (
        <>
          <p className="text-xs font-semibold uppercase tracking-wider mt-1" style={{ color: "var(--viewer-text-muted)" }}>
            Inserted pages ({virtualPages.length})
          </p>
          <div className="flex flex-col gap-1">
            {virtualPages.map((vp) => (
              <div key={vp.id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs"
                style={{ background: "var(--viewer-surface)", border: "1px solid var(--viewer-border-sub)" }}>
                <span className="flex-1 capitalize" style={{ color: "var(--viewer-text-sec)" }}>
                  {vp.template} page
                  {vp.afterRealPage === 0 ? ' (before start)' :
                   vp.afterRealPage >= 9999 ? ' (after end)' :
                   ` (after p.${vp.afterRealPage})`}
                </span>
                <button onClick={() => removeVirtualPage(docPath, vp.id)} title="Remove" style={{ color: "#ef4444" }}>
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        </>
      )}
      <p className="text-xs" style={{ color: "var(--viewer-text-muted)" }}>
        Use <strong>Save</strong> to bake annotations and note pages into the PDF.
      </p>
    </div>
  );
}

interface DrawToolbarProps {
  onExitDraw: () => void;
  onSave: () => void;
  onSaveAs: () => void;
  currentPage: number;
  pageCount: number;
  onApplied: (path: string) => void;
  filePath: string;
}

export function DrawToolbar({
  onExitDraw, onSave, onSaveAs,
  currentPage, pageCount, onApplied, filePath,
}: DrawToolbarProps) {
  const docPath = filePath;

  const drawColor     = useNotesStore((s) => s.drawColor);
  const drawThickness = useNotesStore((s) => s.drawThickness);
  const drawTool      = useNotesStore((s) => s.drawTool);
  const drawNibAngle  = useNotesStore((s) => s.drawNibAngle);
  const eraserSize    = useNotesStore((s) => s.eraserSize);
  const strokeCount   = useNotesStore((s) => s.strokes[docPath]?.length ?? 0);
  const virtualPageCount = useNotesStore((s) => (s.virtualPages[docPath] ?? EMPTY_VIRTUAL_PAGES).length);

  const setDrawColor     = useNotesStore((s) => s.setDrawColor);
  const setDrawThickness = useNotesStore((s) => s.setDrawThickness);
  const setDrawTool      = useNotesStore((s) => s.setDrawTool);
  const setDrawNibAngle  = useNotesStore((s) => s.setDrawNibAngle);
  const setEraserSize    = useNotesStore((s) => s.setEraserSize);
  const undoStroke       = useNotesStore((s) => s.undoStroke);
  const clearStrokes     = useNotesStore((s) => s.clearStrokes);

  const [confirmClear, setConfirmClear]       = useState(false);
  const [confirmDelete, setConfirmDelete]     = useState(false);
  const [addPageOpen, setAddPageOpen]         = useState(false);
  const [isDeleting, setIsDeleting]           = useState(false);
  const [saveState, setSaveState]             = useState<'idle' | 'saving' | 'saved'>('idle');

  // Load draw preferences once on mount
  useEffect(() => {
    Promise.all([
      getSetting("draw_tool"),
      getSetting("draw_color"),
      getSetting("draw_thickness"),
      getSetting("draw_nib_angle"),
      getSetting("draw_eraser_size"),
    ]).then(([tool, color, thickness, nibAngle, eraserSize]) => {
      if (tool) setDrawTool(tool as typeof drawTool);
      if (color) setDrawColor(color);
      if (thickness) setDrawThickness(Number(thickness));
      if (nibAngle) setDrawNibAngle(Number(nibAngle));
      if (eraserSize) setEraserSize(Number(eraserSize));
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist each preference when it changes
  useEffect(() => { setSetting("draw_tool", drawTool).catch(() => {}); }, [drawTool]);
  useEffect(() => { setSetting("draw_color", drawColor).catch(() => {}); }, [drawColor]);
  useEffect(() => { setSetting("draw_thickness", String(drawThickness)).catch(() => {}); }, [drawThickness]);
  useEffect(() => { setSetting("draw_nib_angle", String(drawNibAngle)).catch(() => {}); }, [drawNibAngle]);
  useEffect(() => { setSetting("draw_eraser_size", String(eraserSize)).catch(() => {}); }, [eraserSize]);

  const toolBtnStyle = (active: boolean): React.CSSProperties =>
    active
      ? { background: "color-mix(in oklch, var(--brand) 20%, transparent)", border: "1px solid color-mix(in oklch, var(--brand) 50%, transparent)", color: "var(--brand)" }
      : { background: "transparent", border: "1px solid transparent", color: "var(--viewer-text-sec)" };

  const rowStyle: React.CSSProperties = {
    background: "var(--viewer-surface)",
    borderBottom: "1px solid var(--viewer-border)",
  };

  async function handleDeletePage() {
    if (currentPage < 1 || currentPage > pageCount || pageCount <= 1) return;
    setIsDeleting(true);
    try {
      const outPath = await removePages(filePath, [currentPage]);
      await onApplied(outPath);
    } finally {
      setIsDeleting(false);
      setConfirmDelete(false);
    }
  }

  return (
    <div className="flex flex-col shrink-0">
      {/* ── Row 1: meta controls ── */}
      <div className="flex items-center gap-1 px-2 py-1" style={rowStyle}>
        {/* Exit draw mode */}
        <button
          onClick={onExitDraw}
          className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-xs font-medium transition-colors shrink-0"
          style={{ background: "transparent", border: "1px solid transparent", color: "var(--viewer-text-sec)" }}
          title="Exit draw mode"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Normal view
        </button>

        <Divider />

        {/* Save */}
        <button
          onClick={async () => {
            setSaveState('saving');
            try { await onSave(); setSaveState('saved'); }
            catch { setSaveState('idle'); return; }
            setTimeout(() => setSaveState('idle'), 1800);
          }}
          disabled={saveState === 'saving'}
          title="Save (Ctrl+S)"
          className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-xs font-medium transition-colors shrink-0"
          style={{
            background: saveState === 'saved'
              ? "color-mix(in oklch, var(--action) 15%, transparent)"
              : "transparent",
            border: saveState === 'saved'
              ? "1px solid color-mix(in oklch, var(--action) 40%, transparent)"
              : "1px solid transparent",
            color: saveState === 'saved' ? "var(--action)" : "var(--viewer-text-sec)",
            opacity: saveState === 'saving' ? 0.5 : 1,
            cursor: saveState === 'saving' ? "not-allowed" : "pointer",
          }}
        >
          {saveState === 'saving' ? (
            <svg className="w-3.5 h-3.5 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M4 12a8 8 0 018-8v4l3-3-3-3v4a10 10 0 100 10" />
            </svg>
          ) : saveState === 'saved' ? (
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          ) : (
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
            </svg>
          )}
          {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : 'Save'}
          {saveState === 'idle' && <span className="opacity-40 text-xs">Ctrl+S</span>}
        </button>

        <button
          onClick={onSaveAs}
          title="Save As (Ctrl+Shift+S)"
          className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-xs transition-colors shrink-0"
          style={{ background: "transparent", border: "1px solid transparent", color: "var(--viewer-text-sec)" }}
        >
          Save As
        </button>

        <Divider />

        {/* Delete current page */}
        <div className="relative shrink-0">
          {confirmDelete ? (
            <div className="flex items-center gap-1">
              <span className="text-xs px-1" style={{ color: "var(--viewer-text-muted)" }}>
                Delete page {currentPage}?
              </span>
              <button
                onClick={() => setConfirmDelete(false)}
                className="px-2 py-1.5 rounded-lg text-xs"
                style={{ background: "var(--viewer-elevated)", border: "1px solid var(--viewer-border)", color: "var(--viewer-text-sec)" }}
              >
                Cancel
              </button>
              <button
                onClick={handleDeletePage}
                disabled={isDeleting}
                className="px-2 py-1.5 rounded-lg text-xs font-semibold"
                style={{ background: "#ef4444", border: "1px solid #dc2626", color: "#fff" }}
              >
                {isDeleting ? "Deleting…" : "Delete"}
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              disabled={pageCount <= 1}
              title={pageCount <= 1 ? "Can't delete the only page" : `Delete page ${currentPage}`}
              className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-xs transition-colors shrink-0"
              style={{
                background: "transparent",
                border: "1px solid transparent",
                color: pageCount <= 1 ? "var(--viewer-text-muted)" : "#ef4444",
                opacity: pageCount <= 1 ? 0.4 : 1,
                cursor: pageCount <= 1 ? "not-allowed" : "pointer",
              }}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
              Delete page {currentPage}
            </button>
          )}
        </div>
      </div>

      {/* ── Row 2: drawing tools ── */}
      <div className="flex flex-wrap items-center gap-0.5 px-2 py-1" style={rowStyle}>
        {/* Tools */}
        {TOOLS.map((t) => (
          <button
            key={t.id}
            onClick={() => setDrawTool(t.id)}
            title={t.label}
            className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-xs font-medium transition-colors shrink-0"
            style={toolBtnStyle(drawTool === t.id)}
          >
            {t.icon}
            <span>{t.label}</span>
          </button>
        ))}

        <Divider />

        {/* Inline tool settings */}
        {drawTool === 'calligraphy' && (
          <>
            <div className="flex items-center gap-1.5 shrink-0 px-1">
              <span className="text-xs shrink-0" style={{ color: "var(--viewer-text-muted)" }}>Nib</span>
              <input type="range" min={0} max={90} step={5} value={drawNibAngle}
                onChange={(e) => setDrawNibAngle(Number(e.target.value))} style={{ width: "72px" }} />
              <span className="text-xs tabular-nums shrink-0" style={{ color: "var(--viewer-text-sec)", minWidth: "2rem" }}>
                {drawNibAngle}°
              </span>
            </div>
            <Divider />
          </>
        )}
        {drawTool === 'eraser' && (
          <>
            <div className="flex items-center gap-1.5 shrink-0 px-1">
              <span className="text-xs shrink-0" style={{ color: "var(--viewer-text-muted)" }}>Size</span>
              <input type="range" min={8} max={80} step={4} value={eraserSize}
                onChange={(e) => setEraserSize(Number(e.target.value))} style={{ width: "72px" }} />
              <span className="text-xs tabular-nums shrink-0" style={{ color: "var(--viewer-text-sec)", minWidth: "2.5rem" }}>
                {eraserSize}px
              </span>
            </div>
            <Divider />
          </>
        )}
        {drawTool === 'bezier' && (
          <>
            <span className="text-xs shrink-0 px-1" style={{ color: "var(--viewer-text-muted)" }}>
              Click · Double-click to finish · Esc cancel
            </span>
            <Divider />
          </>
        )}

        {/* Colors — not for eraser */}
        {drawTool !== 'eraser' && (
          <>
            <div className="flex items-center gap-1 px-1 shrink-0">
              {COLORS.map((c) => (
                <button key={c.value} onClick={() => setDrawColor(c.value)} title={c.label}
                  className="rounded-full shrink-0 transition-transform hover:scale-110 hidden sm:block"
                  style={{
                    width: "18px", height: "18px", background: c.value,
                    outline: drawColor === c.value ? "2px solid var(--brand)" : "2px solid transparent",
                    outlineOffset: "1px",
                  }}
                />
              ))}
              {/* Current color — small screens only */}
              <div className="rounded-full shrink-0 sm:hidden" title="Current color"
                style={{ width: "18px", height: "18px", background: drawColor, outline: "2px solid var(--brand)", outlineOffset: "1px" }}
              />
              {/* Custom color picker */}
              <label title="Custom color" className="relative shrink-0 cursor-pointer" style={{ width: "18px", height: "18px" }}>
                <div className="rounded-full w-full h-full"
                  style={{ background: drawColor, border: "2px dashed var(--viewer-border)", boxSizing: "border-box" }} />
                <input type="color" value={drawColor} onChange={(e) => setDrawColor(e.target.value)}
                  className="absolute inset-0 opacity-0 w-full h-full cursor-pointer" />
              </label>
            </div>

            <Divider />

            {/* Thickness */}
            <div className="flex items-center gap-0.5 px-1 shrink-0">
              {THICKNESSES.map((th) => (
                <button key={th.value} onClick={() => setDrawThickness(th.value)} title={th.label}
                  className="flex items-center justify-center px-1.5 py-1 rounded-lg transition-colors shrink-0"
                  style={toolBtnStyle(drawThickness === th.value)}
                >
                  <svg viewBox="0 0 20 20" width="20" height="20" style={{ display: "block" }}>
                    <line x1={2} y1={10} x2={18} y2={10} stroke="currentColor" strokeWidth={th.value / 1.5} strokeLinecap="round" />
                  </svg>
                </button>
              ))}
            </div>

            <Divider />

            {/* Stroke preview */}
            <div className="shrink-0 px-1 flex items-center">
              <svg width="48" height="20" viewBox="0 0 48 20" style={{ overflow: "visible" }}>
                {drawTool === 'bezier' ? (
                  <path d="M2 16 C12 4 24 4 24 10 C24 16 36 16 46 4"
                    stroke={drawColor} strokeWidth={drawThickness} strokeLinecap="round" fill="none" />
                ) : (
                  <path d="M2 16 Q12 2 24 10 Q36 18 46 4"
                    stroke={drawTool === 'highlighter' ? drawColor : "none"}
                    strokeWidth={drawTool === 'highlighter' ? drawThickness * 3 : 0}
                    strokeOpacity={0.35} strokeLinecap="round"
                    fill={drawTool !== 'highlighter' ? drawColor : "none"}
                  />
                )}
              </svg>
            </div>

            <Divider />
          </>
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Undo */}
        <button
          onClick={() => undoStroke(docPath)}
          disabled={strokeCount === 0}
          title="Undo last stroke (Ctrl+Z)"
          className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-xs shrink-0 transition-colors"
          style={{
            background: "transparent", border: "1px solid transparent",
            color: strokeCount === 0 ? "var(--viewer-text-muted)" : "var(--viewer-text-sec)",
            opacity: strokeCount === 0 ? 0.4 : 1,
            cursor: strokeCount === 0 ? "not-allowed" : "pointer",
          }}
        >
          <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
          </svg>
          <span>Undo</span>
        </button>

        {/* Clear */}
        {confirmClear ? (
          <div className="flex items-center gap-1 shrink-0">
            <button onClick={() => setConfirmClear(false)} className="px-2 py-1.5 rounded-lg text-xs"
              style={{ background: "var(--viewer-elevated)", border: "1px solid var(--viewer-border)", color: "var(--viewer-text-sec)" }}>
              Cancel
            </button>
            <button onClick={() => { clearStrokes(docPath); setConfirmClear(false); }}
              className="px-2 py-1.5 rounded-lg text-xs font-semibold"
              style={{ background: "#ef4444", border: "1px solid #dc2626", color: "#fff" }}>
              Clear all
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirmClear(true)}
            disabled={strokeCount === 0}
            title={`Clear all strokes (${strokeCount})`}
            className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-xs shrink-0 transition-colors"
            style={{
              background: "transparent", border: "1px solid transparent",
              color: strokeCount === 0 ? "var(--viewer-text-muted)" : "#ef4444",
              opacity: strokeCount === 0 ? 0.4 : 1,
              cursor: strokeCount === 0 ? "not-allowed" : "pointer",
            }}
          >
            <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
            <span>Clear</span>
            {strokeCount > 0 && <span className="tabular-nums text-xs opacity-70">({strokeCount})</span>}
          </button>
        )}

        <Divider />

        {/* Add Page */}
        <div className="relative shrink-0">
          <button
            onClick={() => setAddPageOpen((o) => !o)}
            title="Add note page"
            className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-xs font-medium transition-colors"
            style={addPageOpen
              ? { background: "color-mix(in oklch, var(--action) 20%, transparent)", border: "1px solid color-mix(in oklch, var(--action) 50%, transparent)", color: "var(--action)" }
              : { background: "transparent", border: "1px solid transparent", color: "var(--viewer-text-sec)" }
            }
          >
            <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <span>Add Page</span>
            {virtualPageCount > 0 && (
              <span className="tabular-nums text-xs px-1 py-0.5 rounded-full"
                style={{ background: "var(--action)", color: "#fff", fontSize: "0.6rem" }}>
                {virtualPageCount}
              </span>
            )}
          </button>
          {addPageOpen && <AddPageDropdown docPath={docPath} onClose={() => setAddPageOpen(false)} />}
        </div>
      </div>
    </div>
  );
}
