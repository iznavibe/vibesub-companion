mod commands;
mod error;
mod state;

use state::AppState;
use std::sync::Arc;
use tokio::sync::RwLock;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize logger, ignore errors
    let _ = env_logger::try_init();

    let app_state = Arc::new(RwLock::new(AppState::new()));

    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_http::init())
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            commands::file::get_app_data_dir,
            commands::waveform::extract_waveform,
            commands::render::check_ffmpeg,
            commands::render::render_lyric_video,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
