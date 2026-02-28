use std::path::PathBuf;

use tauri::{AppHandle, Manager, Runtime};

pub fn app_data_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    // Useful for tests and power users (e.g. portable mode). When unset, we
    // follow the OS-specific default resolved by Tauri.
    if let Ok(v) = std::env::var("CODEXRELAY_APP_DATA_DIR") {
        let v = v.trim();
        if !v.is_empty() {
            return Ok(PathBuf::from(v));
        }
    }
    app.path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app_data_dir: {e}"))
}

pub fn db_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("codexrelay.sqlite3"))
}

pub fn vault_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("vault"))
}

pub fn download_dir() -> Result<PathBuf, String> {
    // Override for tests / power users.
    if let Ok(v) = std::env::var("CODEXRELAY_EXPORT_DIR") {
        let v = v.trim();
        if !v.is_empty() {
            return Ok(PathBuf::from(v));
        }
    }

    if let Some(p) = dirs::download_dir() {
        return Ok(p);
    }
    if let Some(home) = dirs::home_dir() {
        // Best-effort conventional fallback.
        return Ok(home.join("Downloads"));
    }
    // Last resort: still provide a usable directory.
    Ok(std::env::temp_dir())
}
