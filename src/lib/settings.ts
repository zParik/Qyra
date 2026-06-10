import { getSetting, setSetting } from "./tauri";

export type CompressLevel = 0 | 1 | 2;

export interface SettingSpec<T> {
  key: string;
  default: T;
  decode: (raw: string) => T;
  encode: (val: T) => string;
}

function bool(key: string, def: boolean): SettingSpec<boolean> {
  return { key, default: def, decode: (raw) => raw === "1", encode: (v) => (v ? "1" : "0") };
}

function str(key: string, def: string): SettingSpec<string> {
  return { key, default: def, decode: (raw) => raw, encode: (v) => v };
}

function oneOf<T extends string | number>(
  key: string,
  def: T,
  values: readonly T[],
  parse: (raw: string) => T,
): SettingSpec<T> {
  return {
    key,
    default: def,
    decode: (raw) => {
      const v = parse(raw);
      return values.includes(v) ? v : def;
    },
    encode: (v) => String(v),
  };
}

/** Typed registry. Every persisted preference lives here. */
export const Settings = {
  autoSave: bool("auto_save", false),
  defaultCompressLevel: oneOf<CompressLevel>(
    "default_compress_level", 0, [0, 1, 2], (r) => parseInt(r, 10) as CompressLevel,
  ),
  confirmBeforeOverwrite: bool("confirm_before_overwrite", true),
  defaultSaveFolder: str("default_save_folder", ""),
  reopenTabsOnLaunch: bool("reopen_tabs_on_launch", true),
} as const;

/** One-shot async read for non-React consumers (showSaveDialog, ViewerShell). */
export async function loadSetting<T>(spec: SettingSpec<T>): Promise<T> {
  try {
    const raw = await getSetting(spec.key);
    return raw === null ? spec.default : spec.decode(raw);
  } catch {
    return spec.default;
  }
}

/** One-shot async write. Fail-soft: never throws. */
export async function storeSetting<T>(spec: SettingSpec<T>, val: T): Promise<void> {
  try {
    await setSetting(spec.key, spec.encode(val));
  } catch {
    /* fail-soft */
  }
}
