//! Comment ↔ PDF Text-annotation sync: comments saved in Qyra must surface
//! as standard /Annots Text entries (visible in Acrobat/Edge/Firefox), and
//! Text annotations made elsewhere must import as Qyra comments.

mod common;

use common::{fixture, temp_output};
use lopdf::{Document, Object};
use qyra_lib::commands::comments::{load_comments, save_comments};
use serde_json::{json, Value};

fn comment(id: &str, page: u32, text: &str) -> Value {
    json!({
        "id": id,
        "pageIndex": page,
        "x": 0.5,
        "y": 0.25,
        "text": text,
        "color": "#3b82f6",
        "resolved": false,
        "createdAt": 1_700_000_000_000_u64,
    })
}

/// Copy the simple.pdf fixture into a temp dir so save_comments can mutate it.
fn working_copy() -> (tempfile::TempDir, String) {
    let (dir, path) = temp_output("comments.pdf");
    std::fs::copy(fixture("simple.pdf"), &path).expect("copy fixture");
    (dir, path)
}

/// Every Text annotation in the file as (NM-or-empty, Contents-or-empty).
fn text_annots(path: &str) -> Vec<(String, String)> {
    let doc = Document::load(path).expect("load pdf");
    let mut out = Vec::new();
    for (_num, page_id) in doc.get_pages() {
        let Ok(Object::Dictionary(page_dict)) = doc.get_object(page_id) else { continue };
        let refs: Vec<lopdf::ObjectId> = match page_dict.get(b"Annots") {
            Ok(Object::Array(arr)) => arr.iter().filter_map(|o| o.as_reference().ok()).collect(),
            Ok(Object::Reference(r)) => match doc.get_object(*r) {
                Ok(Object::Array(arr)) => {
                    arr.iter().filter_map(|o| o.as_reference().ok()).collect()
                }
                _ => vec![],
            },
            _ => vec![],
        };
        for annot_id in refs {
            let Ok(Object::Dictionary(d)) = doc.get_object(annot_id) else { continue };
            if !matches!(d.get(b"Subtype"), Ok(Object::Name(n)) if n == b"Text") {
                continue;
            }
            let s = |key: &[u8]| -> String {
                match d.get(key) {
                    Ok(Object::String(bytes, _)) => String::from_utf8_lossy(bytes).into_owned(),
                    _ => String::new(),
                }
            };
            out.push((s(b"NM"), s(b"Contents")));
        }
    }
    out
}

/// Count Text annotations carrying an /AP appearance (PDFium draws nothing
/// without one).
fn text_annots_with_ap(path: &str) -> usize {
    let doc = Document::load(path).expect("load pdf");
    let mut count = 0;
    for (_num, page_id) in doc.get_pages() {
        let Ok(Object::Dictionary(page_dict)) = doc.get_object(page_id) else { continue };
        let refs: Vec<lopdf::ObjectId> = match page_dict.get(b"Annots") {
            Ok(Object::Array(arr)) => arr.iter().filter_map(|o| o.as_reference().ok()).collect(),
            _ => vec![],
        };
        for annot_id in refs {
            let Ok(Object::Dictionary(d)) = doc.get_object(annot_id) else { continue };
            if matches!(d.get(b"Subtype"), Ok(Object::Name(n)) if n == b"Text")
                && d.get(b"AP").is_ok()
            {
                count += 1;
            }
        }
    }
    count
}

async fn load(path: &str) -> Vec<Value> {
    let json = load_comments(path.to_string()).await.expect("load_comments");
    serde_json::from_str(&json).expect("comments JSON")
}

#[tokio::test(flavor = "multi_thread")]
async fn save_creates_text_annotations() {
    let (_d, path) = working_copy();

    let comments = json!([
        comment("c-one", 1, "first note"),
        comment("c-two", 1, "second note"),
    ]);
    save_comments(path.clone(), comments.to_string())
        .await
        .expect("save");

    let annots = text_annots(&path);
    assert_eq!(annots.len(), 2, "one Text annotation per comment");
    assert!(annots.iter().any(|(nm, c)| nm == "c-one" && c == "first note"));
    assert!(annots.iter().any(|(nm, c)| nm == "c-two" && c == "second note"));
    assert_eq!(text_annots_with_ap(&path), 2, "every note ships an /AP icon");

    // The reloaded comments are marked synced.
    let loaded = load(&path).await;
    assert_eq!(loaded.len(), 2);
    assert!(loaded.iter().all(|c| c["synced"] == json!(true)));
}

#[tokio::test(flavor = "multi_thread")]
async fn load_roundtrips_sidecar_fields() {
    let (_d, path) = working_copy();

    let mut c = comment("c-rt", 1, "hello roundtrip");
    c["resolved"] = json!(true);
    c["quote"] = json!("quoted text");
    save_comments(path.clone(), json!([c]).to_string())
        .await
        .expect("save");

    let loaded = load(&path).await;
    assert_eq!(loaded.len(), 1);
    let c = &loaded[0];
    assert_eq!(c["id"], json!("c-rt"));
    assert_eq!(c["text"], json!("hello roundtrip"));
    assert_eq!(c["resolved"], json!(true));
    assert_eq!(c["quote"], json!("quoted text"));
    assert_eq!(c["pageIndex"], json!(1));
    assert_eq!(c["createdAt"], json!(1_700_000_000_000.0));
    // Pin position survives the Rect round-trip (within float tolerance).
    let x = c["x"].as_f64().unwrap();
    let y = c["y"].as_f64().unwrap();
    assert!((x - 0.5).abs() < 0.01, "x drifted: {x}");
    assert!((y - 0.25).abs() < 0.01, "y drifted: {y}");
}

#[tokio::test(flavor = "multi_thread")]
async fn deleting_comment_removes_annotation() {
    let (_d, path) = working_copy();

    save_comments(path.clone(), json!([comment("c-del", 1, "bye")]).to_string())
        .await
        .expect("save");
    assert_eq!(text_annots(&path).len(), 1);

    save_comments(path.clone(), "[]".to_string())
        .await
        .expect("save empty");
    assert_eq!(text_annots(&path).len(), 0, "annotation removed with comment");
    assert_eq!(load(&path).await.len(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn external_text_annotation_imports_as_comment() {
    let (_d, path) = working_copy();

    // Simulate another viewer adding a sticky note: a bare Text annotation,
    // no /NM, no qyra sidecar entry.
    {
        let mut doc = Document::load(&path).expect("load");
        let page_id = *doc.get_pages().get(&1).expect("page 1");
        let mut d = lopdf::Dictionary::new();
        d.set("Type", Object::Name(b"Annot".to_vec()));
        d.set("Subtype", Object::Name(b"Text".to_vec()));
        d.set(
            "Rect",
            Object::Array(vec![
                Object::Real(100.0),
                Object::Real(500.0),
                Object::Real(120.0),
                Object::Real(520.0),
            ]),
        );
        d.set(
            "Contents",
            Object::String(b"from acrobat".to_vec(), lopdf::StringFormat::Literal),
        );
        let annot_id = doc.add_object(d);
        if let Ok(Object::Dictionary(page_dict)) = doc.get_object_mut(page_id) {
            match page_dict.get_mut(b"Annots") {
                Ok(Object::Array(arr)) => arr.push(Object::Reference(annot_id)),
                _ => page_dict.set("Annots", Object::Array(vec![Object::Reference(annot_id)])),
            }
        }
        doc.save(&path).expect("save external annot");
    }

    let loaded = load(&path).await;
    assert_eq!(loaded.len(), 1, "external note imported");
    assert_eq!(loaded[0]["text"], json!("from acrobat"));
    assert_eq!(loaded[0]["synced"], json!(true));

    // Auto-save echoes the imported list back — must not duplicate the note.
    save_comments(path.clone(), serde_json::to_string(&loaded).unwrap())
        .await
        .expect("resave");
    assert_eq!(text_annots(&path).len(), 1, "no duplicate after resave");
    assert_eq!(load(&path).await.len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn external_content_edit_wins_on_load() {
    let (_d, path) = working_copy();

    let mut c = comment("c-edit", 1, "original");
    c["quote"] = json!("kept quote");
    save_comments(path.clone(), json!([c]).to_string())
        .await
        .expect("save");

    // Another viewer edits the note's text.
    {
        let mut doc = Document::load(&path).expect("load");
        let page_id = *doc.get_pages().get(&1).expect("page 1");
        let refs: Vec<lopdf::ObjectId> = {
            let Ok(Object::Dictionary(page_dict)) = doc.get_object(page_id) else {
                panic!("page dict")
            };
            match page_dict.get(b"Annots") {
                Ok(Object::Array(arr)) => {
                    arr.iter().filter_map(|o| o.as_reference().ok()).collect()
                }
                _ => vec![],
            }
        };
        let mut edited = false;
        for annot_id in refs {
            if let Ok(Object::Dictionary(d)) = doc.get_object_mut(annot_id) {
                if matches!(d.get(b"Subtype"), Ok(Object::Name(n)) if n == b"Text") {
                    d.set(
                        "Contents",
                        Object::String(b"edited elsewhere".to_vec(), lopdf::StringFormat::Literal),
                    );
                    edited = true;
                }
            }
        }
        assert!(edited, "found the Text annotation to edit");
        doc.save(&path).expect("save edit");
    }

    let loaded = load(&path).await;
    assert_eq!(loaded.len(), 1);
    assert_eq!(loaded[0]["text"], json!("edited elsewhere"), "annotation text wins");
    assert_eq!(loaded[0]["quote"], json!("kept quote"), "sidecar extras survive");
}

#[tokio::test(flavor = "multi_thread")]
async fn externally_deleted_annotation_drops_comment() {
    let (_d, path) = working_copy();

    save_comments(path.clone(), json!([comment("c-gone", 1, "soon gone")]).to_string())
        .await
        .expect("save");

    // Another viewer deletes the annotation (sidecar entry remains, synced).
    {
        let mut doc = Document::load(&path).expect("load");
        let page_id = *doc.get_pages().get(&1).expect("page 1");
        if let Ok(Object::Dictionary(page_dict)) = doc.get_object_mut(page_id) {
            page_dict.remove(b"Annots");
        }
        doc.save(&path).expect("save deletion");
    }

    assert_eq!(
        load(&path).await.len(),
        0,
        "synced sidecar entry without its annotation is dropped"
    );
}
