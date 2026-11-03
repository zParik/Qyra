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

use crate::commands::render::{PageLink, TextLine, CharRect};
use crate::error::{AppError, AppResult};

/// How many distinct documents to keep open at once. A viewer typically has a
/// handful of tabs; beyond this the least-recently-inserted doc is dropped.
const CACHE_CAP: usize = 6;

use crate::render::geometry::PageSizePt;
use mupdf::pdf::PdfDocument;

/// Display lists kept (across documents). A list is the parsed page, which can
/// run to tens of MB on a vector-heavy page; 24 covers the viewer's mounted
/// band (about 17 pages) with room to scroll back.
const LIST_CAP: usize = 24;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocInfo {
    pub page_count: u32,
    pub pages: Vec<PageSizePt>,
    /// File mtime (ns) as a string — cache-busting version for the frontend.
    pub version: String,
}

/// What a document carries that only a full lopdf parse can read. Read-only
/// commands check this first and skip that parse (seconds of CPU and hundreds
/// of MB on a large file) when there is nothing to read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DocFeatures {
    /// The AcroForm has at least one field.
    pub form_fields: bool,
    /// A page has a Text annotation, or the file has embedded files (where the
    /// comments sidecar lives).
    pub comments: bool,
}

/// Work items handed to the worker thread. Each carries its own typed reply
/// channel so results stay strongly typed across the boundary.
enum Job {
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
    Info { path: String, mtime: u64, reply: Sender<AppResult<DocInfo>> },
    Features { path: String, mtime: u64, reply: Sender<AppResult<DocFeatures>> },
    /// Drop everything cached for `path`, closing MuPDF's handle on the file.
    Close { path: String, reply: Sender<()> },
    List { path: String, mtime: u64, page: u32, reply: Sender<AppResult<Arc<mupdf::DisplayList>>> },
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
    /// Spawn the worker thread.
    pub fn new() -> Self {
        let (tx, rx) = channel::<Job>();
        std::thread::Builder::new()
            .name("qyra-render".to_string())
            // High-scale renders on large pages can blow the default 2 MiB
            // stack inside MuPDF; match lib.rs's RUST_MIN_STACK headroom.
            .stack_size(16 * 1024 * 1024)
            .spawn(move || worker_loop(rx))
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

    pub fn text(&self, path: String, page: u32) -> AppResult<Vec<TextLine>> {
        let mtime = file_mtime(&path);
        let (reply, rx) = channel();
        self.enqueue(Job::Text { path, mtime, page, reply })?;
        rx.recv()
            .map_err(|_| AppError::Other("render worker dropped reply".to_string()))?
    }

    pub fn doc_info(&self, path: String) -> AppResult<DocInfo> {
        let mtime = file_mtime(&path);
        let (reply, rx) = channel();
        self.enqueue(Job::Info { path, mtime, reply })?;
        rx.recv().map_err(|_| AppError::Other("render worker dropped reply".to_string()))?
    }

    pub fn features(&self, path: String) -> AppResult<DocFeatures> {
        let mtime = file_mtime(&path);
        let (reply, rx) = channel();
        self.enqueue(Job::Features { path, mtime, reply })?;
        rx.recv().map_err(|_| AppError::Other("render worker dropped reply".to_string()))?
    }

    /// Close `path` on the doc thread (open document and display lists) and wait
    /// until it is closed, so the file can be replaced on disk. The next read
    /// reopens it.
    pub fn close(&self, path: &str) {
        let (reply, rx) = channel();
        if self.enqueue(Job::Close { path: path.to_string(), reply }).is_ok() {
            let _ = rx.recv();
        }
    }

    /// Cached display list for 1-based `page` of `path`.
    pub fn display_list(&self, path: String, page: u32) -> AppResult<Arc<mupdf::DisplayList>> {
        let mtime = file_mtime(&path);
        let (reply, rx) = channel();
        self.enqueue(Job::List { path, mtime, page, reply })?;
        rx.recv().map_err(|_| AppError::Other("render worker dropped reply".to_string()))?
    }

    pub fn links(&self, path: String, page: u32) -> AppResult<Vec<PageLink>> {
        let mtime = file_mtime(&path);
        let (reply, rx) = channel();
        self.enqueue(Job::Links { path, mtime, page, reply })?;
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
/// non-`Send` MuPDF documents never cross a thread boundary.
struct DocCache {
    docs: HashMap<String, (u64, PdfDocument)>,
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
        let doc = PdfDocument::open(path)?;
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
        f: impl FnOnce(&PdfDocument) -> AppResult<R>,
    ) -> AppResult<R> {
        self.ensure(path, mtime)?;
        let (_, doc) = self.docs.get(path).expect("ensure inserted the doc");
        f(doc)
    }
}

fn worker_loop(rx: Receiver<Job>) {
    let mut cache = DocCache::new();
    let mut lists: Vec<((String, u64, u32), Arc<mupdf::DisplayList>)> = Vec::new();
    // The viewer asks once per visible page; walk each file version once.
    let mut features: HashMap<(String, u64), DocFeatures> = HashMap::new();
    while let Ok(job) = rx.recv() {
        // A panic in one job (mupdf-rs unwraps while resolving links in some
        // damaged files) must not kill this thread: every later render would
        // fail until restart. The job's reply is dropped, so its caller gets
        // an error; the caches are reset in case the panic left them torn.
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            match job {
                Job::Text { path, mtime, page, reply } => {
                    let _ = reply.send(do_text(&mut cache, &path, mtime, page));
                }
                Job::Links { path, mtime, page, reply } => {
                    let _ = reply.send(do_links(&mut cache, &path, mtime, page));
                }
                Job::Info { path, mtime, reply } => {
                    let _ = reply.send(cache.with_doc(&path, mtime, |doc| {
                        let pages = crate::render::raster::page_sizes(doc)?;
                        Ok(DocInfo { page_count: pages.len() as u32, pages, version: mtime.to_string() })
                    }));
                }
                Job::Features { path, mtime, reply } => {
                    let key = (path.clone(), mtime);
                    if let Some(f) = features.get(&key) {
                        let _ = reply.send(Ok(*f));
                        return;
                    }
                    let found = cache.with_doc(&path, mtime, scan_features);
                    if let Ok(f) = found {
                        if features.len() >= 32 {
                            features.clear();
                        }
                        features.insert(key, f);
                    }
                    let _ = reply.send(found);
                }
                Job::Close { path, reply } => {
                    cache.docs.remove(&path);
                    cache.order.retain(|p| *p != path);
                    lists.retain(|((p, _, _), _)| *p != path);
                    features.retain(|(p, _), _| *p != path);
                    let _ = reply.send(());
                }
                Job::List { path, mtime, page, reply } => {
                    let key = (path.clone(), mtime, page);
                    if let Some(pos) = lists.iter().position(|(k, _)| *k == key) {
                        let hit = lists.remove(pos); // move to most-recent
                        let _ = reply.send(Ok(hit.1.clone()));
                        lists.push(hit);
                        return;
                    }
                    let built = cache.with_doc(&path, mtime, |doc| {
                        Ok(Arc::new(crate::render::raster::build_display_list(doc, page as i32 - 1)?))
                    });
                    if let Ok(list) = &built {
                        lists.push((key, list.clone()));
                        if lists.len() > LIST_CAP {
                            lists.remove(0);
                        }
                    }
                    let _ = reply.send(built);
                }
                Job::Run { path, mtime, run } => match cache.ensure(&path, mtime) {
                    Ok(()) => {
                        let (_, doc) = cache.docs.get(&path).expect("ensure inserted the doc");
                        run(Ok(&**doc));
                    }
                    Err(e) => run(Err(e)),
                },
            }
        }));
        if outcome.is_err() {
            cache = DocCache::new();
            lists.clear();
            features.clear();
        }
    }
}

/// Walk the object tree MuPDF loads lazily: the catalog, and each page's
/// /Annots array. No page content is parsed.
fn scan_features(doc: &PdfDocument) -> AppResult<DocFeatures> {
    let catalog = doc.catalog()?;
    let form_fields = match catalog.get_dict("AcroForm")? {
        Some(form) => matches!(form.get_dict("Fields")?, Some(f) if f.len()? > 0),
        None => false,
    };
    let embedded = match catalog.get_dict("Names")? {
        Some(names) => names.get_dict("EmbeddedFiles")?.is_some(),
        None => false,
    };
    let mut comments = embedded;
    if !comments {
        'pages: for i in 0..doc.page_count()? {
            let Some(annots) = doc.find_page(i)?.get_dict("Annots")? else { continue };
            for j in 0..annots.len()? as i32 {
                let Some(annot) = annots.get_array(j)? else { continue };
                if let Some(sub) = annot.get_dict("Subtype")? {
                    if sub.as_name()? == b"Text" {
                        comments = true;
                        break 'pages;
                    }
                }
            }
        }
    }
    Ok(DocFeatures { form_fields, comments })
}

fn do_text(
    cache: &mut DocCache,
    path: &str,
    mtime: u64,
    page: u32,
) -> AppResult<Vec<TextLine>> {
    let _t = crate::utils::timing::Timer::start("get_text_page(worker)", format!("p{page}"));
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

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> String {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/fixtures/pdf/generated")
            .join(name)
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn doc_info_lists_every_page_size_and_a_version() {
        let w = RenderWorker::new();
        let info = w.doc_info(fixture("mixed-sizes.pdf")).unwrap();
        assert_eq!(info.page_count, 3);
        assert_eq!(info.pages[1].w, 792.0);
        assert!(info.version.parse::<u64>().unwrap() > 0);
    }

    #[test]
    fn display_list_is_cached_per_page() {
        let w = RenderWorker::new();
        let a = w.display_list(fixture("text.pdf"), 1).unwrap();
        let b = w.display_list(fixture("text.pdf"), 1).unwrap();
        assert!(Arc::ptr_eq(&a, &b));
    }

    #[test]
    fn features_report_form_fields_only_for_a_form() {
        let w = RenderWorker::new();
        assert!(w.features(fixture("acroform.pdf")).unwrap().form_fields);
        assert!(!w.features(fixture("text.pdf")).unwrap().form_fields);
    }

    #[test]
    fn features_report_comments_only_when_a_text_annotation_exists() {
        let w = RenderWorker::new();
        assert!(w.features(fixture("annotated.pdf")).unwrap().comments);
        assert!(!w.features(fixture("text.pdf")).unwrap().comments);
    }

    #[test]
    fn text_does_not_require_the_active_document() {
        let w = RenderWorker::new();
        let lines = w.text(fixture("text.pdf"), 1).unwrap();
        assert!(!lines.is_empty());
    }
}
