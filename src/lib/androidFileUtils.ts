import { appCacheDir, appLocalDataDir, join } from "@tauri-apps/api/path";
import { writeFile, mkdir, exists } from "@tauri-apps/plugin-fs";

/**
 * Imported PDFs live in appLocalDataDir/imports/ — NOT cache.
 * Cache can be evicted by Android at any time, which would silently break
 * the user's Recents / Library / open-tabs the next time they launch Qyra.
 * Local-data is only cleared when the user uninstalls or clears app data.
 */
async function ensureImportsDir(): Promise<string> {
  const base = await appLocalDataDir();
  const dir = await join(base, "imports");
  if (!(await exists(dir))) {
    await mkdir(dir, { recursive: true });
  }
  return dir;
}

export function isAndroid(): boolean {
  return /android/i.test(navigator.userAgent);
}

function readFileBytes(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

async function importFileToDisk(file: File): Promise<{ path: string; name: string }> {
  const bytes = await readFileBytes(file);
  const safeName = file.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "document";
  const importsDir = await ensureImportsDir();
  const dst = await join(importsDir, `${Date.now()}_${safeName}`);
  // Use plugin-fs writeFile for efficient binary transfer (avoids JSON-array IPC overhead)
  await writeFile(dst, bytes);
  return { path: dst, name: file.name };
}

function showNativeFilePicker(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = multiple;
    input.style.cssText =
      "position:fixed;top:-200px;left:-200px;opacity:0;pointer-events:none;";
    document.body.appendChild(input);

    let settled = false;

    const finish = (files: File[]) => {
      if (settled) return;
      settled = true;
      input.remove();
      document.removeEventListener("visibilitychange", onVisible);
      resolve(files);
    };

    input.addEventListener("change", () => {
      finish(Array.from(input.files ?? []));
    });

    // Cancel detection: page becomes visible again after the picker Activity closes
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        setTimeout(() => finish([]), 400);
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    input.click();
  });
}

/**
 * Show Android's native file picker. Imported files are copied into
 * appLocalDataDir/imports/ so they survive cache eviction and the user
 * can re-open them from Library/Recents without re-picking.
 */
export async function pickFilesAndroid(
  accept: string,
  multiple: boolean
): Promise<{ path: string; name: string }[]> {
  const files = await showNativeFilePicker(accept, multiple);
  if (!files.length) return [];
  return Promise.all(files.map(importFileToDisk));
}

/** Returns a writable path in the app cache dir for saving generated output on Android.
 * (Outputs are ephemeral results of tool operations; cache is fine for those.) */
export async function androidSavePath(defaultName: string): Promise<string> {
  const base = defaultName.replace(/\.pdf$/i, "");
  const cacheDir = await appCacheDir();
  return join(cacheDir, `${base}_${Date.now()}.pdf`);
}

/** Returns the app cache dir as the output directory on Android. */
export async function androidOutputDir(): Promise<string> {
  return appCacheDir();
}
