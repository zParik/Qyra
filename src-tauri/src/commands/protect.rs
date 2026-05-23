use lopdf::{Document, EncryptionVersion, EncryptionState, Permissions};
use lopdf::encryption::crypt_filters::{Aes256CryptFilter, CryptFilter};
use rand::RngExt;
use std::collections::BTreeMap;
use std::sync::Arc;
use crate::utils::paths::temp_output_path;
use crate::error::{AppError, AppResult};

/// Password-protect a PDF using AES-256 (PDF encryption V5, R6 — ISO 32000-2).
///
/// V2 (RC4) and V4 (AES-128) are intentionally not used: RC4 is broken and was
/// removed from PDF 2.0, and AES-128 is no longer recommended for new documents.
#[tauri::command]
pub fn protect_pdf(
    path: String,
    user_password: String,
    owner_password: Option<String>,
    output: Option<String>,
) -> AppResult<String> {
    let mut doc = Document::load(&path)?;
    let owner_pw = owner_password.unwrap_or_else(|| user_password.clone());

    // V5 requires a random 32-byte file encryption key supplied by the caller.
    let mut file_encryption_key = [0u8; 32];
    rand::rng().fill(&mut file_encryption_key);

    let crypt_filter: Arc<dyn CryptFilter> = Arc::new(Aes256CryptFilter);

    let version = EncryptionVersion::V5 {
        encrypt_metadata: true,
        crypt_filters: BTreeMap::from([(b"StdCF".to_vec(), crypt_filter)]),
        file_encryption_key: &file_encryption_key,
        stream_filter: b"StdCF".to_vec(),
        string_filter: b"StdCF".to_vec(),
        owner_password: &owner_pw,
        user_password: &user_password,
        permissions: Permissions::all(),
    };

    let state = EncryptionState::try_from(version)
        .map_err(|e| AppError::Pdf(format!("Failed to create encryption state: {}", e)))?;

    doc.encrypt(&state)
        .map_err(|e| AppError::Pdf(format!("Encryption failed: {}", e)))?;

    let out = output.unwrap_or_else(|| temp_output_path(&path, "protected"));
    doc.save(&out)?;
    Ok(out)
}
