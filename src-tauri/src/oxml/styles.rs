//! Parse `word/styles.xml` (document defaults + named styles) and resolve the
//! effective run/paragraph properties for a paragraph style id. Word leans on
//! styles heavily (headings, body, list paragraph), so without this most text
//! renders at the wrong size — this is the single biggest fidelity lever.
//!
//! Resolution order, lowest precedence first:
//!   docDefaults  →  style chain (basedOn root → leaf)  →  direct formatting
//! Direct formatting is applied by the caller (the docx parser) on top of what
//! `run_for` / `para_for` return.
//!
//! Property parsing (`run_prop` / `para_prop`) is shared with the docx parser so
//! direct `rPr`/`pPr` and style `rPr`/`pPr` are interpreted identically.

use std::collections::HashMap;

use quick_xml::events::{BytesStart, Event};
use quick_xml::reader::Reader;

use super::model::{half_points_to_pt, twips_to_pt, Align, ParaProps, RunProps};

#[derive(Default, Clone)]
pub struct RunPropsPartial {
    pub bold: Option<bool>,
    pub italic: Option<bool>,
    pub underline: Option<bool>,
    pub strike: Option<bool>,
    pub size_pt: Option<f32>,
    pub color: Option<[u8; 3]>,
}

#[derive(Default, Clone)]
pub struct ParaPropsPartial {
    pub align: Option<Align>,
    pub space_before_pt: Option<f32>,
    pub space_after_pt: Option<f32>,
    pub line_spacing: Option<f32>,
    pub indent_left_pt: Option<f32>,
    pub indent_first_pt: Option<f32>,
}

#[derive(Default, Clone)]
struct StyleDef {
    based_on: Option<String>,
    run: RunPropsPartial,
    para: ParaPropsPartial,
}

pub struct Styles {
    default_run: RunPropsPartial,
    default_para: ParaPropsPartial,
    defs: HashMap<String, StyleDef>,
}

impl Styles {
    pub fn empty() -> Self {
        Self {
            default_run: RunPropsPartial::default(),
            default_para: ParaPropsPartial::default(),
            defs: HashMap::new(),
        }
    }

    /// Effective run properties for a paragraph style (no direct formatting).
    pub fn run_for(&self, style_id: Option<&str>) -> RunProps {
        let mut rp = RunProps::default();
        apply_run_partial(&mut rp, &self.default_run);
        for id in self.chain(style_id) {
            if let Some(def) = self.defs.get(&id) {
                apply_run_partial(&mut rp, &def.run);
            }
        }
        rp
    }

    /// Effective paragraph properties for a style (no direct formatting).
    pub fn para_for(&self, style_id: Option<&str>) -> ParaProps {
        let mut pp = ParaProps::default();
        apply_para_partial(&mut pp, &self.default_para);
        for id in self.chain(style_id) {
            if let Some(def) = self.defs.get(&id) {
                apply_para_partial(&mut pp, &def.para);
            }
        }
        pp
    }

    /// basedOn chain from root to `style_id`, cycle-guarded.
    fn chain(&self, style_id: Option<&str>) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        let mut cur = style_id.map(|s| s.to_string());
        let mut guard = 0;
        while let Some(id) = cur {
            if out.contains(&id) || guard > 16 {
                break;
            }
            guard += 1;
            let based = self.defs.get(&id).and_then(|d| d.based_on.clone());
            out.push(id);
            cur = based;
        }
        out.reverse(); // root first, leaf last (leaf wins)
        out
    }

    pub fn parse(xml: &str) -> Self {
        let mut styles = Styles::empty();
        let mut reader = Reader::from_str(xml);
        let mut buf = Vec::new();

        let mut stack: Vec<Vec<u8>> = Vec::new();
        let mut cur_style_id: Option<String> = None;
        let mut cur_run = RunPropsPartial::default();
        let mut cur_para = ParaPropsPartial::default();
        let mut cur_based_on: Option<String> = None;
        // Skip paragraph-mark rPr (w:pPr/w:rPr) — it styles the mark, not text.
        let mut skip_rpr = false;

        loop {
            let ev = match reader.read_event_into(&mut buf) {
                Ok(ev) => ev,
                Err(_) => break,
            };
            match ev {
                Event::Start(e) => {
                    let name = e.name().as_ref().to_vec();
                    match name.as_slice() {
                        b"w:style" => {
                            cur_style_id = attr_str(&e, b"w:styleId");
                            cur_based_on = None;
                            cur_run = RunPropsPartial::default();
                            cur_para = ParaPropsPartial::default();
                        }
                        b"w:rPr" => {
                            skip_rpr = stack.last().map(|n| n.as_slice()) == Some(b"w:pPr");
                            if !skip_rpr {
                                cur_run = RunPropsPartial::default();
                            }
                        }
                        b"w:pPr" => {
                            cur_para = ParaPropsPartial::default();
                        }
                        _ => {
                            handle_leaf_start_or_empty(&name, &e, &stack, skip_rpr, &mut cur_run, &mut cur_para, &mut cur_based_on);
                        }
                    }
                    stack.push(name);
                }
                Event::Empty(e) => {
                    let name = e.name().as_ref().to_vec();
                    handle_leaf_start_or_empty(&name, &e, &stack, skip_rpr, &mut cur_run, &mut cur_para, &mut cur_based_on);
                }
                Event::End(e) => {
                    let name = e.name().as_ref().to_vec();
                    match name.as_slice() {
                        b"w:rPr" => {
                            if !skip_rpr {
                                if ctx_has(&stack, b"w:docDefaults") {
                                    styles.default_run = cur_run.clone();
                                } else if let Some(id) = &cur_style_id {
                                    styles.defs.entry(id.clone()).or_default().run = cur_run.clone();
                                }
                            }
                            skip_rpr = false;
                        }
                        b"w:pPr" => {
                            if ctx_has(&stack, b"w:docDefaults") {
                                styles.default_para = cur_para.clone();
                            } else if let Some(id) = &cur_style_id {
                                styles.defs.entry(id.clone()).or_default().para = cur_para.clone();
                            }
                        }
                        b"w:style" => {
                            if let Some(id) = cur_style_id.take() {
                                styles.defs.entry(id).or_default().based_on = cur_based_on.take();
                            }
                        }
                        _ => {}
                    }
                    stack.pop();
                }
                Event::Eof => break,
                _ => {}
            }
            buf.clear();
        }
        styles
    }
}

fn ctx_has(stack: &[Vec<u8>], name: &[u8]) -> bool {
    stack.iter().any(|n| n.as_slice() == name)
}

/// Route a leaf property element to the run or paragraph partial currently being
/// built, based on the element stack context.
fn handle_leaf_start_or_empty(
    name: &[u8],
    e: &BytesStart,
    stack: &[Vec<u8>],
    skip_rpr: bool,
    cur_run: &mut RunPropsPartial,
    cur_para: &mut ParaPropsPartial,
    cur_based_on: &mut Option<String>,
) {
    if name == b"w:basedOn" {
        *cur_based_on = attr_str(e, b"w:val");
        return;
    }
    if ctx_has(stack, b"w:rPr") && !skip_rpr {
        run_prop(cur_run, name, e);
    } else if ctx_has(stack, b"w:pPr") {
        para_prop(cur_para, name, e);
    }
}

/// Parse one run-property leaf into a partial. Shared by styles + direct rPr.
pub fn run_prop(part: &mut RunPropsPartial, name: &[u8], e: &BytesStart) {
    match name {
        b"w:b" => part.bold = Some(truthy(attr_str(e, b"w:val").as_deref())),
        b"w:i" => part.italic = Some(truthy(attr_str(e, b"w:val").as_deref())),
        b"w:strike" => part.strike = Some(truthy(attr_str(e, b"w:val").as_deref())),
        b"w:u" => {
            // <w:u w:val="none"/> turns it off; any other value (single, double…)
            // turns it on; a bare <w:u/> is on.
            let off = attr_str(e, b"w:val").as_deref() == Some("none");
            part.underline = Some(!off);
        }
        b"w:sz" => {
            if let Some(v) = attr_f32(e, b"w:val") {
                part.size_pt = Some(half_points_to_pt(v));
            }
        }
        b"w:color" => {
            if let Some(v) = attr_str(e, b"w:val") {
                part.color = Some(parse_color(&v));
            }
        }
        _ => {}
    }
}

/// Parse one paragraph-property leaf into a partial. Shared by styles + direct
/// pPr. (`w:pStyle`, `w:numPr` are handled by the docx parser, not here.)
pub fn para_prop(part: &mut ParaPropsPartial, name: &[u8], e: &BytesStart) {
    match name {
        b"w:jc" => {
            if let Some(v) = attr_str(e, b"w:val") {
                part.align = Some(parse_align(&v));
            }
        }
        b"w:spacing" => {
            if let Some(v) = attr_f32(e, b"w:before") {
                part.space_before_pt = Some(twips_to_pt(v));
            }
            if let Some(v) = attr_f32(e, b"w:after") {
                part.space_after_pt = Some(twips_to_pt(v));
            }
            // w:line in 240ths of a line when lineRule is auto (the common case).
            let rule = attr_str(e, b"w:lineRule");
            if let Some(line) = attr_f32(e, b"w:line") {
                match rule.as_deref() {
                    Some("exact") | Some("atLeast") => {} // absolute; ignore for now
                    _ => part.line_spacing = Some(line / 240.0),
                }
            }
        }
        b"w:ind" => {
            if let Some(v) = attr_f32(e, b"w:left").or_else(|| attr_f32(e, b"w:start")) {
                part.indent_left_pt = Some(twips_to_pt(v));
            }
            if let Some(v) = attr_f32(e, b"w:firstLine") {
                part.indent_first_pt = Some(twips_to_pt(v));
            }
            if let Some(v) = attr_f32(e, b"w:hanging") {
                part.indent_first_pt = Some(-twips_to_pt(v));
            }
        }
        _ => {}
    }
}

pub fn apply_run_partial(rp: &mut RunProps, p: &RunPropsPartial) {
    if let Some(v) = p.bold {
        rp.bold = v;
    }
    if let Some(v) = p.italic {
        rp.italic = v;
    }
    if let Some(v) = p.underline {
        rp.underline = v;
    }
    if let Some(v) = p.strike {
        rp.strike = v;
    }
    if let Some(v) = p.size_pt {
        rp.size_pt = v;
    }
    if let Some(v) = p.color {
        rp.color = v;
    }
}

pub fn apply_para_partial(pp: &mut ParaProps, p: &ParaPropsPartial) {
    if let Some(v) = p.align {
        pp.align = v;
    }
    if let Some(v) = p.space_before_pt {
        pp.space_before_pt = v;
    }
    if let Some(v) = p.space_after_pt {
        pp.space_after_pt = v;
    }
    if let Some(v) = p.line_spacing {
        pp.line_spacing = v;
    }
    if let Some(v) = p.indent_left_pt {
        pp.indent_left_pt = v;
    }
    if let Some(v) = p.indent_first_pt {
        pp.indent_first_pt = v;
    }
}

/// OOXML on/off toggle: absent value or "1"/"true"/"on" = true.
pub fn truthy(val: Option<&str>) -> bool {
    !matches!(val, Some("0") | Some("false") | Some("off"))
}

pub fn parse_align(val: &str) -> Align {
    match val {
        "center" => Align::Center,
        "right" | "end" => Align::Right,
        "both" | "distribute" => Align::Justify,
        _ => Align::Left,
    }
}

/// Parse a `w:color` value: "RRGGBB" hex, or "auto" → black.
pub fn parse_color(val: &str) -> [u8; 3] {
    if val.eq_ignore_ascii_case("auto") || val.len() < 6 {
        return [0, 0, 0];
    }
    let r = u8::from_str_radix(&val[0..2], 16).unwrap_or(0);
    let g = u8::from_str_radix(&val[2..4], 16).unwrap_or(0);
    let b = u8::from_str_radix(&val[4..6], 16).unwrap_or(0);
    [r, g, b]
}

/// Read an attribute as a string by qualified name (e.g. `b"w:val"`). WML
/// property attributes are plain ASCII, so raw bytes decode directly.
pub fn attr_str(e: &BytesStart, key: &[u8]) -> Option<String> {
    e.attributes()
        .flatten()
        .find(|a| a.key.as_ref() == key)
        .map(|a| String::from_utf8_lossy(a.value.as_ref()).into_owned())
}

pub fn attr_f32(e: &BytesStart, key: &[u8]) -> Option<f32> {
    attr_str(e, key).and_then(|s| s.parse::<f32>().ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_size_through_based_on_chain() {
        let xml = r#"<w:styles xmlns:w="x">
          <w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="20"/></w:rPr></w:rPrDefault></w:docDefaults>
          <w:style w:type="paragraph" w:styleId="Normal"><w:rPr><w:sz w:val="22"/></w:rPr></w:style>
          <w:style w:type="paragraph" w:styleId="Heading1"><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>
        </w:styles>"#;
        let styles = Styles::parse(xml);
        let body = styles.run_for(Some("Normal"));
        assert_eq!(body.size_pt, 11.0); // 22 half-points
        let h1 = styles.run_for(Some("Heading1"));
        assert_eq!(h1.size_pt, 16.0); // 32 half-points, inherited bold
        assert!(h1.bold);
    }

    #[test]
    fn unknown_style_uses_doc_defaults() {
        let xml = r#"<w:styles xmlns:w="x"><w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="20"/></w:rPr></w:rPrDefault></w:docDefaults></w:styles>"#;
        let styles = Styles::parse(xml);
        assert_eq!(styles.run_for(Some("Nope")).size_pt, 10.0); // 20 half-points
        assert_eq!(styles.run_for(None).size_pt, 10.0);
    }

    #[test]
    fn color_parse() {
        assert_eq!(parse_color("FF0000"), [255, 0, 0]);
        assert_eq!(parse_color("auto"), [0, 0, 0]);
    }
}
