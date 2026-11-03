import type { CSSProperties, ReactElement } from "react";
import { useNavigate } from "react-router-dom";
import { IcHome, IcRecent, IcStar, IcArchive, IcFolder, IcGear, type IconProps } from "../../components/Icons";
import { ThemeToggle } from "../../components/ThemeToggle";
import { chipStyle, type Family } from "../../lib/families";
import { STANDALONE_TOOLS } from "./tools";
import type { Section } from "./types";

function RailItem({ label, Icon, count, active, onClick, family }: {
  label: string;
  Icon: (p: IconProps) => ReactElement;
  count?: number;
  active?: boolean;
  onClick: () => void;
  family?: Family;
}) {
  return (
    <button type="button" onClick={onClick} aria-current={active ? "page" : undefined} className="rail-item">
      <span className="rail-icon"><Icon /></span>
      <span className="rail-text">{label}</span>
      {typeof count === "number" && count > 0 && <span className="rail-count">{count}</span>}
      {family && <span className="thumb-tab" style={chipStyle(family) as CSSProperties} aria-hidden="true" />}
    </button>
  );
}

/**
 * The sample book: the library on top, the tool families below, each tool
 * carrying its family colour on the outer edge like a thumb index.
 */
export function LeftRail({ active, onPick, recentCount, starredCount, archivedCount }: {
  active: Section;
  onPick: (id: string) => void;
  recentCount: number;
  starredCount: number;
  archivedCount: number;
}) {
  const navigate = useNavigate();
  return (
    <aside className="rail" aria-label="Library and tools">
      <div className="rail-section">
        <div className="t-label rail-label">Library</div>
        <RailItem label="Home" Icon={IcHome} active={active === "home"} onClick={() => onPick("home")} />
        <RailItem label="Recents" Icon={IcRecent} count={recentCount} active={active === "recent"} onClick={() => onPick("recent")} />
        <RailItem label="Starred" Icon={IcStar} count={starredCount} active={active === "starred"} onClick={() => onPick("starred")} />
        <RailItem label="Archive" Icon={IcArchive} count={archivedCount} active={active === "archive"} onClick={() => onPick("archive")} />
        <RailItem label="Browse files…" Icon={IcFolder} onClick={() => onPick("local")} />
      </div>

      <div className="rail-section">
        <div className="t-label rail-label">Tools</div>
        {STANDALONE_TOOLS.map((t) => (
          <RailItem key={t.id} label={t.title} Icon={t.Icon} family={t.family} onClick={() => navigate(t.route)} />
        ))}
      </div>

      <div className="rail-foot">
        <ThemeToggle variant="rail" />
        <RailItem label="Settings" Icon={IcGear} onClick={() => navigate("/settings")} />
        <div className="rail-sign">Qyra · free · offline · open source</div>
      </div>
    </aside>
  );
}
