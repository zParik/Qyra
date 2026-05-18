import { useNotesStore, PageTemplate, VirtualPage } from "../../store/useNotesStore";
import { useAppStore } from "../../store/useAppStore";

const EMPTY_VIRTUAL_PAGES: VirtualPage[] = [];

const TEMPLATES: { id: PageTemplate; label: string; preview: string }[] = [
  { id: 'blank',  label: 'Blank',  preview: '□' },
  { id: 'ruled',  label: 'Ruled',  preview: '≡' },
  { id: 'grid',   label: 'Grid',   preview: '⊞' },
  { id: 'dotted', label: 'Dotted', preview: '⠿' },
];

export function DrawPanel() {
  const viewerFile = useAppStore((s) => s.viewerFile);
  const docPath = viewerFile?.path ?? "";

  const virtualPages   = useNotesStore((s) => s.virtualPages[docPath] ?? EMPTY_VIRTUAL_PAGES);
  const addVirtualPage = useNotesStore((s) => s.addVirtualPage);
  const removeVirtualPage = useNotesStore((s) => s.removeVirtualPage);

  function handleAddPage(template: PageTemplate) {
    const vp: VirtualPage = {
      id: crypto.randomUUID(),
      template,
      afterRealPage: 9999,
    };
    addVirtualPage(docPath, vp);
  }

  return (
    <div className="flex flex-col gap-5 text-sm" style={{ color: "var(--viewer-text)" }}>

      {/* ── Add Page ── */}
      <div className="flex flex-col gap-2">
        <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--viewer-text-muted)" }}>
          Add Note Page
        </span>
        <p className="text-xs" style={{ color: "var(--viewer-text-muted)" }}>
          Appends a blank writing page at the end. Use the <strong>+</strong> buttons between pages to insert at a specific position.
        </p>
        <div className="grid grid-cols-2 gap-1.5">
          {TEMPLATES.map((tmpl) => (
            <button
              key={tmpl.id}
              onClick={() => handleAddPage(tmpl.id)}
              className="flex items-center gap-2 px-2 py-2 rounded-lg text-xs transition-colors"
              style={{
                background: "var(--viewer-elevated)",
                border: "1px solid var(--viewer-border)",
                color: "var(--viewer-text-sec)",
              }}
            >
              <span className="text-base leading-none">{tmpl.preview}</span>
              <span>{tmpl.label}</span>
            </button>
          ))}
        </div>

        {/* List of inserted virtual pages */}
        {virtualPages.length > 0 && (
          <div className="flex flex-col gap-1 mt-1">
            <span className="text-xs" style={{ color: "var(--viewer-text-muted)" }}>
              Inserted pages ({virtualPages.length})
            </span>
            {virtualPages.map((vp) => (
              <div
                key={vp.id}
                className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs"
                style={{ background: "var(--viewer-elevated)", border: "1px solid var(--viewer-border-sub)" }}
              >
                <span className="flex-1 capitalize" style={{ color: "var(--viewer-text-sec)" }}>
                  {vp.template} page
                  {vp.afterRealPage === 0 ? ' (before start)' :
                   vp.afterRealPage >= 9999 ? ' (after end)' :
                   ` (after p.${vp.afterRealPage})`}
                </span>
                <button
                  onClick={() => removeVirtualPage(docPath, vp.id)}
                  className="shrink-0"
                  title="Remove this page"
                  style={{ color: "#ef4444" }}
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <p className="text-xs" style={{ color: "var(--viewer-text-muted)" }}>
        Use <strong>Save</strong> in the toolbar to bake annotations and note pages into the PDF.
      </p>
    </div>
  );
}
