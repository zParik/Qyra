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

/// Android: Tauri command — called by the frontend on mount to retrieve any
/// PDF path staged by MainActivity (handles both cold-start timing race and
/// the case where the app was already in the foreground when ACTION_VIEW fired).
#[cfg(target_os = "android")]
#[tauri::command]
fn get_pending_open(app: tauri::AppHandle) -> Option<String> {
    use std::path::PathBuf;
    let Ok(files_dir) = app.path().app_local_data_dir() else { return None };
    let candidates: Vec<PathBuf> = vec![
        files_dir.join(".pending_open.txt"),
        files_dir.parent().map(|p| p.join("files/.pending_open.txt")).unwrap_or_default(),
    ];
    for marker in candidates {
        if !marker.exists() { continue; }
        let Ok(contents) = std::fs::read_to_string(&marker) else { continue };
        let path = contents.trim().to_string();
        let _ = std::fs::remove_file(&marker);
        if !path.is_empty() { return Some(path); }
        return None;
    }
    None
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
fn get_pending_open() -> Option<String> { None }

/// Android: drain the SAF folder-picker marker left by MainActivity when the
/// user grants access to a folder via the system tree picker. Each marker
/// line is `<treeUri>\t<childUri>\t<displayName>` for one PDF inside the
/// tree. We group lines by treeUri (currently always one) and emit a
/// `folder-picked` Tauri event with `{ tree_uri, children: [{ uri, name }] }`.
#[cfg(target_os = "android")]
fn drain_pending_folder<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use serde::Serialize;
    use std::path::PathBuf;

    #[derive(Serialize, Clone)]
    struct FolderChild { uri: String, name: String }
    #[derive(Serialize, Clone)]
    struct FolderPicked { tree_uri: String, children: Vec<FolderChild> }

    let Ok(files_dir) = app.path().app_local_data_dir() else { return };
    let candidates: Vec<PathBuf> = vec![
        files_dir.join(".pending_folder.txt"),
        files_dir.parent().map(|p| p.join("files/.pending_folder.txt")).unwrap_or_default(),
    ];
    for marker in candidates {
        if !marker.exists() { continue; }
        let Ok(contents) = std::fs::read_to_string(&marker) else { continue };
        let _ = std::fs::remove_file(&marker);

        let mut tree_uri = String::new();
        let mut children: Vec<FolderChild> = Vec::new();
        for line in contents.lines() {
            let mut parts = line.splitn(3, '\t');
            let Some(tree) = parts.next() else { continue };
            let Some(uri) = parts.next() else { continue };
            let name = parts.next().unwrap_or("").to_string();
            if tree_uri.is_empty() { tree_uri = tree.to_string(); }
            children.push(FolderChild { uri: uri.to_string(), name });
        }
        if !children.is_empty() {
            let _ = app.emit("folder-picked", FolderPicked { tree_uri, children });
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
pub fn init_ndk_context() -> Result<(), String> {
    use jni::{sys::JNI_OK, JavaVM};
    use std::sync::atomic::{AtomicBool, Ordering};

    // JNI_GetCreatedJavaVMs lives in libart.so on Android but is NOT in the NDK
    // libs the linker sees at build time, so we cannot link it statically (the
    // jni crate's `invocation` feature tries to link libjvm which does not
    // exist on Android, causing dlopen of our .so to fail at app startup).
    // Resolve it at runtime via dlsym(RTLD_DEFAULT, ...) instead.
    type GetCreatedFn = unsafe extern "C" fn(
        *mut *mut jni::sys::JavaVM,
        jni::sys::jsize,
        *mut jni::sys::jsize,
    ) -> jni::sys::jint;

    static INITIALIZED: AtomicBool = AtomicBool::new(false);
    if INITIALIZED.load(Ordering::Acquire) {
        return Ok(());
    }

    let result: Result<(), String> = (|| unsafe {
        // On Android Q+ apps live in an isolated linker namespace; RTLD_DEFAULT
        // does NOT see libart.so where JNI_GetCreatedJavaVMs actually lives.
        // dlopen the candidates explicitly and dlsym from the resulting handles.
        let sym_name = b"JNI_GetCreatedJavaVMs\0".as_ptr() as *const _;
        let mut sym_ptr = libc::dlsym(libc::RTLD_DEFAULT, sym_name);
        if sym_ptr.is_null() {
            for lib in [b"libart.so\0".as_ref(), b"libnativehelper.so\0".as_ref(), b"libdvm.so\0".as_ref()] {
                let handle = libc::dlopen(lib.as_ptr() as *const _, libc::RTLD_NOW | libc::RTLD_GLOBAL);
                if handle.is_null() { continue; }
                let s = libc::dlsym(handle, sym_name);
                if !s.is_null() {
                    sym_ptr = s;
                    eprintln!("[qyra] init_ndk_context: resolved JNI_GetCreatedJavaVMs via {:?}", std::ffi::CStr::from_ptr(lib.as_ptr() as *const _));
                    break;
                }
            }
        }
        if sym_ptr.is_null() {
            return Err("dlsym(JNI_GetCreatedJavaVMs) returned null after probing libart.so/libnativehelper.so/libdvm.so".to_string());
        }
        let get_created: GetCreatedFn = std::mem::transmute(sym_ptr);

        let mut raw_vm: *mut jni::sys::JavaVM = std::ptr::null_mut();
        let mut count: jni::sys::jsize = 0;
        let r = get_created(&mut raw_vm, 1, &mut count);
        if r != JNI_OK as i32 || count == 0 || raw_vm.is_null() {
            return Err(format!("no live JVM (result={r} count={count})"));
        }

        let java_vm = JavaVM::from_raw(raw_vm).map_err(|e| format!("JavaVM::from_raw: {e}"))?;
        let mut env = java_vm.attach_current_thread().map_err(|e| format!("attach: {e}"))?;

        let at = env
            .call_static_method(
                "android/app/ActivityThread",
                "currentActivityThread",
                "()Landroid/app/ActivityThread;",
                &[],
            )
            .map_err(|e| format!("currentActivityThread: {e}"))?
            .l()
            .map_err(|e| format!("currentActivityThread.l: {e}"))?;
        if at.is_null() {
            return Err("currentActivityThread returned null".to_string());
        }

        let app = env
            .call_method(&at, "getApplication", "()Landroid/app/Application;", &[])
            .map_err(|e| format!("getApplication: {e}"))?
            .l()
            .map_err(|e| format!("getApplication.l: {e}"))?;
        if app.is_null() {
            return Err("getApplication returned null (called too early?)".to_string());
        }

        let global = env.new_global_ref(&app).map_err(|e| format!("new_global_ref: {e}"))?;
        let activity_ptr = global.as_raw();

        let vm_ptr = java_vm.get_java_vm_pointer();
        drop(env);

        std::mem::forget(global);
        ndk_context::initialize_android_context(vm_ptr as *mut _, activity_ptr as *mut _);
        std::mem::forget(java_vm);
        Ok(())
    })();

    match &result {
        Ok(()) => {
            INITIALIZED.store(true, Ordering::Release);
            eprintln!("[qyra] init_ndk_context: OK");
        }
        Err(e) => eprintln!("[qyra] init_ndk_context FAILED: {e}"),
    }
    result
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
    // MuPDF rendering at high scales (3.0+) on large pages can exceed the
    // default 2MB Windows thread stack. Bump the minimum stack for any thread
    // spawned via std::thread (which tokio's blocking pool uses) so
    // spawn_blocking renders never hit STATUS_STACK_OVERFLOW.
    if std::env::var_os("RUST_MIN_STACK").is_none() {
        std::env::set_var("RUST_MIN_STACK", "8388608"); // 8 MiB
    }

    let builder = tauri::Builder::default()
        .manage(commands::cache::SessionCacheState::new())
        .manage(commands::render::ActiveDocument::new())
        .manage(commands::crash::CrashLogDir::new())
        .setup(|app| {
            #[cfg(not(target_os = "android"))]
            if let Some(dir) = commands::crash::install_panic_hook(app.handle()) {
                if let Ok(mut guard) = app
                    .state::<commands::crash::CrashLogDir>()
                    .0
                    .lock()
                {
                    *guard = Some(dir);
                }
            }
            #[cfg(target_os = "android")]
            {
                if let Err(e) = init_ndk_context() {
                    eprintln!("[qyra] startup init_ndk_context failed: {e} (will retry lazily)");
                }
            }

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
                    drain_pending_folder(&handle);
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
            compress_gs::compress_pdf_gs,
            compress_gs::compress_pdf_gs_parallel,
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
            links::add_link,
            links::remove_link,
            create::images_to_pdf,
            page_numbers::add_page_numbers,
            page_numbers::remove_page_numbers,
            bates::add_bates_numbers,
            bates::remove_bates_numbers,
            header_footer::add_header_footer,
            header_footer::remove_header_footer,
            protect::protect_pdf,
            unlock::unlock_pdf,
            metadata::get_metadata,
            metadata::set_metadata,
            metadata::get_pdf_info,
            metadata::get_pdf_permissions,
            files::copy_file,
            files::open_file,
            files::show_in_folder,
            files::write_bytes,
            files::get_content_uri_display_name,
            files::share_file,
            files::save_to_saf_tree,
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
            outline::detect_outline,
            outline_edit::set_outline,
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
            folder_pick::request_saf_folder_picker,
            repair::repair_pdf,
            anonymize::anonymize_pdf,
            form_data::export_form_xfdf,
            form_data::import_form_xfdf,
            crash::list_crash_logs,
            crash::dismiss_crash_log,
            crash::dismiss_all_crash_logs,
            get_pending_open,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app_handle, _event| {
            #[cfg(target_os = "android")]
            if matches!(_event, tauri::RunEvent::Resumed) {
                drain_pending_open(_app_handle);
                drain_pending_folder(_app_handle);
            }
        });
}
