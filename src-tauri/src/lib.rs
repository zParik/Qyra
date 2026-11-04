// `pub` so the integration test crate in `src-tauri/tests/` can drive commands
// and PDF helpers directly (black-box, exactly as the IPC layer calls them).
pub mod commands;
pub mod render;
mod error;
pub mod pdf;
pub mod utils;

pub use error::{AppError, AppResult};

use commands::*;
use std::sync::Mutex;
use tauri::{Emitter, Manager};

/// The file passed on the command line ("Open with"), held until the frontend
/// asks for it. An event emitted at startup is lost if the webview's listener
/// is not registered yet.
struct PendingOpen(Mutex<Option<String>>);

#[tauri::command]
fn get_pending_open(pending: tauri::State<'_, PendingOpen>) -> Option<String> {
    pending.0.lock().ok()?.take()
}

/// The file named on a command line: its first argument that is not a flag,
/// made absolute against `cwd`. `std::env::args` panics on an argument that
/// is not UTF-8; such a path cannot reach the webview anyway, so it is skipped.
fn file_arg(args: impl IntoIterator<Item = std::ffi::OsString>, cwd: &std::path::Path) -> Option<String> {
    let arg = args
        .into_iter()
        .skip(1)
        .filter_map(|a| a.into_string().ok())
        .find(|a| !a.starts_with('-'))?;
    Some(cwd.join(arg).to_string_lossy().into_owned())
}

pub fn run() {
    // MuPDF rendering at high scales (3.0+) on large pages can exceed the
    // default 2MB Windows thread stack. Bump the minimum stack for any thread
    // spawned via std::thread (which tokio's blocking pool uses) so
    // spawn_blocking renders never hit STATUS_STACK_OVERFLOW.
    if std::env::var_os("RUST_MIN_STACK").is_none() {
        std::env::set_var("RUST_MIN_STACK", "8388608"); // 8 MiB
    }

    // Tauri's default async runtime starts one worker per logical core (28 on a
    // desktop CPU), yet most commands only await IPC replies and hand heavy
    // work to spawn_blocking, whose pool is separate and grows on demand. The
    // `#[tauri::command(async)]` file operations do run on a worker, so four
    // leave IPC responsive even with two of them going; idle workers cost
    // nothing. The runtime must outlive the app, so it is leaked.
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(4)
        .thread_name("qyra-async")
        .enable_all()
        .build()
        .expect("failed to build the async runtime");
    tauri::async_runtime::set(runtime.handle().clone());
    std::mem::forget(runtime);

    // Cap the rayon GLOBAL pool to 2 below-normal-priority threads before any
    // parallel work runs. Its only user is lopdf's parallel object parse, which
    // with 8 threads pinned 8 cores for seconds on every large file opened.
    // The compressor uses its own per-call pool. Best-effort: ignore the error
    // if already initialized.
    let _ = rayon::ThreadPoolBuilder::new()
        .num_threads(2)
        .thread_name(|i| format!("qyra-rayon-{i}"))
        .start_handler(|_| crate::utils::thread_priority::lower_current_thread_priority())
        .build_global();

    // The MuPDF doc thread: owns open documents, serves page sizes, display
    // lists, text and links.
    let render_worker = commands::render_worker::RenderWorker::new();
    // Publish a global handle so plain command fns (get_page_count, get_outline)
    // can reuse the same cached documents without a tauri::State parameter.
    commands::render_worker::set_global(render_worker.clone());
    // Tile pool for the tiled render pipeline; shares the doc thread above.
    let render_service = render::service::RenderService::new(
        render_worker.clone(),
        render::service::RenderService::default_threads(),
    );

    let builder = tauri::Builder::default()
        // Registered first, as the plugin requires. "Open with" while Qyra is
        // running started a second copy; the file now opens in a new tab of
        // the running one, which comes to the front.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let args = argv.into_iter().map(std::ffi::OsString::from);
            if let Some(path) = file_arg(args, std::path::Path::new(&cwd)) {
                let _ = app.emit("open-pdf", path);
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .manage(commands::crash::CrashLogDir::new())
        .setup(|app| {
            if let Some(dir) = commands::crash::install_panic_hook(app.handle()) {
                if let Ok(mut guard) = app
                    .state::<commands::crash::CrashLogDir>()
                    .0
                    .lock()
                {
                    *guard = Some(dir);
                }
            }

            let conn = commands::library::open_db(app.handle())
                .unwrap_or_else(|e| {
                    eprintln!("[qyra] library db failed ({e}), using in-memory fallback");
                    commands::library::open_db_in_memory()
                        .expect("in-memory sqlite always works")
                });
            app.manage(commands::library::LibraryDb(Mutex::new(conn)));
            // Lossless page thumbnails for the `qyra` URI scheme (bounded LRU).
            {
                // The old data-URL thumbnail store grew without bound; free it.
                if let Ok(cache) = app.path().app_cache_dir() {
                    let _ = std::fs::remove_dir_all(cache.join("thumbs"));
                }
                let dir = app
                    .path()
                    .app_cache_dir()
                    .map(|d| d.join("thumbs-v2"))
                    .unwrap_or_else(|_| std::env::temp_dir().join("qyra-thumbs-v2"));
                app.manage(render::thumbs::ThumbCache::new(dir, 256 * 1024 * 1024));
            }
            // "Open with" passes the file path as a CLI arg.
            let cwd = std::env::current_dir().unwrap_or_default();
            app.manage(PendingOpen(Mutex::new(file_arg(std::env::args_os(), &cwd))));
            Ok(())
        });

    // Register the dedicated MuPDF render worker (owns the open-document cache).
    let builder = builder.manage(render_worker);
    let builder = builder.manage(render_service);

    // `qyra://localhost/thumb/<page>?path=..&w=..` (http://qyra.localhost on
    // Windows) → PNG thumbnail. Rendering runs off the webview's thread.
    let builder = builder.register_asynchronous_uri_scheme_protocol("qyra", |ctx, request, responder| {
        let app = ctx.app_handle().clone();
        let pq = request
            .uri()
            .path_and_query()
            .map(|p| p.as_str().to_string())
            .unwrap_or_default();
        // Tokio's blocking pool (bounded, reused) — not a fresh OS thread per image.
        tauri::async_runtime::spawn_blocking(move || {
            let reply = |status: u16, ctype: &str, body: Vec<u8>| {
                tauri::http::Response::builder()
                    .status(status)
                    .header(tauri::http::header::CONTENT_TYPE, ctype)
                    .header(tauri::http::header::CACHE_CONTROL, "no-cache")
                    .body(body)
                    .unwrap()
            };
            let Some((path, page, width)) = render::thumbs::parse_thumb_uri(&pq) else {
                return responder.respond(reply(400, "text/plain", b"bad thumbnail url".to_vec()));
            };
            let service = app.state::<render::service::RenderService>();
            let cache = app.state::<render::thumbs::ThumbCache>();
            match render::thumbs::thumb_png(&service, &cache, &path, page, width) {
                Ok(png) => responder.respond(reply(200, "image/png", png)),
                Err(e) => responder.respond(reply(500, "text/plain", e.to_string().into_bytes())),
            }
        });
    });

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
            compress::cancel_compress,
            compress::save_compressed_copy,
            rotate::rotate_pages,
            remove::remove_pages,
            reorder::reorder_pages,
            commands::render::get_text_page,
            commands::render::search_pdf,
            commands::render::pdf_to_images,
            commands::render::get_page_links,
            commands::render::doc_open,
            commands::render::render_tile,
            commands::render::render_page_rgba,
            commands::render::cancel_renders,
            commands::render::export_page_image,
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
            page_count::get_page_count,
            page_count::get_file_size,
            disk::get_disk_space,
            ocr::make_searchable,
            ocr::ocr_page,
            watermark::add_watermark,
            outline::get_outline,
            outline::detect_outline,
            outline_edit::set_outline,
            forms::get_form_fields,
            forms::fill_form,
            signatures::stamp_images,
            pdf_annotations::get_page_annotations,
            pdf_annotations::add_pdf_annotation,
            pdf_annotations::export_annotations,
            redact::redact_pdf,
            crop::crop_pages,
            flatten::flatten_pdf,
            export_text::export_pdf_to_text,
            tabs::get_tab_session,
            tabs::save_tab_session,
            tabs::save_tab_ui_state,
            tabs::get_tab_ui_state,
            tabs::clear_tab_session,
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
        .run(|_app_handle, _event| {});
}

#[cfg(test)]
mod tests {
    use super::file_arg;
    use std::ffi::OsString;
    use std::path::Path;

    #[test]
    fn file_arg_skips_flags_and_resolves_relative_paths() {
        // Expected paths are built with the platform's own separator.
        let cwd = Path::new("/home/u");
        let joined = |p: &str| cwd.join(p).to_string_lossy().into_owned();
        let args = ["qyra", "--flag", "doc.pdf"].map(OsString::from);
        assert_eq!(file_arg(args, cwd), Some(joined("doc.pdf")));
        let args = ["qyra", "/abs/doc.pdf"].map(OsString::from);
        assert_eq!(file_arg(args, cwd), Some(joined("/abs/doc.pdf")));
        assert_eq!(file_arg([OsString::from("qyra")], Path::new("/")), None);
    }

    #[cfg(unix)]
    #[test]
    fn file_arg_skips_non_utf8_arguments() {
        use std::os::unix::ffi::OsStringExt;
        let args = vec![OsString::from("qyra"), OsString::from_vec(vec![0xFF, 0xFE])];
        assert_eq!(file_arg(args, Path::new("/")), None);
    }
}
