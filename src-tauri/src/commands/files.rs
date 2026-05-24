use std::fs;
use tauri_plugin_opener::OpenerExt;
use crate::error::{AppError, AppResult};

fn mime_from_path(path: &str) -> &'static str {
    match path.rsplit('.').next().map(|e| e.to_lowercase()).as_deref() {
        Some("pdf")  => "application/pdf",
        Some("png")  => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        _ => "application/octet-stream",
    }
}

/// Save a file to the user's Downloads folder on Android, or open it on desktop.
/// On Android API 29+: inserts directly into MediaStore Downloads (no share sheet).
/// On Android API 24-28: falls back to a share chooser since external storage
/// requires a permission we don't request.
#[tauri::command]
pub fn share_file(path: String, app_handle: tauri::AppHandle) -> AppResult<()> {
    #[cfg(target_os = "android")]
    {
        let _ = &app_handle;
        return (|| -> Result<(), String> {
        use jni::objects::{JObject, JValue};

        let filename = std::path::Path::new(&path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("output.pdf")
            .to_owned();
        let mime = mime_from_path(&path);

        let ctx = crate::commands::android_pdf::safe_android_context()?;
        let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }.map_err(|e| e.to_string())?;
        let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
        let context = unsafe { JObject::from_raw(ctx.context().cast()) };

        // Check Android API level
        let sdk_int = env
            .get_static_field("android/os/Build$VERSION", "SDK_INT", "I")
            .map_err(|e| e.to_string())?
            .i()
            .map_err(|e| e.to_string())?;

        if sdk_int >= 29 {
            // ── API 29+ : write directly into MediaStore Downloads ──────────

            // ContentValues cv; cv.put("_display_name", filename); cv.put("mime_type", mime)
            let cv = env
                .new_object("android/content/ContentValues", "()V", &[])
                .map_err(|e| e.to_string())?;
            for (k, v) in [("_display_name", filename.as_str()), ("mime_type", mime)] {
                let jk = env.new_string(k).map_err(|e| e.to_string())?;
                let jv = env.new_string(v).map_err(|e| e.to_string())?;
                env.call_method(&cv, "put",
                    "(Ljava/lang/String;Ljava/lang/String;)V",
                    &[JValue::Object(&jk), JValue::Object(&jv)])
                    .map_err(|e| e.to_string())?;
            }

            // ContentResolver resolver = context.getContentResolver()
            let resolver = env
                .call_method(&context, "getContentResolver",
                    "()Landroid/content/ContentResolver;", &[])
                .map_err(|e| e.to_string())?.l().map_err(|e| e.to_string())?;

            // Uri downloads = MediaStore.Downloads.EXTERNAL_CONTENT_URI
            let dl_uri = env
                .get_static_field("android/provider/MediaStore$Downloads",
                    "EXTERNAL_CONTENT_URI", "Landroid/net/Uri;")
                .map_err(|e| e.to_string())?.l().map_err(|e| e.to_string())?;

            // Uri dest = resolver.insert(downloads, cv)
            let dest = env
                .call_method(&resolver, "insert",
                    "(Landroid/net/Uri;Landroid/content/ContentValues;)Landroid/net/Uri;",
                    &[JValue::Object(&dl_uri), JValue::Object(&cv)])
                .map_err(|e| e.to_string())?.l().map_err(|e| e.to_string())?;
            if dest.is_null() {
                return Err("MediaStore insert returned null".into());
            }

            // OutputStream os = resolver.openOutputStream(dest)
            let os = env
                .call_method(&resolver, "openOutputStream",
                    "(Landroid/net/Uri;)Ljava/io/OutputStream;",
                    &[JValue::Object(&dest)])
                .map_err(|e| e.to_string())?.l().map_err(|e| e.to_string())?;
            if os.is_null() {
                return Err("openOutputStream returned null".into());
            }

            // Files.copy(Path.of(path), os)  — streams without loading into JVM heap
            let j_src_str = env.new_string(&path).map_err(|e| e.to_string())?;
            let j_file = env
                .new_object("java/io/File", "(Ljava/lang/String;)V",
                    &[JValue::Object(&j_src_str)])
                .map_err(|e| e.to_string())?;
            let j_path = env
                .call_method(&j_file, "toPath", "()Ljava/nio/file/Path;", &[])
                .map_err(|e| e.to_string())?.l().map_err(|e| e.to_string())?;
            env.call_static_method("java/nio/file/Files", "copy",
                "(Ljava/nio/file/Path;Ljava/io/OutputStream;)J",
                &[JValue::Object(&j_path), JValue::Object(&os)])
                .map_err(|e| e.to_string())?;
            env.call_method(&os, "close", "()V", &[]).map_err(|e| e.to_string())?;

            return Ok(());
        }

        // ── API < 29 : share-intent fallback (no WRITE_EXTERNAL_STORAGE needed) ──

        let j_path = env.new_string(&path).map_err(|e| e.to_string())?;
        let j_file = env
            .new_object("java/io/File", "(Ljava/lang/String;)V", &[JValue::Object(&j_path)])
            .map_err(|e| e.to_string())?;
        let authority = env
            .new_string("com.parik.qyra.fileprovider")
            .map_err(|e| e.to_string())?;
        let uri = env
            .call_static_method("androidx/core/content/FileProvider", "getUriForFile",
                "(Landroid/content/Context;Ljava/lang/String;Ljava/io/File;)Landroid/net/Uri;",
                &[JValue::Object(&context), JValue::Object(&authority), JValue::Object(&j_file)])
            .map_err(|e| e.to_string())?.l().map_err(|e| e.to_string())?;

        let action = env.new_string("android.intent.action.SEND").map_err(|e| e.to_string())?;
        let intent = env
            .new_object("android/content/Intent", "(Ljava/lang/String;)V",
                &[JValue::Object(&action)])
            .map_err(|e| e.to_string())?;
        let j_mime = env.new_string(mime).map_err(|e| e.to_string())?;
        env.call_method(&intent, "setType", "(Ljava/lang/String;)Landroid/content/Intent;",
            &[JValue::Object(&j_mime)]).map_err(|e| e.to_string())?;
        let extra_stream = env.new_string("android.intent.extra.STREAM").map_err(|e| e.to_string())?;
        env.call_method(&intent, "putExtra",
            "(Ljava/lang/String;Landroid/os/Parcelable;)Landroid/content/Intent;",
            &[JValue::Object(&extra_stream), JValue::Object(&uri)])
            .map_err(|e| e.to_string())?;
        env.call_method(&intent, "addFlags", "(I)Landroid/content/Intent;",
            &[JValue::Int(1)]).map_err(|e| e.to_string())?;
        let title = env.new_string("Save file").map_err(|e| e.to_string())?;
        let chooser = env
            .call_static_method("android/content/Intent", "createChooser",
                "(Landroid/content/Intent;Ljava/lang/CharSequence;)Landroid/content/Intent;",
                &[JValue::Object(&intent), JValue::Object(&title)])
            .map_err(|e| e.to_string())?.l().map_err(|e| e.to_string())?;
        env.call_method(&chooser, "addFlags", "(I)Landroid/content/Intent;",
            &[JValue::Int(0x10000000i32)]).map_err(|e| e.to_string())?;
        env.call_method(&context, "startActivity", "(Landroid/content/Intent;)V",
            &[JValue::Object(&chooser)]).map_err(|e| e.to_string())?;

        Ok(())
        })().map_err(AppError::Other);
    }

    #[cfg(not(target_os = "android"))]
    app_handle
        .opener()
        .open_path(&path, None::<String>)
        .map_err(|e| AppError::Other(e.to_string()))
}

/// Query Android ContentResolver for the display name of a content:// URI.
/// Returns the filename (e.g. "report.pdf") or falls back to extracting it from the URI.
#[tauri::command]
pub fn get_content_uri_display_name(uri: String) -> String {
    #[cfg(target_os = "android")]
    {
        if uri.starts_with("content://") {
            if let Some(name) = android_query_display_name(&uri) {
                return name;
            }
        }
    }
    // Non-Android or fallback: last path segment
    uri.split(['/', '\\']).last().unwrap_or(&uri).to_string()
}

#[cfg(target_os = "android")]
fn android_query_display_name(uri: &str) -> Option<String> {
    use jni::objects::{JObject, JString, JValue};

    let ctx = crate::commands::android_pdf::safe_android_context().ok()?;
    let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }.ok()?;
    let mut env = vm.attach_current_thread().ok()?;

    // Uri.parse(uri)
    let j_uri_str = env.new_string(uri).ok()?;
    let j_uri = env
        .call_static_method(
            "android/net/Uri",
            "parse",
            "(Ljava/lang/String;)Landroid/net/Uri;",
            &[JValue::Object(&j_uri_str)],
        )
        .ok()?
        .l()
        .ok()?;
    if j_uri.is_null() {
        return None;
    }

    // context.getContentResolver()
    let context = unsafe { JObject::from_raw(ctx.context().cast()) };
    let resolver = env
        .call_method(
            &context,
            "getContentResolver",
            "()Landroid/content/ContentResolver;",
            &[],
        )
        .ok()?
        .l()
        .ok()?;
    if resolver.is_null() {
        return None;
    }

    // String[] projection = { OpenableColumns.DISPLAY_NAME }
    let display_name_field = env
        .get_static_field(
            "android/provider/OpenableColumns",
            "DISPLAY_NAME",
            "Ljava/lang/String;",
        )
        .ok()?
        .l()
        .ok()?;
    let string_class = env.find_class("java/lang/String").ok()?;
    let projection = env
        .new_object_array(1, string_class, &display_name_field)
        .ok()?;

    // cursor = resolver.query(uri, projection, null, null, null)
    let null = JObject::null();
    let cursor = env
        .call_method(
            &resolver,
            "query",
            "(Landroid/net/Uri;[Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;)Landroid/database/Cursor;",
            &[
                JValue::Object(&j_uri),
                JValue::Object(&projection),
                JValue::Object(&null),
                JValue::Object(&null),
                JValue::Object(&null),
            ],
        )
        .ok()?
        .l()
        .ok()?;
    if cursor.is_null() {
        return None;
    }

    let moved = env
        .call_method(&cursor, "moveToFirst", "()Z", &[])
        .ok()?
        .z()
        .ok()?;
    if !moved {
        let _ = env.call_method(&cursor, "close", "()V", &[]);
        return None;
    }

    let col_idx = env
        .call_method(
            &cursor,
            "getColumnIndex",
            "(Ljava/lang/String;)I",
            &[JValue::Object(&display_name_field)],
        )
        .ok()?
        .i()
        .ok()?;
    if col_idx < 0 {
        let _ = env.call_method(&cursor, "close", "()V", &[]);
        return None;
    }

    let name_obj = env
        .call_method(
            &cursor,
            "getString",
            "(I)Ljava/lang/String;",
            &[JValue::Int(col_idx)],
        )
        .ok()?
        .l()
        .ok()?;
    let _ = env.call_method(&cursor, "close", "()V", &[]);

    if name_obj.is_null() {
        return None;
    }
    let name: String = env.get_string(&JString::from(name_obj)).ok()?.into();
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

#[tauri::command]
pub fn copy_file(src: String, dst: String) -> AppResult<()> {
    fs::copy(&src, &dst).map(|_| ())?;
    Ok(())
}

/// Open a file with the default OS application. Runs from Rust to bypass
/// frontend path-scope restrictions imposed by the opener plugin.
#[tauri::command]
pub fn open_file(path: String, app_handle: tauri::AppHandle) -> AppResult<()> {
    app_handle
        .opener()
        .open_path(&path, None::<String>)
        .map_err(|e| AppError::Other(e.to_string()))
}

/// Reveal a file in the system file manager (Explorer / Finder / Nautilus).
#[tauri::command]
pub fn show_in_folder(path: String, app_handle: tauri::AppHandle) -> AppResult<()> {
    app_handle
        .opener()
        .reveal_item_in_dir(&path)
        .map_err(|e| AppError::Other(e.to_string()))
}

/// Write raw bytes to a file path. Used by the frontend to save rendered images.
#[tauri::command]
pub fn write_bytes(path: String, data: Vec<u8>) -> AppResult<()> {
    fs::write(&path, &data)?;
    Ok(())
}
