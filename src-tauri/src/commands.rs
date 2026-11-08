//! Tauri commands. Names and arguments mirror `src/lib/api.ts`.

use std::sync::Arc;

use base64::Engine;
use ets2_core::export::{ExportRequest, ExportResult};
use ets2_core::game::{self, GameIndex, GameSession, Installation};
use ets2_core::hashfs::DirListing;
use ets2_core::model::ModelData;
use tauri::State;

use crate::AppState;

type Shared<'a> = State<'a, Arc<AppState>>;
type CmdResult<T> = Result<T, String>;

/// Runs blocking work on the thread pool so the UI stays responsive.
async fn blocking<T, F>(f: F) -> CmdResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> CmdResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("background task failed: {e}"))?
}

fn with_session<T>(state: &AppState, f: impl FnOnce(&GameSession) -> CmdResult<T>) -> CmdResult<T> {
    let guard = state.session.lock().map_err(|_| "state lock poisoned".to_string())?;
    match guard.as_ref() {
        Some(s) => f(s),
        None => Err("no game opened yet".into()),
    }
}

#[tauri::command]
pub async fn detect_installations() -> CmdResult<Vec<Installation>> {
    blocking(|| Ok(game::detect_installations())).await
}

#[tauri::command]
pub fn default_mod_dir() -> Option<String> {
    game::default_mod_dir()
}

#[tauri::command]
pub async fn open_game(state: Shared<'_>, game_dir: String) -> CmdResult<GameIndex> {
    let state = Arc::clone(&state);
    blocking(move || {
        let session = GameSession::open(&game_dir).map_err(|e| e.to_string())?;
        let index = session.index();
        *state.session.lock().map_err(|_| "state lock poisoned".to_string())? = Some(session);
        Ok(index)
    })
    .await
}

#[tauri::command]
pub async fn mount_extra(state: Shared<'_>, path: String) -> CmdResult<GameIndex> {
    let state = Arc::clone(&state);
    blocking(move || {
        let mut guard = state.session.lock().map_err(|_| "state lock poisoned".to_string())?;
        let session = guard.as_mut().ok_or("open the game folder first")?;
        session.mount_extra(&path).map_err(|e| e.to_string())?;
        Ok(session.index())
    })
    .await
}

#[tauri::command]
pub async fn list_dir(state: Shared<'_>, path: String) -> CmdResult<DirListing> {
    let state = Arc::clone(&state);
    blocking(move || with_session(&state, |s| s.vfs.list_dir(&path).map_err(|e| e.to_string()))).await
}

#[tauri::command]
pub async fn read_text(state: Shared<'_>, path: String) -> CmdResult<String> {
    let state = Arc::clone(&state);
    blocking(move || {
        with_session(&state, |s| {
            let data = s.vfs.read(&path).map_err(|e| e.to_string())?;
            ets2_core::sii::decode(&data).map_err(|e| e.to_string())
        })
    })
    .await
}

#[tauri::command]
pub async fn load_model(state: Shared<'_>, pmd_path: String, look: Option<usize>) -> CmdResult<ModelData> {
    let state = Arc::clone(&state);
    blocking(move || {
        with_session(&state, |s| {
            ets2_core::model::load_model(&s.vfs, &pmd_path, look.unwrap_or(0)).map_err(|e| e.to_string())
        })
    })
    .await
}

#[tauri::command]
pub async fn export_mod(request: ExportRequest) -> CmdResult<ExportResult> {
    blocking(move || ets2_core::export::export_mod(&request).map_err(|e| e.to_string())).await
}

#[tauri::command]
pub async fn save_text_file(path: String, contents: String) -> CmdResult<()> {
    blocking(move || std::fs::write(&path, contents).map_err(|e| format!("{path}: {e}"))).await
}

#[tauri::command]
pub async fn load_text_file(path: String) -> CmdResult<String> {
    blocking(move || std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))).await
}

#[tauri::command]
pub async fn save_binary_file(path: String, base64: String) -> CmdResult<()> {
    blocking(move || {
        let data = base64.split_once("base64,").map(|(_, d)| d).unwrap_or(&base64);
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data.trim())
            .map_err(|e| format!("invalid base64: {e}"))?;
        std::fs::write(&path, bytes).map_err(|e| format!("{path}: {e}"))
    })
    .await
}
