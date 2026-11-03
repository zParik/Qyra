//! File plumbing: saving over the user's files and naming working copies.

use qyra_lib::commands::files::copy_file;
use qyra_lib::utils::paths::temp_output_path;

#[tokio::test]
async fn copying_a_file_onto_itself_keeps_its_content() {
    let dir = tempfile::tempdir().unwrap();
    let f = dir.path().join("doc.pdf");
    std::fs::write(&f, b"%PDF-1.7 content").unwrap();
    let p = f.to_string_lossy().into_owned();

    copy_file(p.clone(), p).await.expect("copy onto itself");

    assert_eq!(std::fs::read(&f).unwrap(), b"%PDF-1.7 content");
}

#[tokio::test]
async fn copying_over_a_file_replaces_it_and_leaves_no_temp_files() {
    let dir = tempfile::tempdir().unwrap();
    let (src, dst) = (dir.path().join("new.pdf"), dir.path().join("old.pdf"));
    std::fs::write(&src, b"new").unwrap();
    std::fs::write(&dst, b"old, and longer").unwrap();

    copy_file(src.to_string_lossy().into_owned(), dst.to_string_lossy().into_owned()).await.expect("copy");

    assert_eq!(std::fs::read(&dst).unwrap(), b"new");
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 2, "a temp file was left behind");
}

#[test]
fn working_copies_of_same_named_files_do_not_collide() {
    let a = temp_output_path("/home/u/a/report.pdf", "annotated");
    let b = temp_output_path("/home/u/b/report.pdf", "annotated");
    assert_ne!(a, b);
    assert!(a.ends_with("report_annotated.pdf"), "{a}");
}

#[test]
fn chained_edits_do_not_grow_the_working_file_name() {
    let mut p = temp_output_path("/home/u/report.pdf", "annotated");
    for _ in 0..40 {
        p = temp_output_path(&p, "annotated");
    }
    let name = std::path::Path::new(&p).file_name().unwrap().to_string_lossy().into_owned();
    assert_eq!(name, "report_annotated.pdf");
}
