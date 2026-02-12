/// Get the app data directory path
#[tauri::command]
pub async fn get_app_data_dir() -> Result<String, String> {
    dirs::data_dir()
        .map(|p| p.join("vibesub-companion").to_string_lossy().to_string())
        .ok_or_else(|| "Could not determine app data directory".to_string())
}
