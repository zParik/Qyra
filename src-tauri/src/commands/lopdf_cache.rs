// commands/lopdf_cache.rs
//
// Process-global, read-only cache of parsed lopdf Documents keyed by
// (path, mtime).
//
// `lopdf::Document` is plain owned data (Send + Sync) with no thread affinity,
// so unlike the MuPDF render worker this needs no dedicated thread — a
// Mutex-guarded map handing out `Arc<Document>` snapshots is enough.
//
// READ-ONLY callers only. Commands that mutate and save a PDF must keep loading
// their own fresh owned `Document`; never mutate the shared Arc. The mtime key
// means an in-place rewrite (which bumps mtime) transparently invalidates the
// entry on the next read.
//
// Motivation: per-page commands such as get_page_annotations were calling
// `Document::load` (a full xref + object parse) on every invocation. Scrolling
// an annotated document reparsed the whole file once per visible page.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::UNIX_EPOCH;

use lopdf::Document;

use crate::error::{AppError, AppResult};

/// How many distinct documents to keep parsed at once.
const CACHE_CAP: usize = 4;

struct Cache {
    docs: HashMap<String, (u64, Arc<Document>)>,
    order: Vec<String>,
}

static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();

fn cache() -> &'static Mutex<Cache> {
    CACHE.get_or_init(|| Mutex::new(Cache { docs: HashMap::new(), order: Vec::new() }))
}

fn file_mtime(path: &str) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0)
}

/// Return a shared, parsed Document for `path`, reusing the cached parse when
/// the file is unchanged on disk. The returned Arc is a read-only snapshot —
/// do not attempt to mutate it.
pub fn load(path: &str) -> AppResult<Arc<Document>> {
    let mtime = file_mtime(path);
    let mut c = cache()
        .lock()
        .map_err(|e| AppError::Lock(e.to_string()))?;

    if let Some((m, doc)) = c.docs.get(path) {
        if *m == mtime {
            return Ok(doc.clone());
        }
    }

    // Miss or stale. Parsing happens under the lock, which briefly serializes
    // other readers; after the first parse every caller hits the fast path.
    let doc = Arc::new(Document::load(path)?);
    if c.docs.insert(path.to_string(), (mtime, doc.clone())).is_none() {
        c.order.push(path.to_string());
    }
    while c.order.len() > CACHE_CAP {
        let victim = c.order.remove(0);
        if victim == path {
            c.order.push(victim);
            break;
        }
        c.docs.remove(&victim);
    }
    Ok(doc)
}
