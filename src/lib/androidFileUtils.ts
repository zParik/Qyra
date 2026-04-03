import { appCacheDir, join } from "@tauri-apps/api/path";
import { writeFile } from "@tauri-apps/plugin-fs";

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

async function cacheFileToDisk(file: File): Promise<{ path: string; name: string }> {
  const bytes = await readFileBytes(file);
  const ext = file.name.includes(".") ? file.name.split(".").pop()! : "bin";
  const cacheDir = await appCacheDir();
  const tmpPath = await join(
    cacheDir,
    `na_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`
  );
  // Use plugin-fs writeFile for efficient binary transfer (avoids JSON-array IPC overhead)
  await writeFile(tmpPath, bytes);
  return { path: tmpPath, name: file.name };
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
 * Show Android's native file picker and return resolved temp-file entries.
 * Files are read via FileReader and written to app cache dir so Rust can access them.
 */
export async function pickFilesAndroid(
  accept: string,
  multiple: boolean
): Promise<{ path: string; name: string }[]> {
  const files = await showNativeFilePicker(accept, multiple);
  if (!files.length) return [];
  return Promise.all(files.map(cacheFileToDisk));
}

/** Returns a writable path in the app cache dir for saving output on Android. */
export async function androidSavePath(defaultName: string): Promise<string> {
  const base = defaultName.replace(/\.pdf$/i, "");
  const cacheDir = await appCacheDir();
  return join(cacheDir, `${base}_${Date.now()}.pdf`);
}

/** Returns the app cache dir as the output directory on Android. */
export async function androidOutputDir(): Promise<string> {
  return appCacheDir();
}
