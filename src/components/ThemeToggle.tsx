import { clsx } from "clsx";
import { useTheme, ThemeChoice } from "../lib/useTheme";
import { IcSun, IcMoon, IcMonitor } from "./Icons";

const CHOICES: { value: ThemeChoice; label: string; Icon: typeof IcSun }[] = [
  { value: "light", label: "Light", Icon: IcSun },
  { value: "dark", label: "Dark", Icon: IcMoon },
  { value: "system", label: "System", Icon: IcMonitor },
];

interface Props {
  /** `rail` stretches across its container; `compact` is inline. */
  variant?: "rail" | "compact";
}

/** Day, night, or follow the system. A segmented control, one press per choice. */
export function ThemeToggle({ variant = "compact" }: Props) {
  const { theme, setTheme } = useTheme();
  return (
    <div className={clsx("seg", variant === "rail" && "seg-full")} role="group" aria-label="Theme">
      {CHOICES.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          className="seg-item"
          aria-pressed={theme === value}
          aria-label={`Theme: ${label}`}
          title={`Theme: ${label}`}
          onClick={() => setTheme(value)}
        >
          <Icon size={14} />
          {variant === "rail" && <span>{label}</span>}
        </button>
      ))}
    </div>
  );
}
