// Prevents console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // WebKitGTK 2.40+ defaults to DMA-BUF rendering, which fails with
    // EGL_BAD_PARAMETER on some Bazzite/Wayland GPU configurations and
    // aborts before the window opens. Must be set before Tauri initialises
    // WebKit — putting it here (before run()) is the only reliable place.
    #[cfg(target_os = "linux")]
    std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");

    ignis_setup_lib::run();
}
