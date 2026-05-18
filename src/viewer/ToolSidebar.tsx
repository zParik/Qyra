import { useEffect, useRef, useState } from "react";

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
import { ExportTextPanel } from "./tools/ExportTextPanel";
import { invoke } from "@tauri-apps/api/core";

export type ViewerTool =
  | "rotate" | "remove" | "reorder" | "split"
  | "compress" | "page-numbers" | "protect" | "unlock"
  | "metadata" | "export-images" | "draw" | "comment" | "watermark"
  | "annotate" | "forms" | "signature" | "crop" | "flatten" | "export-text" | "redact";

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
  /** Switch sidebar to comments tab externally (e.g. when comment pill is clicked) */
  forceCommentsTab?: boolean;
}

interface ToolDef { id: ViewerTool; label: string; icon: React.ReactNode }

const PAGE_TOOLS: ToolDef[] = [
  {
    id: "comment",
    label: "Comments",
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
      </svg>
    ),
  },
  {
    id: "draw",
    label: "Draw & Annotate",
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
      </svg>
    ),
  },
  {
    id: "rotate",
    label: "Rotate Pages",
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
      </svg>
    ),
  },
  {
    id: "remove",
    label: "Remove Pages",
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
      </svg>
    ),
  },
  {
    id: "reorder",
    label: "Reorder Pages",
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
      </svg>
    ),
  },
  {
    id: "split",
    label: "Split PDF",
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
      </svg>
    ),
  },
  {
    id: "page-numbers",
    label: "Page Numbers",
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M7 20l4-16m2 16l4-16M6 9h14M4 15h14" />
      </svg>
    ),
  },
  {
    id: "annotate",
    label: "Annotate",
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
      </svg>
    ),
  },
  {
    id: "forms",
    label: "Fill Forms",
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
      </svg>
    ),
  },
  {
    id: "signature",
    label: "Sign",
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
      </svg>
    ),
  },
  {
    id: "crop",
    label: "Crop Pages",
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
      </svg>
    ),
  },
  {
    id: "redact",
    label: "Redact",
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
      </svg>
    ),
  },
];

const FILE_TOOLS: ToolDef[] = [
  {
    id: "compress",
    label: "Compress",
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 13l-7 7-7-7m14-8l-7 7-7-7" />
      </svg>
    ),
  },
  {
    id: "protect",
    label: "Password Protect",
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
      </svg>
    ),
  },
  {
    id: "unlock",
    label: "Unlock PDF",
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" />
      </svg>
    ),
  },
  {
    id: "metadata",
    label: "Edit Metadata",
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
      </svg>
    ),
  },
  {
    id: "export-images",
    label: "Export to Images",
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
      </svg>
    ),
  },
  {
    id: "watermark",
    label: "Watermark",
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01" />
      </svg>
    ),
  },
  {
    id: "flatten",
    label: "Flatten PDF",
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 13l-7 7-7-7m14-8l-7 7-7-7" />
      </svg>
    ),
  },
  {
    id: "export-text",
    label: "Export Text",
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
      </svg>
    ),
  },
];

const ALL_TOOLS = [...PAGE_TOOLS, ...FILE_TOOLS];

import { UI, MONO } from "../lib/tokens";

type SidebarTab = "tools" | "outline" | "comments";

export function ToolSidebar({ file, onApplied, activeTool, onToolChange, selectedPages, onSelectedPagesChange, splitAfter, onSplitAfterChange, onPageSelect, forceCommentsTab }: ToolSidebarProps) {
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
    "export-text": <ExportTextPanel file={file} />,
    draw: <DrawPanel />,
    // comment, annotate, forms, signature, redact have no sidebar panel — handled directly in Viewer
  };

  return (
    <div
      style={{
        width: "100%", flexShrink: 0, height: "100%", display: "flex", flexDirection: "column",
        background: "var(--viewer-surface)", borderLeft: "1px solid var(--viewer-border)",
        overflow: "hidden",
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
                // If switching to comments, don't clear activeTool if it's already "comment"
                if (activeTool !== "comment") setActiveTool(null);
              } else if (t !== "tools") {
                setActiveTool(null);
              }
            }}
            style={{
              flex: 1, padding: "10px 8px", border: "none",
              background: "transparent",
              borderBottom: `2px solid ${tab === t ? "var(--accent)" : "transparent"}`,
              color: tab === t ? "var(--viewer-text)" : "var(--viewer-text-muted)",
              fontFamily: UI, fontSize: 11, fontWeight: 500,
              textTransform: "capitalize", cursor: "pointer", transition: "color 100ms",
            }}
          >{t}</button>
        ))}
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
                <svg width={14} height={14} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
              </button>
              <span style={{ fontFamily: UI, fontSize: 12, fontWeight: 600, color: "var(--accent)" }}>
                {ALL_TOOLS.find((t) => t.id === activeTool)?.label}
              </span>
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: 12, paddingBottom: "max(12px, env(safe-area-inset-bottom, 0px))" }}>
              {panels[activeTool]}
            </div>
          </>
        ) : (
          <div style={{ flex: 1, overflowY: "auto", paddingBottom: "env(safe-area-inset-bottom, 0px)" }}>
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
                  <svg width={16} height={16} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
                  </svg>
                </span>
                <span style={{ flex: 1, fontFamily: UI, fontSize: 12 }}>Print</span>
                <span style={{ fontFamily: MONO, fontSize: 10.5, color: "var(--viewer-text-muted)" }}>Ctrl+P</span>
              </button>
              <div style={{ paddingBottom: 4 }} />
            </div>
          </div>
        )
      )}

      {/* Outline tab */}
      {tab === "outline" && (
        <div style={{ flex: 1, overflowY: "auto", padding: "8px 0" }}>
          <OutlineContent filePath={file.path} onPageSelect={onPageSelect} />
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

function OutlineContent({ filePath, onPageSelect }: { filePath: string; onPageSelect: (page: number) => void }) {
  const [nodes, setNodes] = useState<OutlineNode[]>([]);
  const [loading, setLoading] = useState(true);
  const pathRef = useRef(filePath);

  useEffect(() => {
    pathRef.current = filePath;
    setLoading(true);
    buildOutline(filePath).then((result) => {
      if (pathRef.current === filePath) { setNodes(result); setLoading(false); }
    }).catch(() => { if (pathRef.current === filePath) setLoading(false); });
  }, [filePath]);

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

  if (nodes.length === 0) {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, paddingTop: 40 }}>
        <svg width={28} height={28} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" style={{ color: "var(--viewer-text-muted)", opacity: 0.5 }}>
          <path d="M4 6h16M4 10h10M4 14h12M4 18h8" />
        </svg>
        <p style={{ fontFamily: UI, fontSize: 12, color: "var(--viewer-text-muted)", textAlign: "center", margin: 0 }}>
          No outline in this document
        </p>
      </div>
    );
  }

  return <OutlineTree nodes={nodes} onPageSelect={onPageSelect} depth={0} />;
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
          <svg width={12} height={12} fill="none" stroke="currentColor" viewBox="0 0 24 24" className="v-row-chevron" style={{ flexShrink: 0 }}>
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
      ))}
      <div style={{ paddingBottom: 4 }} />
    </div>
  );
}
