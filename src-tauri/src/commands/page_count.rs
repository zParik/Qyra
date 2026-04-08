use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};

/// Returns the page count by reading only the XRef table and two PDF objects
/// (Catalog → Pages). Total I/O: a few KB. No full document parse.
///
/// Only handles traditional XRef tables. Returns Err for cross-reference
/// streams (PDF ≥ 1.5) — the caller should fall back to PDF.js in that case.
#[tauri::command]
pub async fn get_page_count(path: String) -> Result<usize, String> {
    tokio::task::spawn_blocking(move || page_count_fast(&path).map_err(|e| e.to_string()))
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

fn page_count_fast(path: &str) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
    let mut f = File::open(path)?;
    let size = f.metadata()?.len();

    // ── 1. Find startxref offset in the last 1 KB ────────────────────────────
    let tail_start = size.saturating_sub(1024);
    f.seek(SeekFrom::Start(tail_start))?;
    let mut tail = vec![0u8; (size - tail_start) as usize];
    f.read_exact(&mut tail)?;

    let sxref_pos = tail
        .windows(9)
        .enumerate()
        .filter(|(_, w)| *w == b"startxref")
        .last()
        .map(|(i, _)| i)
        .ok_or("startxref not found")?;

    let xref_off: u64 = std::str::from_utf8(&tail[sxref_pos + 9..])?
        .split_ascii_whitespace()
        .next()
        .and_then(|s| s.parse().ok())
        .ok_or("invalid xref offset")?;

    // ── 2. Check XRef type ───────────────────────────────────────────────────
    f.seek(SeekFrom::Start(xref_off))?;
    let mut sig = [0u8; 8];
    f.read_exact(&mut sig)?;

    if !sig.starts_with(b"xref") {
        // Cross-reference stream (PDF 1.5+) — needs decompression, not handled here.
        return Err("xref stream — use PDF.js fallback".into());
    }

    // ── 3. Read the XRef table + trailer (cap at 4 MB) ──────────────────────
    let chunk_size = ((size - xref_off).min(4 * 1024 * 1024)) as usize;
    f.seek(SeekFrom::Start(xref_off))?;
    let mut chunk = vec![0u8; chunk_size];
    let n = f.read(&mut chunk)?;
    chunk.truncate(n);

    let text = std::str::from_utf8(&chunk)?;

    // Build obj_id → file_offset map from XRef entries
    let mut offsets: HashMap<u32, u64> = HashMap::new();
    let mut lines = text.lines();
    lines.next(); // skip "xref"

    let mut next_id: u32 = 0;
    let mut in_subsection = false;

    for line in lines.by_ref() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if line == "trailer" {
            break;
        }
        let parts: Vec<&str> = line.split_ascii_whitespace().collect();
        // Subsection header: "<first_id> <count>"
        if parts.len() == 2 {
            if let (Ok(start), Ok(_)) = (parts[0].parse::<u32>(), parts[1].parse::<u32>()) {
                next_id = start;
                in_subsection = true;
                continue;
            }
        }
        // Entry: "<offset> <gen> n|f"
        if parts.len() >= 3 && in_subsection {
            if parts[2] == "n" {
                if let Ok(off) = parts[0].parse::<u64>() {
                    offsets.insert(next_id, off);
                }
            }
            next_id += 1;
        }
    }

    // ── 4. Parse trailer to find /Root ───────────────────────────────────────
    let trailer_pos = text.rfind("trailer").ok_or("trailer not found")?;
    let trailer = &text[trailer_pos..];
    let root_id = extract_ref(trailer, "/Root").ok_or("/Root missing from trailer")?;

    // ── 5. Read Catalog object to find /Pages ────────────────────────────────
    let root_off = *offsets.get(&root_id).ok_or("Root object offset not in XRef")?;
    let cat = read_obj(&mut f, root_off, 1024)?;
    let pages_id = extract_ref(&cat, "/Pages").ok_or("/Pages missing from Catalog")?;

    // ── 6. Read Pages object to get /Count ───────────────────────────────────
    let pages_off = *offsets.get(&pages_id).ok_or("Pages object offset not in XRef")?;
    let pages = read_obj(&mut f, pages_off, 1024)?;
    extract_int(&pages, "/Count").ok_or_else(|| "/Count missing from Pages dict".into())
}

// ── Helpers ──────────────────────────────────────────────────────────────────

fn read_obj(f: &mut File, offset: u64, max: usize) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    f.seek(SeekFrom::Start(offset))?;
    let mut buf = vec![0u8; max];
    let n = f.read(&mut buf)?;
    buf.truncate(n);
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

fn extract_ref(text: &str, key: &str) -> Option<u32> {
    let pos = text.find(key)?;
    let mut parts = text[pos + key.len()..].split_ascii_whitespace();
    let id: u32 = parts.next()?.parse().ok()?;
    let _gen: u16 = parts.next()?.parse().ok()?;
    if parts.next()? != "R" {
        return None;
    }
    Some(id)
}

fn extract_int(text: &str, key: &str) -> Option<usize> {
    let pos = text.find(key)?;
    text[pos + key.len()..].split_ascii_whitespace().next()?.parse().ok()
}
