mod commands;
mod error;
mod pdf;
mod utils;

pub use error::{AppError, AppResult};

use commands::*;
use std::sync::Mutex;
use tauri::{Emitter, Manager};

/// Android: drain the pending-open marker file left by MainActivity when the
/// user opened a PDF via ACTION_VIEW / ACTION_SEND / ACTION_EDIT.
/// Reads the absolute path, deletes the marker, emits "open-pdf" to the frontend.
#[cfg(target_os = "android")]
fn drain_pending_open<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use std::path::PathBuf;
    let Ok(files_dir) = app.path().app_local_data_dir() else { return };
    // app_local_data_dir() on Android resolves to /data/data/<pkg>/files via the Tauri path API.
    // MainActivity writes the marker into Android `filesDir`, which is the same location.
    let candidates: Vec<PathBuf> = vec![
        files_dir.join(".pending_open.txt"),
        // Fallback in case the Tauri path API resolves to a parent dir
        files_dir.parent().map(|p| p.join("files/.pending_open.txt")).unwrap_or_default(),
    ];
    for marker in candidates {
        if !marker.exists() { continue; }
        let Ok(contents) = std::fs::read_to_string(&marker) else { continue };
        let path = contents.trim().to_string();
        let _ = std::fs::remove_file(&marker);
        if !path.is_empty() {
            let _ = app.emit("open-pdf", path);
        }
        return;
    }
}

/// Android: initialize ndk_context so our commands (files.rs / render.rs /
/// page_count.rs) that call `ndk_context::android_context()` don't panic.
///
/// Tauri 2 does NOT auto-initialize ndk-context — it has its own JNI bridge.
/// We reach into the live JVM via JNI_GetCreatedJavaVMs, walk the
/// ActivityThread reflection chain to find the Application instance, and feed
/// both into ndk-context's static. Runs ONCE on startup.
#[cfg(target_os = "android")]
fn init_ndk_context() {
    use jni::{sys::JNI_OK, JavaVM};

    static INIT: std::sync::Once = std::sync::Once::new();
    INIT.call_once(|| unsafe {
        let mut raw_vm: *mut jni::sys::JavaVM = std::ptr::null_mut();
        let mut count: jni::sys::jsize = 0;
        let result = jni::sys::JNI_GetCreatedJavaVMs(&mut raw_vm, 1, &mut count);
        if result != JNI_OK as i32 || count == 0 || raw_vm.is_null() {
            eprintln!("[qyra] init_ndk_context: no live JVM (result={result} count={count})");
            return;
        }

        let java_vm = match JavaVM::from_raw(raw_vm) {
            Ok(v) => v,
            Err(e) => { eprintln!("[qyra] init_ndk_context: JavaVM::from_raw: {e}"); return; }
        };
        let mut env = match java_vm.attach_current_thread() {
            Ok(e) => e,
            Err(e) => { eprintln!("[qyra] init_ndk_context: attach: {e}"); return; }
        };

        let at = match env.call_static_method(
            "android/app/ActivityThread",
            "currentActivityThread",
            "()Landroid/app/ActivityThread;",
            &[],
        ) {
            Ok(v) => v.l().unwrap(),
            Err(e) => { eprintln!("[qyra] init_ndk_context: currentActivityThread: {e}"); return; }
        };

        let app = match env.call_method(
            &at,
            "getApplication",
            "()Landroid/app/Application;",
            &[],
        ) {
            Ok(v) => v.l().unwrap(),
            Err(e) => { eprintln!("[qyra] init_ndk_context: getApplication: {e}"); return; }
        };

        let global = match env.new_global_ref(&app) {
            Ok(g) => g,
            Err(e) => { eprintln!("[qyra] init_ndk_context: new_global_ref: {e}"); return; }
        };

        let activity_ptr = global.as_raw();
        // Keep the global ref alive for the process lifetime so the JVM
        // does not GC the Application reference under ndk-context.
        std::mem::forget(global);

        ndk_context::initialize_android_context(
            java_vm.get_java_vm_pointer() as *mut _,
            activity_ptr as *mut _,
        );
        // Intentionally leak the JavaVM wrapper too — the underlying *mut JavaVM
        // is process-lifetime owned by libart.
        std::mem::forget(java_vm);
        eprintln!("[qyra] init_ndk_context: OK");
    });
}

fn cleanup_stale_sessions(current_pid: u32) {
    let temp = std::env::temp_dir();
    let now = std::time::SystemTime::now();
    let Ok(entries) = std::fs::read_dir(&temp) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if !name_str.starts_with("qyra-session-") { continue; }
        if let Some(pid_str) = name_str.strip_prefix("qyra-session-") {
            if pid_str.parse::<u32>().ok() == Some(current_pid) { continue; }
        }
        if let Ok(meta) = entry.metadata() {
            if let Ok(modified) = meta.modified() {
                if let Ok(age) = now.duration_since(modified) {
                    if age.as_secs() > 3600 {
                        let _ = std::fs::remove_dir_all(entry.path());
                    }
                }
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .manage(commands::cache::SessionCacheState::new())
        .manage(commands::render::ActiveDocument::new())
        .setup(|app| {
            #[cfg(target_os = "android")]
            init_ndk_context();

            cleanup_stale_sessions(std::process::id());
            let conn = commands::library::open_db(app.handle())
                .unwrap_or_else(|e| {
                    eprintln!("[qyra] library db failed ({e}), using in-memory fallback");
                    commands::library::open_db_in_memory()
                        .expect("in-memory sqlite always works")
                });
            app.manage(commands::library::LibraryDb(Mutex::new(conn)));
            let thumb_store = commands::thumb_store::ThumbStore::new(app.handle())
                .expect("failed to initialize thumb store");
            app.manage(thumb_store);
            // Desktop: "Open with" passes the file path as a CLI arg.
            #[cfg(not(target_os = "android"))]
            {
                let file_path = std::env::args()
                    .skip(1)
                    .find(|a| !a.starts_with('-'));
                if let Some(path) = file_path {
                    let handle = app.handle().clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(800));
                        handle.emit("open-pdf", path).ok();
                    });
                }
            }

            // Android: MainActivity copies the incoming intent's URI into
            // filesDir/imports/ and writes the absolute path into
            // filesDir/.pending_open.txt. We poll that marker on startup and
            // again whenever the activity resumes (handled below in RunEvent::Resumed).
            #[cfg(target_os = "android")]
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(800));
                    drain_pending_open(&handle);
                });
            }

            Ok(())
        });

    // Updater not applicable on Android (Play Store handles updates)
    #[cfg(not(target_os = "android"))]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    builder
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            merge::merge_pdfs,
            split::split_pdf,
            split::split_pdf_per_page,
            split::split_pdf_by_bookmarks,
            compress::compress_pdf,
            rotate::rotate_pages,
            remove::remove_pages,
            reorder::reorder_pages,
            render::read_pdf_bytes,
            render::render_page,
            render::render_page_uncached,
            render::set_active_document,
            render::get_page_aspect_ratio,
            render::get_text_page,
            render::search_pdf,
            render::render_thumbnail,
            render::pdf_to_images,
            render::get_page_links,
            create::images_to_pdf,
            page_numbers::add_page_numbers,
            page_numbers::remove_page_numbers,
            protect::protect_pdf,
            unlock::unlock_pdf,
            metadata::get_metadata,
            metadata::set_metadata,
            metadata::get_pdf_info,
            files::copy_file,
            files::open_file,
            files::show_in_folder,
            files::write_bytes,
            files::get_content_uri_display_name,
            files::share_file,
            annotate::bake_annotations,
            comments::load_comments,
            comments::save_comments,
            library::set_starred,
            library::set_archived,
            library::get_starred,
            library::get_archived,
            library::get_entry,
            library::get_setting,
            library::set_setting,
            thumb_store::thumb_get,
            thumb_store::thumb_put,
            thumb_store::thumb_evict,
            page_count::get_page_count,
            page_count::get_file_size,
            cache::cache_put,
            cache::cache_get,
            cache::cache_has,
            cache::cache_remove,
            cache::cache_evict_prefix,
            cache::cache_stats,
            cache::cache_clear,
            disk::get_disk_space,
            ocr::make_searchable,
            watermark::add_watermark,
            outline::get_outline,
            forms::get_form_fields,
            forms::fill_form,
            pdf_annotations::get_page_annotations,
            pdf_annotations::add_pdf_annotation,
            pdf_annotations::export_annotations,
            redact::redact_pdf,
            crop::crop_pages,
            flatten::flatten_pdf,
            export_text::export_pdf_to_text,
            export_word::export_pdf_to_word,
            tabs::get_tab_session,
            tabs::save_tab_session,
            tabs::save_tab_ui_state,
            tabs::get_tab_ui_state,
            tabs::clear_tab_session,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app_handle, _event| {
            #[cfg(target_os = "android")]
            if matches!(_event, tauri::RunEvent::Resumed) {
                drain_pending_open(_app_handle);
            }
        });
}
