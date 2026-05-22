use crate::error::{AppError, AppResult};

#[tauri::command]
#[cfg(not(target_os = "android"))]
pub async fn get_page_count(path: String) -> AppResult<usize> {
    tokio::task::spawn_blocking(move || -> AppResult<usize> {
        let doc = mupdf::Document::open(&path).map_err(|e| AppError::Pdf(e.to_string()))?;
        let count = doc.page_count().map_err(|e| AppError::Pdf(e.to_string()))?;
        Ok(count as usize)
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
#[cfg(target_os = "android")]
pub async fn get_page_count(path: String) -> AppResult<usize> {
    tokio::task::spawn_blocking(move || -> AppResult<usize> {
        use crate::commands::android_pdf::{open_pfd, pdf_render_lock};
        use jni::objects::{JObject, JValue};

        let _lock = pdf_render_lock().lock().map_err(|e| AppError::Lock(e.to_string()))?;

        let ctx = ndk_context::android_context();
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
