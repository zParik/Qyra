mod commands;
mod pdf;
mod utils;

use commands::*;
use tauri::Emitter;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(commands::cache::SessionCacheState::new())
        .setup(|app| {
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
        })
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            merge::merge_pdfs,
            split::split_pdf,
            split::split_pdf_per_page,
            compress::compress_pdf,
            rotate::rotate_pages,
            remove::remove_pages,
            reorder::reorder_pages,
            render::read_pdf_bytes,
            render::render_thumbnail,
            render::pdf_to_images,
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
            page_count::get_page_count,
            page_count::get_file_size,
            cache::cache_put,
            cache::cache_get,
            cache::cache_has,
            cache::cache_remove,
            cache::cache_evict_prefix,
            cache::cache_stats,
            cache::cache_clear,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
