use crate::error::{AppError, AppResult};
use crate::utils::paths::temp_output_path;
use std::fs;

use super::forms::{fill_form, get_form_fields, FieldValue};

fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '&' => out.push_str("&amp;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(c),
        }
    }
    out
}

/// Walk an XFDF blob and pull `<field name="..."><value>...</value></field>`
/// pairs. Handles nested fields (Adobe XFDF lets fields nest to express dot
/// names) by joining ancestor names with `.`. We intentionally use a small
/// hand-rolled parser to avoid pulling in an XML dependency.
fn parse_xfdf(xml: &str) -> Vec<(String, String)> {
    let bytes = xml.as_bytes();
    let mut i = 0;
    let mut stack: Vec<String> = Vec::new();
    let mut result: Vec<(String, String)> = Vec::new();
    let mut current_value: Option<(String, String)> = None;

    fn read_attr<'a>(tag: &'a str, attr: &str) -> Option<&'a str> {
        let key = format!("{}=\"", attr);
        let from = tag.find(&key)?;
        let after = &tag[from + key.len()..];
        let end = after.find('"')?;
        Some(&after[..end])
    }

    while i < bytes.len() {
        if bytes[i] != b'<' {
            if let Some((_, ref mut val)) = current_value {
                val.push(bytes[i] as char);
            }
            i += 1;
            continue;
        }

        // Skip XML declaration and comments.
        if bytes[i..].starts_with(b"<?") {
            if let Some(rel) = bytes[i..].iter().position(|&b| b == b'>') {
                i += rel + 1;
            } else { break; }
            continue;
        }
        if bytes[i..].starts_with(b"<!--") {
            if let Some(rel) = xml[i..].find("-->") {
                i += rel + 3;
            } else { break; }
            continue;
        }

        // Find tag end.
        let tag_end_rel = match bytes[i..].iter().position(|&b| b == b'>') {
            Some(p) => p,
            None => break,
        };
        let tag = &xml[i + 1..i + tag_end_rel];
        i += tag_end_rel + 1;

        let self_closing = tag.ends_with('/');
        let is_close = tag.starts_with('/');
        let inner = tag.trim_start_matches('/').trim_end_matches('/').trim();
        let name_end = inner.find(|c: char| c.is_whitespace()).unwrap_or(inner.len());
        let name = &inner[..name_end];

        if is_close {
            if name == "value" {
                if let Some((field_name, value)) = current_value.take() {
                    result.push((field_name, value));
                }
            } else if name == "field" {
                stack.pop();
            }
            continue;
        }

        if name == "field" {
            let fname = read_attr(inner, "name").unwrap_or("").to_string();
            let full = if stack.is_empty() { fname.clone() } else {
                format!("{}.{}", stack.join("."), fname)
            };
            if !self_closing {
                stack.push(fname);
            }
            // The full path is staged for any nested <value>.
            current_value = Some((full, String::new()));
            // But only commit if a value tag actually populates it.
            // We still want stack push for nested traversal; the value
            // commit happens in the </value> branch above.
            // If no nested value appears, we just drop current_value when
            // the next field opens — that mirrors XFDF semantics.
        } else if name == "value" && !self_closing {
            if current_value.is_none() {
                current_value = Some((stack.join("."), String::new()));
            } else if let Some((_, ref mut v)) = current_value {
                v.clear();
            }
        }
    }

    // Decode entity references after collection so users see real text.
    result
        .into_iter()
        .map(|(n, v)| {
            (
                n,
                v.replace("&lt;", "<")
                    .replace("&gt;", ">")
                    .replace("&quot;", "\"")
                    .replace("&apos;", "'")
                    .replace("&amp;", "&"),
            )
        })
        .collect()
}

#[tauri::command]
pub async fn export_form_xfdf(path: String, output: Option<String>) -> AppResult<String> {
    let fields = get_form_fields(path.clone()).await?;
    let mut xml = String::new();
    xml.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    xml.push_str("<xfdf xmlns=\"http://ns.adobe.com/xfdf/\" xml:space=\"preserve\">\n");
    xml.push_str("  <fields>\n");
    for f in &fields {
        xml.push_str(&format!(
            "    <field name=\"{}\"><value>{}</value></field>\n",
            xml_escape(&f.name),
            xml_escape(&f.value),
        ));
    }
    xml.push_str("  </fields>\n");
    xml.push_str(&format!("  <f href=\"{}\"/>\n", xml_escape(&path)));
    xml.push_str("</xfdf>\n");

    let out = output.unwrap_or_else(|| {
        let base = temp_output_path(&path, "form");
        // temp_output_path defaults to .pdf — swap extension.
        base.trim_end_matches(".pdf").to_string() + ".xfdf"
    });
    fs::write(&out, xml).map_err(|e| AppError::Other(format!("write xfdf: {e}")))?;
    Ok(out)
}

#[tauri::command]
pub async fn import_form_xfdf(
    pdf_path: String,
    xfdf_path: String,
    flatten: bool,
    output: Option<String>,
) -> AppResult<String> {
    let xml = fs::read_to_string(&xfdf_path)
        .map_err(|e| AppError::Other(format!("read xfdf: {e}")))?;
    let pairs = parse_xfdf(&xml);
    if pairs.is_empty() {
        return Err(AppError::Other("no fields found in XFDF".into()));
    }
    let fields: Vec<FieldValue> = pairs
        .into_iter()
        .map(|(name, value)| FieldValue { name, value })
        .collect();
    fill_form(pdf_path, fields, flatten, output).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_simple_xfdf() {
        let xml = r#"<?xml version="1.0"?>
<xfdf xmlns="http://ns.adobe.com/xfdf/">
  <fields>
    <field name="Name"><value>Alice</value></field>
    <field name="Age"><value>30</value></field>
  </fields>
</xfdf>"#;
        let pairs = parse_xfdf(xml);
        assert_eq!(pairs.len(), 2);
        assert_eq!(pairs[0], ("Name".to_string(), "Alice".to_string()));
        assert_eq!(pairs[1], ("Age".to_string(), "30".to_string()));
    }

    #[test]
    fn decodes_entities() {
        let xml = r#"<xfdf><fields><field name="X"><value>a &amp; b</value></field></fields></xfdf>"#;
        let pairs = parse_xfdf(xml);
        assert_eq!(pairs[0].1, "a & b");
    }
}
