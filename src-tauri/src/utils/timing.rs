// utils/timing.rs
//
// Lightweight, opt-in wall-clock instrumentation for the hot command paths.
//
// A `Timer` logs the elapsed time of the scope it lives in when it is dropped.
// It is silent unless the `QYRA_PERF` environment variable is set, so it ships
// harmlessly in release builds and costs only one `Instant::now()` + an env read
// when disabled — negligible next to opening/parsing/rendering a PDF page.
//
// Usage:
//   let _t = Timer::start("render_page", format!("p{page} s{scale}"));
//   ... work ...
//   // on scope exit prints:  [perf] render_page p3 s1.5  42.18ms
//
// Enable with:  $env:QYRA_PERF = "1"   (PowerShell)   /   QYRA_PERF=1 (sh)
// Output goes to stderr, visible in the `cargo tauri dev` terminal.

use std::time::Instant;

/// Returns true once the first time it is asked; caches the env lookup so the
/// hot path does not hit the environment on every call.
fn enabled() -> bool {
    use std::sync::OnceLock;
    static ON: OnceLock<bool> = OnceLock::new();
    *ON.get_or_init(|| std::env::var_os("QYRA_PERF").is_some())
}

/// Scope timer. Construct with [`Timer::start`]; logs elapsed on drop.
pub struct Timer {
    label: &'static str,
    detail: String,
    start: Instant,
}

impl Timer {
    /// Start a timer tagged with a static `label` and a dynamic `detail`
    /// (e.g. the page number / scale / file size). When `QYRA_PERF` is unset
    /// the `detail` string is still built by the caller but never logged — keep
    /// callers' `detail` cheap (a short `format!` is fine).
    pub fn start(label: &'static str, detail: impl Into<String>) -> Self {
        Self { label, detail: detail.into(), start: Instant::now() }
    }
}

impl Drop for Timer {
    fn drop(&mut self) {
        if enabled() {
            let ms = self.start.elapsed().as_secs_f64() * 1000.0;
            eprintln!("[perf] {} {}  {:.2}ms", self.label, self.detail, ms);
        }
    }
}
