//! Password protection: protect → encrypted, unlock → plaintext, permissions.

mod common;

use common::{fixture_str, is_encrypted, page_count, temp_output};
use qyra_lib::commands::metadata::get_pdf_permissions;
use qyra_lib::commands::protect::protect_pdf;
use qyra_lib::commands::unlock::unlock_pdf;

#[tokio::test]
async fn protect_then_unlock_round_trips() {
    let src = fixture_str("simple.pdf");
    let (_d1, protected) = temp_output("protected.pdf");
    let (_d2, unlocked) = temp_output("unlocked.pdf");

    protect_pdf(src, "secret".into(), None, Some(protected.clone())).expect("protect");
    assert!(is_encrypted(&protected), "protected file must be encrypted");

    unlock_pdf(protected.clone(), "secret".into(), Some(unlocked.clone())).expect("unlock");
    assert!(!is_encrypted(&unlocked), "unlocked file must be plaintext");
    assert_eq!(page_count(&unlocked), 1, "unlocked file should reopen cleanly");
}

#[tokio::test]
async fn unlock_with_wrong_password_fails() {
    let src = fixture_str("simple.pdf");
    let (_d, protected) = temp_output("protected.pdf");

    protect_pdf(src, "secret".into(), None, Some(protected.clone())).expect("protect");
    assert!(unlock_pdf(protected, "wrong".into(), None).is_err());
}

#[tokio::test]
async fn permissions_report_plaintext_as_unencrypted() {
    let src = fixture_str("simple.pdf");
    let perms = get_pdf_permissions(src).expect("permissions");
    assert!(!perms.encrypted);
    assert!(perms.print);
}

#[tokio::test]
async fn edits_keep_owner_only_encryption() {
    // A file with an owner password and an empty user password opens without
    // a prompt. lopdf decrypts it on load, and every edit used to save it
    // with the encryption (and its permission limits) gone.
    let (_d1, protected) = temp_output("owner-only.pdf");
    protect_pdf(fixture_str("simple.pdf"), String::new(), Some("owner".into()), Some(protected.clone()))
        .expect("protect");
    let has_encrypt = |p: &str| {
        let bytes = std::fs::read(p).unwrap();
        bytes.windows(8).any(|w| w == b"/Encrypt")
    };
    assert!(has_encrypt(&protected));

    let (_d2, rotated) = temp_output("rotated.pdf");
    qyra_lib::commands::rotate::rotate_pages(protected, vec![1], 90, Some(rotated.clone())).expect("rotate");
    assert!(has_encrypt(&rotated), "rotating must keep the encryption");
    assert_eq!(page_count(&rotated), 1, "and the file must still open");
    let doc = lopdf::Document::load(&rotated).unwrap();
    assert_eq!(doc.get_pages().len(), 1);
}
