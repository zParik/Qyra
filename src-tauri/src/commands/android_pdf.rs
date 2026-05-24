//! Android PDF helpers — compiled only on Android.
//!
//! Provides a shared `open_pfd` helper that opens a `ParcelFileDescriptor`
//! for either a regular file path or a `content://` URI, which is required
//! by `android.graphics.pdf.PdfRenderer`.

#![cfg(target_os = "android")]

use jni::objects::{JObject, JValue};
use jni::JNIEnv;
use std::sync::{Mutex, OnceLock};

/// Global lock that serialises all `PdfRenderer` construction and usage.
/// Android's PdfRenderer (via pdfium) does not support concurrent access to
/// the same document from multiple threads, and some devices restrict
/// concurrent access even to different files.
static PDF_RENDER_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

pub fn pdf_render_lock() -> &'static Mutex<()> {
    PDF_RENDER_LOCK.get_or_init(|| Mutex::new(()))
}

/// Lock helper that recovers from poison. A prior PDF op may have panicked
/// while holding the lock (typically the first call hitting an uninitialised
/// ndk-context). Without this, every subsequent PDF open returns
/// 'lock poisoned' forever. The lock guards no state — it only serialises
/// PdfRenderer access — so it is safe to keep using after a poisoning panic.
pub fn pdf_render_guard() -> std::sync::MutexGuard<'static, ()> {
    pdf_render_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Opens a read-only `ParcelFileDescriptor` for `path`.
///
/// Accepts regular filesystem paths and `content://` URIs (from the Android
/// file picker). Returns a local JNI reference whose lifetime is tied to the
/// current JNI env frame; callers must close the PFD when done.
pub fn open_pfd<'local>(
    env: &mut JNIEnv<'local>,
    context: &JObject<'local>,
    path: &str,
) -> Result<JObject<'local>, String> {
    if path.starts_with("content://") {
        // Uri.parse(path)
        let j_uri_str = env.new_string(path).map_err(|e| e.to_string())?;
        let j_uri = env
            .call_static_method(
                "android/net/Uri",
                "parse",
                "(Ljava/lang/String;)Landroid/net/Uri;",
                &[JValue::Object(&j_uri_str)],
            )
            .map_err(|e| e.to_string())?
            .l()
            .map_err(|e| e.to_string())?;

        // context.getContentResolver()
        let resolver = env
            .call_method(
                context,
                "getContentResolver",
                "()Landroid/content/ContentResolver;",
                &[],
            )
            .map_err(|e| e.to_string())?
            .l()
            .map_err(|e| e.to_string())?;

        // resolver.openFileDescriptor(uri, "r")
        let mode = env.new_string("r").map_err(|e| e.to_string())?;
        let pfd = env
            .call_method(
                &resolver,
                "openFileDescriptor",
                "(Landroid/net/Uri;Ljava/lang/String;)Landroid/os/ParcelFileDescriptor;",
                &[JValue::Object(&j_uri), JValue::Object(&mode)],
            )
            .map_err(|e| e.to_string())?
            .l()
            .map_err(|e| e.to_string())?;

        if pfd.is_null() {
            return Err("ContentResolver.openFileDescriptor returned null".into());
        }
        Ok(pfd)
    } else {
        // new File(path)
        let j_path = env.new_string(path).map_err(|e| e.to_string())?;
        let j_file = env
            .new_object("java/io/File", "(Ljava/lang/String;)V", &[JValue::Object(&j_path)])
            .map_err(|e| e.to_string())?;

        // ParcelFileDescriptor.MODE_READ_ONLY
        let mode_read_only = env
            .get_static_field("android/os/ParcelFileDescriptor", "MODE_READ_ONLY", "I")
            .map_err(|e| e.to_string())?
            .i()
            .map_err(|e| e.to_string())?;

        // ParcelFileDescriptor.open(file, MODE_READ_ONLY)
        let pfd = env
            .call_static_method(
                "android/os/ParcelFileDescriptor",
                "open",
                "(Ljava/io/File;I)Landroid/os/ParcelFileDescriptor;",
                &[JValue::Object(&j_file), JValue::Int(mode_read_only)],
            )
            .map_err(|e| e.to_string())?
            .l()
            .map_err(|e| e.to_string())?;

        if pfd.is_null() {
            return Err("ParcelFileDescriptor.open returned null".into());
        }
        Ok(pfd)
    }
}

/// Returns a writable path inside the app's cache directory, suitable for
/// writing temporary JPEG files during rendering. Avoids relying on
/// `std::env::temp_dir()` which may not be writable on Android.
pub fn app_cache_dir<'local>(
    env: &mut JNIEnv<'local>,
    context: &JObject<'local>,
) -> Result<String, String> {
    let cache_dir = env
        .call_method(context, "getCacheDir", "()Ljava/io/File;", &[])
        .map_err(|e| e.to_string())?
        .l()
        .map_err(|e| e.to_string())?;

    let path_obj = env
        .call_method(&cache_dir, "getAbsolutePath", "()Ljava/lang/String;", &[])
        .map_err(|e| e.to_string())?
        .l()
        .map_err(|e| e.to_string())?;

    let path: String = env
        .get_string(&jni::objects::JString::from(path_obj))
        .map_err(|e| e.to_string())?
        .into();

    Ok(path)
}
