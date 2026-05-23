use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("io: {0}")] Io(#[from] std::io::Error),
    #[error("db: {0}")] Db(#[from] rusqlite::Error),
    #[error("pdf: {0}")] Pdf(String),
    #[error("pdf: {0}")] Lopdf(#[from] lopdf::Error),
    #[error("pdf: {0}")] Mupdf(#[from] mupdf::Error),
    #[error("image: {0}")] Image(#[from] image::ImageError),
    #[error("invalid input: {0}")] Invalid(String),
    #[error("not found: {0}")] NotFound(String),
    #[error("lock poisoned: {0}")] Lock(String),
    #[error("{0}")] Other(String),
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

impl From<String> for AppError {
    fn from(s: String) -> Self { AppError::Other(s) }
}
impl From<&str> for AppError {
    fn from(s: &str) -> Self { AppError::Other(s.to_string()) }
}

pub type AppResult<T> = Result<T, AppError>;
