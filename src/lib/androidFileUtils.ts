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

/**
 * Show Android's SAF folder picker (ACTION_OPEN_DOCUMENT_TREE) and return
 * every PDF found inside the chosen tree as `{ path, name }`. `path` is a
 * persistent `content://` URI that the Rust `open_pfd` helper consumes
 * directly via `ContentResolver.openFileDescriptor`. We do NOT copy these
 * into appLocalDataDir/imports/ — the persistable URI permission survives
 * process death, so the user grants once and the files are reachable on
 * every subsequent launch.
 *
 * Returns [] if the user cancels the picker or the folder contains no PDFs.
 *
 * Implementation: invokes the Tauri command `request_saf_folder_picker`,
 * which JNI-calls MainActivity to launch the system tree picker. The
 * picker result is handled in Kotlin, which writes a marker file. The
 * Rust side reads it on `RunEvent::Resumed` and emits the `folder-picked`
 * event we wait for here.
 */
export async function pickFolderAndroid(): Promise<{ path: string; name: string }[]> {
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");

  interface FolderPickedPayload {
    tree_uri: string;
    children: { uri: string; name: string }[];
  }

  return new Promise<{ path: string; name: string }[]>((resolve, reject) => {
    let unlisten: (() => void) | undefined;
    let settled = false;

    const finish = (out: { path: string; name: string }[]) => {
      if (settled) return;
      settled = true;
      unlisten?.();
      clearTimeout(cancelTimer);
      resolve(out);
    };

    // Hard cancel after 5 minutes — if the user backgrounded the picker
    // and never returned, we don't want this promise pending forever.
    const cancelTimer = setTimeout(() => finish([]), 5 * 60 * 1000);

    listen<FolderPickedPayload>("folder-picked", (e) => {
      const children = e.payload.children.map((c) => ({ path: c.uri, name: c.name }));
      finish(children);
    })
      .then((u) => {
        unlisten = u;
        invoke("request_saf_folder_picker").catch((err) => {
          if (settled) return;
          settled = true;
          unlisten?.();
          clearTimeout(cancelTimer);
          reject(err);
        });
      })
      .catch(reject);
  });
}
