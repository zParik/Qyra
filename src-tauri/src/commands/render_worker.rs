// commands/render_worker.rs  (desktop only)
//
// Dedicated MuPDF render worker.
//
// MuPDF documents/pages are bound to the thread + fz_context that created them
// and must not be touched from another thread. The previous code sidestepped
// that by reopening the file inside every `spawn_blocking` call — which meant a
// viewer scrolling 50 pages re-parsed the whole PDF (xref + object stream
// decode) 50 times from disk.
//
// Instead we keep ONE long-lived worker thread that owns every open
// `mupdf::Document` in a small (path, mtime) → Document cache. Callers send a
// job plus a reply channel; only the *result* (JPEG bytes / text lines / link
// list / f64 — all `Send`) crosses back. The Document never leaves the worker.
//
// Net effect: the document is parsed once and reused, so a warm page render
// drops from "reparse the entire file" to "load + rasterize one page".

use std::collections::HashMap;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::UNIX_EPOCH;

use base64::Engine;

use crate::commands::render::{ActiveDocument, PageLink, TextLine, CharRect};
use crate::error::{AppError, AppResult};

/// How many distinct documents to keep open at once. A viewer typically has a
/// handful of tabs; beyond this the least-recently-inserted doc is dropped.
const CACHE_CAP: usize = 6;

/// Work items handed to the worker thread. Each carries its own typed reply
/// channel so results stay strongly typed across the boundary.
enum Job {
    Render {
        path: String,
        mtime: u64,
        page: u32,
        scale: f32,
        check_active: bool,
        reply: Sender<AppResult<Vec<u8>>>,
    },
    Text {
        path: String,
        mtime: u64,
        page: u32,
        reply: Sender<AppResult<Vec<TextLine>>>,
    },
    Links {
        path: String,
        mtime: u64,
        page: u32,
        reply: Sender<AppResult<Vec<PageLink>>>,
    },
    Aspect {
        path: String,
        mtime: u64,
        reply: Sender<AppResult<f64>>,
    },
    /// Generic short read-only task against the cached document. The closure
    /// owns its own reply channel and receives the open result (or the open
    /// error) so failures still reach the caller. Only use for *fast* reads
    /// (page count, outline) — long page-walking work would stall renders.
    Run {
        path: String,
        mtime: u64,
        run: Box<dyn for<'a> FnOnce(AppResult<&'a mupdf::Document>) + Send>,
    },
}

/// Cloneable handle to the worker thread. Stored as Tauri managed state.
///
/// `std::sync::mpsc::Sender` is `Send` but not `Sync`, whereas Tauri managed
/// state must be `Sync`. Wrapping it in `Arc<Mutex<..>>` makes the handle both
/// `Sync` and cheaply cloneable; the lock is held only for the (non-blocking,
/// unbounded) enqueue.
#[derive(Clone)]
pub struct RenderWorker {
    tx: Arc<Mutex<Sender<Job>>>,
}

/// Process-global handle, set once at app startup. Lets plain command functions
/// (get_page_count, get_outline) reuse the cached document without threading a
/// `tauri::State` param — which also keeps them callable from the integration
/// tests, where no worker exists and `global()` returns None (callers then fall
/// back to opening the document directly).
static GLOBAL: OnceLock<RenderWorker> = OnceLock::new();

/// Register the global worker. Idempotent; later calls are ignored.
pub fn set_global(worker: RenderWorker) {
    let _ = GLOBAL.set(worker);
}

/// The global worker handle if one was registered (always present in the running
/// app, absent in unit/integration tests).
pub fn global() -> Option<RenderWorker> {
    GLOBAL.get().cloned()
}

impl RenderWorker {
    /// Spawn the worker thread. `active` shares the same `Arc<Mutex<..>>` as the
    /// managed `ActiveDocument`, so `set_active_document` cancels stale jobs.
    pub fn new(active: ActiveDocument) -> Self {
        let (tx, rx) = channel::<Job>();
        std::thread::Builder::new()
            .name("qyra-render".to_string())
            // High-scale renders on large pages can blow the default 2 MiB
            // stack inside MuPDF; match lib.rs's RUST_MIN_STACK headroom.
            .stack_size(16 * 1024 * 1024)
            .spawn(move || worker_loop(rx, active))
            .expect("failed to spawn qyra render worker");
        Self { tx: Arc::new(Mutex::new(tx)) }
    }

    fn enqueue(&self, job: Job) -> AppResult<()> {
        self.tx
            .lock()
            .map_err(|_| AppError::Other("render worker lock poisoned".to_string()))?
            .send(job)
            .map_err(|_| AppError::Other("render worker stopped".to_string()))
    }

    pub fn render(&self, path: String, page: u32, scale: f32, check_active: bool) -> AppResult<Vec<u8>> {
        let mtime = file_mtime(&path);
        let (reply, rx) = channel();
        self.enqueue(Job::Render { path, mtime, page, scale, check_active, reply })?;
        rx.recv()
            .map_err(|_| AppError::Other("render worker dropped reply".to_string()))?
    }

    pub fn text(&self, path: String, page: u32) -> AppResult<Vec<TextLine>> {
        let mtime = file_mtime(&path);
        let (reply, rx) = channel();
        self.enqueue(Job::Text { path, mtime, page, reply })?;
        rx.recv()
            .map_err(|_| AppError::Other("render worker dropped reply".to_string()))?
    }

    pub fn links(&self, path: String, page: u32) -> AppResult<Vec<PageLink>> {
        let mtime = file_mtime(&path);
        let (reply, rx) = channel();
        self.enqueue(Job::Links { path, mtime, page, reply })?;
        rx.recv()
            .map_err(|_| AppError::Other("render worker dropped reply".to_string()))?
    }

    pub fn aspect(&self, path: String) -> AppResult<f64> {
        let mtime = file_mtime(&path);
        let (reply, rx) = channel();
        self.enqueue(Job::Aspect { path, mtime, reply })?;
        rx.recv()
            .map_err(|_| AppError::Other("render worker dropped reply".to_string()))?
    }

    /// Run a short read-only closure against the cached document and return its
    /// result. Reuses the worker's open-document cache (no reparse). Only use
    /// for fast reads — anything that walks every page belongs on its own
    /// spawn_blocking so it does not stall interactive renders.
    pub fn with<R, F>(&self, path: String, f: F) -> AppResult<R>
    where
        R: Send + 'static,
        F: FnOnce(&mupdf::Document) -> AppResult<R> + Send + 'static,
    {
        let mtime = file_mtime(&path);
        let (reply, rx) = channel::<AppResult<R>>();
        let run: Box<dyn for<'a> FnOnce(AppResult<&'a mupdf::Document>) + Send> =
            Box::new(move |doc: AppResult<&mupdf::Document>| {
                let _ = reply.send(doc.and_then(f));
            });
        self.enqueue(Job::Run { path, mtime, run })?;
        rx.recv()
            .map_err(|_| AppError::Other("render worker dropped reply".to_string()))?
    }
}

/// Modification time as nanos-since-epoch; 0 if it cannot be read (treated as a
/// cache miss so we always reopen rather than serve a stale handle).
fn file_mtime(path: &str) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0)
}

/// Per-thread document cache. Lives entirely inside the worker thread, so the
/// non-`Send` `mupdf::Document` values never cross a thread boundary.
struct DocCache {
    docs: HashMap<String, (u64, mupdf::Document)>,
    order: Vec<String>,
}

impl DocCache {
    fn new() -> Self {
        Self { docs: HashMap::new(), order: Vec::new() }
    }

    /// Ensure an up-to-date Document for `path` is cached, reopening if missing
    /// or if the file changed on disk (mtime mismatch).
    fn ensure(&mut self, path: &str, mtime: u64) -> AppResult<()> {
        let fresh = matches!(self.docs.get(path), Some((m, _)) if *m == mtime);
        if fresh {
            return Ok(());
        }
        let doc = mupdf::Document::open(path)?;
        if self.docs.insert(path.to_string(), (mtime, doc)).is_none() {
            self.order.push(path.to_string());
        }
        // Evict least-recently-inserted docs other than the one just opened.
        while self.order.len() > CACHE_CAP {
            let victim = self.order.remove(0);
            if victim == path {
                // Don't evict what we just inserted; push it back as newest.
                self.order.push(victim);
                break;
            }
            self.docs.remove(&victim);
        }
        Ok(())
    }

    /// Run `f` against the cached Document for `path`, opening/refreshing first.
    fn with_doc<R>(
        &mut self,
        path: &str,
        mtime: u64,
        f: impl FnOnce(&mupdf::Document) -> AppResult<R>,
    ) -> AppResult<R> {
        self.ensure(path, mtime)?;
        let (_, doc) = self.docs.get(path).expect("ensure inserted the doc");
        f(doc)
    }
}

fn worker_loop(rx: Receiver<Job>, active: ActiveDocument) {
    let mut cache = DocCache::new();
    while let Ok(job) = rx.recv() {
        match job {
            Job::Render { path, mtime, page, scale, check_active, reply } => {
                let _ = reply.send(do_render(&mut cache, &active, &path, mtime, page, scale, check_active));
            }
            Job::Text { path, mtime, page, reply } => {
                let _ = reply.send(do_text(&mut cache, &active, &path, mtime, page));
            }
            Job::Links { path, mtime, page, reply } => {
                let _ = reply.send(do_links(&mut cache, &path, mtime, page));
            }
            Job::Aspect { path, mtime, reply } => {
                let _ = reply.send(do_aspect(&mut cache, &path, mtime));
            }
            Job::Run { path, mtime, run } => match cache.ensure(&path, mtime) {
                Ok(()) => {
                    let (_, doc) = cache.docs.get(&path).expect("ensure inserted the doc");
                    run(Ok(doc));
                }
                Err(e) => run(Err(e)),
            },
        }
    }
}

#[inline]
fn cancelled() -> AppError {
    AppError::Other("Cancelled".to_string())
}

fn do_render(
    cache: &mut DocCache,
    active: &ActiveDocument,
    path: &str,
    mtime: u64,
    page: u32,
    scale: f32,
    check_active: bool,
) -> AppResult<Vec<u8>> {
    let _t = crate::utils::timing::Timer::start("render_page(worker)", format!("p{page} s{scale}"));
    if check_active && !active.is(path) {
        return Err(cancelled());
    }
    cache.with_doc(path, mtime, |doc| {
        let p = doc.load_page(page as i32 - 1)?;
        let matrix = mupdf::Matrix::new_scale(scale, scale);
        let cs = mupdf::Colorspace::device_rgb();
        if check_active && !active.is(path) {
            return Err(cancelled());
        }
        let pixmap = p.to_pixmap(&matrix, &cs, false, false)?;
        let width = pixmap.width();
        let height = pixmap.height();
        let samples = pixmap.samples();
        let img = image::RgbImage::from_raw(width, height, samples.to_vec())
            .ok_or_else(|| AppError::Pdf("pixmap→RgbImage failed".to_string()))?;
        let mut buf = Vec::new();
        {
            let mut cursor = std::io::Cursor::new(&mut buf);
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, 90)
                .encode_image(&image::DynamicImage::ImageRgb8(img))?;
        }
        Ok(buf)
    })
}

fn do_text(
    cache: &mut DocCache,
    active: &ActiveDocument,
    path: &str,
    mtime: u64,
    page: u32,
) -> AppResult<Vec<TextLine>> {
    let _t = crate::utils::timing::Timer::start("get_text_page(worker)", format!("p{page}"));
    if !active.is(path) {
        return Err(cancelled());
    }
    cache.with_doc(path, mtime, |doc| {
        let p = doc.load_page(page as i32 - 1)?;
        let b = p.bounds()?;
        let pw = (b.x1 - b.x0) as f64;
        let ph = (b.y1 - b.y0) as f64;
        if pw == 0.0 || ph == 0.0 {
            return Ok(vec![]);
        }
        let stext = p.to_text_page(mupdf::TextPageFlags::empty())?;
        let mut lines: Vec<TextLine> = Vec::new();
        for block in stext.blocks() {
            if block.r#type() != mupdf::text_page::TextBlockType::Text {
                continue;
            }
            for line in block.lines() {
                let mut line_chars = Vec::new();
                let mut lx0 = f64::MAX;
                let mut ly0 = f64::MAX;
                let mut lx1 = f64::MIN;
                let mut ly1 = f64::MIN;
                for ch in line.chars() {
                    let c_char = match ch.char() {
                        Some(c) => c,
                        None => continue,
                    };
                    let cp = c_char as u32;
                    if cp == 0 || (cp < 32 && cp != 9) {
                        continue;
                    }
                    let c = c_char.to_string();
                    let q = ch.quad();
                    let x0 = ((q.ul.x - b.x0) as f64) / pw;
                    let y0 = ((q.ul.y - b.y0) as f64) / ph;
                    let x1 = ((q.lr.x - b.x0) as f64) / pw;
                    let y1 = ((q.lr.y - b.y0) as f64) / ph;
                    lx0 = lx0.min(x0);
                    ly0 = ly0.min(y0);
                    lx1 = lx1.max(x1);
                    ly1 = ly1.max(y1);
                    line_chars.push(CharRect { c, x0, y0, x1, y1 });
                }
                if !line_chars.is_empty() {
                    lines.push(TextLine { chars: line_chars, x0: lx0, y0: ly0, x1: lx1, y1: ly1 });
                }
            }
        }
        Ok(lines)
    })
}

fn do_links(cache: &mut DocCache, path: &str, mtime: u64, page: u32) -> AppResult<Vec<PageLink>> {
    cache.with_doc(path, mtime, |doc| {
        let p = doc.load_page(page as i32 - 1)?;
        let b = p.bounds()?;
        let pw = (b.x1 - b.x0) as f64;
        let ph = (b.y1 - b.y0) as f64;
        if pw == 0.0 || ph == 0.0 {
            return Ok(vec![]);
        }
        let mut result = Vec::new();
        for link in p.links()? {
            if link.uri.is_empty() && link.dest.is_none() {
                continue;
            }
            let page_dest = link.dest.map(|d| d.loc.page_number + 1);
            result.push(PageLink {
                x0: ((link.bounds.x0 - b.x0) as f64) / pw,
                y0: ((link.bounds.y0 - b.y0) as f64) / ph,
                x1: ((link.bounds.x1 - b.x0) as f64) / pw,
                y1: ((link.bounds.y1 - b.y0) as f64) / ph,
                uri: link.uri,
                page: page_dest,
            });
        }
        Ok(result)
    })
}

fn do_aspect(cache: &mut DocCache, path: &str, mtime: u64) -> AppResult<f64> {
    cache.with_doc(path, mtime, |doc| {
        let page = doc.load_page(0)?;
        let b = page.bounds()?;
        let w = (b.x1 - b.x0) as f64;
        let h = (b.y1 - b.y0) as f64;
        if w == 0.0 {
            return Err(AppError::Invalid("zero page width".to_string()));
        }
        Ok(h / w)
    })
}

/// Encode raw JPEG bytes to base64 (kept here so render commands stay thin).
pub fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}
