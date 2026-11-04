// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "linux")]
    {
        // Keep WebKitGTK's DMA-buf renderer (GPU compositing) on: forcing
        // WEBKIT_DISABLE_DMABUF_RENDERER=1 drops every page canvas to CPU
        // compositing and scrolling crawls at a few fps.
        //
        // On Wayland with the NVIDIA driver, that renderer dies with
        // "Error 71 (Protocol error) dispatching to Wayland display" unless
        // NVIDIA's explicit sync is off. The variable only affects NVIDIA's EGL
        // driver, so it is harmless on Intel/AMD. Set before GTK/WebKit start,
        // and inherited by WebKit's web process.
        //
        // Values the user sets explicitly always win, so a machine that still
        // crashes can opt back into CPU compositing with
        // WEBKIT_DISABLE_DMABUF_RENDERER=1.
        if std::env::var_os("WAYLAND_DISPLAY").is_some()
            && std::env::var_os("__NV_DISABLE_EXPLICIT_SYNC").is_none()
        {
            std::env::set_var("__NV_DISABLE_EXPLICIT_SYNC", "1");
        }
        std::env::set_var("LD_PRELOAD", "/usr/lib/libwayland-client.so");
    }
    qyra_lib::run()
}
