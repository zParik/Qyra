use crate::error::{AppError, AppResult};
use crate::utils::paths::temp_output_path;
use lopdf::{Dictionary, Document, Object, ObjectId};
use serde::Deserialize;

#[derive(Debug, Deserialize, Clone)]
pub struct OutlineItemInput {
    pub title: String,
    pub page: Option<u32>,
    pub items: Vec<OutlineItemInput>,
}

fn page_id_for_number(doc: &Document, page_num: u32) -> Option<ObjectId> {
    doc.get_pages().get(&page_num).copied()
}

fn flatten<'a>(input: &'a [OutlineItemInput], out: &mut Vec<(usize, &'a OutlineItemInput)>, depth: usize) {
    for item in input {
        out.push((depth, item));
        flatten(&item.items, out, depth + 1);
    }
}

/// Replace the document outline with the supplied tree. Existing outline is
/// dropped. Pass an empty Vec to remove the outline entirely.
#[tauri::command]
pub async fn set_outline(
    path: String,
    items: Vec<OutlineItemInput>,
    output: Option<String>,
) -> AppResult<String> {
    tokio::task::spawn_blocking(move || -> AppResult<String> {
        let mut doc = Document::load(&path)?;

        // 1) Drop the existing outline (if any).
        let catalog_id = doc
            .trailer
            .get(b"Root")
            .map_err(|e| AppError::Pdf(e.to_string()))?
            .as_reference()
            .map_err(|e| AppError::Pdf(e.to_string()))?;
        if let Ok(Object::Dictionary(catalog)) = doc.get_object_mut(catalog_id) {
            catalog.remove(b"Outlines");
            catalog.remove(b"PageMode");
        }

        if items.is_empty() {
            let out = output.unwrap_or_else(|| temp_output_path(&path, "outline"));
            doc.save(&out)?;
            return Ok(out);
        }

        // 2) Flatten the input tree to (depth, item) DFS order so we can build
        //    sibling/parent pointers in one pass.
        let mut flat: Vec<(usize, &OutlineItemInput)> = Vec::new();
        flatten(&items, &mut flat, 0);

        // 3) Pre-allocate ObjectIds for each item + the outline root.
        let root_id = doc.add_object(Object::Dictionary(Dictionary::new()));
        let item_ids: Vec<ObjectId> = flat
            .iter()
            .map(|_| doc.add_object(Object::Dictionary(Dictionary::new())))
            .collect();

        // 4) Walk the flat list to compute parent/prev/next/first/last/count
        //    for each node.
        struct NodeMeta {
            parent: ObjectId,
            prev: Option<ObjectId>,
            next: Option<ObjectId>,
            first: Option<ObjectId>,
            last: Option<ObjectId>,
            count: i64,
        }

        let mut metas: Vec<NodeMeta> = (0..flat.len())
            .map(|_| NodeMeta {
                parent: root_id,
                prev: None,
                next: None,
                first: None,
                last: None,
                count: 0,
            })
            .collect();

        // Track the last seen index per depth so we can wire prev/next.
        let mut stack: Vec<Vec<usize>> = vec![Vec::new()]; // children at depth 0 = root's
        for (idx, (depth, _)) in flat.iter().enumerate() {
            while stack.len() <= *depth { stack.push(Vec::new()); }
            // Truncate any deeper levels — entering a shallower depth closes them.
            stack.truncate(depth + 1);
            stack.push(Vec::new());
            stack[*depth].push(idx);
        }

        // Reset and walk again, this time recording parent + sibling chain.
        let mut depth_parent_idx: Vec<Option<usize>> = vec![None];
        for (idx, (depth, _)) in flat.iter().enumerate() {
            while depth_parent_idx.len() <= *depth { depth_parent_idx.push(None); }
            depth_parent_idx.truncate(depth + 1);

            let parent_id = if *depth == 0 {
                root_id
            } else {
                let pidx = depth_parent_idx[*depth - 1]
                    .expect("nested item should have a parent at the previous depth");
                item_ids[pidx]
            };
            metas[idx].parent = parent_id;

            depth_parent_idx.push(Some(idx));
        }

        // Sibling chains: group children by parent index (None = root).
        use std::collections::HashMap;
        let mut groups: HashMap<Option<usize>, Vec<usize>> = HashMap::new();
        // Recompute parent index per item to feed the group map.
        let mut parent_of: Vec<Option<usize>> = vec![None; flat.len()];
        let mut depth_to_idx: Vec<Option<usize>> = Vec::new();
        for (idx, (depth, _)) in flat.iter().enumerate() {
            while depth_to_idx.len() <= *depth { depth_to_idx.push(None); }
            depth_to_idx.truncate(depth + 1);
            parent_of[idx] = if *depth == 0 { None } else { depth_to_idx[*depth - 1] };
            depth_to_idx.push(Some(idx));
        }
        for (idx, parent) in parent_of.iter().enumerate() {
            groups.entry(*parent).or_default().push(idx);
        }

        // Wire prev/next inside each sibling group.
        for siblings in groups.values() {
            for (i, &idx) in siblings.iter().enumerate() {
                if i > 0 { metas[idx].prev = Some(item_ids[siblings[i - 1]]); }
                if i + 1 < siblings.len() { metas[idx].next = Some(item_ids[siblings[i + 1]]); }
            }
        }

        // Wire first/last/count on each parent (including root).
        let mut root_count: i64 = 0;
        for (parent_idx, siblings) in &groups {
            let first = siblings.first().map(|&i| item_ids[i]);
            let last = siblings.last().map(|&i| item_ids[i]);
            let direct = siblings.len() as i64;
            if let Some(pi) = parent_idx {
                metas[*pi].first = first;
                metas[*pi].last = last;
                metas[*pi].count = direct; // open: positive = expanded child count
            } else {
                root_count = direct;
            }
        }

        // 5) Materialise each item dictionary.
        for (idx, (_depth, item)) in flat.iter().enumerate() {
            let mut dict = Dictionary::new();
            dict.set("Title", Object::string_literal(item.title.clone()));
            dict.set("Parent", Object::Reference(metas[idx].parent));
            if let Some(p) = metas[idx].prev { dict.set("Prev", Object::Reference(p)); }
            if let Some(n) = metas[idx].next { dict.set("Next", Object::Reference(n)); }
            if let Some(f) = metas[idx].first { dict.set("First", Object::Reference(f)); }
            if let Some(l) = metas[idx].last { dict.set("Last", Object::Reference(l)); }
            if metas[idx].count > 0 {
                dict.set("Count", Object::Integer(metas[idx].count));
            }

            if let Some(page_num) = item.page {
                if let Some(page_id) = page_id_for_number(&doc, page_num) {
                    // /Dest [<page_ref> /XYZ null null null] — open at top-left, default zoom.
                    let dest = vec![
                        Object::Reference(page_id),
                        Object::Name(b"XYZ".to_vec()),
                        Object::Null,
                        Object::Null,
                        Object::Null,
                    ];
                    dict.set("Dest", Object::Array(dest));
                }
            }

            let target = doc.get_object_mut(item_ids[idx])
                .map_err(|e| AppError::Pdf(e.to_string()))?;
            if let Object::Dictionary(d) = target {
                *d = dict;
            }
        }

        // 6) Materialise the outline root.
        let mut root_dict = Dictionary::new();
        root_dict.set("Type", Object::Name(b"Outlines".to_vec()));
        if let Some(first) = groups.get(&None).and_then(|v| v.first()).copied() {
            root_dict.set("First", Object::Reference(item_ids[first]));
        }
        if let Some(last) = groups.get(&None).and_then(|v| v.last()).copied() {
            root_dict.set("Last", Object::Reference(item_ids[last]));
        }
        if root_count > 0 {
            root_dict.set("Count", Object::Integer(root_count));
        }
        if let Ok(Object::Dictionary(d)) = doc.get_object_mut(root_id) {
            *d = root_dict;
        }

        // 7) Catalog → /Outlines + /PageMode UseOutlines for default visibility.
        if let Ok(Object::Dictionary(catalog)) = doc.get_object_mut(catalog_id) {
            catalog.set("Outlines", Object::Reference(root_id));
            catalog.set("PageMode", Object::Name(b"UseOutlines".to_vec()));
        }

        let out = output.unwrap_or_else(|| temp_output_path(&path, "outline"));
        doc.save(&out)?;
        Ok(out)
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flatten_preserves_dfs_order_with_depth() {
        let items = vec![
            OutlineItemInput {
                title: "A".into(), page: Some(1),
                items: vec![
                    OutlineItemInput { title: "A.1".into(), page: Some(2), items: vec![] },
                    OutlineItemInput { title: "A.2".into(), page: Some(3), items: vec![] },
                ],
            },
            OutlineItemInput { title: "B".into(), page: Some(4), items: vec![] },
        ];
        let mut flat = Vec::new();
        flatten(&items, &mut flat, 0);
        let titles: Vec<(usize, &str)> = flat
            .iter()
            .map(|(d, i)| (*d, i.title.as_str()))
            .collect();
        assert_eq!(titles, vec![(0, "A"), (1, "A.1"), (1, "A.2"), (0, "B")]);
    }
}
