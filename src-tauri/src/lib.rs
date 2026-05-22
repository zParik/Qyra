mod commands;
mod error;
mod pdf;
mod utils;

pub use error::{AppError, AppResult};

use commands::*;
use std::sync::Mutex;
use tauri::{Emitter, Manager};

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
            // When opened via "Open with" or double-click, the file path is passed as a CLI arg.
            // Emit it to the frontend after a short delay so the webview has time to load.
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
