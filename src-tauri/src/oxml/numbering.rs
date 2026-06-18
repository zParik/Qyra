//! Parse `word/numbering.xml` to distinguish ordered vs bullet lists and supply
//! per-level marker text. Resolution: `numId` → `abstractNumId` → per-`ilvl`
//! format (`w:numFmt`, `w:lvlText`, `w:start`).
//!
//! The docx parser combines this with running counters (in document order) to
//! produce the concrete marker string for each list paragraph.

use std::collections::HashMap;

use quick_xml::events::Event;
use quick_xml::reader::Reader;

use super::styles::{attr_f32, attr_str};

#[derive(Debug, Clone, PartialEq)]
pub struct LevelFmt {
    pub ordered: bool,
    /// Marker template, e.g. "%1." for decimal; bullet symbol for bullets.
    pub lvl_text: String,
    pub start: i32,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Numbering {
    nums: HashMap<i32, Vec<LevelFmt>>,
}

impl Numbering {
    pub fn empty() -> Self {
        Self::default()
    }

    /// The format for `num_id` at list level `level`, if known.
    pub fn level(&self, num_id: i32, level: u8) -> Option<&LevelFmt> {
        self.nums.get(&num_id).and_then(|lv| lv.get(level as usize))
    }

    pub fn parse(xml: &str) -> Self {
        let mut abstract_levels: HashMap<i32, Vec<LevelFmt>> = HashMap::new();
        let mut num_to_abstract: HashMap<i32, i32> = HashMap::new();

        let mut cur_abstract: Option<i32> = None;
        let mut cur_levels: Vec<LevelFmt> = Vec::new();
        let mut cur_lvl: Option<LevelFmt> = None;
        let mut cur_num: Option<i32> = None;

        let mut reader = Reader::from_str(xml);
        let mut buf = Vec::new();
        loop {
            let ev = match reader.read_event_into(&mut buf) {
                Ok(ev) => ev,
                Err(_) => break,
            };
            match ev {
                Event::Start(e) | Event::Empty(e) => match e.name().as_ref() {
                    b"w:abstractNum" => {
                        cur_abstract = attr_f32(&e, b"w:abstractNumId").map(|f| f as i32);
                        cur_levels = Vec::new();
                    }
                    b"w:lvl" => {
                        cur_lvl = Some(LevelFmt { ordered: false, lvl_text: String::new(), start: 1 });
                    }
                    b"w:numFmt" => {
                        if let Some(l) = cur_lvl.as_mut() {
                            let v = attr_str(&e, b"w:val");
                            l.ordered = !matches!(v.as_deref(), Some("bullet") | Some("none") | None);
                        }
                    }
                    b"w:lvlText" => {
                        if let Some(l) = cur_lvl.as_mut() {
                            if let Some(v) = attr_str(&e, b"w:val") {
                                l.lvl_text = v;
                            }
                        }
                    }
                    b"w:start" => {
                        if let Some(l) = cur_lvl.as_mut() {
                            if let Some(v) = attr_f32(&e, b"w:val") {
                                l.start = v as i32;
                            }
                        }
                    }
                    b"w:num" => cur_num = attr_f32(&e, b"w:numId").map(|f| f as i32),
                    b"w:abstractNumId" => {
                        // The element form (inside <w:num>), not the attribute.
                        if let (Some(n), Some(a)) = (cur_num, attr_f32(&e, b"w:val").map(|f| f as i32)) {
                            num_to_abstract.insert(n, a);
                        }
                    }
                    _ => {}
                },
                Event::End(e) => match e.name().as_ref() {
                    b"w:lvl" => {
                        if let Some(l) = cur_lvl.take() {
                            cur_levels.push(l);
                        }
                    }
                    b"w:abstractNum" => {
                        if let Some(a) = cur_abstract.take() {
                            abstract_levels.insert(a, std::mem::take(&mut cur_levels));
                        }
                    }
                    b"w:num" => cur_num = None,
                    _ => {}
                },
                Event::Eof => break,
                _ => {}
            }
            buf.clear();
        }

        let mut nums = HashMap::new();
        for (num, abs) in num_to_abstract {
            if let Some(levels) = abstract_levels.get(&abs) {
                nums.insert(num, levels.clone());
            }
        }
        Numbering { nums }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_ordered_and_bullet() {
        let xml = r#"<w:numbering xmlns:w="x">
          <w:abstractNum w:abstractNumId="0">
            <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl>
          </w:abstractNum>
          <w:abstractNum w:abstractNumId="1">
            <w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="o"/></w:lvl>
          </w:abstractNum>
          <w:num w:numId="5"><w:abstractNumId w:val="0"/></w:num>
          <w:num w:numId="6"><w:abstractNumId w:val="1"/></w:num>
        </w:numbering>"#;
        let n = Numbering::parse(xml);
        let ordered = n.level(5, 0).expect("num 5 level 0");
        assert!(ordered.ordered);
        assert_eq!(ordered.lvl_text, "%1.");
        assert!(!n.level(6, 0).expect("num 6").ordered);
    }
}
