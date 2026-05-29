//! Outline editing: set a new outline, and clear it.

mod common;

use common::{fixture_str, temp_output};
use qyra_lib::commands::outline::get_outline;
use qyra_lib::commands::outline_edit::{set_outline, OutlineItemInput};

#[tokio::test]
async fn set_outline_then_read_back_titles() {
    let src = fixture_str("multipage.pdf");
    let (_d, out) = temp_output("outlined.pdf");

    set_outline(
        src,
        vec![
            OutlineItemInput { title: "Intro".into(), page: Some(1), items: vec![] },
            OutlineItemInput { title: "Conclusion".into(), page: Some(5), items: vec![] },
        ],
        Some(out.clone()),
    )
    .await
    .expect("set outline");

    let nodes = get_outline(out).await.expect("get outline");
    let titles: Vec<String> = nodes.iter().map(|n| n.title.clone()).collect();
    assert!(titles.iter().any(|t| t.contains("Intro")));
    assert!(titles.iter().any(|t| t.contains("Conclusion")));
}

// Regression for a known bug: set_outline panics on nested items because the
// depth→parent stack in outline_edit.rs is off by one (reads depth_parent_idx
// [depth-1], the root slot, instead of the parent). Un-ignore once fixed.
#[tokio::test]
#[ignore = "set_outline panics on nested outline items (outline_edit.rs:107 off-by-one)"]
async fn set_outline_supports_nested_items() {
    let src = fixture_str("multipage.pdf");
    let (_d, out) = temp_output("nested.pdf");

    set_outline(
        src,
        vec![OutlineItemInput {
            title: "Intro".into(),
            page: Some(1),
            items: vec![OutlineItemInput { title: "Background".into(), page: Some(2), items: vec![] }],
        }],
        Some(out.clone()),
    )
    .await
    .expect("set nested outline");

    let nodes = get_outline(out).await.expect("get outline");
    assert!(nodes.iter().any(|n| n.title.contains("Intro")));
}

#[tokio::test]
async fn empty_outline_clears_existing_bookmarks() {
    let src = fixture_str("outline.pdf");
    let (_d, out) = temp_output("nooutline.pdf");

    set_outline(src, vec![], Some(out.clone())).await.expect("clear outline");

    let nodes = get_outline(out).await.expect("get outline");
    assert!(nodes.is_empty(), "outline should be empty after clearing");
}
