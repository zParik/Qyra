//! Below-normal priority for background worker threads (compressor, tile pool).

/// Drop the calling thread's scheduling priority so it yields to foreground
/// work. No-op where we don't have a cheap per-thread hook.
#[cfg(windows)]
pub fn lower_current_thread_priority() {
    use std::ffi::c_void;
    const THREAD_PRIORITY_BELOW_NORMAL: i32 = -1;
    extern "system" {
        fn GetCurrentThread() -> *mut c_void;
        fn SetThreadPriority(handle: *mut c_void, priority: i32) -> i32;
    }
    unsafe {
        SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);
    }
}

// Used by the compressor pool, the render tile pool and the rayon global pool.
#[cfg(unix)]
pub fn lower_current_thread_priority() {
    // setpriority(PRIO_PROCESS, 0, ..) applies to the calling thread on Linux.
    unsafe {
        libc::setpriority(libc::PRIO_PROCESS, 0, 10);
    }
}

#[cfg(not(any(windows, unix)))]
pub fn lower_current_thread_priority() {}
