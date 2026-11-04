//! Native printing on Linux through GTK's print dialog.
//!
//! The webview path (pages as images in a hidden iframe, then
//! `window.print()`) prints blank pages on WebKitGTK, which lays the frame out
//! at its own 0×0 size. Here GTK owns the dialog, preview and printer, and
//! each page is rendered by MuPDF only when GTK asks for it.
//!
//! Other platforms return `false` and the frontend prints through the webview,
//! which works on WebView2.

use crate::error::AppResult;

/// Raster resolution for printed pages.
#[cfg(target_os = "linux")]
const PRINT_DPI: f64 = 200.0;

/// Show the print dialog for the PDF at `path`. `true` when the platform
/// printed natively (or the user cancelled), `false` when it cannot.
#[tauri::command]
pub async fn print_pdf(app: tauri::AppHandle, window: tauri::WebviewWindow, path: String) -> AppResult<bool> {
    #[cfg(target_os = "linux")]
    {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let handle = app.clone();
        app.run_on_main_thread(move || {
            let _ = tx.send(linux::run(&handle, &window, &path));
        })
        .map_err(|e| crate::error::AppError::Other(e.to_string()))?;
        rx.await.map_err(|e| crate::error::AppError::Other(e.to_string()))??;
        Ok(true)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, window, path);
        Ok(false)
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::PRINT_DPI;
    use crate::error::{AppError, AppResult};
    use crate::render::scheduler::Priority;
    use crate::render::service::{internal_id, RenderService};
    use gtk::prelude::*;
    use tauri::Manager;

    /// Size of 1-based `page` in points.
    fn page_size(service: &RenderService, path: &str, page: u32) -> Option<(f64, f64)> {
        let list = service.worker().display_list(path.to_string(), page).ok()?;
        let b = list.bounds();
        Some((((b.x1 - b.x0).abs() as f64).max(1.0), ((b.y1 - b.y0).abs() as f64).max(1.0)))
    }

    /// Cairo wants native-endian premultiplied ARGB; MuPDF renders opaque
    /// RGBA, so this is a channel swap.
    pub(super) fn to_cairo(img: &crate::render::raster::RgbaImage) -> AppResult<gtk::cairo::ImageSurface> {
        let fmt = gtk::cairo::Format::Rgb24;
        let stride = fmt
            .stride_for_width(img.width)
            .map_err(|e| AppError::Other(e.to_string()))? as usize;
        let mut data = vec![0u8; stride * img.height as usize];
        for y in 0..img.height as usize {
            let src = &img.data[y * img.width as usize * 4..(y + 1) * img.width as usize * 4];
            let dst = &mut data[y * stride..y * stride + img.width as usize * 4];
            for (s, d) in src.chunks_exact(4).zip(dst.chunks_exact_mut(4)) {
                let px = u32::from_be_bytes([0xff, s[0], s[1], s[2]]);
                d.copy_from_slice(&px.to_ne_bytes());
            }
        }
        gtk::cairo::ImageSurface::create_for_data(data, fmt, img.width as i32, img.height as i32, stride as i32)
            .map_err(|e| AppError::Other(e.to_string()))
    }

    pub fn run(app: &tauri::AppHandle, window: &tauri::WebviewWindow, path: &str) -> AppResult<()> {
        let service = app.state::<RenderService>();
        let doc = mupdf::Document::open(path)?;
        let pages = doc.page_count()?;
        drop(doc);

        let op = gtk::PrintOperation::new();
        op.set_n_pages(pages);
        op.set_unit(gtk::Unit::Points);
        op.set_embed_page_setup(true);
        op.set_show_progress(true);
        let name = std::path::Path::new(path)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "Document".into());
        op.set_job_name(&name);

        // Landscape pages print landscape.
        {
            let service = service.inner().clone();
            let path = path.to_string();
            op.connect_request_page_setup(move |_, _, page_nr, setup| {
                if let Some((w, h)) = page_size(&service, &path, page_nr as u32 + 1) {
                    setup.set_orientation(if w > h {
                        gtk::PageOrientation::Landscape
                    } else {
                        gtk::PageOrientation::Portrait
                    });
                }
            });
        }

        {
            let service = service.inner().clone();
            let path = path.to_string();
            op.connect_draw_page(move |op, ctx, page_nr| {
                let page = page_nr as u32 + 1;
                let drawn = (|| -> AppResult<()> {
                    let (w, h) = page_size(&service, &path, page)
                        .ok_or_else(|| AppError::Other(format!("page {page} has no size")))?;
                    let img = service
                        .page(internal_id(), path.clone(), page, PRINT_DPI / 72.0, Priority::Visible)?
                        .ok_or_else(|| AppError::Other("print render cancelled".into()))?;
                    let surface = to_cairo(&img)?;
                    let cr = ctx
                        .cairo_context()
                        .ok_or_else(|| AppError::Other("print context has no cairo surface".into()))?;
                    // Fit the page into the printable area, centred.
                    let fit = (ctx.width() / w).min(ctx.height() / h);
                    cr.translate((ctx.width() - w * fit) / 2.0, (ctx.height() - h * fit) / 2.0);
                    cr.scale(w * fit / img.width as f64, h * fit / img.height as f64);
                    cr.set_source_surface(&surface, 0.0, 0.0).map_err(|e| AppError::Other(e.to_string()))?;
                    cr.paint().map_err(|e| AppError::Other(e.to_string()))?;
                    Ok(())
                })();
                if let Err(e) = drawn {
                    eprintln!("[qyra] print: page {page}: {e}");
                    op.cancel();
                }
            });
        }

        let parent = window.gtk_window().ok();
        op.run(gtk::PrintOperationAction::PrintDialog, parent.as_ref())
            .map_err(|e| AppError::Other(format!("print failed: {e}")))?;
        Ok(())
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    #[test]
    fn to_cairo_writes_native_endian_xrgb() {
        let img = crate::render::raster::RgbaImage { width: 2, height: 1, data: vec![10, 20, 30, 255, 200, 100, 50, 255] };
        let mut surface = super::linux::to_cairo(&img).unwrap();
        let stride = surface.stride() as usize;
        assert!(stride >= 8);
        let data = surface.data().unwrap();
        let px = |i: usize| u32::from_ne_bytes([data[i], data[i + 1], data[i + 2], data[i + 3]]);
        assert_eq!(px(0) & 0x00ff_ffff, 0x000a_141e);
        assert_eq!(px(4) & 0x00ff_ffff, 0x00c8_6432);
    }
}
