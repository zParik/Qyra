//! Kern <-> Qyra PDF bridge (merge, split).
//!
//! Self-contained: depends only on `lopdf` (+ `jni` on Android). The PDF logic is
//! ported from Qyra's `src-tauri/src/commands/{merge,split}.rs` so this crate does
//! not pull in MuPDF / Tauri and therefore cross-compiles to Android with a plain
//! `cargo ndk` build.
//!
//! License: part of Qyra (GPL-3.0), bridged into Kern (AGPL-3.0).

pub mod pdf {
    //! Pure PDF operations over `lopdf`. No JNI, no Android specifics - unit
    //! testable on the host. Errors are plain `String` messages.

    use lopdf::{Document, Object, ObjectId};
    use std::collections::BTreeMap;
    use std::path::Path;

    /// A 1-based, inclusive page range.
    pub struct PageRange {
        pub start: u32,
        pub end: u32,
    }

    fn stem_of(path: &str, fallback: &str) -> String {
        Path::new(path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(fallback)
            .to_string()
    }

    /// Splits `path` into one file per page, written into `out_dir`.
    /// Returns the absolute output paths.
    pub fn split_per_page(path: &str, out_dir: &str) -> Result<Vec<String>, String> {
        let mut doc = Document::load(path).map_err(|e| e.to_string())?;
        let pages_map = doc.get_pages();
        let total = pages_map.len() as u32;
        if total == 0 {
            return Err("PDF has no pages".to_string());
        }
        let stem = stem_of(path, "page");

        // Locate the Pages root from the catalog.
        let pages_root_id = {
            let catalog = doc.catalog().map_err(|e| e.to_string())?;
            catalog
                .get(b"Pages")
                .and_then(|obj| obj.as_reference())
                .map_err(|e| e.to_string())?
        };

        // Flatten any nested page tree: point every page Parent at the root.
        for (_, &page_obj_id) in &pages_map {
            if let Some(Object::Dictionary(page_dict)) = doc.objects.get_mut(&page_obj_id) {
                page_dict.set("Parent", Object::Reference(pages_root_id));
            }
        }

        let mut outputs = Vec::new();
        for page_num in 1..=total {
            let page_obj_id = pages_map[&page_num];
            // Swap the Kids array to contain only this page, save, then restore.
            let single_kids = Object::Array(vec![Object::Reference(page_obj_id)]);
            let old_kids = if let Some(Object::Dictionary(dict)) = doc.objects.get_mut(&pages_root_id) {
                let old = dict.get(b"Kids").ok().cloned();
                dict.set("Kids", single_kids);
                dict.set("Count", Object::Integer(1));
                old
            } else {
                return Err("Could not find Pages root dictionary".to_string());
            };

            let out = format!("{}/{}_page{:04}.pdf", out_dir, stem, page_num);
            doc.save(&out).map_err(|e| e.to_string())?;
            outputs.push(out);

            if let Some(Object::Dictionary(dict)) = doc.objects.get_mut(&pages_root_id) {
                if let Some(kids) = old_kids {
                    dict.set("Kids", kids);
                }
                dict.set("Count", Object::Integer(total as i64));
            }
        }
        Ok(outputs)
    }

    /// Splits `path` by explicit 1-based page ranges, one output file per range.
    pub fn split_ranges(path: &str, ranges: &[PageRange], out_dir: &str) -> Result<Vec<String>, String> {
        let doc = Document::load(path).map_err(|e| e.to_string())?;
        let total = doc.get_pages().len() as u32;
        let stem = stem_of(path, "split");

        let mut outputs = Vec::new();
        for (i, range) in ranges.iter().enumerate() {
            let start = range.start.max(1);
            let end = range.end.min(total);
            if start > end {
                return Err(format!("Invalid range {}-{}", start, end));
            }
            let pages_to_delete: Vec<u32> = (1..=total).filter(|&p| p < start || p > end).collect();

            let mut part = doc.clone();
            part.delete_pages(&pages_to_delete);

            let out = format!("{}/{}_part{}.pdf", out_dir, stem, i + 1);
            part.save(&out).map_err(|e| e.to_string())?;
            outputs.push(out);
        }
        Ok(outputs)
    }

    /// Merges `paths` (in order) into a single file at `output`.
    pub fn merge(paths: &[&str], output: &str) -> Result<Vec<String>, String> {
        if paths.len() < 2 {
            return Err("Need at least 2 files to merge".to_string());
        }
        let mut documents = Vec::with_capacity(paths.len());
        for p in paths {
            let doc = Document::load(p).map_err(|e| format!("Failed to load {}: {}", p, e))?;
            documents.push(doc);
        }
        let mut merged = merge_documents(documents)?;
        merged.save(output).map_err(|e| e.to_string())?;
        Ok(vec![output.to_string()])
    }

    /// Combines page trees of multiple documents into one (lopdf merge example).
    fn merge_documents(mut documents: Vec<Document>) -> Result<Document, String> {
        let mut max_id = 1u32;
        let mut documents_pages: BTreeMap<ObjectId, Object> = BTreeMap::new();
        let mut documents_objects: BTreeMap<ObjectId, Object> = BTreeMap::new();
        let mut document = Document::with_version("1.5");

        for doc in documents.iter_mut() {
            doc.renumber_objects_with(max_id);
            max_id = doc.max_id + 1;

            doc.get_pages().into_values().for_each(|object_id| {
                if let Ok(obj) = doc.get_object(object_id) {
                    documents_pages.insert(object_id, obj.to_owned());
                }
            });

            documents_objects.extend(doc.objects.clone());
        }

        let mut catalog_object: Option<(ObjectId, Object)> = None;
        let mut pages_object: Option<(ObjectId, Object)> = None;

        for (object_id, object) in documents_objects.into_iter() {
            match object.type_name().unwrap_or(b"") {
                b"Catalog" => {
                    catalog_object = Some((
                        if let Some((id, _)) = catalog_object { id } else { object_id },
                        object,
                    ));
                }
                b"Pages" => {
                    if let Ok(dictionary) = object.as_dict() {
                        let mut dictionary = dictionary.clone();
                        if let Some((_, ref existing)) = pages_object {
                            if let Ok(old_dict) = existing.as_dict() {
                                dictionary.extend(old_dict);
                            }
                        }
                        pages_object = Some((
                            if let Some((id, _)) = pages_object { id } else { object_id },
                            Object::Dictionary(dictionary),
                        ));
                    }
                }
                b"Page" | b"Outlines" | b"Outline" => {} // handled separately
                _ => {
                    document.objects.insert(object_id, object);
                }
            }
        }

        let pages_object = pages_object.ok_or_else(|| "Pages root not found in source PDFs".to_string())?;
        let catalog_object = catalog_object.ok_or_else(|| "Catalog not found in source PDFs".to_string())?;

        for (object_id, object) in documents_pages.iter() {
            if let Ok(dictionary) = object.as_dict() {
                let mut dictionary = dictionary.clone();
                dictionary.set("Parent", pages_object.0);
                document.objects.insert(*object_id, Object::Dictionary(dictionary));
            }
        }

        let (page_id, page_object) = pages_object;
        let (catalog_id, catalog_object) = catalog_object;

        if let Ok(dictionary) = page_object.as_dict() {
            let mut dictionary = dictionary.clone();
            dictionary.set("Count", documents_pages.len() as u32);
            dictionary.set(
                "Kids",
                documents_pages.keys().map(|&id| Object::Reference(id)).collect::<Vec<_>>(),
            );
            document.objects.insert(page_id, Object::Dictionary(dictionary));
        }

        if let Ok(dictionary) = catalog_object.as_dict() {
            let mut dictionary = dictionary.clone();
            dictionary.set("Pages", page_id);
            dictionary.remove(b"Outlines");
            document.objects.insert(catalog_id, Object::Dictionary(dictionary));
        }

        document.trailer.set("Root", catalog_id);
        document.max_id = document.objects.len() as u32;
        document.renumber_objects();
        document.adjust_zero_pages();

        Ok(document)
    }

    /// Parses `"1-3,5,7-9"` into a list of [`PageRange`]. Whitespace tolerant.
    pub fn parse_ranges(spec: &str) -> Result<Vec<PageRange>, String> {
        let mut out = Vec::new();
        for token in spec.split(',') {
            let token = token.trim();
            if token.is_empty() {
                continue;
            }
            let (start, end) = match token.split_once('-') {
                Some((a, b)) => (a.trim(), b.trim()),
                None => (token, token),
            };
            let start: u32 = start.parse().map_err(|_| format!("Bad page number: {}", start))?;
            let end: u32 = end.parse().map_err(|_| format!("Bad page number: {}", end))?;
            if start == 0 || end == 0 {
                return Err("Pages are 1-based; 0 is not valid".to_string());
            }
            if start > end {
                return Err(format!("Range {}-{} is backwards", start, end));
            }
            out.push(PageRange { start, end });
        }
        Ok(out)
    }
}

/// JNI surface - Android only. Maps to `dev.kern.pdfbridge.QyraPdf` native methods.
///
/// Each export returns a small JSON string the Kotlin side parses:
///   success: {"ok":true,"paths":["/abs/out1.pdf", ...]}
///   failure: {"ok":false,"error":"message"}
#[cfg(target_os = "android")]
mod android {
    use crate::pdf;
    use jni::objects::{JClass, JString};
    use jni::sys::jstring;
    use jni::JNIEnv;

    fn json_result(env: &mut JNIEnv, result: Result<Vec<String>, String>) -> jstring {
        let json = match result {
            Ok(paths) => {
                let items: Vec<String> = paths.iter().map(|p| format!("{:?}", p)).collect();
                format!("{{\"ok\":true,\"paths\":[{}]}}", items.join(","))
            }
            Err(e) => format!("{{\"ok\":false,\"error\":{:?}}}", e),
        };
        env.new_string(json).map(|s| s.into_raw()).unwrap_or(std::ptr::null_mut())
    }

    fn read_string(env: &mut JNIEnv, s: &JString) -> Result<String, String> {
        env.get_string(s).map(|js| js.into()).map_err(|e| e.to_string())
    }

    #[no_mangle]
    pub extern "system" fn Java_dev_kern_pdfbridge_QyraPdf_nativeSplitPerPage<'local>(
        mut env: JNIEnv<'local>,
        _class: JClass<'local>,
        path: JString<'local>,
        out_dir: JString<'local>,
    ) -> jstring {
        let result = (|| -> Result<Vec<String>, String> {
            let path = read_string(&mut env, &path)?;
            let out_dir = read_string(&mut env, &out_dir)?;
            pdf::split_per_page(&path, &out_dir)
        })();
        json_result(&mut env, result)
    }

    #[no_mangle]
    pub extern "system" fn Java_dev_kern_pdfbridge_QyraPdf_nativeSplitRanges<'local>(
        mut env: JNIEnv<'local>,
        _class: JClass<'local>,
        path: JString<'local>,
        ranges_spec: JString<'local>,
        out_dir: JString<'local>,
    ) -> jstring {
        let result = (|| -> Result<Vec<String>, String> {
            let path = read_string(&mut env, &path)?;
            let spec = read_string(&mut env, &ranges_spec)?;
            let out_dir = read_string(&mut env, &out_dir)?;
            let ranges = pdf::parse_ranges(&spec)?;
            if ranges.is_empty() {
                return Err("No page ranges were provided".to_string());
            }
            pdf::split_ranges(&path, &ranges, &out_dir)
        })();
        json_result(&mut env, result)
    }

    #[no_mangle]
    pub extern "system" fn Java_dev_kern_pdfbridge_QyraPdf_nativeMerge<'local>(
        mut env: JNIEnv<'local>,
        _class: JClass<'local>,
        paths_joined: JString<'local>,
        output: JString<'local>,
    ) -> jstring {
        let result = (|| -> Result<Vec<String>, String> {
            let joined = read_string(&mut env, &paths_joined)?;
            let output = read_string(&mut env, &output)?;
            let paths: Vec<&str> = joined.split('\n').filter(|s| !s.is_empty()).collect();
            pdf::merge(&paths, &output)
        })();
        json_result(&mut env, result)
    }
}
