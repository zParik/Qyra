import { UI, MONO } from "../../lib/tokens";
import { IconProps, IcHome, IcRecent, IcStar, IcFolder, IcArchive, IcMerge, IcImage } from "../../components/Icons";
import type { DiskSpace } from "../../lib/schemas";
import { Section, formatBytes } from "./types";

function RailItem({ label, Icon, badge, active, onClick }: {
  id?: string; label: string; Icon: (p: IconProps) => React.ReactElement;
  badge?: string; active: boolean; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className="home-rail-item"
      style={{ fontFamily: UI }}
    >
      <span className="rail-icon"><Icon /></span>
      <span className="flex-1">{label}</span>
      {badge && <span className="home-rail-badge" style={{ fontFamily: MONO }}>{badge}</span>}
    </button>
  );
}

export function LeftRail({ active, onPick, recentCount, storageUsage }: {
  active: Section;
  onPick: (id: string) => void;
  recentCount: number;
  storageUsage: DiskSpace | null;
}) {
  const navItems = [
    { id: "home",    label: "Home",        Icon: IcHome },
    { id: "recent",  label: "Recents",     Icon: IcRecent, badge: recentCount > 0 ? String(recentCount) : undefined },
    { id: "starred", label: "Starred",     Icon: IcStar },
    { id: "local",   label: "Local files", Icon: IcFolder },
    { id: "archive", label: "Archive",     Icon: IcArchive },
  ];
  const toolItems = [
    { id: "merge",  label: "Merge",         Icon: IcMerge },
    { id: "i2pdf",  label: "Images to PDF", Icon: IcImage },
  ];

  return (
    <aside className="home-rail">
      <div className="px-3 pt-3 pb-1">
        <div className="home-rail-label" style={{ fontFamily: UI }}>Library</div>
        <div className="flex flex-col gap-px">
          {navItems.map(({ id, label, Icon, badge }) => (
            <RailItem key={id} id={id} label={label} Icon={Icon} badge={badge}
              active={active === id} onClick={() => onPick(id)} />
          ))}
        </div>
      </div>

      <div className="h-px mx-3 my-1" style={{ background: "var(--line2)" }} />

      <div className="px-3 py-1">
        <div className="home-rail-label" style={{ fontFamily: UI }}>Tools</div>
        <div className="flex flex-col gap-px">
          {toolItems.map(({ id, label, Icon }) => (
            <RailItem key={id} id={id} label={label} Icon={Icon} active={false} onClick={() => onPick(id)} />
          ))}
        </div>
      </div>

      <div className="flex-1" />

      <div className="m-3 p-3 rounded-md" style={{ border: "1px solid var(--line)", background: "var(--bg2)", fontFamily: UI }}>
        <div className="flex items-center gap-1.5 mb-1.5">
          <span className="w-1.5 h-1.5 rounded-full inline-block" style={{ background: "var(--accent)" }} />
          <span className="text-[10.5px] font-semibold uppercase tracking-[0.5px]" style={{ color: "var(--fg0)" }}>Storage</span>
        </div>
        <div className="h-1 rounded-sm overflow-hidden mb-1.5" style={{ background: "var(--bg3)" }}>
          <div style={{
            width: storageUsage ? `${Math.min(100, (storageUsage.used / storageUsage.total) * 100).toFixed(1)}%` : "0%",
            height: "100%", background: "var(--accent)", borderRadius: 2,
            transition: "width 400ms ease",
          }} />
        </div>
        <div className="flex justify-between text-[10.5px]" style={{ fontFamily: MONO, color: "var(--fg1)" }}>
          {storageUsage ? (
            <>
              <span>{formatBytes(storageUsage.used)} used</span>
              <span style={{ color: "var(--fg2)" }}>{formatBytes(storageUsage.total)}</span>
            </>
          ) : (
            <>
              <span>Local only</span>
              <span style={{ color: "var(--fg2)" }}>offline</span>
            </>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 px-3.5 py-2.5" style={{ borderTop: "1px solid var(--line2)" }}>
        <img src="/Logo.png" alt="Qyra" className="w-8 h-8 rounded-full object-contain" />
        <div className="flex flex-col min-w-0">
          <span className="text-[11.5px] font-medium leading-tight" style={{ color: "var(--fg0)", fontFamily: UI }}>Qyra</span>
          <span className="text-[10px] leading-tight" style={{ color: "var(--fg2)", fontFamily: MONO }}>free · offline · open source</span>
        </div>
      </div>
    </aside>
  );
}
