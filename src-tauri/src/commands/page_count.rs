#[tauri::command]
#[cfg(not(target_os = "android"))]
pub async fn get_page_count(path: String) -> Result<usize, String> {
    tokio::task::spawn_blocking(move || {
        let doc = mupdf::Document::open(&path).map_err(|e| e.to_string())?;
        let count = doc.page_count().map_err(|e| e.to_string())?;
        Ok(count as usize)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
#[cfg(target_os = "android")]
pub async fn get_page_count(path: String) -> Result<usize, String> {
    tokio::task::spawn_blocking(move || {
        use crate::commands::android_pdf::{open_pfd, pdf_render_lock};
        use jni::objects::{JObject, JValue};

        let _lock = pdf_render_lock().lock().map_err(|e| e.to_string())?;

        let ctx = ndk_context::android_context();
        let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }
            .map_err(|e| e.to_string())?;
        let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
        let context = unsafe { JObject::from_raw(ctx.context().cast()) };

        let result: Result<usize, String> = (|| {
            let pfd = open_pfd(&mut env, &context, &path)?;
            let renderer = env
                .new_object(
                    "android/graphics/pdf/PdfRenderer",
                    "(Landroid/os/ParcelFileDescriptor;)V",
                    &[JValue::Object(&pfd)],
                )
                .map_err(|e| e.to_string())?;

            let count = env
                .call_method(&renderer, "getPageCount", "()I", &[])
                .map_err(|e| e.to_string())?
                .i()
                .map_err(|e| e.to_string())?;

            env.call_method(&renderer, "close", "()V", &[]).ok();
            env.call_method(&pfd, "close", "()V", &[]).ok();

            Ok(count as usize)
        })();

        env.exception_clear().ok();
        result
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_file_size(path: String) -> Result<u64, String> {
    tokio::task::spawn_blocking(move || {
        std::fs::metadata(&path)
            .map(|m| m.len())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
