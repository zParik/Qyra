use lopdf::{Dictionary, Document, Object, ObjectId, Stream, StringFormat};

const ATTACHMENT_KEY: &[u8] = b"qyra-comments";
const ATTACHMENT_FILENAME: &[u8] = b"qyra-comments.json";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn obj_as_ref(obj: &Object) -> Option<ObjectId> {
    match obj {
        Object::Reference(id) => Some(*id),
        _ => None,
    }
}

fn obj_as_dict(obj: &Object) -> Option<&Dictionary> {
    match obj {
        Object::Dictionary(d) => Some(d),
        _ => None,
    }
}

fn obj_as_array(obj: &Object) -> Option<&Vec<Object>> {
    match obj {
        Object::Array(arr) => Some(arr),
        _ => None,
    }
}

fn get_dict<'a>(doc: &'a Document, id: ObjectId) -> Option<&'a Dictionary> {
    obj_as_dict(doc.get_object(id).ok()?)
}

/// Walk Catalog -> Names -> EmbeddedFiles -> Names array.
/// Returns the stream ObjectId of the embedded qyra-comments JSON, if present.
fn find_comments_stream(doc: &Document) -> Option<ObjectId> {
    // Step 1: catalog reference
    let root_ref = obj_as_ref(doc.trailer.get(b"Root").ok()?)?;

    // Step 2: /Names reference from catalog
    let names_ref = {
        let catalog = get_dict(doc, root_ref)?;
        obj_as_ref(catalog.get(b"Names").ok()?)?
    };

    // Step 3: /EmbeddedFiles reference from Names dict
    let ef_ref = {
        let names_dict = get_dict(doc, names_ref)?;
        obj_as_ref(names_dict.get(b"EmbeddedFiles").ok()?)?
    };

    // Step 4: find our key in the EmbeddedFiles /Names array → FileSpec ref
    let filespec_ref = {
        let ef_dict = get_dict(doc, ef_ref)?;
        let arr = obj_as_array(ef_dict.get(b"Names").ok()?)?;

        let mut found: Option<ObjectId> = None;
        let mut i = 0;
        while i + 1 < arr.len() {
            if let Object::String(key, _) = &arr[i] {
                if key.as_slice() == ATTACHMENT_KEY {
                    found = obj_as_ref(&arr[i + 1]);
                    break;
                }
            }
            i += 2;
        }
        found?
    };

    // Step 5: FileSpec /EF /F → stream ref
    {
        let filespec = get_dict(doc, filespec_ref)?;
        let ef_val = filespec.get(b"EF").ok()?;
        let ef_dict = match ef_val {
            Object::Dictionary(d) => d,
            Object::Reference(id) => get_dict(doc, *id)?,
            _ => return None,
        };
        obj_as_ref(ef_dict.get(b"F").ok()?)
    }
}

// ---------------------------------------------------------------------------
// Collect the IDs of the Names/EmbeddedFiles structure (all immutable borrows
// happen here, before any mutation).
// ---------------------------------------------------------------------------

struct NamesStructure {
    root_ref: ObjectId,
    names_ref: Option<ObjectId>,
    ef_names_ref: Option<ObjectId>,
}

fn collect_structure(doc: &Document) -> Option<NamesStructure> {
    let root_ref = obj_as_ref(doc.trailer.get(b"Root").ok()?)?;

    let names_ref = {
        let catalog = get_dict(doc, root_ref)?;
        catalog.get(b"Names").ok().and_then(obj_as_ref)
    };

    let ef_names_ref = names_ref.and_then(|nid| {
        let names_dict = get_dict(doc, nid)?;
        names_dict.get(b"EmbeddedFiles").ok().and_then(obj_as_ref)
    });

    Some(NamesStructure { root_ref, names_ref, ef_names_ref })
}

// ---------------------------------------------------------------------------
// Public Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn load_comments(path: String) -> Result<String, String> {
    let doc = Document::load(&path).map_err(|e| e.to_string())?;

    let stream_id = match find_comments_stream(&doc) {
        None => return Ok("[]".to_string()),
        Some(id) => id,
    };

    let obj = doc.get_object(stream_id).map_err(|e| e.to_string())?;
    let stream = match obj {
        Object::Stream(s) => s,
        _ => return Ok("[]".to_string()),
    };

    // stream.content holds raw bytes (possibly FlateDecode-compressed).
    // We never write with a filter, so this is almost always plain JSON.
    let bytes = match stream.dict.get(b"Filter") {
        Ok(Object::Name(name)) if name == b"FlateDecode" => {
            use flate2::read::ZlibDecoder;
            use std::io::Read;
            let mut decoder = ZlibDecoder::new(stream.content.as_slice());
            let mut out = Vec::new();
            decoder.read_to_end(&mut out).map_err(|e| e.to_string())?;
            out
        }
        _ => stream.content.clone(),
    };

    String::from_utf8(bytes).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_comments(path: String, comments_json: String) -> Result<(), String> {
    let mut doc = Document::load(&path).map_err(|e| e.to_string())?;
    let json_bytes = comments_json.into_bytes();
    let json_len = json_bytes.len() as i64;

    // --- Case A: stream already exists → update in-place ---
    if let Some(stream_id) = find_comments_stream(&doc) {
        let obj = doc.get_object_mut(stream_id).map_err(|e| e.to_string())?;
        if let Object::Stream(stream) = obj {
            stream.dict.set("Length", Object::Integer(json_len));
            stream.dict.remove(b"Filter");
            stream.dict.remove(b"DecodeParms");
            stream.content = json_bytes;
        }
        doc.save(&path).map_err(|e| e.to_string())?;
        return Ok(());
    }

    // --- Case B: need to add a new attachment ---
    let structure = collect_structure(&doc)
        .ok_or_else(|| "Could not locate PDF Catalog".to_string())?;

    // 1. Build the embedded-file stream
    let mut stream_dict = Dictionary::new();
    stream_dict.set("Type", Object::Name(b"EmbeddedFile".to_vec()));
    stream_dict.set("Subtype", Object::Name(b"application/json".to_vec()));
    stream_dict.set("Length", Object::Integer(json_len));
    let stream_id = doc.add_object(Object::Stream(Stream::new(stream_dict, json_bytes)));

    // 2. Build the FileSpec dict
    let mut ef_inner = Dictionary::new();
    ef_inner.set("F", Object::Reference(stream_id));

    let mut filespec = Dictionary::new();
    filespec.set("Type", Object::Name(b"Filespec".to_vec()));
    filespec.set(
        "F",
        Object::String(ATTACHMENT_FILENAME.to_vec(), StringFormat::Literal),
    );
    filespec.set("EF", Object::Dictionary(ef_inner));
    let filespec_id = doc.add_object(Object::Dictionary(filespec));

    let entry_key = Object::String(ATTACHMENT_KEY.to_vec(), StringFormat::Literal);
    let entry_ref = Object::Reference(filespec_id);

    // 3. Attach to existing EmbeddedFiles dict, or create the Names structure
    if let Some(ef_id) = structure.ef_names_ref {
        // Append to existing EmbeddedFiles /Names array
        let ef_obj = doc.get_object_mut(ef_id).map_err(|e| e.to_string())?;
        if let Object::Dictionary(d) = ef_obj {
            match d.get_mut(b"Names") {
                Ok(Object::Array(arr)) => {
                    arr.push(entry_key);
                    arr.push(entry_ref);
                }
                _ => {
                    d.set("Names", Object::Array(vec![entry_key, entry_ref]));
                }
            }
        }
    } else if let Some(nid) = structure.names_ref {
        // Names dict exists but no EmbeddedFiles key yet
        let mut ef_dict = Dictionary::new();
        ef_dict.set("Names", Object::Array(vec![entry_key, entry_ref]));
        let ef_obj_id = doc.add_object(Object::Dictionary(ef_dict));

        let names_obj = doc.get_object_mut(nid).map_err(|e| e.to_string())?;
        if let Object::Dictionary(d) = names_obj {
            d.set("EmbeddedFiles", Object::Reference(ef_obj_id));
        }
    } else {
        // No Names dict at all — create from scratch
        let mut ef_dict = Dictionary::new();
        ef_dict.set("Names", Object::Array(vec![entry_key, entry_ref]));
        let ef_obj_id = doc.add_object(Object::Dictionary(ef_dict));

        let mut names_dict = Dictionary::new();
        names_dict.set("EmbeddedFiles", Object::Reference(ef_obj_id));
        let names_obj_id = doc.add_object(Object::Dictionary(names_dict));

        let catalog_obj = doc
            .get_object_mut(structure.root_ref)
            .map_err(|e| e.to_string())?;
        if let Object::Dictionary(d) = catalog_obj {
            d.set("Names", Object::Reference(names_obj_id));
        }
    }

    doc.save(&path).map_err(|e| e.to_string())?;
    Ok(())
}
