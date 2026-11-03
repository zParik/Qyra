import { useState, type ReactElement } from "react";
import { useNavigate } from "react-router-dom";
import { isAndroid } from "../lib/androidFileUtils";
import { IcArrowLeft, IcSun, IcFolder, IcRecent, IcConvert, IcInfo, type IconProps } from "../components/Icons";
import { AppearanceSection } from "./settings/AppearanceSection";
import { FilesSection } from "./settings/FilesSection";
import { SessionSection } from "./settings/SessionSection";
import { UpdatesSection } from "./settings/UpdatesSection";
import { AboutSection } from "./settings/AboutSection";

type SectionId = "appearance" | "files" | "session" | "updates" | "about";

interface SectionDef {
  id: SectionId;
  label: string;
  Icon: (p: IconProps) => ReactElement;
  render: () => React.ReactNode;
}

export default function Settings() {
  const navigate = useNavigate();
  const [active, setActive] = useState<SectionId>("appearance");

  const sections: SectionDef[] = [
    { id: "appearance", label: "Appearance", Icon: IcSun,     render: () => <AppearanceSection /> },
    { id: "files",      label: "Files",      Icon: IcFolder,  render: () => <FilesSection /> },
    { id: "session",    label: "Session",    Icon: IcRecent,  render: () => <SessionSection /> },
    ...(isAndroid()
      ? []
      : [{ id: "updates" as const, label: "Updates", Icon: IcConvert, render: () => <UpdatesSection /> }]),
    { id: "about",      label: "About",      Icon: IcInfo,    render: () => <AboutSection /> },
  ];

  const current = sections.find((s) => s.id === active) ?? sections[0]!;

  return (
    <div className="tool-shell">
      <header className="panel-head tool-head">
        <button type="button" className="btn-ghost" onClick={() => navigate(-1)} title="Back">
          <IcArrowLeft size={16} />
          Back
        </button>
        <h1 className="t-title" style={{ margin: 0, flex: 1 }}>Settings</h1>
      </header>

      <div className="settings">
        <aside className="rail settings-nav" aria-label="Settings sections">
          <div className="rail-section">
            <div className="t-label rail-label">Settings</div>
            {sections.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setActive(s.id)}
                aria-current={active === s.id ? "page" : undefined}
                className="rail-item"
              >
                <span className="rail-icon"><s.Icon /></span>
                <span className="rail-text">{s.label}</span>
              </button>
            ))}
          </div>
        </aside>
        <main className="settings-main">
          <div className="settings-column">{current.render()}</div>
        </main>
      </div>
    </div>
  );
}
