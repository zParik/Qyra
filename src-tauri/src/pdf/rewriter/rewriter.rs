/// Two-pass PDF rewriter orchestrator.
///
/// Pass 1 : PdfReader::new() — parse xref, unpack ObjStm streams.
/// Pass 2a: parallel — for each object, parse from raw bytes + transform.
/// Pass 2b: sequential — write results in order, emit xref table.
///
/// There is NO "load all objects into Vec" step — InUse objects are parsed
/// directly inside the parallel transform, avoiding O(n²) scan_for_endstream
/// and the 138 MB worth of sequential clone allocations.
use std::collections::HashSet;
use std::fs::File;
use std::io::BufWriter;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use rayon::prelude::*;

use crate::pdf::error::PdfError;
use crate::pdf::parser::object::parse_indirect_object;
use crate::pdf::parser::PdfReader;
use crate::pdf::rewriter::config::CompressConfig;
use crate::pdf::rewriter::placement::analyze_placements;
use crate::pdf::rewriter::plan::{build_plans, ImagePlan, PlanMap};
use crate::pdf::rewriter::transforms::{is_metadata_stream, recompress_image, recompress_stream};
use crate::pdf::source::Bytes;
use crate::pdf::types::{ObjectId, PdfDict, PdfObject, XrefEntry};
use crate::pdf::writer::PdfWriter;

pub struct Rewriter {
    config: CompressConfig,
}

impl Rewriter {
    pub fn new(level: u8) -> Self {
        Rewriter {
            config: CompressConfig::from_level(level),
        }
    }

    /// Compress `source` and STREAM the result to `out_path`. Returns the number
    /// of bytes written. Output goes straight to disk (object-by-object), so the
    /// whole compressed document never has to live in the heap; validation reads
    /// the written file back via mmap rather than cloning it.
    pub fn run(
        &self,
        source: Bytes,
        out_path: &Path,
        progress_cb: impl Fn(usize, usize, &str) + Send + Sync,
        cancel: &AtomicBool,
    ) -> Result<u64, PdfError> {
        // ---------------------------------------------------------------
        // Pass 1: parse xref + eagerly unpack all ObjStm streams.
        // ---------------------------------------------------------------
        #[cfg(debug_assertions)]
        eprintln!("[compress] Pass 1: parsing xref + unpacking ObjStm streams…");
        progress_cb(0, 1, "Reading PDF");
        let mut reader = PdfReader::from_source(source)?;
        let trailer = reader.trailer().clone();
        let expected_pages = reader.pages().map(|p| p.len()).unwrap_or(0);

        let mut all_ids: Vec<ObjectId> = reader.all_object_ids();
        all_ids.sort_unstable();
        #[cfg(debug_assertions)]
        eprintln!("[compress] ready — {} objects indexed", all_ids.len());

        // ---------------------------------------------------------------
        // Build exclusion set (metadata objects to drop).
        // ---------------------------------------------------------------
        let mut excluded: HashSet<ObjectId> = HashSet::new();
        if self.config.strip_metadata {
            if let Some(r) = trailer.get(b"Info").and_then(|v| v.as_reference()) {
                excluded.insert(r);
            }
            if let Some(r) = trailer.get(b"Metadata").and_then(|v| v.as_reference()) {
                excluded.insert(r);
            }
            if let Ok(page_ids) = reader.pages() {
                for page_id in page_ids {
                    if let Ok(obj) = reader.get_object(page_id) {
                        if let Some(r) = obj
                            .as_dict()
                            .and_then(|d| d.get(b"Thumb"))
                            .and_then(|v| v.as_reference())
                        {
                            excluded.insert(r);
                        }
                    }
                }
            }
        }

        // ---------------------------------------------------------------
        // Image pre-pass (sequential, needs reader): walk content streams to
        // learn each image's drawn size, then resolve colour spaces + target
        // resolution into a self-contained ImagePlan per image. This is what
        // closes the gap to Ghostscript — DPI-based downsampling of ICCBased /
        // CMYK / Indexed images the old per-object path could not touch.
        // ---------------------------------------------------------------
        let plans: PlanMap = if self.config.compress_images() {
            progress_cb(0, 1, "Analyzing images");
            let placements = analyze_placements(&mut reader);
            build_plans(&mut reader, &self.config, &placements)
        } else {
            PlanMap::new()
        };
        #[cfg(debug_assertions)]
        eprintln!("[compress] image pre-pass: {} image plans", plans.len());

        // ---------------------------------------------------------------
        // Extract raw parts from reader — no more sequential access needed.
        // data: immutable raw bytes shared across threads via &[u8].
        // objstm_cache: already fully populated at construction time.
        // xref: needed to know each object's location.
        // sorted_offsets: needed to bound stream scans per-object.
        // ---------------------------------------------------------------
        let (data, xref, objstm_cache, sorted_offsets) = reader.into_parts();

        // Build the work list: filter excluded + format-internal objects.
        // We store (ObjectId, XrefEntry) — no raw bytes yet.
        let work: Vec<(ObjectId, XrefEntry)> = all_ids
            .iter()
            .filter_map(|&id| {
                if excluded.contains(&id) {
                    return None;
                }
                let entry = xref.entries.get(&id)?.clone();
                if matches!(entry, XrefEntry::Free) {
                    return None;
                }
                Some((id, entry))
            })
            .collect();

        let work_total = work.len();
        #[cfg(debug_assertions)]
        eprintln!("[compress] Pass 2a: transforming {} objects in parallel…", work_total);

        // ---------------------------------------------------------------
        // Pass 2a: parallel parse + transform.
        //
        // InUse objects: parse_indirect_object on a bounded slice of `data`
        //   — safe because &data is immutable and the slice is per-object.
        // Compressed objects: index into the pre-built objstm_cache (read-only).
        // ---------------------------------------------------------------
        let config = &self.config;
        let plans_ref = &plans;
        let data_ref: &[u8] = &data;
        let done_count = Arc::new(AtomicUsize::new(0));
        // Show the bar at 0 immediately so a slow first object doesn't look stuck.
        progress_cb(0, work_total, "Compressing");

        // The transform body. Runs over `&work` (borrowed) so nothing it touches
        // — including `progress_cb` — has to be moved into it; that lets us run
        // it on a dedicated, capped pool below without losing the closure for the
        // sequential phases that follow.
        let run_transform = || -> Vec<(ObjectId, Result<PdfObject, PdfError>)> {
            work
                .par_iter()
                .map(|(id, entry)| {
                    let id = *id;
                    if cancel.load(Ordering::Relaxed) {
                        return (id, Ok(PdfObject::Null));
                    }
                    let obj = match entry {
                        XrefEntry::InUse { offset } => {
                            let offset = *offset;
                            // Bound slice to [offset, next_object_offset] so any
                            // scan_for_endstream fallback can't read the whole file.
                            let end = {
                                let idx = sorted_offsets.partition_point(|&o| o <= offset);
                                sorted_offsets
                                    .get(idx)
                                    .copied()
                                    .unwrap_or(data_ref.len() as u64) as usize
                            };
                            let slice = &data_ref[offset as usize..end];
                            match parse_indirect_object(slice, 0) {
                                Ok((_, o)) => o,
                                Err(_) => return (id, Ok(PdfObject::Null)),
                            }
                        }
                        XrefEntry::Compressed { obj_stream_id, index } => objstm_cache
                            .get(obj_stream_id)
                            .and_then(|v| v.get(*index as usize))
                            .map(|(_, o)| o.clone())
                            .unwrap_or(PdfObject::Null),
                        XrefEntry::Free => return (id, Ok(PdfObject::Null)),
                    };

                    // Skip format-internal objects (xref streams, object streams).
                    if let Some(dict) = obj.as_dict() {
                        let t = dict.get_type();
                        if t == Some(b"XRef") || t == Some(b"ObjStm") {
                            return (id, Ok(PdfObject::Null));
                        }
                    }

                    let result = transform_object(config, obj, plans_ref.get(&id));
                    let done = done_count.fetch_add(1, Ordering::Relaxed) + 1;
                    // Throttle: emit on the first + every 50 to avoid flooding the bus.
                    if done == 1 || done % 50 == 0 || done == work_total {
                        progress_cb(done, work_total, "Compressing");
                    }
                    (id, result)
                })
                .collect()
        };

        // Run on a capped, de-prioritised pool, then DROP it so its worker
        // threads are torn down the moment the job ends — they can't linger or
        // spin on the cores afterwards. Falls back to the (startup-capped) global
        // pool if the dedicated one can't be built.
        let transformed: Vec<(ObjectId, Result<PdfObject, PdfError>)> =
            match build_compress_pool() {
                Some(pool) => pool.install(run_transform),
                None => run_transform(),
            };

        if cancel.load(Ordering::Relaxed) {
            return Err(PdfError::Cancelled);
        }

        // Free the input bytes, the unpacked object-stream cache, and the image
        // plans now — the transform is done with them, and the write/dedup/gc
        // phase below builds its own buffers. Releasing here keeps peak memory to
        // roughly one copy of the document, which is what keeps phones off the
        // OOM killer. (Borrows into these ended when the pool closure returned.)
        drop(data);
        drop(objstm_cache);
        drop(plans);

        // ---------------------------------------------------------------
        // Pass 2b: collect live objects, then write with object streams
        // (validated) or fall back to a classic xref table.
        // ---------------------------------------------------------------
        #[cfg(debug_assertions)]
        eprintln!("[compress] Pass 2b: writing {} objects…", work_total);

        let live: Vec<(ObjectId, PdfObject)> = transformed
            .into_iter()
            .filter_map(|(id, r)| match r {
                Ok(PdfObject::Null) => None,
                Ok(obj) => Some(Ok((id, obj))),
                Err(e) => Some(Err(e)),
            })
            .collect::<Result<Vec<_>, PdfError>>()?;
        progress_cb(work_total, work_total, "Writing objects");

        // Collapse byte-identical objects (repeated images/fonts/resources).
        progress_cb(0, 1, "Deduplicating objects");
        let (live, remap) = crate::pdf::rewriter::dedup::dedup(live);

        let mut out_trailer = trailer;
        out_trailer.remove(b"Encrypt");
        out_trailer.remove(b"XRefStm");
        out_trailer.remove(b"Prev");
        if self.config.strip_metadata {
            out_trailer.remove(b"Info");
            out_trailer.remove(b"Metadata");
        }
        if !remap.is_empty() {
            for (_, v) in out_trailer.0.iter_mut() {
                crate::pdf::rewriter::dedup::remap_refs(v, &remap);
            }
        }

        // Drop objects unreachable from the trailer (orphaned fonts/images/etc.).
        progress_cb(0, 1, "Removing unused objects");
        let live = crate::pdf::rewriter::gc::gc(live, &out_trailer);

        // Stream the compressed PDF straight to `out_path`. Preferred path:
        // object streams + xref stream, then validate by re-opening the file
        // (mmap) and checking the page count. If that fails, rewrite a classic
        // xref table in its place. The full output never lives in the heap.
        progress_cb(0, 1, "Writing compressed PDF");

        let objstm_ok = match write_object_streams_to(out_path, &live, &out_trailer) {
            Ok(()) => validate_output(out_path, expected_pages),
            Err(_e) => {
                #[cfg(debug_assertions)]
                eprintln!("[compress] object-stream write failed: {_e}; falling back");
                false
            }
        };

        if !objstm_ok {
            // Fallback: classic cross-reference table (trusted, no re-validation).
            write_classic_to(out_path, &live, out_trailer)?;
        }

        let written = std::fs::metadata(out_path)?.len();
        #[cfg(debug_assertions)]
        eprintln!("[compress] done — {} bytes out", written);
        Ok(written)
    }
}

// ---------------------------------------------------------------------------
// Output writers (stream to disk) + validation
// ---------------------------------------------------------------------------

/// Write `live` to `path` using object streams + an xref stream, streamed.
fn write_object_streams_to(
    path: &Path,
    live: &[(ObjectId, PdfObject)],
    trailer: &PdfDict,
) -> Result<(), PdfError> {
    let file = File::create(path)?;
    let mut w = PdfWriter::new(BufWriter::new(file));
    w.write_header()?;
    w.write_with_object_streams(live, trailer.clone())?;
    w.finish()?;
    Ok(())
}

/// Write `live` to `path` using a classic cross-reference table, streamed.
fn write_classic_to(
    path: &Path,
    live: &[(ObjectId, PdfObject)],
    trailer: PdfDict,
) -> Result<(), PdfError> {
    let file = File::create(path)?;
    let mut w = PdfWriter::new(BufWriter::new(file));
    w.write_header()?;
    for (id, obj) in live {
        w.write_object(*id, obj)?;
    }
    w.write_xref_and_trailer(trailer)?;
    w.finish()?;
    Ok(())
}

/// Re-open the written file (mmap) and confirm the page count matches. The
/// reader — and its mapping — is dropped before this returns, so a fallback
/// rewrite of the same path is free to truncate it.
fn validate_output(path: &Path, expected_pages: usize) -> bool {
    match PdfReader::open(path) {
        Ok(mut r) => matches!(r.pages(), Ok(p) if p.len() == expected_pages),
        Err(_) => false,
    }
}

// ---------------------------------------------------------------------------
// Transform dispatch — free function so it's usable inside par_iter.
// ---------------------------------------------------------------------------

fn transform_object(
    config: &CompressConfig,
    obj: PdfObject,
    plan: Option<&ImagePlan>,
) -> Result<PdfObject, PdfError> {
    match obj {
        PdfObject::Stream(stream) => {
            let subtype = stream.dict.get_subtype().map(|s| s.to_vec());

            if config.strip_metadata && is_metadata_stream(&stream.dict) {
                return Ok(PdfObject::Null);
            }

            // Image with a plan: downsample + DCT re-encode (GS-parity path).
            if config.compress_images() && subtype.as_deref() == Some(b"Image") {
                if let Some(plan) = plan {
                    let recompressed = recompress_image(stream, plan, config.jpeg_quality)?;
                    return Ok(PdfObject::Stream(recompressed));
                }
                // No plan (mono/mask/unsupported space): fall through to a
                // lossless re-flate below — never worse than the original.
            }

            if config.recompress_streams {
                let recompressed = recompress_stream(stream, config.zlib_level)?;
                return Ok(PdfObject::Stream(recompressed));
            }

            Ok(PdfObject::Stream(stream))
        }
        other => Ok(other),
    }
}

// ---------------------------------------------------------------------------
// Scheduling — keep the box usable while compressing.
// ---------------------------------------------------------------------------

/// Build a per-call, capped, de-prioritised rayon pool for the transform pass.
///
/// Returned by value so the caller can DROP it right after the job — that tears
/// the worker threads down immediately, so they can never linger or spin on the
/// cores once compression has finished (the symptom we kept chasing).
///
/// Capped to half the cores (min 2, max 8) so a compression never pins every
/// core, and at most that many full-resolution images decode at once (memory).
/// Phones: at most 2 workers (tighter memory + thermal headroom). Worker threads
/// run at below-normal priority so they yield to the UI/audio.
fn build_compress_pool() -> Option<rayon::ThreadPool> {
    let cores = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(2);
    let workers = if cfg!(target_os = "android") {
        cores.saturating_sub(1).clamp(1, 2)
    } else {
        (cores / 2).clamp(2, 8).min(cores.max(1))
    };
    rayon::ThreadPoolBuilder::new()
        .num_threads(workers)
        .thread_name(|i| format!("qyra-compress-{i}"))
        .start_handler(|_| lower_current_thread_priority())
        .build()
        .ok()
}

/// Drop the calling thread's scheduling priority so it yields to foreground
/// work. No-op where we don't have a cheap per-thread hook.
#[cfg(windows)]
fn lower_current_thread_priority() {
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

// unix covers Linux, macOS AND Android (bionic has setpriority; libc is a dep on
// all three). Phones especially need this so the compressor yields instead of
// cooking the CPU / tripping thermal throttling.
#[cfg(unix)]
fn lower_current_thread_priority() {
    // setpriority(PRIO_PROCESS, 0, ..) applies to the calling thread on Linux.
    unsafe {
        libc::setpriority(libc::PRIO_PROCESS, 0, 10);
    }
}

#[cfg(not(any(windows, unix)))]
fn lower_current_thread_priority() {}
