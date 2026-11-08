//! Tauri shell for ETS2 Livery Studio. All file-format logic lives in `ets2-core`.

mod commands;

use std::sync::Mutex;

/// Shared backend state: the currently opened game (mounted archives).
#[derive(Default)]
pub struct AppState {
    pub session: Mutex<Option<ets2_core::game::GameSession>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(std::sync::Arc::new(AppState::default()))
        .invoke_handler(tauri::generate_handler![
            commands::detect_installations,
            commands::default_mod_dir,
            commands::open_game,
            commands::mount_extra,
            commands::list_dir,
            commands::read_text,
            commands::load_model,
            commands::export_mod,
            commands::save_text_file,
            commands::load_text_file,
            commands::save_binary_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running ETS2 Livery Studio");
}
