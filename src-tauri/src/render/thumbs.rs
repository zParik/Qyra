//! Page thumbnails: lossless PNG at fixed widths, cached on disk, served to
//! `<img>` via the `qyra` URI scheme (`qyra://localhost/thumb/<page>?path=..&w=..`,
//! `http://qyra.localhost/...` on Windows). Print pages come through the same
//! scheme at `/print/<page>?path=..`, uncached.

use std::path::PathBuf;
use std::time::SystemTime;

use crate::error::AppResult;
use crate::render::scheduler::Priority;
use crate::render::service::{internal_id, RenderService};

/// The only thumbnail widths served (keeps the disk cache small and shared).
pub const WIDTHS: [u32; 3] = [128, 256, 512];

pub struct ThumbCache {
    dir: PathBuf,
    budget: u64,
}

impl ThumbCache {
    pub fn new(dir: PathBuf, budget_bytes: u64) -> Self {
        let _ = std::fs::create_dir_all(&dir);
        Self { dir, budget: budget_bytes }
    }

    pub fn key(path: &str, mtime_ns: u64, page: u32, width: u32) -> String {
        format!("{}-{mtime_ns}-{page}-{width}", crate::utils::fnv1a_hex(path))
    }

    fn file(&self, key: &str) -> PathBuf {
        self.dir.join(format!("{key}.png"))
    }

    pub fn get(&self, key: &str) -> Option<Vec<u8>> {
        let p = self.file(key);
        let bytes = std::fs::read(&p).ok()?;
        // Recency = mtime: touch on read so eviction is least-recently-USED.
        if let Ok(f) = std::fs::File::options().write(true).open(&p) {
            let _ = f.set_modified(SystemTime::now());
        }
        Some(bytes)
    }

    pub fn put(&self, key: &str, png: &[u8]) {
        if std::fs::write(self.file(key), png).is_ok() {
            self.evict();
        }
    }

    /// Over budget → delete least-recently-used files down to 80% of budget.
    fn evict(&self) {
        let Ok(rd) = std::fs::read_dir(&self.dir) else { return };
        let mut files: Vec<(SystemTime, u64, PathBuf)> = rd
            .flatten()
            .filter_map(|e| {
                let m = e.metadata().ok()?;
                Some((m.modified().ok()?, m.len(), e.path()))
            })
            .collect();
        let mut total: u64 = files.iter().map(|f| f.1).sum();
        if total <= self.budget {
            return;
        }
        files.sort_by_key(|f| f.0);
        let target = self.budget * 8 / 10;
        for (_, len, path) in files {
            if total <= target {
                break;
            }
            if std::fs::remove_file(&path).is_ok() {
                total -= len;
            }
        }
    }
}

fn file_mtime_ns(path: &str) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0)
}

/// PNG thumbnail of 1-based `page`, `width` px wide (one of `WIDTHS`).
pub fn thumb_png(service: &RenderService, cache: &ThumbCache, path: &str, page: u32, width: u32) -> AppResult<Vec<u8>> {
    let key = ThumbCache::key(path, file_mtime_ns(path), page, width);
    if let Some(hit) = cache.get(&key) {
        return Ok(hit);
    }
    let list = service.worker().display_list(path.to_string(), page)?;
    let b = list.bounds();
    let page_w = (b.x1 - b.x0).abs().max(1.0) as f64;
    let img = service
        .page(internal_id(), path.to_string(), page, width as f64 / page_w, Priority::Preview)?
        .ok_or_else(|| crate::error::AppError::Other("thumbnail cancelled".into()))?;
    let png = crate::render::raster::encode_png(&img)?;
    cache.put(&key, &png);
    Ok(png)
}

/// Print resolution: sharp on paper, and a long document's page images still
/// fit in the webview's memory while it lays them out for printing.
pub const PRINT_DPI: f64 = 150.0;

/// PNG of 1-based `page` at `PRINT_DPI`, for printing. Not cached: a print
/// job would push every thumbnail out of the cache. Queued behind the pages
/// on screen, so the viewer stays responsive while a job renders.
pub fn print_png(service: &RenderService, path: &str, page: u32) -> AppResult<Vec<u8>> {
    let img = service
        .page(internal_id(), path.to_string(), page, PRINT_DPI / 72.0, Priority::Prefetch)?
        .ok_or_else(|| crate::error::AppError::Other("print page cancelled".into()))?;
    crate::render::raster::encode_png(&img)
}

/// `/print/<page>?path=<urlenc>` → (path, page).
pub fn parse_print_uri(path_and_query: &str) -> Option<(String, u32)> {
    let (p, q) = path_and_query.split_once('?')?;
    let page: u32 = p.strip_prefix("/print/")?.parse().ok()?;
    if page == 0 {
        return None;
    }
    let pdf = q.split('&').find_map(|kv| kv.strip_prefix("path=")).and_then(percent_decode)?;
    Some((pdf, page))
}

fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'%' => {
                let hex = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
                out.push(u8::from_str_radix(hex, 16).ok()?);
                i += 3;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

/// `/thumb/<page>?path=<urlenc>&w=<128|256|512>[&v=..]` → (path, page, width).
pub fn parse_thumb_uri(path_and_query: &str) -> Option<(String, u32, u32)> {
    let (p, q) = path_and_query.split_once('?')?;
    let page: u32 = p.strip_prefix("/thumb/")?.parse().ok()?;
    if page == 0 {
        return None;
    }
    let mut pdf = None;
    let mut width = None;
    for kv in q.split('&') {
        let (k, v) = kv.split_once('=')?;
        match k {
            "path" => pdf = Some(percent_decode(v)?),
            "w" => width = v.parse::<u32>().ok(),
            _ => {}
        }
    }
    let width = width.filter(|w| WIDTHS.contains(w))?;
    Some((pdf?, page, width))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_print_uri_decodes_path_and_page() {
        assert_eq!(
            parse_print_uri("/print/3?path=%2Fhome%2Fu%2Fa%20b.pdf&v=1"),
            Some(("/home/u/a b.pdf".to_string(), 3))
        );
        assert_eq!(parse_print_uri("/print/0?path=%2Fa.pdf"), None);
        assert_eq!(parse_print_uri("/print/2"), None);
        assert_eq!(parse_print_uri("/thumb/2?path=%2Fa.pdf&w=256"), None);
    }

    #[test]
    fn key_changes_with_mtime_page_and_width() {
        let a = ThumbCache::key("/a.pdf", 1, 1, 256);
        assert_ne!(a, ThumbCache::key("/a.pdf", 2, 1, 256));
        assert_ne!(a, ThumbCache::key("/a.pdf", 1, 2, 256));
        assert_ne!(a, ThumbCache::key("/a.pdf", 1, 1, 128));
        assert_ne!(a, ThumbCache::key("/b.pdf", 1, 1, 256));
        assert_eq!(a, ThumbCache::key("/a.pdf", 1, 1, 256));
    }

    #[test]
    fn put_then_get_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let c = ThumbCache::new(dir.path().to_path_buf(), 1 << 20);
        c.put("k", b"png-bytes");
        assert_eq!(c.get("k").as_deref(), Some(&b"png-bytes"[..]));
        assert!(c.get("missing").is_none());
    }

    #[test]
    fn put_evicts_oldest_beyond_budget() {
        let dir = tempfile::tempdir().unwrap();
        let c = ThumbCache::new(dir.path().to_path_buf(), 250);
        c.put("old", &[0u8; 100]);
        std::thread::sleep(std::time::Duration::from_millis(20));
        c.put("mid", &[0u8; 100]);
        std::thread::sleep(std::time::Duration::from_millis(20));
        c.put("new", &[0u8; 100]); // 300 > 250 → evict down to <= 80% (200)
        assert!(c.get("old").is_none());
        assert!(c.get("mid").is_some());
        assert!(c.get("new").is_some());
    }

    #[test]
    fn parse_thumb_uri_decodes_path_page_width() {
        let got = parse_thumb_uri("/thumb/3?path=%2Fhome%2Fz%2Fmy%20doc.pdf&w=256&v=123");
        assert_eq!(got, Some(("/home/z/my doc.pdf".to_string(), 3, 256)));
    }

    #[test]
    fn parse_thumb_uri_rejects_bad_width_and_shapes() {
        assert_eq!(parse_thumb_uri("/thumb/3?path=%2Fa.pdf&w=300"), None);
        assert_eq!(parse_thumb_uri("/other/3?path=%2Fa.pdf&w=256"), None);
        assert_eq!(parse_thumb_uri("/thumb/x?path=%2Fa.pdf&w=256"), None);
        assert_eq!(parse_thumb_uri("/thumb/0?path=%2Fa.pdf&w=256"), None);
    }
}
