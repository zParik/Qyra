//! AcroForm fields: list them for the viewer's form layer, fill them, and
//! flatten them into page content.

use std::collections::{HashMap, HashSet};

use lopdf::{dictionary, Dictionary, Document, Object, ObjectId, Stream};

use crate::error::{AppError, AppResult};
use crate::utils::annots::{annot_refs, remove_annot_ref};
use crate::utils::geometry::PageGeom;
use crate::utils::paths::temp_output_path;

#[derive(serde::Serialize)]
pub struct FormField {
    /// Fully qualified name (`parent.child`), unique within the form.
    pub name: String,
    pub field_type: String,
    pub value: String,
    pub page: u32,
    /// `[x0, y0, x1, y1]` normalised to the page as shown, top-left origin.
    pub rect: [f64; 4],
    pub options: Vec<String>,
    pub flags: u32,
    /// The widget's "on" appearance state: what a checkbox or radio button
    /// sets the field's value to when it is turned on.
    pub on_state: Option<String>,
}

#[derive(serde::Deserialize)]
pub struct FieldValue {
    pub name: String,
    pub value: String,
}

// Field flags (/Ff), counted from bit 1.
const FF_MULTILINE: i64 = 1 << 12;
const FF_PASSWORD: i64 = 1 << 13;
const FF_PUSHBUTTON: i64 = 1 << 16;

// ── helpers ───────────────────────────────────────────────────────────────────

fn decode_pdf_string(bytes: &[u8]) -> String {
    crate::utils::pdf_text::decode(bytes)
}

fn object_to_string(obj: &Object) -> String {
    match obj {
        Object::String(bytes, _) => decode_pdf_string(bytes),
        Object::Name(bytes) => String::from_utf8_lossy(bytes).to_string(),
        Object::Integer(i) => i.to_string(),
        Object::Real(f) => f.to_string(),
        Object::Boolean(b) => b.to_string(),
        // A multi-select list box holds an array of choices.
        Object::Array(a) => a.first().map(object_to_string).unwrap_or_default(),
        _ => String::new(),
    }
}

fn obj_to_f64(o: &Object) -> f64 {
    match o {
        Object::Integer(i) => *i as f64,
        Object::Real(f) => *f as f64,
        _ => 0.0,
    }
}

/// Follow one level of indirection.
fn resolve<'a>(doc: &'a Document, o: &'a Object) -> &'a Object {
    match o {
        Object::Reference(id) => doc.get_object(*id).unwrap_or(o),
        _ => o,
    }
}

fn ref_list(doc: &Document, o: Option<&Object>) -> Vec<ObjectId> {
    match o.map(|o| resolve(doc, o)) {
        Some(Object::Array(a)) => a.iter().filter_map(|o| o.as_reference().ok()).collect(),
        _ => vec![],
    }
}

fn acroform(doc: &Document) -> Option<&Dictionary> {
    let af = doc.catalog().ok()?.get(b"AcroForm").ok()?;
    resolve(doc, af).as_dict().ok()
}

/// Resolve an inherited field attribute: the field, then its /Parent chain,
/// then (for /DA and /Q) the AcroForm defaults.
fn inherit_attr(doc: &Document, dict: &Dictionary, key: &[u8]) -> Option<Object> {
    if let Ok(v) = dict.get(key) {
        return Some(resolve(doc, v).clone());
    }
    let mut parent = dict.get(b"Parent").ok().and_then(|o| o.as_reference().ok());
    for _ in 0..32 {
        let Some(id) = parent else { break };
        let Ok(d) = doc.get_dictionary(id) else { break };
        if let Ok(v) = d.get(key) {
            return Some(resolve(doc, v).clone());
        }
        parent = d.get(b"Parent").ok().and_then(|o| o.as_reference().ok());
    }
    if key == b"DA" || key == b"Q" {
        return acroform(doc).and_then(|af| af.get(key).ok()).map(|v| resolve(doc, v).clone());
    }
    None
}

fn inherit_int(doc: &Document, dict: &Dictionary, key: &[u8]) -> i64 {
    match inherit_attr(doc, dict, key) {
        Some(Object::Integer(i)) => i,
        Some(Object::Real(r)) => r as i64,
        _ => 0,
    }
}

// ── field tree ────────────────────────────────────────────────────────────────

/// A field that holds a value, with its fully qualified name and its widget
/// annotations (the field itself when field and widget are merged).
struct Terminal {
    id: ObjectId,
    name: String,
    widgets: Vec<ObjectId>,
}

fn terminal_fields(doc: &Document) -> Vec<Terminal> {
    let Some(af) = acroform(doc) else { return vec![] };
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for id in ref_list(doc, af.get(b"Fields").ok()) {
        walk(doc, id, None, 0, &mut seen, &mut out);
    }
    out
}

fn walk(
    doc: &Document,
    id: ObjectId,
    prefix: Option<&str>,
    depth: usize,
    seen: &mut HashSet<ObjectId>,
    out: &mut Vec<Terminal>,
) {
    if depth > 32 || !seen.insert(id) {
        return;
    }
    let Ok(dict) = doc.get_dictionary(id) else { return };
    let partial = match dict.get(b"T").map(|o| resolve(doc, o)) {
        Ok(Object::String(b, _)) => Some(decode_pdf_string(b)),
        _ => None,
    };
    // Matching on the partial name alone mixed up fields such as
    // `buyer.name` and `seller.name`.
    let name = match (prefix, partial) {
        (Some(p), Some(t)) => format!("{p}.{t}"),
        (None, Some(t)) => t,
        (Some(p), None) => p.to_string(),
        (None, None) => String::new(),
    };
    let kids = ref_list(doc, dict.get(b"Kids").ok());
    // Kids with a /T are child fields; kids without one are this field's widgets.
    let child_fields: Vec<ObjectId> = kids
        .iter()
        .copied()
        .filter(|k| doc.get_dictionary(*k).map(|d| d.has(b"T")).unwrap_or(false))
        .collect();
    if !child_fields.is_empty() {
        let prefix = (!name.is_empty()).then_some(name.as_str());
        for k in child_fields {
            walk(doc, k, prefix, depth + 1, seen, out);
        }
        return;
    }
    if name.is_empty() {
        return;
    }
    let widgets = if kids.is_empty() { vec![id] } else { kids };
    out.push(Terminal { id, name, widgets });
}

/// The widget's normal-appearance states other than Off (a checkbox has
/// one; each radio button has its own).
fn on_states(doc: &Document, widget: &Dictionary) -> Vec<String> {
    let Some(ap) = widget.get(b"AP").ok().map(|o| resolve(doc, o)).and_then(|o| o.as_dict().ok()) else {
        return vec![];
    };
    let Some(n) = ap.get(b"N").ok().map(|o| resolve(doc, o)).and_then(|o| o.as_dict().ok()) else {
        return vec![];
    };
    n.iter()
        .map(|(k, _)| String::from_utf8_lossy(k).to_string())
        .filter(|k| k != "Off")
        .collect()
}

fn options(doc: &Document, field: &Dictionary) -> Vec<String> {
    match inherit_attr(doc, field, b"Opt") {
        Some(Object::Array(arr)) => arr
            .iter()
            .map(|item| match resolve(doc, item) {
                Object::Array(a) => a.get(1).or_else(|| a.first()).map(object_to_string).unwrap_or_default(),
                o => object_to_string(o),
            })
            .collect(),
        _ => vec![],
    }
}

fn get_form_fields_sync(path: &str) -> AppResult<Vec<FormField>> {
    // Read-only: share one parse per file version. The viewer asks once per
    // visible page, which used to run a full parse of the file for each.
    let doc = crate::commands::lopdf_cache::load(path)?;
    let doc: &Document = &doc;

    // /P is optional on widgets: find each widget's page from the pages'
    // /Annots (the old page-1 fallback put such fields on the wrong page).
    let pages = doc.get_pages();
    let mut widget_page: HashMap<ObjectId, (u32, ObjectId)> = HashMap::new();
    for (&num, &page_id) in &pages {
        for a in annot_refs(doc, page_id) {
            widget_page.entry(a).or_insert((num, page_id));
        }
    }
    let page_of_id: HashMap<ObjectId, u32> = pages.iter().map(|(n, id)| (*id, *n)).collect();

    let mut fields = Vec::new();
    for t in terminal_fields(doc) {
        let Ok(fd) = doc.get_dictionary(t.id) else { continue };
        let ft = inherit_attr(doc, fd, b"FT").map(|o| object_to_string(&o)).unwrap_or_else(|| "Tx".into());
        let flags = inherit_int(doc, fd, b"Ff");
        if ft == "Btn" && flags & FF_PUSHBUTTON != 0 {
            continue; // push buttons hold no value
        }
        let value = inherit_attr(doc, fd, b"V").map(|o| object_to_string(&o)).unwrap_or_default();
        let opts = options(doc, fd);
        for w in &t.widgets {
            let Ok(wd) = doc.get_dictionary(*w) else { continue };
            let placed = widget_page.get(w).copied().or_else(|| {
                let p = wd.get(b"P").ok()?.as_reference().ok()?;
                Some((*page_of_id.get(&p)?, p))
            });
            let Some((page, page_id)) = placed else { continue };
            let rect = match wd.get(b"Rect").map(|o| resolve(doc, o)) {
                Ok(Object::Array(a)) if a.len() >= 4 => PageGeom::of(doc, page_id)
                    .rect_to_norm([obj_to_f64(&a[0]), obj_to_f64(&a[1]), obj_to_f64(&a[2]), obj_to_f64(&a[3])]),
                _ => continue,
            };
            let on_state = if ft == "Btn" { on_states(doc, wd).into_iter().next() } else { None };
            // A checkbox without /V shows its widget's /AS.
            let value = if ft == "Btn" && value.is_empty() {
                wd.get(b"AS").map(object_to_string).unwrap_or_default()
            } else {
                value.clone()
            };
            fields.push(FormField {
                name: t.name.clone(),
                field_type: ft.clone(),
                value,
                page,
                rect,
                options: opts.clone(),
                flags: flags as u32,
                on_state,
            });
        }
    }
    Ok(fields)
}

#[tauri::command]
pub async fn get_form_fields(path: String) -> AppResult<Vec<FormField>> {
    tokio::task::spawn_blocking(move || {
        // Most files have no form: answer from MuPDF's lazy object tree instead
        // of a whole-file lopdf parse. (No worker in tests: always parse.)
        if let Some(w) = crate::commands::render_worker::global() {
            if matches!(w.features(path.clone()), Ok(f) if !f.form_fields) {
                return Ok(vec![]);
            }
        }
        get_form_fields_sync(&path)
    })
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

// ── appearances ───────────────────────────────────────────────────────────────

/// Helvetica advance widths (1/1000 em) for ASCII 32..=126.
const HELVETICA_WIDTHS: [u16; 95] = [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, // space../
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, // 0-9
    278, 278, 584, 584, 584, 556, 1015, // :..@
    667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, // A-M
    722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, // N-Z
    278, 278, 278, 469, 556, 333, // [..`
    556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, // a-m
    556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, // n-z
    334, 260, 334, 584, // {..~
];

fn char_width(c: char) -> f64 {
    let i = c as u32;
    if (32..=126).contains(&i) {
        HELVETICA_WIDTHS[(i - 32) as usize] as f64
    } else {
        556.0
    }
}

fn text_width(s: &str, size: f64) -> f64 {
    s.chars().map(char_width).sum::<f64>() * size / 1000.0
}

/// Encode for the WinAnsi Helvetica of the generated appearance, escaped for
/// a literal string. Characters it cannot show become `?`.
fn win_ansi_literal(s: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(s.len());
    for c in s.chars() {
        let b = match c {
            '€' => 0x80,
            '…' => 0x85,
            '‘' => 0x91,
            '’' => 0x92,
            '“' => 0x93,
            '”' => 0x94,
            '•' => 0x95,
            '–' => 0x96,
            '—' => 0x97,
            c if (c as u32) < 0x80 || ((c as u32) >= 0xA0 && (c as u32) <= 0xFF) => c as u32 as u8,
            _ => b'?',
        };
        if matches!(b, b'(' | b')' | b'\\') {
            out.push(b'\\');
        }
        out.push(b);
    }
    out
}

/// Font size (0 = auto) and colour operator from a /DA string such as
/// `/Helv 0 Tf 0 g` or `0 0 1 rg /TiRo 11 Tf`.
fn parse_da(da: &str) -> (f64, String) {
    let toks: Vec<&str> = da.split_whitespace().collect();
    let mut size = 0.0;
    let mut color = "0 g".to_string();
    for (i, t) in toks.iter().enumerate() {
        let nums = |n: usize| -> Option<Vec<&str>> {
            (i >= n && toks[i - n..i].iter().all(|x| x.parse::<f64>().is_ok())).then(|| toks[i - n..i].to_vec())
        };
        match *t {
            "Tf" => size = nums(1).and_then(|v| v[0].parse().ok()).unwrap_or(0.0),
            "g" => if let Some(v) = nums(1) { color = format!("{} g", v[0]) },
            "rg" => if let Some(v) = nums(3) { color = format!("{} rg", v.join(" ")) },
            "k" => if let Some(v) = nums(4) { color = format!("{} k", v.join(" ")) },
            _ => {}
        }
    }
    (size, color)
}

/// Break `text` into lines no wider than `max_w` at `size`.
fn wrap(text: &str, size: f64, max_w: f64) -> Vec<String> {
    let mut lines = Vec::new();
    for para in text.split('\n') {
        let mut line = String::new();
        for word in para.split(' ') {
            let candidate = if line.is_empty() { word.to_string() } else { format!("{line} {word}") };
            if !line.is_empty() && text_width(&candidate, size) > max_w {
                lines.push(std::mem::take(&mut line));
                line = word.to_string();
            } else {
                line = candidate;
            }
        }
        lines.push(line);
    }
    lines
}

struct TextStyle {
    da: String,
    quadding: i64,
    multiline: bool,
    password: bool,
}

/// A normal appearance stream that shows `value` in a `w`×`h` widget.
/// Viewers draw the stored appearance, so a value without one stays
/// invisible (and flattening it left the field blank).
fn text_appearance(doc: &mut Document, font_id: ObjectId, w: f64, h: f64, value: &str, style: &TextStyle) -> ObjectId {
    let (da_size, color) = parse_da(&style.da);
    let pad = 2.0;
    let shown: String = if style.password { "*".repeat(value.chars().count()) } else { value.to_string() };
    let size = if da_size > 0.0 {
        da_size
    } else if style.multiline {
        10.0_f64.min(h - 2.0 * pad).max(4.0)
    } else {
        // Auto size: fit the height, and shrink a long value to fit the width.
        let by_height = ((h - 2.0 * pad) * 0.75).clamp(4.0, 12.0);
        let wide = text_width(&shown, 1.0);
        if wide > 0.0 { by_height.min((w - 2.0 * pad) / wide).max(4.0) } else { by_height }
    };
    let x_for = |line: &str| match style.quadding {
        1 => (w - text_width(line, size)) / 2.0,
        2 => w - pad - text_width(line, size),
        _ => pad,
    };

    let mut body: Vec<u8> = Vec::new();
    body.extend_from_slice(format!("/Tx BMC\nq\n1 1 {:.3} {:.3} re W n\nBT\n/QyHelv {size:.3} Tf\n{color}\n", (w - 2.0).max(0.0), (h - 2.0).max(0.0)).as_bytes());
    let lines = if style.multiline { wrap(&shown, size, w - 2.0 * pad) } else { vec![shown.replace('\n', " ")] };
    let lead = size * 1.15;
    for (i, line) in lines.iter().enumerate() {
        let y = if style.multiline {
            h - pad - size * 0.9 - lead * i as f64
        } else {
            (h - size) / 2.0 + 0.22 * size
        };
        body.extend_from_slice(format!("1 0 0 1 {:.3} {y:.3} Tm (", x_for(line)).as_bytes());
        body.extend(win_ansi_literal(line));
        body.extend_from_slice(b") Tj\n");
    }
    body.extend_from_slice(b"ET\nQ\nEMC\n");

    let dict = dictionary! {
        "Type" => "XObject",
        "Subtype" => "Form",
        "BBox" => vec![0.into(), 0.into(), Object::Real(w as f32), Object::Real(h as f32)],
        "Resources" => dictionary! { "Font" => dictionary! { "QyHelv" => font_id } },
    };
    doc.add_object(Stream::new(dict, body))
}

fn helvetica(doc: &mut Document) -> ObjectId {
    doc.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "Type1",
        "BaseFont" => "Helvetica",
        "Encoding" => "WinAnsiEncoding",
    })
}

fn widget_size(doc: &Document, widget: ObjectId) -> Option<(f64, f64)> {
    match doc.get_dictionary(widget).ok()?.get(b"Rect").ok().map(|o| resolve(doc, o)) {
        Some(Object::Array(a)) if a.len() >= 4 => Some((
            (obj_to_f64(&a[2]) - obj_to_f64(&a[0])).abs(),
            (obj_to_f64(&a[3]) - obj_to_f64(&a[1])).abs(),
        )),
        _ => None,
    }
}

fn text_style(doc: &Document, field: &Dictionary) -> TextStyle {
    let flags = inherit_int(doc, field, b"Ff");
    TextStyle {
        da: inherit_attr(doc, field, b"DA").map(|o| object_to_string(&o)).unwrap_or_default(),
        quadding: inherit_int(doc, field, b"Q"),
        multiline: flags & FF_MULTILINE != 0,
        password: flags & FF_PASSWORD != 0,
    }
}

fn set_text_field(doc: &mut Document, font_id: ObjectId, t: &Terminal, value: &str) -> AppResult<()> {
    let style = text_style(doc, doc.get_dictionary(t.id)?);
    doc.get_dictionary_mut(t.id)?.set("V", crate::utils::pdf_text::encode(value));
    for &w in &t.widgets {
        let Some((ww, wh)) = widget_size(doc, w) else { continue };
        let ap = text_appearance(doc, font_id, ww, wh, value, &style);
        doc.get_dictionary_mut(w)?.set("AP", dictionary! { "N" => ap });
    }
    Ok(())
}

/// Turn a checkbox or radio group on or off. The value is an appearance
/// state name: writing it as a string, or dropping the /AP, left checkboxes
/// unchecked or blank in other viewers.
fn set_button_field(doc: &mut Document, t: &Terminal, value: &str) -> AppResult<()> {
    let states: Vec<Vec<String>> = t
        .widgets
        .iter()
        .map(|w| doc.get_dictionary(*w).map(|d| on_states(doc, d)).unwrap_or_default())
        .collect();
    let target = if value.is_empty() || value == "Off" {
        "Off".to_string()
    } else if states.iter().any(|s| s.iter().any(|x| x == value)) {
        value.to_string()
    } else {
        // A generic "Yes" from the viewer: use the widget's own on state.
        states.iter().flatten().next().cloned().unwrap_or_else(|| value.to_string())
    };
    doc.get_dictionary_mut(t.id)?.set("V", Object::Name(target.clone().into_bytes()));
    for (w, s) in t.widgets.iter().zip(&states) {
        let shown = if s.contains(&target) { target.as_str() } else { "Off" };
        doc.get_dictionary_mut(*w)?.set("AS", Object::Name(shown.as_bytes().to_vec()));
    }
    Ok(())
}

// ── flatten ───────────────────────────────────────────────────────────────────

/// The widget's normal appearance stream, picking the /AS state when /N
/// holds several.
fn normal_appearance(doc: &Document, widget: &Dictionary) -> Option<ObjectId> {
    let ap = resolve(doc, widget.get(b"AP").ok()?).as_dict().ok()?;
    let n = ap.get(b"N").ok()?;
    match n {
        Object::Reference(id) if matches!(doc.get_object(*id), Ok(Object::Stream(_))) => Some(*id),
        _ => {
            let states = resolve(doc, n).as_dict().ok()?;
            let state = widget.get(b"AS").ok()?.as_name().ok()?;
            states.get(state).ok()?.as_reference().ok()
        }
    }
}

fn numbers(doc: &Document, o: Option<&Object>, n: usize) -> Option<Vec<f64>> {
    match o.map(|o| resolve(doc, o)) {
        Some(Object::Array(a)) if a.len() >= n => Some(a[..n].iter().map(obj_to_f64).collect()),
        _ => None,
    }
}

/// Draw every widget's appearance into its page and remove the form.
/// Only setting ReadOnly and dropping /AcroForm left the widgets as
/// annotations, and fields without an appearance came out blank.
pub(crate) fn flatten_form(doc: &mut Document) -> AppResult<()> {
    // A text field filled elsewhere may carry a value but no appearance.
    let font_id = helvetica(doc);
    for t in terminal_fields(doc) {
        let Ok(fd) = doc.get_dictionary(t.id) else { continue };
        let ft = inherit_attr(doc, fd, b"FT").map(|o| object_to_string(&o)).unwrap_or_default();
        if ft != "Tx" && ft != "Ch" {
            continue;
        }
        let value = inherit_attr(doc, fd, b"V").map(|o| object_to_string(&o)).unwrap_or_default();
        let lacks_ap = t.widgets.iter().any(|w| {
            doc.get_dictionary(*w).map(|d| normal_appearance(doc, d).is_none()).unwrap_or(false)
        });
        if lacks_ap && !value.is_empty() {
            set_text_field(doc, font_id, &t, &value)?;
        }
    }

    crate::utils::own_inherited_resources(doc);
    let pages: Vec<ObjectId> = doc.get_pages().into_values().collect();
    for page_id in pages {
        let mut ops = String::new();
        let mut widgets = Vec::new();
        for annot_id in annot_refs(doc, page_id) {
            let Ok(ad) = doc.get_dictionary(annot_id) else { continue };
            if ad.get(b"Subtype").ok().and_then(|o| o.as_name().ok()) != Some(b"Widget".as_slice()) {
                continue;
            }
            widgets.push(annot_id);
            let flags = ad.get(b"F").ok().and_then(|o| o.as_i64().ok()).unwrap_or(0);
            if flags & (2 | 32) != 0 {
                continue; // Hidden or NoView
            }
            let Some(ap_id) = normal_appearance(doc, ad) else { continue };
            let Some(rect) = numbers(doc, ad.get(b"Rect").ok(), 4) else { continue };
            let (sd, bbox, m) = {
                let Ok(Object::Stream(s)) = doc.get_object(ap_id) else { continue };
                let bbox = numbers(doc, s.dict.get(b"BBox").ok(), 4).unwrap_or_else(|| vec![0.0, 0.0, 1.0, 1.0]);
                let m = numbers(doc, s.dict.get(b"Matrix").ok(), 6).unwrap_or_else(|| vec![1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);
                (s.dict.has(b"Subtype"), bbox, m)
            };
            // Map the appearance's transformed BBox onto the widget's /Rect.
            let corners = [(bbox[0], bbox[1]), (bbox[2], bbox[1]), (bbox[0], bbox[3]), (bbox[2], bbox[3])]
                .map(|(x, y)| (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]));
            let (tx0, tx1) = corners.iter().fold((f64::MAX, f64::MIN), |(a, b), c| (a.min(c.0), b.max(c.0)));
            let (ty0, ty1) = corners.iter().fold((f64::MAX, f64::MIN), |(a, b), c| (a.min(c.1), b.max(c.1)));
            if tx1 - tx0 <= 0.0 || ty1 - ty0 <= 0.0 {
                continue;
            }
            let (rx0, ry0) = (rect[0].min(rect[2]), rect[1].min(rect[3]));
            let sx = (rect[2] - rect[0]).abs() / (tx1 - tx0);
            let sy = (rect[3] - rect[1]).abs() / (ty1 - ty0);
            if !sd {
                if let Ok(Object::Stream(s)) = doc.get_object_mut(ap_id) {
                    s.dict.set("Type", "XObject");
                    s.dict.set("Subtype", "Form");
                }
            }
            let name = crate::utils::add_page_xobject(doc, page_id, "QyFlat", ap_id)?;
            ops.push_str(&format!(
                "q {sx:.5} 0 0 {sy:.5} {:.3} {:.3} cm /{name} Do Q\n",
                rx0 - tx0 * sx,
                ry0 - ty0 * sy,
            ));
        }
        if !ops.is_empty() {
            let sid = doc.add_object(Stream::new(Dictionary::new(), ops.into_bytes()));
            crate::utils::put_overlay_on_top(doc, page_id, sid, "QyraFlatten")?;
        }
        for w in widgets {
            remove_annot_ref(doc, page_id, w)?;
        }
    }

    let root = doc.trailer.get(b"Root")?.as_reference()?;
    doc.get_dictionary_mut(root)?.remove(b"AcroForm");
    Ok(())
}

// ── fill_form ─────────────────────────────────────────────────────────────────

pub(crate) fn fill_form_doc(doc: &mut Document, fields: &[FieldValue]) -> AppResult<()> {
    let wanted: HashMap<&str, &str> = fields.iter().map(|f| (f.name.as_str(), f.value.as_str())).collect();
    let mut font_id = None;
    for t in terminal_fields(doc) {
        let Some(&value) = wanted.get(t.name.as_str()) else { continue };
        let fd = doc.get_dictionary(t.id)?;
        let ft = inherit_attr(doc, fd, b"FT").map(|o| object_to_string(&o)).unwrap_or_default();
        match ft.as_str() {
            "Btn" if inherit_int(doc, fd, b"Ff") & FF_PUSHBUTTON == 0 => set_button_field(doc, &t, value)?,
            "Tx" | "Ch" => {
                let font = *font_id.get_or_insert_with(|| helvetica(doc));
                set_text_field(doc, font, &t, value)?;
            }
            _ => {} // push buttons and signatures hold no typed value
        }
    }
    Ok(())
}

fn fill_form_sync(
    path: &str,
    fields: Vec<FieldValue>,
    flatten: bool,
    output: Option<String>,
) -> AppResult<String> {
    let out = output.unwrap_or_else(|| temp_output_path(path, "filled"));
    let _t = crate::utils::timing::Timer::start("fill_form", String::new());
    let mut doc = Document::load(path)?;
    fill_form_doc(&mut doc, &fields)?;
    if flatten {
        flatten_form(&mut doc)?;
    }
    crate::utils::save_pdf(&mut doc, &out)?;
    Ok(out)
}

#[tauri::command]
pub async fn fill_form(
    path: String,
    fields: Vec<FieldValue>,
    flatten: bool,
    output: Option<String>,
) -> AppResult<String> {
    tokio::task::spawn_blocking(move || fill_form_sync(&path, fields, flatten, output))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn da_gives_size_and_colour() {
        assert_eq!(parse_da("/Helv 0 Tf 0 g"), (0.0, "0 g".into()));
        assert_eq!(parse_da("0 0 1 rg /TiRo 11 Tf"), (11.0, "0 0 1 rg".into()));
    }

    #[test]
    fn literal_escapes_and_replaces() {
        assert_eq!(win_ansi_literal("a(b)\\é漢"), b"a\\(b\\)\\\\\xE9?".to_vec());
    }

    #[test]
    fn wrap_breaks_at_width() {
        let lines = wrap("one two three four", 10.0, text_width("three four", 10.0) + 0.1);
        assert_eq!(lines, vec!["one two", "three four"]);
    }
}
