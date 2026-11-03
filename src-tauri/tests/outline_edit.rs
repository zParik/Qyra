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

// Regression for a fixed bug: set_outline used to panic on nested items because
// the depth→parent map in outline_edit.rs was off by one (read the root slot
// instead of the parent). Asserts the nested child round-trips under its parent.
#[tokio::test]
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
    let intro = nodes
        .iter()
        .find(|n| n.title.contains("Intro"))
        .expect("Intro present at top level");
    assert!(
        intro.items.iter().any(|c| c.title.contains("Background")),
        "Background should be nested under Intro, got: {:?}",
        intro.items.iter().map(|c| &c.title).collect::<Vec<_>>()
    );
    // Sibling at root level must not absorb the child.
    assert_eq!(nodes.len(), 1, "only Intro should be at the top level");
}

// Three levels deep — exercises the parent map at depth >= 2.
#[tokio::test]
async fn set_outline_supports_deeply_nested_items() {
    let src = fixture_str("multipage.pdf");
    let (_d, out) = temp_output("deep.pdf");

    set_outline(
        src,
        vec![OutlineItemInput {
            title: "Part".into(),
            page: Some(1),
            items: vec![OutlineItemInput {
                title: "Chapter".into(),
                page: Some(2),
                items: vec![OutlineItemInput {
                    title: "Section".into(),
                    page: Some(3),
                    items: vec![],
                }],
            }],
        }],
        Some(out.clone()),
    )
    .await
    .expect("set deep outline");

    let nodes = get_outline(out).await.expect("get outline");
    let part = nodes.iter().find(|n| n.title.contains("Part")).expect("Part");
    let chapter = part
        .items
        .iter()
        .find(|n| n.title.contains("Chapter"))
        .expect("Chapter under Part");
    assert!(
        chapter.items.iter().any(|n| n.title.contains("Section")),
        "Section should be nested under Chapter"
    );
}

#[tokio::test]
async fn empty_outline_clears_existing_bookmarks() {
    let src = fixture_str("outline.pdf");
    let (_d, out) = temp_output("nooutline.pdf");

    set_outline(src, vec![], Some(out.clone())).await.expect("clear outline");

    let nodes = get_outline(out).await.expect("get outline");
    assert!(nodes.is_empty(), "outline should be empty after clearing");
}
