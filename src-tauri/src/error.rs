use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Error, Debug, Serialize, Deserialize, Clone)]
pub enum AppError {
    #[error("IO error: {0}")]
    IoError(String),

    #[error("Internal error: {0}")]
    InternalError(String),
}

impl From<std::io::Error> for AppError {
    fn from(err: std::io::Error) -> Self {
        AppError::IoError(err.to_string())
    }
}

// Convert AppError to a serializable format for Tauri commands
impl From<AppError> for String {
    fn from(err: AppError) -> String {
        err.to_string()
    }
}
