use crate::error::{AppError, AppResult};

/// Count pages with MuPDF, reusing the render worker's open-document cache when
/// the app is running. Falls back to opening directly (e.g. in tests).
#[cfg(not(target_os = "android"))]
fn count_pages(path: String) -> AppResult<usize> {
    let read = |doc: &mupdf::Document| {
        doc.page_count()
            .map(|c| c as usize)
            .map_err(|e| AppError::Pdf(e.to_string()))
    };
    match crate::commands::render_worker::global() {
        Some(worker) => worker.with(path, read),
        None => {
            let doc = mupdf::Document::open(&path).map_err(|e| AppError::Pdf(e.to_string()))?;
            read(&doc)
        }
    }
}

#[tauri::command]
#[cfg(not(target_os = "android"))]
pub async fn get_page_count(path: String) -> AppResult<usize> {
    tokio::task::spawn_blocking(move || count_pages(path))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
#[cfg(target_os = "android")]
pub async fn get_page_count(path: String) -> AppResult<usize> {
    tokio::task::spawn_blocking(move || -> AppResult<usize> {
        use crate::commands::android_pdf::{open_pfd, pdf_render_guard, safe_android_context};
        use jni::objects::{JObject, JValue};

        let _lock = pdf_render_guard();

        let ctx = safe_android_context().map_err(AppError::Other)?;
        let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }
            .map_err(|e| AppError::Other(e.to_string()))?;
        let mut env = vm.attach_current_thread().map_err(|e| AppError::Other(e.to_string()))?;
        let context = unsafe { JObject::from_raw(ctx.context().cast()) };

        let result: AppResult<usize> = (|| {
            let pfd = open_pfd(&mut env, &context, &path).map_err(AppError::Other)?;
            let renderer = env
                .new_object(
                    "android/graphics/pdf/PdfRenderer",
                    "(Landroid/os/ParcelFileDescriptor;)V",
                    &[JValue::Object(&pfd)],
                )
                .map_err(|e| AppError::Other(e.to_string()))?;

            let count = env
                .call_method(&renderer, "getPageCount", "()I", &[])
                .map_err(|e| AppError::Other(e.to_string()))?
                .i()
                .map_err(|e| AppError::Other(e.to_string()))?;

            env.call_method(&renderer, "close", "()V", &[]).ok();
            env.call_method(&pfd, "close", "()V", &[]).ok();

            Ok(count as usize)
        })();

        env.exception_clear().ok();
        result
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn get_file_size(path: String) -> AppResult<u64> {
    tokio::task::spawn_blocking(move || -> AppResult<u64> {
        Ok(std::fs::metadata(&path).map(|m| m.len())?)
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}
