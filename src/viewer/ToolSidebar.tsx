import { useEffect, useRef, useState } from "react";

import { LoadedFile } from "../store/useAppStore";
import { useIsPhone } from "../hooks/useMediaQuery";
import { RotatePanel } from "./tools/RotatePanel";
import { RemovePanel } from "./tools/RemovePanel";
import { ReorderPanel } from "./tools/ReorderPanel";
import { SplitPanel } from "./tools/SplitPanel";
import { CompressPanel } from "./tools/CompressPanel";
import { PageNumbersPanel } from "./tools/PageNumbersPanel";
import { ProtectPanel } from "./tools/ProtectPanel";
import { UnlockPanel } from "./tools/UnlockPanel";
import { MetadataPanel } from "./tools/MetadataPanel";
import { ExportImagesPanel } from "./tools/ExportImagesPanel";
import { triggerPrint } from "./tools/PrintPanel";
import { DrawPanel } from "./tools/DrawPanel";
import { WatermarkPanel } from "./tools/WatermarkPanel";
import { CommentPanel } from "./CommentPanel";
import { CropPanel } from "./tools/CropPanel";
import { FlattenPanel } from "./tools/FlattenPanel";
import { AnonymizePanel } from "./tools/AnonymizePanel";
import { FormDataPanel } from "./tools/FormDataPanel";
import { BatesPanel } from "./tools/BatesPanel";
import { LinksPanel } from "./tools/LinksPanel";
import { HeaderFooterPanel } from "./tools/HeaderFooterPanel";
import { ExportTextPanel } from "./tools/ExportTextPanel";
import { StampsPanel } from "./tools/StampsPanel";
import { ExportWordPanel } from "./tools/ExportWordPanel";
import { RedactPanel, type RedactRegion } from "./tools/RedactPanel";
import { ExportAnnotationsPanel } from "./tools/ExportAnnotationsPanel";
import { ComparePanel } from "./tools/ComparePanel";
import { invoke } from "@tauri-apps/api/core";
import {
  IconComment, IconPencil, IconRotate, IconTrash, IconReorder, IconSplit,
  IconPageNumbers, IconStar, IconForms, IconCrop, IconRedact, IconCheckBadge,
  IconCompress, IconLock, IconUnlock, IconEdit, IconImage, IconWatermark,
  IconFlatten, IconDocText, IconDocWord, IconList, IconCompare,
  IconChevronLeft, IconChevronRight, IconPrint,
} from "./icons";

export type ViewerTool =
  | "rotate" | "remove" | "reorder" | "split"
  | "compress" | "page-numbers" | "protect" | "unlock"
  | "metadata" | "export-images" | "draw" | "comment" | "watermark"
  | "annotate" | "forms" | "signature" | "crop" | "flatten" | "export-text" | "export-word" | "redact" | "stamps" | "export-annotations" | "compare" | "anonymize" | "form-data" | "bates" | "links" | "header-footer";

interface ToolSidebarProps {
  file: LoadedFile;
  onApplied: (path: string) => void;
  activeTool: ViewerTool | null;
  onToolChange: (tool: ViewerTool | null) => void;
  selectedPages: Set<number>;
  onSelectedPagesChange: (pages: Set<number>) => void;
  splitAfter: number;
  onSplitAfterChange: (n: number) => void;
  onPageSelect: (page: number) => void;
  currentPage: number;
  /** Switch sidebar to comments tab externally (e.g. when comment pill is clicked) */
  forceCommentsTab?: boolean;
  /** Redact regions marked on pages (owned by Viewer) */
  redactRegions?: RedactRegion[];
  /** Clear all redact regions */
  onClearRedactRegions?: () => void;
  /** Redaction selection mode: free-form region drag, or driven by text selection */
  redactMode?: "region" | "text";
  onRedactModeChange?: (m: "region" | "text") => void;
}

interface ToolDef { id: ViewerTool; label: string; icon: React.ReactNode }

const ICON_CLS = "w-4 h-4";

const PAGE_TOOLS: ToolDef[] = [
  { id: "comment",      label: "Comments",        icon: <IconComment className={ICON_CLS} /> },
  { id: "draw",         label: "Draw & Annotate", icon: <IconPencil className={ICON_CLS} /> },
  { id: "rotate",       label: "Rotate Pages",    icon: <IconRotate className={ICON_CLS} /> },
  { id: "remove",       label: "Remove Pages",    icon: <IconTrash className={ICON_CLS} /> },
  { id: "reorder",      label: "Reorder Pages",   icon: <IconReorder className={ICON_CLS} /> },
  { id: "split",        label: "Split PDF",       icon: <IconSplit className={ICON_CLS} /> },
  { id: "page-numbers", label: "Page Numbers",    icon: <IconPageNumbers className={ICON_CLS} /> },
  { id: "bates",        label: "Bates Numbering", icon: <IconPageNumbers className={ICON_CLS} /> },
  { id: "header-footer", label: "Header / Footer", icon: <IconPageNumbers className={ICON_CLS} /> },
  { id: "annotate",     label: "Annotate",        icon: <IconStar className={ICON_CLS} /> },
  { id: "links",        label: "Links",           icon: <IconList className={ICON_CLS} /> },
  { id: "forms",        label: "Fill Forms",      icon: <IconForms className={ICON_CLS} /> },
  { id: "signature",    label: "Sign",            icon: <IconPencil className={ICON_CLS} /> },
  { id: "crop",         label: "Crop Pages",      icon: <IconCrop className={ICON_CLS} /> },
  { id: "redact",       label: "Redact",          icon: <IconRedact className={ICON_CLS} /> },
  { id: "stamps",       label: "Stamps",          icon: <IconCheckBadge className={ICON_CLS} /> },
];

const FILE_TOOLS: ToolDef[] = [
  { id: "compress",            label: "Compress",           icon: <IconCompress className={ICON_CLS} /> },
  { id: "protect",             label: "Password Protect",   icon: <IconLock className={ICON_CLS} /> },
  { id: "unlock",              label: "Unlock PDF",         icon: <IconUnlock className={ICON_CLS} /> },
  { id: "metadata",            label: "Edit Metadata",      icon: <IconEdit className={ICON_CLS} /> },
  { id: "export-images",       label: "Export to Images",   icon: <IconImage className={ICON_CLS} /> },
  { id: "watermark",           label: "Watermark",          icon: <IconWatermark className={ICON_CLS} /> },
  { id: "flatten",             label: "Flatten PDF",        icon: <IconFlatten className={ICON_CLS} /> },
  { id: "anonymize",           label: "Anonymize",          icon: <IconUnlock className={ICON_CLS} /> },
  { id: "export-text",         label: "Export Text",        icon: <IconDocText className={ICON_CLS} /> },
  { id: "export-word",         label: "Export to Word",     icon: <IconDocWord className={ICON_CLS} /> },
  { id: "export-annotations",  label: "Export Annotations", icon: <IconList className={ICON_CLS} /> },
  { id: "form-data",           label: "Form Data (XFDF)",   icon: <IconForms className={ICON_CLS} /> },
  { id: "compare",             label: "Compare PDFs",       icon: <IconCompare className={ICON_CLS} /> },
];

const ALL_TOOLS = [...PAGE_TOOLS, ...FILE_TOOLS];

import { UI, MONO } from "../lib/tokens";

type SidebarTab = "tools" | "outline" | "comments";

export function ToolSidebar({ file, onApplied, activeTool, onToolChange, selectedPages, onSelectedPagesChange, splitAfter, onSplitAfterChange, onPageSelect, currentPage, forceCommentsTab, redactRegions, onClearRedactRegions, redactMode, onRedactModeChange }: ToolSidebarProps) {
  const setActiveTool = onToolChange;
  const [tab, setTab] = useState<SidebarTab>("tools");

  useEffect(() => {
    if (forceCommentsTab) setTab("comments");
  }, [forceCommentsTab]);

  // Close panel on Esc
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && activeTool) setActiveTool(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeTool]);

  const panels: Partial<Record<ViewerTool, React.ReactNode>> = {
    rotate: <RotatePanel file={file} onApplied={onApplied} />,
    remove: <RemovePanel file={file} onApplied={onApplied} selectedPages={selectedPages} onSelectedPagesChange={onSelectedPagesChange} />,
    reorder: <ReorderPanel file={file} onApplied={onApplied} />,
    split: <SplitPanel file={file} splitAfter={splitAfter} onSplitAfterChange={onSplitAfterChange} />,
    compress: <CompressPanel file={file} onApplied={onApplied} />,
    "page-numbers": <PageNumbersPanel file={file} onApplied={onApplied} />,
    protect: <ProtectPanel file={file} onApplied={onApplied} />,
    unlock: <UnlockPanel file={file} onApplied={onApplied} />,
    metadata: <MetadataPanel file={file} onApplied={onApplied} />,
    "export-images": <ExportImagesPanel file={file} />,
    watermark: <WatermarkPanel file={file} onApplied={onApplied} />,
    crop: <CropPanel file={file} onApplied={onApplied} />,
    flatten: <FlattenPanel file={file} onApplied={onApplied} />,
    anonymize: <AnonymizePanel file={file} onApplied={onApplied} />,
    "form-data": <FormDataPanel file={file} onApplied={onApplied} />,
    bates: <BatesPanel file={file} onApplied={onApplied} />,
    links: <LinksPanel file={file} onApplied={onApplied} currentPage={currentPage} />,
    "header-footer": <HeaderFooterPanel file={file} onApplied={onApplied} />,
    "export-text": <ExportTextPanel file={file} />,
    draw: <DrawPanel />,
    stamps: <StampsPanel filePath={file.path} currentPage={currentPage} onApplied={onApplied} />,
    "export-word": <ExportWordPanel file={file} />,
    redact: (
      <RedactPanel
        file={file}
        onApplied={onApplied}
        markedRegions={redactRegions ?? []}
        onClearRegions={onClearRedactRegions ?? (() => {})}
        currentPage={currentPage}
        mode={redactMode ?? "region"}
        onModeChange={onRedactModeChange ?? (() => {})}
      />
    ),
    "export-annotations": <ExportAnnotationsPanel file={file} />,
    compare: <ComparePanel file={file} />,
    // comment, annotate, forms, signature, redact have no sidebar panel — handled directly in Viewer
  };

  const isPhone = useIsPhone();

  return (
    <div
      style={{
        width: "100%", flexShrink: 0, height: "100%", display: "flex", flexDirection: "column",
        background: "var(--viewer-surface)", borderLeft: "1px solid var(--viewer-border)",
        overflow: "hidden",
        paddingTop: isPhone ? "env(safe-area-inset-top, 0px)" : undefined,
      }}
    >
      {/* Tab bar */}
      <div style={{ display: "flex", borderBottom: "1px solid var(--viewer-border-sub)", flexShrink: 0 }}>
        {(["tools", "outline", "comments"] as SidebarTab[]).map((t) => (
          <button
            key={t}
            onClick={() => {
              setTab(t);
              if (t === "comments") {
                if (activeTool !== "comment") setActiveTool(null);
              } else if (t !== "tools") {
                setActiveTool(null);
              }
            }}
            style={{
              flex: 1,
              padding: isPhone ? "14px 8px" : "10px 8px",
              minHeight: isPhone ? 48 : undefined,
              border: "none",
              background: "transparent",
              borderBottom: `2px solid ${tab === t ? "var(--accent)" : "transparent"}`,
              color: tab === t ? "var(--viewer-text)" : "var(--viewer-text-muted)",
              fontFamily: UI,
              fontSize: isPhone ? 14 : 11,
              fontWeight: 500,
              textTransform: "capitalize", cursor: "pointer", transition: "color 100ms",
              WebkitTapHighlightColor: "transparent",
            }}
          >{t}</button>
        ))}
        {isPhone && (
          <button
            onClick={() => {
              // Close sidebar on phone — find the showTools setter via Viewer's prop indirectly
              // by dispatching a custom event the Viewer can listen to. Simpler: call onToolChange(null)
              // then rely on header toggle to dismiss. We just clear activeTool here.
              onToolChange(null);
              window.dispatchEvent(new CustomEvent("viewer:closeTools"));
            }}
            aria-label="Close panel"
            style={{
              width: 48, minHeight: 48,
              border: "none", background: "transparent",
              color: "var(--viewer-text-muted)",
              cursor: "pointer",
              borderLeft: "1px solid var(--viewer-border-sub)",
              fontSize: 20, lineHeight: 1,
              WebkitTapHighlightColor: "transparent",
            }}
          >×</button>
        )}
      </div>

      {/* Tools tab */}
      {tab === "tools" && (
        activeTool && activeTool !== "comment" ? (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", flexShrink: 0, borderBottom: "1px solid var(--viewer-border)" }}>
              <button
                onClick={() => setActiveTool(null)}
                className="v-icon-btn"
                style={{ padding: 4, borderRadius: 4 }}
                title="Back to tools (Esc)"
              >
                <IconChevronLeft width={14} height={14} />
              </button>
              <span style={{ fontFamily: UI, fontSize: 12, fontWeight: 600, color: "var(--accent)" }}>
                {ALL_TOOLS.find((t) => t.id === activeTool)?.label}
              </span>
            </div>
            <div className="scroll-invisible" style={{ flex: 1, overflowY: "auto", padding: 12, paddingBottom: "max(12px, env(safe-area-inset-bottom, 0px))" }}>
              {panels[activeTool]}
            </div>
          </>
        ) : (
          <div className="scroll-invisible" style={{ flex: 1, overflowY: "auto", paddingBottom: "env(safe-area-inset-bottom, 0px)" }}>
            <ToolGroup label="Pages" tools={PAGE_TOOLS} onSelect={setActiveTool} />
            <ToolGroup label="File" tools={FILE_TOOLS} onSelect={setActiveTool} />
            <div style={{ borderTop: "1px solid var(--viewer-border-sub)" }}>
              <p style={{ padding: "12px 16px 6px", fontFamily: UI, fontSize: 10.5, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.6px", color: "var(--viewer-text-muted)" }}>
                Actions
              </p>
              <button
                onClick={() => triggerPrint(file.path)}
                className="v-row-btn"
                style={{ width: "100%", display: "flex", alignItems: "center", gap: 12, padding: "8px 16px", textAlign: "left" }}
              >
                <span className="v-row-icon" style={{ flexShrink: 0 }}>
                  <IconPrint width={16} height={16} />
                </span>
                <span style={{ flex: 1, fontFamily: UI, fontSize: 12 }}>Print</span>
                {!isPhone && (
                  <span style={{ fontFamily: MONO, fontSize: 10.5, color: "var(--viewer-text-muted)" }}>Ctrl+P</span>
                )}
              </button>
              <div style={{ paddingBottom: 4 }} />
            </div>
          </div>
        )
      )}

      {/* Outline tab */}
      {tab === "outline" && (
        <div className="scroll-invisible" style={{ flex: 1, overflowY: "auto", padding: "8px 0" }}>
          <OutlineContent filePath={file.path} onPageSelect={onPageSelect} onApplied={onApplied} />
        </div>
      )}

      {/* Comments tab */}
      {tab === "comments" && (
        <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
          <CommentPanel
            docPath={file.path}
            onPageSelect={onPageSelect}
            isCommentMode={activeTool === "comment"}
            onToggleMode={() => setActiveTool(activeTool === "comment" ? null : "comment")}
          />
        </div>
      )}
    </div>
  );
}

interface OutlineNode {
  title: string;
  page: number | null;
  items: OutlineNode[];
}

async function buildOutline(filePath: string): Promise<OutlineNode[]> {
  return invoke<OutlineNode[]>("get_outline", { path: filePath });
}

function OutlineContent({ filePath, onPageSelect, onApplied }: { filePath: string; onPageSelect: (page: number) => void; onApplied: (path: string) => void }) {
  const [nodes, setNodes] = useState<OutlineNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [autoDetecting, setAutoDetecting] = useState(false);
  const [isAuto, setIsAuto] = useState(false);
  const [editing, setEditing] = useState(false);
  const pathRef = useRef(filePath);

  useEffect(() => {
    pathRef.current = filePath;
    setLoading(true);
    setIsAuto(false);
    setEditing(false);
    buildOutline(filePath).then((result) => {
      if (pathRef.current === filePath) { setNodes(result); setLoading(false); }
    }).catch(() => { if (pathRef.current === filePath) setLoading(false); });
  }, [filePath]);

  async function runAutoDetect() {
    setAutoDetecting(true);
    try {
      const detected = await invoke<OutlineNode[]>("detect_outline", { path: filePath, maxPages: 500 });
      if (pathRef.current === filePath) {
        setNodes(detected);
        setIsAuto(true);
      }
    } catch {
      /* swallow — keep the existing outline */
    } finally {
      setAutoDetecting(false);
    }
  }

  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", paddingTop: 40 }}>
        <svg width={16} height={16} viewBox="0 0 16 16" fill="none" style={{ animation: "spin 0.8s linear infinite", color: "var(--accent)" }}>
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth={1.5} strokeOpacity={0.2} />
          <path d="M8 2a6 6 0 016 6" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
        </svg>
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      </div>
    );
  }

  if (editing) {
    return (
      <OutlineEditor
        filePath={filePath}
        initial={nodes}
        onCancel={() => setEditing(false)}
        onSaved={(newPath, savedNodes) => {
          setNodes(savedNodes);
          setEditing(false);
          onApplied(newPath);
        }}
      />
    );
  }

  const autoButton = (
    <button
      onClick={runAutoDetect}
      disabled={autoDetecting}
      style={{
        marginTop: 8,
        padding: "6px 10px",
        background: "var(--viewer-elevated)",
        color: "var(--viewer-text)",
        border: "1px solid var(--viewer-border)",
        borderRadius: 6,
        fontFamily: UI, fontSize: 11.5,
        cursor: autoDetecting ? "wait" : "pointer",
      }}
    >
      {autoDetecting ? "Detecting…" : isAuto ? "Re-detect from headings" : "Auto-detect from headings"}
    </button>
  );

  if (nodes.length === 0) {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, paddingTop: 40 }}>
        <svg width={28} height={28} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" style={{ color: "var(--viewer-text-muted)", opacity: 0.5 }}>
          <path d="M4 6h16M4 10h10M4 14h12M4 18h8" />
        </svg>
        <p style={{ fontFamily: UI, fontSize: 12, color: "var(--viewer-text-muted)", textAlign: "center", margin: 0 }}>
          No outline in this document
        </p>
        {autoButton}
        <button
          onClick={() => setEditing(true)}
          style={{
            padding: "6px 12px",
            background: "var(--viewer-elevated)",
            color: "var(--viewer-text)",
            border: "1px solid var(--viewer-border)",
            borderRadius: 6,
            fontFamily: UI, fontSize: 11.5,
            cursor: "pointer",
          }}
        >
          Create outline
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "0 12px 8px", display: "flex", justifyContent: "flex-end" }}>
        <button
          onClick={() => setEditing(true)}
          style={{
            padding: "4px 10px",
            background: "var(--viewer-elevated)",
            color: "var(--viewer-text)",
            border: "1px solid var(--viewer-border)",
            borderRadius: 6,
            fontFamily: UI, fontSize: 11,
            cursor: "pointer",
          }}
        >
          Edit outline
        </button>
      </div>
      {isAuto && (
        <div
          style={{
            padding: "6px 12px",
            fontSize: 10.5,
            color: "var(--viewer-text-muted)",
            fontFamily: UI,
            borderBottom: "1px solid var(--viewer-border-sub)",
          }}
        >
          Detected from font-size jumps · not saved to document
        </div>
      )}
      <OutlineTree nodes={nodes} onPageSelect={onPageSelect} depth={0} />
      <div style={{ padding: "0 12px 12px" }}>{autoButton}</div>
    </div>
  );
}

interface FlatItem { id: number; title: string; page: number | null; depth: number; }

function flatten(nodes: OutlineNode[], depth: number, counter: { n: number }): FlatItem[] {
  const out: FlatItem[] = [];
  for (const node of nodes) {
    out.push({ id: counter.n++, title: node.title, page: node.page, depth });
    out.push(...flatten(node.items, depth + 1, counter));
  }
  return out;
}

function unflatten(items: FlatItem[]): OutlineNode[] {
  const root: OutlineNode[] = [];
  const stack: { depth: number; node: OutlineNode | null; children: OutlineNode[] }[] = [
    { depth: -1, node: null, children: root },
  ];
  for (const item of items) {
    while (stack.length > 1 && stack[stack.length - 1]!.depth >= item.depth) stack.pop();
    const parentChildren = stack[stack.length - 1]!.children;
    const newNode: OutlineNode = { title: item.title, page: item.page, items: [] };
    parentChildren.push(newNode);
    stack.push({ depth: item.depth, node: newNode, children: newNode.items });
  }
  return root;
}

function OutlineEditor({
  filePath, initial, onCancel, onSaved,
}: {
  filePath: string;
  initial: OutlineNode[];
  onCancel: () => void;
  onSaved: (newPath: string, nodes: OutlineNode[]) => void;
}) {
  const counter = useRef({ n: 0 });
  const [items, setItems] = useState<FlatItem[]>(() => {
    counter.current.n = 0;
    return flatten(initial, 0, counter.current);
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function update(idx: number, patch: Partial<FlatItem>) {
    setItems((arr) => arr.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  }

  function move(idx: number, delta: number) {
    setItems((arr) => {
      const next = arr.slice();
      const target = idx + delta;
      if (target < 0 || target >= next.length) return arr;
      const a = next[idx]!;
      const b = next[target]!;
      next[idx] = b; next[target] = a;
      return next;
    });
  }

  function remove(idx: number) {
    setItems((arr) => arr.filter((_, i) => i !== idx));
  }

  function indent(idx: number, delta: number) {
    setItems((arr) => {
      const next = arr.slice();
      const item = next[idx]!;
      const newDepth = item.depth + delta;
      if (newDepth < 0) return arr;
      // Cap depth so children cannot leapfrog their parent.
      const prev = idx > 0 ? next[idx - 1]! : null;
      if (delta > 0 && (!prev || newDepth > prev.depth + 1)) return arr;
      next[idx] = { ...item, depth: newDepth };
      return next;
    });
  }

  function addAfter(idx: number, depth: number) {
    setItems((arr) => {
      const next = arr.slice();
      const id = counter.current.n++;
      const insertAt = idx + 1;
      next.splice(insertAt, 0, { id, title: "New bookmark", page: null, depth });
      return next;
    });
  }

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      const nodes = unflatten(items);
      const newPath = await invoke<string>("set_outline", {
        path: filePath,
        items: nodes,
      });
      onSaved(newPath, nodes);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ padding: "0 8px 8px", display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", gap: 6, padding: "4px 4px 8px" }}>
        <button
          onClick={save}
          disabled={saving}
          style={{
            padding: "5px 12px",
            background: "var(--accent)", color: "var(--accent-text)",
            border: "none", borderRadius: 6,
            fontFamily: UI, fontSize: 11.5, fontWeight: 600,
            cursor: saving ? "wait" : "pointer",
          }}
        >
          {saving ? "Saving…" : "Save outline"}
        </button>
        <button
          onClick={onCancel}
          disabled={saving}
          style={{
            padding: "5px 12px",
            background: "transparent", color: "var(--viewer-text)",
            border: "1px solid var(--viewer-border)", borderRadius: 6,
            fontFamily: UI, fontSize: 11.5,
            cursor: "pointer",
          }}
        >
          Cancel
        </button>
        <button
          onClick={() => addAfter(items.length - 1, 0)}
          disabled={saving}
          style={{
            marginLeft: "auto",
            padding: "5px 10px",
            background: "var(--viewer-elevated)", color: "var(--viewer-text)",
            border: "1px solid var(--viewer-border)", borderRadius: 6,
            fontFamily: UI, fontSize: 11.5,
            cursor: "pointer",
          }}
        >
          + Add
        </button>
      </div>

      {err && (
        <div style={{
          padding: "6px 10px",
          background: "var(--v-bad-bg)", border: "1px solid var(--v-bad-border)",
          borderRadius: 6, color: "var(--v-bad-text)", fontSize: 11.5,
        }}>{err}</div>
      )}

      {items.length === 0 ? (
        <div style={{ padding: "12px", fontSize: 12, color: "var(--viewer-text-muted)" }}>
          Outline is empty. Use + Add to insert a bookmark.
        </div>
      ) : items.map((item, idx) => (
        <div
          key={item.id}
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 56px auto",
            gap: 4,
            paddingLeft: 4 + item.depth * 14,
            alignItems: "center",
          }}
        >
          <input
            value={item.title}
            onChange={(e) => update(idx, { title: e.target.value })}
            placeholder="Title"
            style={{
              padding: "4px 6px",
              background: "var(--viewer-elevated)",
              color: "var(--viewer-text)",
              border: "1px solid var(--viewer-border)",
              borderRadius: 4,
              fontSize: 12,
            }}
          />
          <input
            type="number"
            min={1}
            value={item.page ?? ""}
            onChange={(e) => update(idx, { page: e.target.value === "" ? null : Math.max(1, parseInt(e.target.value) || 1) })}
            placeholder="Pg"
            style={{
              padding: "4px 6px",
              background: "var(--viewer-elevated)",
              color: "var(--viewer-text)",
              border: "1px solid var(--viewer-border)",
              borderRadius: 4,
              fontSize: 11,
              fontFamily: MONO,
              textAlign: "right",
            }}
          />
          <div style={{ display: "flex", gap: 2 }}>
            <IconBtn label="Outdent" onClick={() => indent(idx, -1)}>⇤</IconBtn>
            <IconBtn label="Indent" onClick={() => indent(idx, +1)}>⇥</IconBtn>
            <IconBtn label="Up" onClick={() => move(idx, -1)}>↑</IconBtn>
            <IconBtn label="Down" onClick={() => move(idx, +1)}>↓</IconBtn>
            <IconBtn label="Add below" onClick={() => addAfter(idx, item.depth)}>+</IconBtn>
            <IconBtn label="Delete" danger onClick={() => remove(idx)}>×</IconBtn>
          </div>
        </div>
      ))}
    </div>
  );
}

function IconBtn({ children, label, onClick, danger }: { children: React.ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      style={{
        width: 22, height: 22,
        background: "var(--viewer-elevated)",
        color: danger ? "var(--v-bad-text)" : "var(--viewer-text)",
        border: "1px solid var(--viewer-border)",
        borderRadius: 4,
        fontSize: 11, lineHeight: 1,
        cursor: "pointer",
        display: "inline-flex", alignItems: "center", justifyContent: "center",
      }}
    >{children}</button>
  );
}

function OutlineTree({ nodes, onPageSelect, depth }: { nodes: OutlineNode[]; onPageSelect: (page: number) => void; depth: number }) {
  return (
    <>
      {nodes.map((node, i) => (
        <OutlineRow key={i} node={node} onPageSelect={onPageSelect} depth={depth} />
      ))}
    </>
  );
}

function OutlineRow({ node, onPageSelect, depth }: { node: OutlineNode; onPageSelect: (page: number) => void; depth: number }) {
  const [open, setOpen] = useState(depth < 1);
  const hasChildren = node.items.length > 0;
  const [hover, setHover] = useState(false);

  return (
    <div>
      <div
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          display: "flex", alignItems: "center", gap: 4,
          padding: `4px 12px 4px ${12 + depth * 14}px`,
          background: hover ? "var(--viewer-elevated)" : "transparent",
          cursor: node.page != null ? "pointer" : "default",
          transition: "background 80ms",
        }}
        onClick={() => {
          if (hasChildren) setOpen((o) => !o);
          if (node.page != null) onPageSelect(node.page);
        }}
      >
        {hasChildren ? (
          <svg
            width={10} height={10} viewBox="0 0 10 10" fill="none"
            stroke="currentColor" strokeWidth={1.5} strokeLinecap="round"
            style={{ flexShrink: 0, color: "var(--viewer-text-muted)", transform: open ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 120ms" }}
          >
            <path d="M3 2l4 3-4 3" />
          </svg>
        ) : (
          <span style={{ width: 10, flexShrink: 0 }} />
        )}
        <span style={{
          fontFamily: UI, fontSize: 12, color: node.page != null ? "var(--viewer-text)" : "var(--viewer-text-muted)",
          flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          lineHeight: 1.4,
        }}>{node.title || "(untitled)"}</span>
        {node.page != null && (
          <span style={{ fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontSize: 10, color: "var(--viewer-text-muted)", flexShrink: 0 }}>
            {node.page}
          </span>
        )}
      </div>
      {hasChildren && open && (
        <OutlineTree nodes={node.items} onPageSelect={onPageSelect} depth={depth + 1} />
      )}
    </div>
  );
}


function ToolGroup({
  label,
  tools,
  onSelect,
  isLast = false,
}: {
  label: string;
  tools: ToolDef[];
  onSelect: (id: ViewerTool) => void;
  isLast?: boolean;
}) {
  return (
    <div style={!isLast ? { borderBottom: "1px solid var(--viewer-border-sub)" } : {}}>
      <p style={{ padding: "12px 16px 6px", fontFamily: UI, fontSize: 10.5, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.6px", color: "var(--viewer-text-muted)" }}>
        {label}
      </p>
      {tools.map((tool) => (
        <button
          key={tool.id}
          onClick={() => onSelect(tool.id)}
          className="v-row-btn"
          style={{ width: "100%", display: "flex", alignItems: "center", gap: 12, padding: "8px 16px", textAlign: "left" }}
        >
          <span className="v-row-icon" style={{ flexShrink: 0 }}>
            {tool.icon}
          </span>
          <span style={{ flex: 1, fontFamily: UI, fontSize: 12 }}>{tool.label}</span>
          <IconChevronRight width={12} height={12} className="v-row-chevron" style={{ flexShrink: 0 }} />
        </button>
      ))}
      <div style={{ paddingBottom: 4 }} />
    </div>
  );
}
