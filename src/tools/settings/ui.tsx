export function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-base font-semibold mb-4" style={{ color: "var(--fg0)" }}>
      {children}
    </h2>
  );
}

export function SettingRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="flex items-center justify-between gap-4 py-3"
      style={{ borderBottom: "1px solid var(--line2)" }}
    >
      <div className="min-w-0">
        <div className="text-sm" style={{ color: "var(--fg0)" }}>{label}</div>
        {description && (
          <div className="text-xs mt-0.5" style={{ color: "var(--fg2)" }}>{description}</div>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <input
      type="checkbox"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      className="w-4 h-4"
    />
  );
}
