import { useEffect, useRef, useState, type CSSProperties } from "react";

import { LoadedFile } from "../store/useAppStore";
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
  IconPageNumbers, IconForms, IconCrop, IconRedact, IconCheckBadge,
  IconCompress, IconLock, IconUnlock, IconEdit, IconImage, IconWatermark,
  IconFlatten, IconDocText, IconDocWord, IconList, IconCompare,
  IconChevronLeft, IconChevronRight, IconPrint,
} from "./icons";
import { IcPlus, IcClose, IcArrowLeft } from "../components/Icons";
import { chipStyle, FAMILY, type Family } from "../lib/families";

export type ViewerTool =
  | "rotate" | "remove" | "reorder" | "split"
  | "compress" | "page-numbers" | "protect" | "unlock"
  | "metadata" | "export-images" | "draw" | "comment" | "watermark"
  | "forms" | "signature" | "crop" | "flatten" | "export-text" | "export-word" | "redact" | "stamps" | "export-annotations" | "compare" | "anonymize" | "form-data" | "bates" | "links" | "header-footer";

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

/** The sample book: every tool filed under its family, each family with its colour. */
const GROUPS: { family: Family; tools: ToolDef[] }[] = [
  { family: "annotate", tools: [
    { id: "comment", label: "Comments",        icon: <IconComment className={ICON_CLS} /> },
    { id: "draw",    label: "Draw & annotate", icon: <IconPencil className={ICON_CLS} /> },
    { id: "stamps",  label: "Stamps",          icon: <IconCheckBadge className={ICON_CLS} /> },
  ]},
  { family: "sign", tools: [
    { id: "signature", label: "Sign", icon: <IconPencil className={ICON_CLS} /> },
  ]},
  { family: "forms", tools: [
    { id: "forms",     label: "Fill forms",       icon: <IconForms className={ICON_CLS} /> },
    { id: "form-data", label: "Form data (XFDF)", icon: <IconForms className={ICON_CLS} /> },
  ]},
  { family: "pages", tools: [
    { id: "rotate",        label: "Rotate pages",    icon: <IconRotate className={ICON_CLS} /> },
    { id: "remove",        label: "Remove pages",    icon: <IconTrash className={ICON_CLS} /> },
    { id: "reorder",       label: "Reorder pages",   icon: <IconReorder className={ICON_CLS} /> },
    { id: "split",         label: "Split PDF",       icon: <IconSplit className={ICON_CLS} /> },
    { id: "crop",          label: "Crop pages",      icon: <IconCrop className={ICON_CLS} /> },
    { id: "page-numbers",  label: "Page numbers",    icon: <IconPageNumbers className={ICON_CLS} /> },
    { id: "bates",         label: "Bates numbering", icon: <IconPageNumbers className={ICON_CLS} /> },
    { id: "header-footer", label: "Header & footer", icon: <IconPageNumbers className={ICON_CLS} /> },
    { id: "watermark",     label: "Watermark",       icon: <IconWatermark className={ICON_CLS} /> },
    { id: "links",         label: "Links",           icon: <IconList className={ICON_CLS} /> },
    { id: "flatten",       label: "Flatten",         icon: <IconFlatten className={ICON_CLS} /> },
  ]},
  { family: "redact", tools: [
    { id: "redact",    label: "Redact",    icon: <IconRedact className={ICON_CLS} /> },
    { id: "anonymize", label: "Anonymize", icon: <IconUnlock className={ICON_CLS} /> },
  ]},
  { family: "compress", tools: [
    { id: "compress", label: "Compress",         icon: <IconCompress className={ICON_CLS} /> },
    { id: "protect",  label: "Password protect", icon: <IconLock className={ICON_CLS} /> },
    { id: "unlock",   label: "Unlock",           icon: <IconUnlock className={ICON_CLS} /> },
    { id: "metadata", label: "Edit metadata",    icon: <IconEdit className={ICON_CLS} /> },
  ]},
  { family: "export", tools: [
    { id: "export-images",      label: "Export images",      icon: <IconImage className={ICON_CLS} /> },
    { id: "export-text",        label: "Export text",        icon: <IconDocText className={ICON_CLS} /> },
    { id: "export-word",        label: "Export to Word",     icon: <IconDocWord className={ICON_CLS} /> },
    { id: "export-annotations", label: "Export annotations", icon: <IconList className={ICON_CLS} /> },
    { id: "compare",            label: "Compare PDFs",       icon: <IconCompare className={ICON_CLS} /> },
  ]},
];

const ALL_TOOLS = GROUPS.flatMap((g) => g.tools);
const FAMILY_OF: Partial<Record<ViewerTool, Family>> = Object.fromEntries(
  GROUPS.flatMap((g) => g.tools.map((t) => [t.id, g.family])),
);

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
    // comment, forms, signature have no sidebar panel — handled directly in Viewer
  };

  const activeDef = activeTool ? ALL_TOOLS.find((t) => t.id === activeTool) : undefined;
  const activeFamily = activeTool ? FAMILY_OF[activeTool] : undefined;

  return (
    <div className="vside">
      <div className="panel-head vside-head">
        <div className="seg seg-full" role="tablist" aria-label="Sidebar">
          {(["tools", "outline", "comments"] as SidebarTab[]).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              aria-pressed={tab === t}
              className="seg-item"
              onClick={() => {
                setTab(t);
                if (t === "comments") {
                  if (activeTool !== "comment") setActiveTool(null);
                } else if (t !== "tools") {
                  setActiveTool(null);
                }
              }}
            >
              {t === "tools" ? "Tools" : t === "outline" ? "Outline" : "Comments"}
            </button>
          ))}
        </div>
      </div>

      {tab === "tools" && (
        activeTool && activeTool !== "comment" ? (
          <div className="vside-panel" style={activeFamily ? (chipStyle(activeFamily) as CSSProperties) : undefined}>
            <div className="vside-panel-head">
              <button onClick={() => setActiveTool(null)} className="btn-icon" title="Back to all tools (Esc)" aria-label="Back to all tools">
                <IcArrowLeft size={16} />
              </button>
              <span className="vside-panel-title">{activeDef?.label}</span>
              {activeFamily && <span className="chip">{FAMILY[activeFamily].label}</span>}
            </div>
            <div className="vside-scroll vside-panel-body">
              {panels[activeTool]}
            </div>
          </div>
        ) : (
          <div className="vside-scroll">
            {GROUPS.map((g) => (
              <section key={g.family} className="vside-group" style={chipStyle(g.family) as CSSProperties} aria-label={FAMILY[g.family].label}>
                <div className="vside-group-head">
                  <span className="chip">{FAMILY[g.family].label}</span>
                  <span className="t-meta">{g.tools.length} {g.tools.length === 1 ? "tool" : "tools"}</span>
                  <span className="thumb-tab" aria-hidden="true" />
                </div>
                {g.tools.map((tool) => (
                  <button key={tool.id} type="button" onClick={() => setActiveTool(tool.id)} className="row vside-row">
                    <span className="vside-row-icon">{tool.icon}</span>
                    <span style={{ flex: 1 }}>{tool.label}</span>
                    <IconChevronRight width={12} height={12} className="vside-row-chev" />
                  </button>
                ))}
                {g.family === "export" && (
                  <button type="button" onClick={() => triggerPrint(file.path)} className="row vside-row">
                    <span className="vside-row-icon"><IconPrint width={16} height={16} /></span>
                    <span style={{ flex: 1 }}>Print</span>
                    <kbd className="kbd">Ctrl+P</kbd>
                  </button>
                )}
              </section>
            ))}
          </div>
        )
      )}

      {tab === "outline" && (
        <div className="vside-scroll" style={{ padding: "var(--space-2) 0" }}>
          <OutlineContent filePath={file.path} onPageSelect={onPageSelect} onApplied={onApplied} />
        </div>
      )}

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

function Spinner() {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" style={{ animation: "spin 0.8s linear infinite", color: "var(--rose)" }} aria-hidden="true">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth={1.5} strokeOpacity={0.2} />
      <path d="M8 2a6 6 0 016 6" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
    </svg>
  );
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
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", paddingTop: 40 }} aria-busy="true" aria-label="Loading outline">
        <Spinner />
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
    <button type="button" onClick={runAutoDetect} disabled={autoDetecting} className="btn-secondary btn-sm">
      {autoDetecting ? "Detecting…" : isAuto ? "Detect again from headings" : "Detect from headings"}
    </button>
  );

  if (nodes.length === 0) {
    return (
      <div className="empty" style={{ margin: "var(--space-3)" }}>
        <IconList className="w-6 h-6" style={{ color: "var(--fg3)" }} />
        <strong>No outline in this document</strong>
        <span>Qyra can guess one from the headings, or you can write your own.</span>
        <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
          {autoButton}
          <button type="button" onClick={() => setEditing(true)} className="btn-secondary btn-sm">
            Create outline
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "0 var(--space-3) var(--space-2)", display: "flex", justifyContent: "flex-end" }}>
        <button type="button" onClick={() => setEditing(true)} className="btn-secondary btn-sm">
          Edit outline
        </button>
      </div>
      {isAuto && (
        <div className="t-meta" style={{ padding: "var(--space-2) var(--space-4)", borderBottom: "1px solid var(--line2)" }}>
          Guessed from heading sizes. Not saved to the document.
        </div>
      )}
      <OutlineTree nodes={nodes} onPageSelect={onPageSelect} depth={0} />
      <div style={{ padding: "var(--space-3)" }}>{autoButton}</div>
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
    <div style={{ padding: "0 var(--space-2) var(--space-2)", display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
      <div style={{ display: "flex", gap: "var(--space-2)", padding: "var(--space-1) var(--space-1) var(--space-2)" }}>
        <button type="button" onClick={save} disabled={saving} className="btn-primary btn-sm">
          {saving ? "Saving…" : "Save outline"}
        </button>
        <button type="button" onClick={onCancel} disabled={saving} className="btn-ghost btn-sm">
          Cancel
        </button>
        <button type="button" onClick={() => addAfter(items.length - 1, 0)} disabled={saving} className="btn-secondary btn-sm" style={{ marginLeft: "auto" }}>
          <IcPlus size={14} /> Add
        </button>
      </div>

      {err && <div className="alert" role="alert">{err}</div>}

      {items.length === 0 ? (
        <div className="t-meta" style={{ padding: "var(--space-3)" }}>
          The outline is empty. Add a bookmark to start.
        </div>
      ) : items.map((item, idx) => (
        <div
          key={item.id}
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 52px auto",
            gap: 4,
            paddingLeft: 4 + item.depth * 14,
            alignItems: "center",
          }}
        >
          <input
            value={item.title}
            onChange={(e) => update(idx, { title: e.target.value })}
            placeholder="Title"
            aria-label="Bookmark title"
            className="input"
            style={{ height: 28, padding: "0 var(--space-2)" }}
          />
          <input
            type="number"
            min={1}
            value={item.page ?? ""}
            onChange={(e) => update(idx, { page: e.target.value === "" ? null : Math.max(1, parseInt(e.target.value) || 1) })}
            placeholder="Pg"
            aria-label="Page"
            className="input t-num"
            style={{ height: 28, padding: "0 var(--space-1)", textAlign: "right" }}
          />
          <div style={{ display: "flex", gap: 2 }}>
            <IconBtn label="Outdent" onClick={() => indent(idx, -1)}><IconChevronLeft width={12} height={12} /></IconBtn>
            <IconBtn label="Indent" onClick={() => indent(idx, +1)}><IconChevronRight width={12} height={12} /></IconBtn>
            <IconBtn label="Move up" onClick={() => move(idx, -1)}>
              <svg width={12} height={12} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"><path d="M8 13V3M4 7l4-4 4 4" /></svg>
            </IconBtn>
            <IconBtn label="Move down" onClick={() => move(idx, +1)}>
              <svg width={12} height={12} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"><path d="M8 3v10M4 9l4 4 4-4" /></svg>
            </IconBtn>
            <IconBtn label="Add below" onClick={() => addAfter(idx, item.depth)}><IcPlus size={12} /></IconBtn>
            <IconBtn label="Delete" danger onClick={() => remove(idx)}><IcClose size={12} /></IconBtn>
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
      className="btn-icon"
      style={{ width: 24, height: 24, color: danger ? "var(--bad)" : undefined }}
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

  return (
    <div>
      <div
        className="outline-row"
        role="button"
        tabIndex={0}
        style={{ paddingLeft: 12 + depth * 14, cursor: node.page != null ? "pointer" : "default" }}
        onClick={() => {
          if (hasChildren) setOpen((o) => !o);
          if (node.page != null) onPageSelect(node.page);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (hasChildren) setOpen((o) => !o);
            if (node.page != null) onPageSelect(node.page);
          }
        }}
      >
        {hasChildren ? (
          <svg
            width={10} height={10} viewBox="0 0 10 10" fill="none"
            stroke="currentColor" strokeWidth={1.5} strokeLinecap="round"
            style={{ flexShrink: 0, color: "var(--fg2)", transform: open ? "rotate(90deg)" : "rotate(0deg)", transition: "transform var(--dur-1)" }}
            aria-hidden="true"
          >
            <path d="M3 2l4 3-4 3" />
          </svg>
        ) : (
          <span style={{ width: 10, flexShrink: 0 }} />
        )}
        <span className="outline-title" style={{ color: node.page != null ? "var(--fg0)" : "var(--fg2)" }}>
          {node.title || "(untitled)"}
        </span>
        {node.page != null && <span className="t-meta">{node.page}</span>}
      </div>
      {hasChildren && open && (
        <OutlineTree nodes={node.items} onPageSelect={onPageSelect} depth={depth + 1} />
      )}
    </div>
  );
}
