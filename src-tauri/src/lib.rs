mod app_paths;
mod bundle;
mod codex;
mod db;
mod device;
mod errors;
mod hash;
mod id_extract;
mod ops;
mod preview;
mod settings;
mod transfers;
mod vault;
mod vault_usage;

use serde::{Deserialize, Serialize};
use {errors::AppError, errors::AppResult};

#[derive(Debug, Clone, Serialize)]
struct AppStatus {
    product_name: String,
    version: String,
    codex_home: settings::ResolvedCodexHome,
    app_data_dir: String,
    vault_dir: String,
    db_path: String,
    device: device::DeviceInfo,
}

#[tauri::command]
fn app_status(app: tauri::AppHandle) -> AppResult<AppStatus> {
    let package = app.package_info();
    db::with_conn(&app, |conn| -> AppResult<AppStatus> {
        let (_codex_home, resolved) = settings::resolve_codex_home(conn)?;
        let device = device::current_device_info(conn)?;
        Ok(AppStatus {
            product_name: package.name.to_string(),
            version: package.version.to_string(),
            codex_home: resolved,
            app_data_dir: app_paths::app_data_dir(&app)?.to_string_lossy().to_string(),
            vault_dir: app_paths::vault_dir(&app)?.to_string_lossy().to_string(),
            db_path: app_paths::db_path(&app)?.to_string_lossy().to_string(),
            device,
        })
    })
}

#[tauri::command]
async fn codex_list_sessions(
    app: tauri::AppHandle,
    limit: Option<usize>,
) -> AppResult<Vec<codex::SessionSummary>> {
    let limit = limit.unwrap_or(200);
    tauri::async_runtime::spawn_blocking(move || {
        db::with_conn(&app, |conn| -> Result<Vec<codex::SessionSummary>, String> {
            let (codex_home, _resolved) = settings::resolve_codex_home(conn)?;
            Ok(codex::list_sessions(&codex_home, limit))
        })
    })
    .await
    .map_err(|e| AppError::internal(format!("list-sessions task join error: {e}")))?
    .map_err(AppError::from)
}

#[tauri::command]
async fn export_bundle(
    app: tauri::AppHandle,
    params: ops::ExportParams,
) -> AppResult<ops::ExportResult> {
    tauri::async_runtime::spawn_blocking(move || ops::export_session(&app, params))
        .await
        .map_err(|e| AppError::internal(format!("export task join error: {e}")))?
}

#[tauri::command]
async fn export_sessions(
    app: tauri::AppHandle,
    params: ops::ExportSessionsParams,
) -> AppResult<ops::ExportSessionsResult> {
    tauri::async_runtime::spawn_blocking(move || ops::export_sessions(&app, params))
        .await
        .map_err(|e| AppError::internal(format!("export-sessions task join error: {e}")))?
}

#[tauri::command]
async fn inspect_bundle(
    app: tauri::AppHandle,
    bundle_path: String,
) -> AppResult<ops::InspectBundleResult> {
    tauri::async_runtime::spawn_blocking(move || ops::inspect_bundle(&app, &bundle_path))
        .await
        .map_err(|e| AppError::internal(format!("inspect task join error: {e}")))?
}

#[tauri::command]
async fn import_bundle(
    app: tauri::AppHandle,
    params: ops::ImportParams,
) -> AppResult<ops::ImportResult> {
    tauri::async_runtime::spawn_blocking(move || ops::import_bundle(&app, params))
        .await
        .map_err(|e| AppError::internal(format!("import task join error: {e}")))?
}

#[tauri::command]
async fn import_bundles(
    app: tauri::AppHandle,
    params: ops::ImportBundlesParams,
) -> AppResult<ops::ImportBundlesResult> {
    tauri::async_runtime::spawn_blocking(move || ops::import_bundles(&app, params))
        .await
        .map_err(|e| AppError::internal(format!("import-bundles task join error: {e}")))?
}

#[tauri::command]
async fn change_session_id(
    app: tauri::AppHandle,
    params: ops::ChangeIdParams,
) -> AppResult<ops::ChangeIdResult> {
    tauri::async_runtime::spawn_blocking(move || ops::change_session_id(&app, params))
        .await
        .map_err(|e| AppError::internal(format!("change-id task join error: {e}")))?
}

#[tauri::command]
async fn restore_from_history(
    app: tauri::AppHandle,
    params: ops::RestoreFromHistoryParams,
) -> AppResult<ops::ImportResult> {
    tauri::async_runtime::spawn_blocking(move || ops::restore_from_history(&app, params))
        .await
        .map_err(|e| AppError::internal(format!("restore task join error: {e}")))?
}

#[derive(Debug, Clone, Deserialize)]
struct CodexHomeOverrideParams {
    codex_home_override: Option<String>,
}

#[tauri::command]
fn settings_set_codex_home_override(
    app: tauri::AppHandle,
    params: CodexHomeOverrideParams,
) -> AppResult<AppStatus> {
    db::with_conn(&app, |conn| {
        settings::set_codex_home_override(conn, params.codex_home_override.as_deref())
    })?;
    app_status(app)
}

#[tauri::command]
fn history_list(
    app: tauri::AppHandle,
    limit: Option<usize>,
) -> AppResult<Vec<transfers::TransferRecord>> {
    db::with_conn(&app, |conn| -> AppResult<Vec<transfers::TransferRecord>> {
        Ok(db::transfers_list(conn, limit.unwrap_or(200))?)
    })
}

#[derive(Debug, Clone, Deserialize)]
struct HistoryLatestForSessionsParams {
    session_ids: Vec<String>,
}

#[tauri::command]
fn history_latest_for_sessions(
    app: tauri::AppHandle,
    params: HistoryLatestForSessionsParams,
) -> AppResult<Vec<transfers::TransferRecord>> {
    db::with_conn(&app, |conn| -> AppResult<Vec<transfers::TransferRecord>> {
        Ok(db::transfers_latest_for_sessions(
            conn,
            &params.session_ids,
        )?)
    })
}

#[derive(Debug, Clone, Deserialize)]
struct HistoryDeleteParams {
    id: String,
    delete_files: bool,
}

#[tauri::command]
fn history_delete(app: tauri::AppHandle, params: HistoryDeleteParams) -> AppResult<()> {
    db::with_conn(&app, |conn| -> AppResult<()> {
        if params.delete_files {
            if let Some(r) = db::transfers_get(conn, &params.id)? {
                let dir = std::path::PathBuf::from(r.vault_dir);
                if dir.exists() {
                    let dir = vault::validate_dir_within_vault(&app, &dir)?;
                    vault::safe_remove_dir(&dir)?;
                }
            }
        }
        db::transfers_delete(conn, &params.id)?;
        Ok(())
    })
}

#[derive(Debug, Clone, Deserialize)]
struct HistoryDeleteManyParams {
    ids: Vec<String>,
    delete_files: bool,
}

#[derive(Debug, Clone, Serialize)]
struct HistoryDeleteManyItemError {
    id: String,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
struct HistoryDeleteManyResult {
    requested: usize,
    deleted: usize,
    failed: usize,
    errors: Vec<HistoryDeleteManyItemError>,
}

#[tauri::command]
fn history_delete_many(
    app: tauri::AppHandle,
    params: HistoryDeleteManyParams,
) -> AppResult<HistoryDeleteManyResult> {
    if params.ids.is_empty() {
        return Err(
            AppError::validation("请选择要删除的记录").with_hint("请在历史列表中勾选后再删除。")
        );
    }

    db::with_conn(&app, |conn| -> AppResult<HistoryDeleteManyResult> {
        let mut deleted: usize = 0;
        let mut errors: Vec<HistoryDeleteManyItemError> = Vec::new();

        let mut seen = std::collections::HashSet::<String>::new();
        for raw_id in &params.ids {
            let id = raw_id.trim();
            if id.is_empty() {
                continue;
            }
            if !seen.insert(id.to_string()) {
                continue;
            }

            if params.delete_files {
                match db::transfers_get(conn, id) {
                    Ok(Some(r)) => {
                        let dir = std::path::PathBuf::from(r.vault_dir);
                        if dir.exists() {
                            match vault::validate_dir_within_vault(&app, &dir)
                                .and_then(|d| vault::safe_remove_dir(&d))
                            {
                                Ok(()) => {}
                                Err(e) => {
                                    errors.push(HistoryDeleteManyItemError {
                                        id: id.to_string(),
                                        message: e,
                                    });
                                    continue;
                                }
                            }
                        }
                    }
                    Ok(None) => {
                        errors.push(HistoryDeleteManyItemError {
                            id: id.to_string(),
                            message: "未找到历史记录".to_string(),
                        });
                        continue;
                    }
                    Err(e) => {
                        errors.push(HistoryDeleteManyItemError {
                            id: id.to_string(),
                            message: e,
                        });
                        continue;
                    }
                }
            }

            match db::transfers_delete(conn, id) {
                Ok(()) => deleted += 1,
                Err(e) => errors.push(HistoryDeleteManyItemError {
                    id: id.to_string(),
                    message: e,
                }),
            }
        }

        Ok(HistoryDeleteManyResult {
            requested: seen.len(),
            deleted,
            failed: errors.len(),
            errors,
        })
    })
}

#[derive(Debug, Clone, Deserialize)]
struct HistoryUpdateParams {
    id: String,
    name: String,
    note: Option<String>,
    tags: Option<String>,
    favorite: bool,
}

#[tauri::command]
fn history_update(
    app: tauri::AppHandle,
    params: HistoryUpdateParams,
) -> AppResult<transfers::TransferRecord> {
    db::with_conn(&app, |conn| {
        if params.name.trim().is_empty() {
            return Err(AppError::validation("名称为必填项"));
        }
        let now = bundle::now_rfc3339_utc()?;
        Ok(db::transfers_update_meta(
            conn,
            &params.id,
            &params.name,
            params.note.as_deref(),
            params.tags.as_deref(),
            params.favorite,
            &now,
        )?)
    })
}

#[tauri::command]
async fn vault_usage(
    app: tauri::AppHandle,
    limit: Option<usize>,
) -> AppResult<vault_usage::VaultUsage> {
    let limit = limit.unwrap_or(200);
    tauri::async_runtime::spawn_blocking(move || vault_usage::vault_usage_command(&app, limit))
        .await
        .map_err(|e| AppError::internal(format!("vault usage task join error: {e}")))?
        .map_err(AppError::from)
}

#[tauri::command]
async fn preview_rollout(
    app: tauri::AppHandle,
    params: preview::PreviewRolloutParams,
) -> AppResult<preview::RolloutPreview> {
    tauri::async_runtime::spawn_blocking(move || preview::preview_rollout_command(&app, params))
        .await
        .map_err(|e| AppError::internal(format!("preview task join error: {e}")))?
        .map_err(AppError::from)
}

#[tauri::command]
async fn preview_bundle(
    app: tauri::AppHandle,
    params: preview::PreviewBundleParams,
) -> AppResult<preview::RolloutPreview> {
    tauri::async_runtime::spawn_blocking(move || preview::preview_bundle_command(&app, params))
        .await
        .map_err(|e| AppError::internal(format!("preview task join error: {e}")))?
        .map_err(AppError::from)
}

#[tauri::command]
async fn extract_session_ids_from_file(
    _app: tauri::AppHandle,
    params: id_extract::ExtractSessionIdsFromFileParams,
) -> AppResult<id_extract::ExtractSessionIdsResult> {
    tauri::async_runtime::spawn_blocking(move || id_extract::extract_session_ids_from_file(params))
        .await
        .map_err(|e| AppError::internal(format!("extract ids task join error: {e}")))?
        .map_err(AppError::from)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            app_status,
            codex_list_sessions,
            export_bundle,
            export_sessions,
            inspect_bundle,
            import_bundle,
            import_bundles,
            change_session_id,
            restore_from_history,
            settings_set_codex_home_override,
            history_list,
            history_latest_for_sessions,
            history_delete,
            history_delete_many,
            history_update,
            vault_usage,
            preview_rollout,
            preview_bundle,
            extract_session_ids_from_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
