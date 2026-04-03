// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "linux")]
    {
        // WebKitGTK's DMA-buf renderer conflicts with Hyprland and other Wayland compositors.
        // Disabling it prevents black windows and crashes on Wayland.
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        std::env::set_var("LD_PRELOAD", "/usr/lib/libwayland-client.so");
    }
    quire_lib::run()
}
