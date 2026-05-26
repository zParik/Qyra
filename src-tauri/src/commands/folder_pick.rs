//! Android SAF folder picker bridge.
//!
//! Calls into MainActivity (Kotlin) via JNI to launch the Storage Access
//! Framework tree picker. The Kotlin side handles the picker result, takes
//! a persistable URI permission, enumerates PDF children under the tree,
//! and writes a marker file (`.pending_folder.txt`) in app filesDir. The
//! Rust side polls that marker on `RunEvent::Resumed` (see lib.rs) and
//! emits a `folder-picked` Tauri event with the resulting list.
//!
//! Desktop is a no-op stub so the command remains callable from shared
//! frontend code without `#[cfg]` forks on the JS side.

#[cfg(target_os = "android")]
#[tauri::command]
pub fn request_saf_folder_picker() -> Result<(), String> {
    use crate::commands::android_pdf::safe_android_context;

    let ctx = safe_android_context()?;
    // Reattach to the live JVM. ctx.vm() is *mut c_void → JavaVM raw pointer.
    let vm = unsafe { jni::JavaVM::from_raw(ctx.vm() as *mut jni::sys::JavaVM) }
        .map_err(|e| format!("JavaVM::from_raw: {e}"))?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|e| format!("attach_current_thread: {e}"))?;

    let result = env
        .call_static_method(
            "com/parik/qyra/MainActivity",
            "launchFolderPickerFromNative",
            "()Z",
            &[],
        )
        .map_err(|e| format!("call launchFolderPickerFromNative: {e}"))?
        .z()
        .map_err(|e| format!("decode bool: {e}"))?;

    if !result {
        return Err("MainActivity not in foreground; picker not launched".into());
    }
    Ok(())
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn request_saf_folder_picker() -> Result<(), String> {
    Err("SAF folder picker is Android-only".into())
}
