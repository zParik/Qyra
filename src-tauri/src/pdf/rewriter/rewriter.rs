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
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use rayon::prelude::*;

use crate::pdf::error::PdfError;
use crate::pdf::parser::object::parse_indirect_object;
use crate::pdf::parser::PdfReader;
use crate::pdf::rewriter::config::CompressConfig;
use crate::pdf::rewriter::transforms::{is_metadata_stream, recompress_image, recompress_stream};
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

    pub fn run(
        &self,
        input_bytes: Vec<u8>,
        progress_cb: impl Fn(usize, usize, &str) + Send + Sync,
        cancel: &AtomicBool,
    ) -> Result<Vec<u8>, PdfError> {
        // ---------------------------------------------------------------
        // Pass 1: parse xref + eagerly unpack all ObjStm streams.
        // ---------------------------------------------------------------
        #[cfg(debug_assertions)]
        eprintln!("[compress] Pass 1: parsing xref + unpacking ObjStm streams…");
        progress_cb(0, 1, "Reading PDF");
        let mut reader = PdfReader::new(input_bytes)?;
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
        let trailer_ref = &trailer;
        let data_ref: &[u8] = &data;
        let done_count = Arc::new(AtomicUsize::new(0));
        // Show the bar at 0 immediately so a slow first object doesn't look stuck.
        progress_cb(0, work_total, "Compressing");

        let transformed: Vec<(ObjectId, Result<PdfObject, PdfError>)> = work
            .into_par_iter()
            .map(|(id, entry)| {
                if cancel.load(Ordering::Relaxed) {
                    return (id, Ok(PdfObject::Null));
                }
                let obj = match entry {
                    XrefEntry::InUse { offset } => {
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
                    XrefEntry::Compressed { obj_stream_id, index } => {
                        objstm_cache
                            .get(&obj_stream_id)
                            .and_then(|v| v.get(index as usize))
                            .map(|(_, o)| o.clone())
                            .unwrap_or(PdfObject::Null)
                    }
                    XrefEntry::Free => return (id, Ok(PdfObject::Null)),
                };

                // Skip format-internal objects (xref streams, object streams).
                if let Some(dict) = obj.as_dict() {
                    let t = dict.get_type();
                    if t == Some(b"XRef") || t == Some(b"ObjStm") {
                        return (id, Ok(PdfObject::Null));
                    }
                }

                let result = transform_object(config, obj, trailer_ref);
                let done = done_count.fetch_add(1, Ordering::Relaxed) + 1;
                // Throttle: emit on the first + every 50 to avoid flooding the bus.
                if done == 1 || done % 50 == 0 || done == work_total {
                    progress_cb(done, work_total, "Compressing");
                }
                (id, result)
            })
            .collect();

        if cancel.load(Ordering::Relaxed) {
            return Err(PdfError::Cancelled);
        }

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

        // Preferred path: object streams + xref stream.
        progress_cb(0, 1, "Writing compressed PDF");
        let objstm_bytes = {
            let mut w = PdfWriter::new();
            w.write_header();
            match w.write_with_object_streams(&live, out_trailer.clone()) {
                Ok(()) => Some(w.finish()),
                Err(_e) => {
                    #[cfg(debug_assertions)]
                    eprintln!("[compress] object-stream write failed: {_e}; falling back");
                    None
                }
            }
        };

        // Validate by re-parsing; page count must match the input.
        let validated = objstm_bytes.and_then(|bytes| match PdfReader::new(bytes.clone()) {
            Ok(mut r) => match r.pages() {
                Ok(p) if p.len() == expected_pages => Some(bytes),
                _ => None,
            },
            Err(_) => None,
        });

        let result = match validated {
            Some(bytes) => bytes,
            None => {
                // Fallback: classic cross-reference table.
                let mut w = PdfWriter::new();
                w.write_header();
                for (id, obj) in &live {
                    w.write_object(*id, obj)?;
                }
                w.write_xref_and_trailer(out_trailer)?;
                w.finish()
            }
        };
        #[cfg(debug_assertions)]
        eprintln!("[compress] done — {} bytes out", result.len());
        Ok(result)
    }
}

// ---------------------------------------------------------------------------
// Transform dispatch — free function so it's usable inside par_iter.
// ---------------------------------------------------------------------------

fn transform_object(
    config: &CompressConfig,
    obj: PdfObject,
    _trailer: &PdfDict,
) -> Result<PdfObject, PdfError> {
    match obj {
        PdfObject::Stream(stream) => {
            let subtype = stream.dict.get_subtype().map(|s| s.to_vec());

            if config.strip_metadata && is_metadata_stream(&stream.dict) {
                return Ok(PdfObject::Null);
            }

            if config.compress_images() && subtype.as_deref() == Some(b"Image") {
                let recompressed = recompress_image(
                    stream,
                    config.jpeg_quality,
                    config.to_grayscale,
                    config.max_image_dimension,
                )?;
                return Ok(PdfObject::Stream(recompressed));
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
