import { UI } from "../../lib/tokens";
import { IcHome, IcRecent, IcStar, IcArchive, IcUpload } from "../../components/Icons";
import { Section } from "./types";

export function BottomTabBar({ active, onPick, onOpenFile }: {
  active: Section;
  onPick: (id: string) => void;
  onOpenFile: () => void;
}) {
  const tabs = [
    { id: "home",    label: "Home",    Icon: IcHome },
    { id: "recent",  label: "Recents", Icon: IcRecent },
    { id: "starred", label: "Starred", Icon: IcStar },
    { id: "archive", label: "Archive", Icon: IcArchive },
  ];
  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 flex items-stretch"
      style={{ background: "var(--bg1)", borderTop: "1px solid var(--line)", paddingBottom: "env(safe-area-inset-bottom, 0px)" }}>
      {tabs.map(({ id, label, Icon }) => (
        <button
          key={id}
          onClick={() => onPick(id)}
          aria-current={active === id ? "page" : undefined}
          className="home-tab-btn"
          style={{ fontFamily: UI }}
        >
          <Icon size={20} />
          <span>{label}</span>
        </button>
      ))}
      <button onClick={onOpenFile} aria-label="Open PDF" className="home-tab-btn" style={{ fontFamily: UI }}>
        <span className="flex items-center justify-center w-9 h-9 rounded-full -mb-0.5"
          style={{ background: "var(--accent)", color: "var(--accent-text)", boxShadow: "0 2px 8px rgba(0,0,0,0.25)" }}>
          <IcUpload size={18} />
        </span>
        <span>Open</span>
      </button>
    </nav>
  );
}
