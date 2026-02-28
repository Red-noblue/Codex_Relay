use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{BufRead, Read, Write},
    path::{Path, PathBuf},
};

use crate::{
    app_paths,
    bundle::{
        self, BundleManifest, ManifestCodexInfo, ManifestDeviceInfo, ManifestFileInfo,
        BUNDLE_SCHEMA_VERSION,
    },
    codex, db, device,
    errors::{AppError, AppResult},
    hash, settings,
    transfers::TransferRecord,
    vault,
};

#[derive(Debug, Clone, Deserialize)]
pub struct ExportParams {
    pub session_id: String,
    pub name: String,
    pub note: Option<String>,
    pub include_shell_snapshot: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExportResult {
    pub transfer_id: String,
    pub bundle_path: String,
    pub vault_dir: String,
    pub manifest: BundleManifest,
    pub resume_cmd: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExportBundleMode {
    Merged,
    PerSession,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ExportSessionsParams {
    pub session_ids: Vec<String>,
    pub name: String,
    pub note: Option<String>,
    pub include_shell_snapshot: bool,
    pub mode: ExportBundleMode,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExportSessionItem {
    pub session_id: String,
    pub transfer_id: String,
    pub vault_dir: String,
    pub vault_bundle_path: String,
    pub exported_bundle_path: Option<String>,
    pub manifest: BundleManifest,
    pub resume_cmd: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExportSessionError {
    pub session_id: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExportSessionsResult {
    pub mode: ExportBundleMode,
    pub export_dir: String,
    pub merged_bundle_path: Option<String>,
    pub items: Vec<ExportSessionItem>,
    pub errors: Vec<ExportSessionError>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LocalSessionInfo {
    pub session_id: String,
    pub rollout_path: String,
    pub sha256: String,
    pub size: i64,
    pub mtime_ms: Option<i64>,
    pub last_event_timestamp: Option<String>,
    pub cwd: Option<String>,
    pub cli_version: Option<String>,
    pub model_provider: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct InspectBundleResult {
    pub bundle_path: String,
    pub manifest: BundleManifest,
    pub sha256_ok: bool,
    pub rollout_last_event_timestamp: Option<String>,
    pub local_existing: Option<LocalSessionInfo>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConflictStrategy {
    Recommended,
    Overwrite,
    ImportAsNew,
    Cancel,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ImportParams {
    pub bundle_path: String,
    pub name: String,
    pub note: Option<String>,
    pub strategy: ConflictStrategy,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RestoreFromHistoryParams {
    pub record_id: String,
    pub name: String,
    pub note: Option<String>,
    pub strategy: ConflictStrategy,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportResult {
    pub transfer_id: String,
    pub vault_dir: String,
    pub effective_session_id: String,
    pub local_rollout_path: Option<String>,
    pub resume_cmd: Option<String>,
    pub status: String, // ok | canceled
}

#[derive(Debug, Clone, Deserialize)]
pub struct ImportBundlesParams {
    pub bundle_paths: Vec<String>,
    pub name: String,
    pub note: Option<String>,
    pub strategy: ConflictStrategy,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportBundlesItem {
    pub source: String,
    pub result: ImportResult,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportBundlesError {
    pub source: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportBundlesResult {
    pub requested_paths: usize,
    pub imported: usize,
    pub failed: usize,
    pub items: Vec<ImportBundlesItem>,
    pub errors: Vec<ImportBundlesError>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ChangeIdParams {
    pub session_id: String,
    pub name: String,
    pub note: Option<String>,
    pub new_session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChangeIdResult {
    pub transfer_id: String,
    pub vault_dir: String,
    pub bundle_path: String,
    pub old_session_id: String,
    pub new_session_id: String,
    pub local_rollout_path: String,
    pub resume_cmd: String,
}

pub fn export_session<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    params: ExportParams,
) -> AppResult<ExportResult> {
    if params.name.trim().is_empty() {
        return Err(AppError::validation("名称为必填项")
            .with_hint("请填写一个便于识别的名称，例如：mac -> win 传递"));
    }
    if params.session_id.trim().is_empty() {
        return Err(
            AppError::validation("会话ID为必填项").with_hint("请粘贴或输入一个 UUID 会话ID。")
        );
    }

    db::with_conn(app, |conn| -> AppResult<ExportResult> {
        let (codex_home, _resolved) = settings::resolve_codex_home(conn)?;
        let device_info = device::current_device_info(conn)?;

        let transfer_id = uuid::Uuid::now_v7().to_string();
        let created_at = bundle::now_rfc3339_utc()?;
        let transfer_dir = vault::ensure_transfer_dir(app, &transfer_id)?;

        let rollout_src = codex::find_rollout_by_session_id(&codex_home, &params.session_id)?
            .ok_or_else(|| {
                AppError::not_found(format!("未找到会话：{}", params.session_id)).with_hint(
                    "请在“会话列表”确认该 session_id 是否存在，或在终端运行 `codex resume <id>` 验证。",
                )
            })?;

        let meta = codex::read_rollout_meta(&codex_home, &rollout_src)?;
        if meta.id != params.session_id {
            return Err(AppError::integrity(format!(
                "会话文件 session_meta.id 不匹配：期望 {}，实际 {}",
                params.session_id, meta.id
            )));
        }

        let shell_src = codex_home
            .join("shell_snapshots")
            .join(format!("{}.sh", params.session_id));
        let include_shell_snapshot = params.include_shell_snapshot && shell_src.exists();

        let rollout_vault_path = transfer_dir.join("rollout.jsonl");
        let (sha256, file_size) = vault::copy_file_with_sha256(&rollout_src, &rollout_vault_path)?;

        let (shell_vault_path, shell_snapshot_info) = if include_shell_snapshot {
            let p = transfer_dir.join("shell_snapshot.sh");
            let (sh, sz) = vault::copy_file_with_sha256(&shell_src, &p)?;
            (
                Some(p),
                Some(ManifestFileInfo {
                    sha256: sh,
                    size: sz,
                }),
            )
        } else {
            (None, None)
        };

        let manifest = BundleManifest {
            schema_version: BUNDLE_SCHEMA_VERSION,
            name: params.name.clone(),
            note: params.note.clone(),
            session_id: params.session_id.clone(),
            created_at: created_at.clone(),
            source_device: ManifestDeviceInfo {
                device_id: device_info.device_id.clone(),
                os: device_info.os.clone(),
                arch: device_info.arch.clone(),
                hostname: device_info.hostname.clone(),
            },
            codex: ManifestCodexInfo {
                cli_version: meta.cli_version.clone(),
                model_provider: meta.model_provider.clone(),
                cwd: meta.cwd.clone(),
                rollout_rel_path: meta.rollout_rel_path.clone(),
                rollout_file_name: meta.rollout_file_name.clone(),
            },
            rollout: ManifestFileInfo {
                sha256: sha256.clone(),
                size: file_size,
            },
            shell_snapshot: shell_snapshot_info,
        };

        let manifest_path = transfer_dir.join("manifest.json");
        bundle::write_manifest_json(&manifest_path, &manifest)?;

        let bundle_zip_path = transfer_dir.join(build_bundle_filename(
            "export",
            &params.session_id,
            &params.name,
        ));
        bundle::write_bundle_zip(
            &bundle_zip_path,
            &manifest_path,
            &rollout_vault_path,
            shell_vault_path.as_deref(),
        )?;

        let record = TransferRecord {
            id: transfer_id.clone(),
            created_at,
            op: "export".to_string(),
            name: params.name.clone(),
            note: params.note.clone(),
            tags: None,
            favorite: false,
            updated_at: None,
            session_id_old: Some(params.session_id.clone()),
            session_id_new: None,
            effective_session_id: Some(params.session_id.clone()),
            status: "ok".to_string(),
            error_message: None,
            vault_dir: transfer_dir.to_string_lossy().to_string(),
            bundle_path: bundle_zip_path.to_string_lossy().to_string(),
            vault_rollout_rel_path: Some("rollout.jsonl".to_string()),
            rollout_sha256: Some(sha256),
            rollout_size: Some(file_size),
            local_rollout_path: Some(rollout_src.to_string_lossy().to_string()),
        };
        db::transfers_insert(conn, &record)?;

        Ok(ExportResult {
            transfer_id,
            bundle_path: bundle_zip_path.to_string_lossy().to_string(),
            vault_dir: transfer_dir.to_string_lossy().to_string(),
            manifest,
            resume_cmd: format!("codex resume {}", params.session_id),
        })
    })
}

pub fn export_sessions<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    params: ExportSessionsParams,
) -> AppResult<ExportSessionsResult> {
    if params.name.trim().is_empty() {
        return Err(AppError::validation("名称为必填项")
            .with_hint("请填写一个便于识别的名称，例如：mac -> win 传递"));
    }
    if params.session_ids.is_empty() {
        return Err(AppError::validation("请至少提供 1 个会话ID")
            .with_hint("请在“会话列表”勾选或粘贴 UUID 会话ID。"));
    }

    // Dedupe while preserving order.
    let mut seen = std::collections::HashSet::<String>::new();
    let mut ids: Vec<String> = Vec::new();
    for raw in &params.session_ids {
        let sid = raw.trim();
        if sid.is_empty() {
            continue;
        }
        if seen.insert(sid.to_string()) {
            ids.push(sid.to_string());
        }
    }
    if ids.is_empty() {
        return Err(AppError::validation("会话ID为空")
            .with_hint("请粘贴或输入至少一个 UUID 会话ID。"));
    }

    let export_dir = app_paths::download_dir().map_err(AppError::from)?;
    fs::create_dir_all(&export_dir)
        .map_err(|e| AppError::io(format!("create export dir: {e}")))?;

    let mut items: Vec<ExportSessionItem> = Vec::new();
    let mut errors: Vec<ExportSessionError> = Vec::new();

    for sid in &ids {
        let name = if ids.len() == 1 {
            params.name.clone()
        } else {
            format!("{} [{}]", params.name, &sid.chars().take(8).collect::<String>())
        };
        match export_session(
            app,
            ExportParams {
                session_id: sid.clone(),
                name,
                note: params.note.clone(),
                include_shell_snapshot: params.include_shell_snapshot,
            },
        ) {
            Ok(r) => items.push(ExportSessionItem {
                session_id: sid.clone(),
                transfer_id: r.transfer_id,
                vault_dir: r.vault_dir,
                vault_bundle_path: r.bundle_path,
                exported_bundle_path: None,
                manifest: r.manifest,
                resume_cmd: r.resume_cmd,
            }),
            Err(e) => errors.push(ExportSessionError {
                session_id: sid.clone(),
                message: format!("{}{}", e.message, e.hint.map(|h| format!("（{}）", h)).unwrap_or_default()),
            }),
        }
    }

    // If everything failed, surface a single error for UX.
    if items.is_empty() {
        let msg = if errors.len() == 1 {
            errors[0].message.clone()
        } else {
            format!("全部导出失败：{}/{}", errors.len(), ids.len())
        };
        return Err(AppError::new("EXPORT_FAILED", msg));
    }

    // Export bundle(s) to user's download dir for convenient sharing.
    let mut merged_bundle_path: Option<String> = None;

    match params.mode {
        ExportBundleMode::PerSession => {
            for item in &mut items {
                let src = PathBuf::from(&item.vault_bundle_path);
                let file_name = src
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("bundle.zip");
                let dst = copy_to_dir_unique(&src, &export_dir, file_name)?;
                item.exported_bundle_path = Some(dst.to_string_lossy().to_string());
            }
        }
        ExportBundleMode::Merged => {
            if items.len() == 1 {
                let src = PathBuf::from(&items[0].vault_bundle_path);
                let file_name = src
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("bundle.zip");
                let dst = copy_to_dir_unique(&src, &export_dir, file_name)?;
                let dst_s = dst.to_string_lossy().to_string();
                items[0].exported_bundle_path = Some(dst_s.clone());
                merged_bundle_path = Some(dst_s);
            } else {
                let file_name = build_batch_bundle_filename("export", &params.name);
                let out = unique_path_in_dir(&export_dir, &file_name);

                // Inner bundle zip files from vault.
                let mut inner: Vec<(String, PathBuf)> = Vec::new();
                for item in &items {
                    let entry = format!("bundles/{}.zip", item.session_id);
                    inner.push((entry, PathBuf::from(&item.vault_bundle_path)));
                }

                #[derive(Serialize)]
                struct BatchManifestItem {
                    session_id: String,
                    inner_zip: String,
                    resume_cmd: String,
                }

                #[derive(Serialize)]
                struct BatchManifest {
                    schema_version: u32,
                    kind: String,
                    name: String,
                    note: Option<String>,
                    created_at: String,
                    items: Vec<BatchManifestItem>,
                }

                let created_at = bundle::now_rfc3339_utc()?;
                let batch_manifest = BatchManifest {
                    schema_version: 1,
                    kind: "codexrelay_batch_export".to_string(),
                    name: params.name.clone(),
                    note: params.note.clone(),
                    created_at,
                    items: items
                        .iter()
                        .map(|it| BatchManifestItem {
                            session_id: it.session_id.clone(),
                            inner_zip: format!("bundles/{}.zip", it.session_id),
                            resume_cmd: it.resume_cmd.clone(),
                        })
                        .collect(),
                };
                let json = serde_json::to_string_pretty(&batch_manifest)
                    .map_err(|e| AppError::internal(format!("serialize batch manifest: {e}")))?;

                bundle::write_batch_zip_of_zips(&out, &inner, Some(&json))?;
                merged_bundle_path = Some(out.to_string_lossy().to_string());
            }
        }
    }

    Ok(ExportSessionsResult {
        mode: params.mode,
        export_dir: export_dir.to_string_lossy().to_string(),
        merged_bundle_path,
        items,
        errors,
    })
}

pub fn inspect_bundle<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    bundle_path: &str,
) -> AppResult<InspectBundleResult> {
    let bundle_path = PathBuf::from(bundle_path);
    if !bundle_path.exists() {
        return Err(AppError::not_found("bundle.zip 文件不存在")
            .with_hint("请重新选择 bundle.zip 文件路径。"));
    }

    db::with_conn(app, |conn| -> AppResult<InspectBundleResult> {
        let (codex_home, _resolved) = settings::resolve_codex_home(conn)?;

        // Extract into a temp folder under app data to avoid touching CODEX_HOME.
        let transfer_id = uuid::Uuid::now_v7().to_string();
        let tmp_dir = crate::app_paths::app_data_dir(app)?
            .join("tmp_inspect")
            .join(&transfer_id);
        if tmp_dir.exists() {
            vault::safe_remove_dir(&tmp_dir)?;
        }
        fs::create_dir_all(&tmp_dir).map_err(|e| AppError::io(format!("create tmp dir: {e}")))?;
        let extracted = bundle::extract_bundle_zip(&bundle_path, &tmp_dir)?;
        let manifest = bundle::read_manifest_json(&extracted.manifest.path)?;

        let computed_sha = extracted.rollout.sha256.clone();
        let computed_size = extracted.rollout.size;
        let sha256_ok =
            computed_sha == manifest.rollout.sha256 && computed_size == manifest.rollout.size;
        let rollout_last_event_timestamp =
            codex::read_last_event_timestamp(&extracted.rollout.path).unwrap_or(None);

        let local_existing = if let Some(local_path) =
            codex::find_rollout_by_session_id(&codex_home, &manifest.session_id)?
        {
            let size = i64::try_from(
                fs::metadata(&local_path)
                    .map_err(|e| format!("stat local rollout: {e}"))?
                    .len(),
            )
            .map_err(|_| "本机 rollout 文件过大".to_string())?;
            // Hashing a huge local rollout can be expensive. We only compute sha256 when the size
            // matches the imported version; otherwise it's already a conflict signal.
            let sha = if size == manifest.rollout.size {
                hash::sha256_file_hex(&local_path)?
            } else {
                String::new()
            };
            let mtime_ms = fs::metadata(&local_path)
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .and_then(|d| i64::try_from(d.as_millis()).ok());
            let last_event_timestamp =
                codex::read_last_event_timestamp(&local_path).unwrap_or(None);
            let meta = codex::read_rollout_meta(&codex_home, &local_path).ok();
            Some(LocalSessionInfo {
                session_id: manifest.session_id.clone(),
                rollout_path: local_path.to_string_lossy().to_string(),
                sha256: sha,
                size,
                mtime_ms,
                last_event_timestamp,
                cwd: meta.as_ref().and_then(|m| m.cwd.clone()),
                cli_version: meta.as_ref().and_then(|m| m.cli_version.clone()),
                model_provider: meta.as_ref().and_then(|m| m.model_provider.clone()),
            })
        } else {
            None
        };

        // Best-effort cleanup.
        let _ = vault::safe_remove_dir(&tmp_dir);

        Ok(InspectBundleResult {
            bundle_path: bundle_path.to_string_lossy().to_string(),
            manifest,
            sha256_ok,
            rollout_last_event_timestamp,
            local_existing,
        })
    })
}

pub fn import_bundle<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    params: ImportParams,
) -> AppResult<ImportResult> {
    if params.name.trim().is_empty() {
        return Err(AppError::validation("名称为必填项").with_hint("请填写本次导入/传递的名称。"));
    }
    if params.bundle_path.trim().is_empty() {
        return Err(AppError::validation("请选择 bundle.zip")
            .with_hint("请点击“选择 bundle.zip”或拖拽导入。"));
    }

    let bundle_src = PathBuf::from(&params.bundle_path);
    if !bundle_src.exists() {
        return Err(AppError::not_found("bundle.zip 文件不存在")
            .with_hint("请确认文件未被移动/删除，并重新选择。"));
    }

    db::with_conn(app, |conn| -> AppResult<ImportResult> {
        let (codex_home, _resolved) = settings::resolve_codex_home(conn)?;
        let device_info = device::current_device_info(conn)?;

        let transfer_id = uuid::Uuid::now_v7().to_string();
        let created_at = bundle::now_rfc3339_utc()?;
        let transfer_dir = vault::ensure_transfer_dir(app, &transfer_id)?;

        // Store bundle (B).
        let bundle_vault_path = transfer_dir.join("bundle.zip");
        vault::copy_file(&bundle_src, &bundle_vault_path)?;

        // Extract bundle (A).
        let extracted = bundle::extract_bundle_zip(&bundle_vault_path, &transfer_dir)?;
        let manifest = bundle::read_manifest_json(&extracted.manifest.path)?;

        if manifest.schema_version != BUNDLE_SCHEMA_VERSION {
            return Err(AppError::new(
                "BUNDLE_SCHEMA_UNSUPPORTED",
                format!(
                    "不支持的 manifest.schema_version：{}",
                    manifest.schema_version
                ),
            )
            .with_hint("请更新 CodexRelay 到较新版本后再导入。"));
        }

        // Validate rollout sha/size.
        let mut computed_sha = extracted.rollout.sha256.clone();
        let mut computed_size = extracted.rollout.size;
        if computed_sha != manifest.rollout.sha256 || computed_size != manifest.rollout.size {
            return Err(AppError::integrity(
                "导入包的 rollout sha256/size 校验失败（文件可能已损坏）",
            ));
        }

        // Validate session id matches rollout.
        let rollout_session_id = codex::read_rollout_session_id(&extracted.rollout.path)?;
        if rollout_session_id != manifest.session_id {
            return Err(AppError::new(
                "BUNDLE_SESSION_ID_MISMATCH",
                "manifest.session_id 与 rollout 中的 session_id 不一致",
            )
            .with_hint("导入包可能被手动修改或损坏；建议重新导出 bundle.zip。"));
        }

        // Check local conflict.
        let local_existing_path =
            codex::find_rollout_by_session_id(&codex_home, &manifest.session_id)?;
        let mut local_existing_sha: Option<String> = None;
        let mut has_conflict = false;
        if let Some(p) = &local_existing_path {
            // Fast path: size mismatch is already a conflict; avoid hashing huge files when not needed.
            let local_size = i64::try_from(
                fs::metadata(p)
                    .map_err(|e| format!("stat local rollout: {e}"))?
                    .len(),
            )
            .map_err(|_| "本机 rollout 文件过大".to_string())?;
            if local_size != manifest.rollout.size {
                has_conflict = true;
            } else {
                local_existing_sha = Some(hash::sha256_file_hex(p)?);
                has_conflict = local_existing_sha.as_deref() != Some(&manifest.rollout.sha256);
            }
        }

        let mut effective_session_id = manifest.session_id.clone();
        let local_written_path: Option<PathBuf>;
        let mut vault_rollout_rel = "rollout.jsonl".to_string();

        let strategy = match params.strategy {
            ConflictStrategy::Recommended => {
                if has_conflict {
                    ConflictStrategy::ImportAsNew
                } else {
                    ConflictStrategy::Overwrite
                }
            }
            s => s,
        };

        match strategy {
            ConflictStrategy::Cancel => {
                let record = TransferRecord {
                    id: transfer_id.clone(),
                    created_at,
                    op: "import".to_string(),
                    name: params.name.clone(),
                    note: params.note.clone(),
                    tags: None,
                    favorite: false,
                    updated_at: None,
                    session_id_old: Some(manifest.session_id.clone()),
                    session_id_new: None,
                    effective_session_id: Some(manifest.session_id.clone()),
                    status: "canceled".to_string(),
                    error_message: None,
                    vault_dir: transfer_dir.to_string_lossy().to_string(),
                    bundle_path: bundle_vault_path.to_string_lossy().to_string(),
                    vault_rollout_rel_path: Some(vault_rollout_rel),
                    rollout_sha256: Some(manifest.rollout.sha256.clone()),
                    rollout_size: Some(manifest.rollout.size),
                    local_rollout_path: None,
                };
                db::transfers_insert(conn, &record)?;

                return Ok(ImportResult {
                    transfer_id,
                    vault_dir: transfer_dir.to_string_lossy().to_string(),
                    effective_session_id,
                    local_rollout_path: None,
                    resume_cmd: None,
                    status: "canceled".to_string(),
                });
            }
            ConflictStrategy::Overwrite => {
                // If conflict, backup local existing into vault for safety.
                if let Some(local_path) = &local_existing_path {
                    if local_existing_sha.as_deref() != Some(&manifest.rollout.sha256) {
                        let local_backup = transfer_dir.join("local_before_rollout.jsonl");
                        vault::copy_file(local_path, &local_backup)?;
                    }
                }

                // If local exists, overwrite in place; otherwise restore using rel path or a generated one.
                let target = if let Some(local_path) = &local_existing_path {
                    local_path.clone()
                } else if let Some(rel) = manifest.codex.rollout_rel_path.as_deref() {
                    if rel.starts_with("sessions/") {
                        codex::safe_join_codex_home(&codex_home, rel)?
                    } else {
                        generate_new_rollout_path(&codex_home, &effective_session_id)?
                    }
                } else {
                    generate_new_rollout_path(&codex_home, &effective_session_id)?
                };

                if local_existing_path.is_some()
                    && local_existing_sha.as_deref() == Some(&manifest.rollout.sha256)
                {
                    // Same content already exists locally; still record the import, but do not rewrite the file.
                } else {
                    if let Some(parent) = target.parent() {
                        fs::create_dir_all(parent)
                            .map_err(|e| format!("create sessions dir: {e}"))?;
                    }
                    vault::copy_file(&extracted.rollout.path, &target)?;
                }
                local_written_path = Some(target);
            }
            ConflictStrategy::ImportAsNew => {
                let new_id = uuid::Uuid::now_v7().to_string();
                let rewritten = transfer_dir.join("rollout_effective.jsonl");
                rewrite_session_id(
                    &extracted.rollout.path,
                    &manifest.session_id,
                    &new_id,
                    &rewritten,
                )?;
                vault_rollout_rel = "rollout_effective.jsonl".to_string();

                effective_session_id = new_id;
                computed_sha = hash::sha256_file_hex(&rewritten)?;
                computed_size = i64::try_from(
                    fs::metadata(&rewritten)
                        .map_err(|e| format!("stat rewritten rollout: {e}"))?
                        .len(),
                )
                .map_err(|_| "改ID后的 rollout 文件过大".to_string())?;
                let target = generate_new_rollout_path(&codex_home, &effective_session_id)?;
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent).map_err(|e| format!("create sessions dir: {e}"))?;
                }
                vault::copy_file(&rewritten, &target)?;
                local_written_path = Some(target);

                // Also store an updated manifest for easier browsing.
                let mut derived_manifest = manifest.clone();
                derived_manifest.session_id = effective_session_id.clone();
                derived_manifest.name = params.name.clone();
                derived_manifest.note = params.note.clone();
                derived_manifest.created_at = created_at.clone();
                derived_manifest.source_device = ManifestDeviceInfo {
                    device_id: device_info.device_id.clone(),
                    os: device_info.os.clone(),
                    arch: device_info.arch.clone(),
                    hostname: device_info.hostname.clone(),
                };
                derived_manifest.codex.rollout_rel_path =
                    codex::codex_rel_path(&codex_home, local_written_path.as_ref().unwrap());
                derived_manifest.codex.rollout_file_name = local_written_path
                    .as_ref()
                    .and_then(|p| p.file_name())
                    .and_then(|s| s.to_str())
                    .map(|s| s.to_string());
                derived_manifest.rollout.sha256 = computed_sha.clone();
                derived_manifest.rollout.size = computed_size;

                let derived_manifest_path = transfer_dir.join("manifest_effective.json");
                bundle::write_manifest_json(&derived_manifest_path, &derived_manifest)?;
            }
            ConflictStrategy::Recommended => unreachable!(),
        }

        let record = TransferRecord {
            id: transfer_id.clone(),
            created_at,
            op: "import".to_string(),
            name: params.name.clone(),
            note: params.note.clone(),
            tags: None,
            favorite: false,
            updated_at: None,
            session_id_old: Some(manifest.session_id.clone()),
            session_id_new: if effective_session_id != manifest.session_id {
                Some(effective_session_id.clone())
            } else {
                None
            },
            effective_session_id: Some(effective_session_id.clone()),
            status: "ok".to_string(),
            error_message: None,
            vault_dir: transfer_dir.to_string_lossy().to_string(),
            bundle_path: bundle_vault_path.to_string_lossy().to_string(),
            vault_rollout_rel_path: Some(vault_rollout_rel),
            rollout_sha256: Some(computed_sha),
            rollout_size: Some(computed_size),
            local_rollout_path: local_written_path
                .as_ref()
                .map(|p| p.to_string_lossy().to_string()),
        };
        db::transfers_insert(conn, &record)?;

        Ok(ImportResult {
            transfer_id,
            vault_dir: transfer_dir.to_string_lossy().to_string(),
            effective_session_id: effective_session_id.clone(),
            local_rollout_path: local_written_path
                .as_ref()
                .map(|p| p.to_string_lossy().to_string()),
            resume_cmd: Some(format!("codex resume {}", effective_session_id)),
            status: "ok".to_string(),
        })
    })
}

pub fn import_bundles<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    params: ImportBundlesParams,
) -> AppResult<ImportBundlesResult> {
    if params.name.trim().is_empty() {
        return Err(AppError::validation("名称为必填项").with_hint("请填写本次导入/传递的名称。"));
    }
    if params.bundle_paths.is_empty() {
        return Err(AppError::validation("请选择至少一个 zip 包")
            .with_hint("你可以多选 zip 文件，或选择“合并后的一个压缩包”。"));
    }

    // Dedupe while preserving order.
    let mut seen = std::collections::HashSet::<String>::new();
    let mut paths: Vec<String> = Vec::new();
    for p in &params.bundle_paths {
        let p = p.trim();
        if p.is_empty() {
            continue;
        }
        if seen.insert(p.to_string()) {
            paths.push(p.to_string());
        }
    }
    if paths.is_empty() {
        return Err(AppError::validation("bundle 路径为空").with_hint("请重新选择 zip 文件。"));
    }

    let mut out_items: Vec<ImportBundlesItem> = Vec::new();
    let mut out_errors: Vec<ImportBundlesError> = Vec::new();

    for p in &paths {
        let src = PathBuf::from(p);
        if !src.exists() {
            out_errors.push(ImportBundlesError {
                source: p.clone(),
                message: "文件不存在".to_string(),
            });
            continue;
        }

        match classify_zip_bundle(&src) {
            Ok(ZipBundleKind::SingleBundle) => {
                // Best-effort: include short id in name when importing multiple sessions.
                let sid = read_manifest_session_id(&src).unwrap_or_else(|_| "".to_string());
                let derived_name = if paths.len() > 1 && !sid.is_empty() {
                    format!("{} [{}]", params.name, &sid.chars().take(8).collect::<String>())
                } else {
                    params.name.clone()
                };
                match import_bundle(
                    app,
                    ImportParams {
                        bundle_path: p.clone(),
                        name: derived_name,
                        note: params.note.clone(),
                        strategy: params.strategy.clone(),
                    },
                ) {
                    Ok(r) => out_items.push(ImportBundlesItem {
                        source: p.clone(),
                        result: r,
                    }),
                    Err(e) => out_errors.push(ImportBundlesError {
                        source: p.clone(),
                        message: format!(
                            "{}{}",
                            e.message,
                            e.hint.map(|h| format!("（{}）", h)).unwrap_or_default()
                        ),
                    }),
                }
            }
            Ok(ZipBundleKind::BatchZip { entries }) => {
                if entries.is_empty() {
                    out_errors.push(ImportBundlesError {
                        source: p.clone(),
                        message: "合并包中未找到可导入的 .zip 条目".to_string(),
                    });
                    continue;
                }

                let tmp_root = crate::app_paths::app_data_dir(app)
                    .map_err(AppError::from)?
                    .join("tmp_batch_import")
                    .join(uuid::Uuid::now_v7().to_string());
                fs::create_dir_all(&tmp_root).map_err(|e| {
                    AppError::io(format!("create tmp_batch_import dir: {e}"))
                })?;

                for (idx, entry_name) in entries.iter().enumerate() {
                    let tmp_zip = tmp_root.join(format!("inner-{idx}.zip"));
                    if let Err(e) = extract_zip_entry_to_file(&src, entry_name, &tmp_zip) {
                        out_errors.push(ImportBundlesError {
                            source: format!("{p}::{entry_name}"),
                            message: e,
                        });
                        continue;
                    }

                    let sid = read_manifest_session_id(&tmp_zip).unwrap_or_else(|_| "".to_string());
                    let derived_name = if !sid.is_empty() {
                        format!("{} [{}]", params.name, &sid.chars().take(8).collect::<String>())
                    } else {
                        params.name.clone()
                    };

                    match import_bundle(
                        app,
                        ImportParams {
                            bundle_path: tmp_zip.to_string_lossy().to_string(),
                            name: derived_name,
                            note: params.note.clone(),
                            strategy: params.strategy.clone(),
                        },
                    ) {
                        Ok(r) => out_items.push(ImportBundlesItem {
                            source: format!("{p}::{entry_name}"),
                            result: r,
                        }),
                        Err(e) => out_errors.push(ImportBundlesError {
                            source: format!("{p}::{entry_name}"),
                            message: format!(
                                "{}{}",
                                e.message,
                                e.hint.map(|h| format!("（{}）", h)).unwrap_or_default()
                            ),
                        }),
                    }
                }

                // Best-effort cleanup.
                let _ = vault::safe_remove_dir(&tmp_root);
            }
            Ok(ZipBundleKind::Unknown) => {
                out_errors.push(ImportBundlesError {
                    source: p.clone(),
                    message: "不是有效的 CodexRelay 导出包：缺少 manifest.json/rollout.jsonl，且未找到 bundles/*.zip"
                        .to_string(),
                });
            }
            Err(e) => out_errors.push(ImportBundlesError {
                source: p.clone(),
                message: e.message,
            }),
        }
    }

    let imported = out_items.len();
    let failed = out_errors.len();
    Ok(ImportBundlesResult {
        requested_paths: paths.len(),
        imported,
        failed,
        items: out_items,
        errors: out_errors,
    })
}

pub fn restore_from_history<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    params: RestoreFromHistoryParams,
) -> AppResult<ImportResult> {
    if params.name.trim().is_empty() {
        return Err(AppError::validation("名称为必填项").with_hint("请填写本次恢复操作的名称。"));
    }
    if params.record_id.trim().is_empty() {
        return Err(
            AppError::validation("记录ID为必填项").with_hint("请先在“历史”中选择一条记录。")
        );
    }

    db::with_conn(app, |conn| -> AppResult<ImportResult> {
        let (codex_home, _resolved) = settings::resolve_codex_home(conn)?;
        let device_info = device::current_device_info(conn)?;

        let src_record = db::transfers_get(conn, &params.record_id)?.ok_or_else(|| {
            AppError::not_found("未找到历史记录").with_hint("请刷新历史列表后重试。")
        })?;
        let src_vault_dir = PathBuf::from(&src_record.vault_dir);
        let src_vault_dir = vault::validate_dir_within_vault(app, &src_vault_dir)?;
        let rel = src_record
            .vault_rollout_rel_path
            .clone()
            .unwrap_or_else(|| "rollout.jsonl".to_string());
        let src_rollout = src_vault_dir.join(&rel);
        if !src_rollout.exists() {
            return Err(AppError::not_found("存档库中的会话文件缺失").with_hint(
                "该记录对应的存档库目录可能已被手动删除；可在“设置 -> 存档库”中检查目录内容。",
            ));
        }

        let transfer_id = uuid::Uuid::now_v7().to_string();
        let created_at = bundle::now_rfc3339_utc()?;
        let transfer_dir = vault::ensure_transfer_dir(app, &transfer_id)?;

        // Store into vault (A).
        let rollout_vault_path = transfer_dir.join("rollout.jsonl");
        vault::copy_file(&src_rollout, &rollout_vault_path)?;

        let source_session_id = codex::read_rollout_session_id(&rollout_vault_path)?;

        let mut computed_size = i64::try_from(
            fs::metadata(&rollout_vault_path)
                .map_err(|e| format!("stat rollout: {e}"))?
                .len(),
        )
        .map_err(|_| "会话文件过大".to_string())?;
        let mut computed_sha = hash::sha256_file_hex(&rollout_vault_path)?;

        // Best-effort manifest so the vault is browseable/portable.
        let meta = codex::read_rollout_meta(&codex_home, &rollout_vault_path)?;
        let manifest = BundleManifest {
            schema_version: BUNDLE_SCHEMA_VERSION,
            name: params.name.clone(),
            note: params.note.clone(),
            session_id: source_session_id.clone(),
            created_at: created_at.clone(),
            source_device: ManifestDeviceInfo {
                device_id: device_info.device_id.clone(),
                os: device_info.os.clone(),
                arch: device_info.arch.clone(),
                hostname: device_info.hostname.clone(),
            },
            codex: ManifestCodexInfo {
                cli_version: meta.cli_version.clone(),
                model_provider: meta.model_provider.clone(),
                cwd: meta.cwd.clone(),
                rollout_rel_path: None,
                rollout_file_name: None,
            },
            rollout: ManifestFileInfo {
                sha256: computed_sha.clone(),
                size: computed_size,
            },
            shell_snapshot: None,
        };
        let manifest_path = transfer_dir.join("manifest.json");
        bundle::write_manifest_json(&manifest_path, &manifest)?;

        let bundle_zip_path = transfer_dir.join("bundle.zip");
        bundle::write_bundle_zip(&bundle_zip_path, &manifest_path, &rollout_vault_path, None)?;

        // Check local conflict. Hashing huge rollouts can be expensive, so we only compute
        // sha256 when the local file size matches the imported version.
        let local_existing_path =
            codex::find_rollout_by_session_id(&codex_home, &source_session_id)?;
        let mut local_existing_sha: Option<String> = None;
        let mut has_conflict = false;
        if let Some(p) = &local_existing_path {
            let local_size = i64::try_from(
                fs::metadata(p)
                    .map_err(|e| format!("stat local rollout: {e}"))?
                    .len(),
            )
            .map_err(|_| "本机 rollout 文件过大".to_string())?;
            if local_size != computed_size {
                has_conflict = true;
            } else {
                local_existing_sha = Some(hash::sha256_file_hex(p)?);
                has_conflict = local_existing_sha.as_deref() != Some(&computed_sha);
            }
        }

        let mut effective_session_id = source_session_id.clone();
        let local_written_path: Option<PathBuf>;
        let mut vault_rollout_rel = "rollout.jsonl".to_string();

        let strategy = match params.strategy {
            ConflictStrategy::Recommended => {
                if has_conflict {
                    ConflictStrategy::ImportAsNew
                } else {
                    ConflictStrategy::Overwrite
                }
            }
            s => s,
        };

        match strategy {
            ConflictStrategy::Cancel => {
                let record = TransferRecord {
                    id: transfer_id.clone(),
                    created_at,
                    op: "restore".to_string(),
                    name: params.name.clone(),
                    note: params.note.clone(),
                    tags: None,
                    favorite: false,
                    updated_at: None,
                    session_id_old: Some(source_session_id.clone()),
                    session_id_new: None,
                    effective_session_id: Some(source_session_id.clone()),
                    status: "canceled".to_string(),
                    error_message: None,
                    vault_dir: transfer_dir.to_string_lossy().to_string(),
                    bundle_path: bundle_zip_path.to_string_lossy().to_string(),
                    vault_rollout_rel_path: Some(vault_rollout_rel),
                    rollout_sha256: Some(computed_sha),
                    rollout_size: Some(computed_size),
                    local_rollout_path: None,
                };
                db::transfers_insert(conn, &record)?;

                return Ok(ImportResult {
                    transfer_id,
                    vault_dir: transfer_dir.to_string_lossy().to_string(),
                    effective_session_id,
                    local_rollout_path: None,
                    resume_cmd: None,
                    status: "canceled".to_string(),
                });
            }
            ConflictStrategy::Overwrite => {
                // If conflict, backup local existing into vault for safety.
                if let Some(local_path) = &local_existing_path {
                    if local_existing_sha.as_deref() != Some(&computed_sha) {
                        let local_backup = transfer_dir.join("local_before_rollout.jsonl");
                        vault::copy_file(local_path, &local_backup)?;
                    }
                }

                let target = if let Some(local_path) = &local_existing_path {
                    local_path.clone()
                } else {
                    generate_new_rollout_path(&codex_home, &effective_session_id)?
                };
                if local_existing_path.is_some()
                    && local_existing_sha.as_deref() == Some(&computed_sha)
                {
                    // Same content already exists locally; still record the restore, but do not rewrite the file.
                } else {
                    if let Some(parent) = target.parent() {
                        fs::create_dir_all(parent)
                            .map_err(|e| format!("create sessions dir: {e}"))?;
                    }
                    vault::copy_file(&rollout_vault_path, &target)?;
                }
                local_written_path = Some(target);
            }
            ConflictStrategy::ImportAsNew => {
                let new_id = uuid::Uuid::now_v7().to_string();
                let rewritten = transfer_dir.join("rollout_effective.jsonl");
                rewrite_session_id(&rollout_vault_path, &source_session_id, &new_id, &rewritten)?;
                vault_rollout_rel = "rollout_effective.jsonl".to_string();

                effective_session_id = new_id;

                computed_sha = hash::sha256_file_hex(&rewritten)?;
                computed_size = i64::try_from(
                    fs::metadata(&rewritten)
                        .map_err(|e| format!("stat rewritten rollout: {e}"))?
                        .len(),
                )
                .map_err(|_| "改ID后的 rollout 文件过大".to_string())?;

                let target = generate_new_rollout_path(&codex_home, &effective_session_id)?;
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent).map_err(|e| format!("create sessions dir: {e}"))?;
                }
                vault::copy_file(&rewritten, &target)?;
                local_written_path = Some(target);

                let mut derived_manifest = manifest.clone();
                derived_manifest.session_id = effective_session_id.clone();
                derived_manifest.rollout.sha256 = computed_sha.clone();
                derived_manifest.rollout.size = computed_size;
                let derived_manifest_path = transfer_dir.join("manifest_effective.json");
                bundle::write_manifest_json(&derived_manifest_path, &derived_manifest)?;
            }
            ConflictStrategy::Recommended => unreachable!(),
        }

        let record = TransferRecord {
            id: transfer_id.clone(),
            created_at,
            op: "restore".to_string(),
            name: params.name.clone(),
            note: params.note.clone(),
            tags: None,
            favorite: false,
            updated_at: None,
            session_id_old: Some(source_session_id.clone()),
            session_id_new: if effective_session_id != source_session_id {
                Some(effective_session_id.clone())
            } else {
                None
            },
            effective_session_id: Some(effective_session_id.clone()),
            status: "ok".to_string(),
            error_message: None,
            vault_dir: transfer_dir.to_string_lossy().to_string(),
            bundle_path: bundle_zip_path.to_string_lossy().to_string(),
            vault_rollout_rel_path: Some(vault_rollout_rel),
            rollout_sha256: Some(computed_sha),
            rollout_size: Some(computed_size),
            local_rollout_path: local_written_path
                .as_ref()
                .map(|p| p.to_string_lossy().to_string()),
        };
        db::transfers_insert(conn, &record)?;

        Ok(ImportResult {
            transfer_id,
            vault_dir: transfer_dir.to_string_lossy().to_string(),
            effective_session_id: effective_session_id.clone(),
            local_rollout_path: local_written_path
                .as_ref()
                .map(|p| p.to_string_lossy().to_string()),
            resume_cmd: Some(format!("codex resume {}", effective_session_id)),
            status: "ok".to_string(),
        })
    })
}

pub fn change_session_id<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    params: ChangeIdParams,
) -> AppResult<ChangeIdResult> {
    if params.name.trim().is_empty() {
        return Err(AppError::validation("名称为必填项").with_hint("请填写本次改ID操作的名称。"));
    }
    if params.session_id.trim().is_empty() {
        return Err(
            AppError::validation("会话ID为必填项").with_hint("请粘贴或输入一个 UUID 会话ID。")
        );
    }

    db::with_conn(app, |conn| -> AppResult<ChangeIdResult> {
        let (codex_home, _resolved) = settings::resolve_codex_home(conn)?;
        let device_info = device::current_device_info(conn)?;

        let transfer_id = uuid::Uuid::now_v7().to_string();
        let created_at = bundle::now_rfc3339_utc()?;
        let transfer_dir = vault::ensure_transfer_dir(app, &transfer_id)?;

        let rollout_src = codex::find_rollout_by_session_id(&codex_home, &params.session_id)?
            .ok_or_else(|| {
                AppError::not_found(format!("未找到会话：{}", params.session_id)).with_hint(
                    "请在“会话列表”确认该 session_id 是否存在，或在终端运行 `codex resume <id>` 验证。",
                )
            })?;

        let new_id = params
            .new_session_id
            .clone()
            .unwrap_or_else(|| uuid::Uuid::now_v7().to_string());
        if new_id.trim().is_empty() {
            return Err(AppError::validation("新会话ID不能为空")
                .with_hint("请留空让工具自动生成，或输入一个 UUID。"));
        }
        if new_id == params.session_id {
            return Err(AppError::validation("新会话ID不能与原会话ID相同")
                .with_hint("请留空自动生成 UUID v7，或输入一个不同的会话ID。"));
        }
        if codex::find_rollout_by_session_id(&codex_home, &new_id)?.is_some() {
            return Err(AppError::new("SESSION_ID_CONFLICT", "本机已存在该新会话ID")
                .with_hint("请换一个新会话ID，或留空让工具自动生成。"));
        }

        let original_vault = transfer_dir.join("rollout.jsonl");
        vault::copy_file(&rollout_src, &original_vault)?;

        let rewritten_vault = transfer_dir.join("rollout_effective.jsonl");
        rewrite_session_id(
            &original_vault,
            &params.session_id,
            &new_id,
            &rewritten_vault,
        )?;

        let target = generate_new_rollout_path(&codex_home, &new_id)?;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("create sessions dir: {e}"))?;
        }
        vault::copy_file(&rewritten_vault, &target)?;

        let sha = hash::sha256_file_hex(&rewritten_vault)?;
        let sz = i64::try_from(
            fs::metadata(&rewritten_vault)
                .map_err(|e| format!("stat rewritten rollout: {e}"))?
                .len(),
        )
        .map_err(|_| "改ID后的会话文件过大".to_string())?;

        // Also create a portable bundle zip for convenience (so user can transfer immediately).
        let meta_effective = codex::read_rollout_meta(&codex_home, &rewritten_vault)?;
        let manifest = BundleManifest {
            schema_version: BUNDLE_SCHEMA_VERSION,
            name: params.name.clone(),
            note: params.note.clone(),
            session_id: new_id.clone(),
            created_at: created_at.clone(),
            source_device: ManifestDeviceInfo {
                device_id: device_info.device_id.clone(),
                os: device_info.os.clone(),
                arch: device_info.arch.clone(),
                hostname: device_info.hostname.clone(),
            },
            codex: ManifestCodexInfo {
                cli_version: meta_effective.cli_version.clone(),
                model_provider: meta_effective.model_provider.clone(),
                cwd: meta_effective.cwd.clone(),
                rollout_rel_path: codex::codex_rel_path(&codex_home, &target),
                rollout_file_name: target
                    .file_name()
                    .and_then(|s| s.to_str())
                    .map(|s| s.to_string()),
            },
            rollout: ManifestFileInfo {
                sha256: sha.clone(),
                size: sz,
            },
            shell_snapshot: None,
        };
        let manifest_path = transfer_dir.join("manifest.json");
        bundle::write_manifest_json(&manifest_path, &manifest)?;

        let bundle_zip_path =
            transfer_dir.join(build_bundle_filename("change_id", &new_id, &params.name));
        bundle::write_bundle_zip(&bundle_zip_path, &manifest_path, &rewritten_vault, None)?;

        let record = TransferRecord {
            id: transfer_id.clone(),
            created_at,
            op: "change_id".to_string(),
            name: params.name.clone(),
            note: params.note.clone(),
            tags: None,
            favorite: false,
            updated_at: None,
            session_id_old: Some(params.session_id.clone()),
            session_id_new: Some(new_id.clone()),
            effective_session_id: Some(new_id.clone()),
            status: "ok".to_string(),
            error_message: None,
            vault_dir: transfer_dir.to_string_lossy().to_string(),
            bundle_path: bundle_zip_path.to_string_lossy().to_string(),
            vault_rollout_rel_path: Some("rollout_effective.jsonl".to_string()),
            rollout_sha256: Some(sha),
            rollout_size: Some(sz),
            local_rollout_path: Some(target.to_string_lossy().to_string()),
        };
        db::transfers_insert(conn, &record)?;

        Ok(ChangeIdResult {
            transfer_id,
            vault_dir: transfer_dir.to_string_lossy().to_string(),
            bundle_path: bundle_zip_path.to_string_lossy().to_string(),
            old_session_id: params.session_id.clone(),
            new_session_id: new_id.clone(),
            local_rollout_path: target.to_string_lossy().to_string(),
            resume_cmd: format!("codex resume {}", new_id),
        })
    })
}

fn generate_new_rollout_path(codex_home: &Path, session_id: &str) -> Result<PathBuf, String> {
    let now = time::OffsetDateTime::now_utc();
    let year = now.year();
    let month = u8::from(now.month());
    let day = now.day();
    let hour = now.hour();
    let minute = now.minute();
    let second = now.second();

    let dir = codex_home
        .join("sessions")
        .join(format!("{year:04}"))
        .join(format!("{month:02}"))
        .join(format!("{day:02}"));

    let ts = format!("{year:04}-{month:02}-{day:02}T{hour:02}-{minute:02}-{second:02}");
    let file = format!("rollout-{ts}-{session_id}.jsonl");
    Ok(dir.join(file))
}

fn build_bundle_filename(op: &str, session_id: &str, name: &str) -> String {
    let now = time::OffsetDateTime::now_utc();
    let year = now.year();
    let month = u8::from(now.month());
    let day = now.day();
    let hour = now.hour();
    let minute = now.minute();
    let second = now.second();
    let ts = format!("{year:04}{month:02}{day:02}-{hour:02}{minute:02}{second:02}Z");

    // Keep filenames short and cross-platform safe (esp. Windows).
    let safe_id = sanitize_filename_component(session_id, 64);
    let mut safe_name = sanitize_filename_component(name, 64);
    let mut file = format!("CodexRelay-{op}-{ts}-{safe_id}-{safe_name}.zip");

    // Hard cap to avoid absurdly long paths (best-effort).
    const MAX_CHARS: usize = 180;
    if file.chars().count() > MAX_CHARS {
        let extra = file.chars().count().saturating_sub(MAX_CHARS);
        let target_len = safe_name.chars().count().saturating_sub(extra + 3);
        safe_name = safe_name.chars().take(target_len.max(8)).collect();
        file = format!("CodexRelay-{op}-{ts}-{safe_id}-{safe_name}.zip");
    }
    file
}

fn build_batch_bundle_filename(op: &str, name: &str) -> String {
    let now = time::OffsetDateTime::now_utc();
    let year = now.year();
    let month = u8::from(now.month());
    let day = now.day();
    let hour = now.hour();
    let minute = now.minute();
    let second = now.second();
    let ts = format!("{year:04}{month:02}{day:02}-{hour:02}{minute:02}{second:02}Z");

    let safe_name = sanitize_filename_component(name, 80);
    let mut file = format!("CodexRelay-{op}-batch-{ts}-{safe_name}.zip");

    const MAX_CHARS: usize = 180;
    if file.chars().count() > MAX_CHARS {
        let extra = file.chars().count().saturating_sub(MAX_CHARS);
        let target_len = safe_name.chars().count().saturating_sub(extra + 3);
        let safe_name = safe_name.chars().take(target_len.max(8)).collect::<String>();
        file = format!("CodexRelay-{op}-batch-{ts}-{safe_name}.zip");
    }
    file
}

fn sanitize_filename_component(input: &str, max_chars: usize) -> String {
    let mut out = String::new();
    for (count, c) in input.trim().chars().enumerate() {
        if count >= max_chars {
            break;
        }
        let mapped = match c {
            // Windows reserved / path related characters.
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            // Normalize whitespace so sharing via IM apps is less error-prone.
            c if c.is_whitespace() => '_',
            c if c.is_control() => '_',
            c => c,
        };
        out.push(mapped);
    }

    // Windows doesn't allow trailing dots/spaces; also keep it tidy.
    let trimmed = out
        .trim_matches(|c: char| c == '_' || c == '.' || c == ' ')
        .to_string();
    if trimmed.is_empty() {
        "unnamed".to_string()
    } else {
        trimmed
    }
}

fn unique_path_in_dir(dir: &Path, file_name: &str) -> PathBuf {
    let mut candidate = dir.join(file_name);
    if !candidate.exists() {
        return candidate;
    }
    let p = Path::new(file_name);
    let stem = p
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("CodexRelay");
    let ext = p.extension().and_then(|s| s.to_str()).unwrap_or("");
    for i in 2..=9999 {
        let name = if ext.is_empty() {
            format!("{stem}-{i}")
        } else {
            format!("{stem}-{i}.{ext}")
        };
        candidate = dir.join(name);
        if !candidate.exists() {
            return candidate;
        }
    }
    // Should never happen, but still return something.
    dir.join(format!("{stem}-{}.zip", uuid::Uuid::now_v7()))
}

fn copy_to_dir_unique(src: &Path, dst_dir: &Path, file_name: &str) -> AppResult<PathBuf> {
    let dst = unique_path_in_dir(dst_dir, file_name);
    vault::copy_file(src, &dst)?;
    Ok(dst)
}

#[derive(Debug, Clone)]
enum ZipBundleKind {
    SingleBundle,
    BatchZip { entries: Vec<String> },
    Unknown,
}

fn classify_zip_bundle(zip_path: &Path) -> AppResult<ZipBundleKind> {
    let f =
        fs::File::open(zip_path).map_err(|e| AppError::io(format!("open zip: {e}")))?;
    let mut z =
        zip::ZipArchive::new(f).map_err(|e| AppError::io(format!("read zip: {e}")))?;

    let has_manifest = z.by_name("manifest.json").is_ok();
    let has_rollout = z.by_name("rollout.jsonl").is_ok();
    if has_manifest && has_rollout {
        return Ok(ZipBundleKind::SingleBundle);
    }

    let mut entries: Vec<String> = Vec::new();
    let mut any_zip_entries: Vec<String> = Vec::new();
    for i in 0..z.len() {
        let file = z
            .by_index(i)
            .map_err(|e| AppError::io(format!("read zip entry: {e}")))?;
        let name = file.name().to_string();
        if name.ends_with('/') {
            continue;
        }
        let lower = name.to_ascii_lowercase();
        if lower.ends_with(".zip") {
            any_zip_entries.push(name.clone());
        }
        if lower.starts_with("bundles/") && lower.ends_with(".zip") {
            entries.push(name);
        }
    }
    if !entries.is_empty() {
        return Ok(ZipBundleKind::BatchZip { entries });
    }

    // Fallback: user may have zipped multiple CodexRelay export zips manually at the root.
    if !any_zip_entries.is_empty() {
        return Ok(ZipBundleKind::BatchZip {
            entries: any_zip_entries,
        });
    }

    Ok(ZipBundleKind::Unknown)
}

fn extract_zip_entry_to_file(zip_path: &Path, entry_name: &str, out_path: &Path) -> Result<(), String> {
    const MAX_BYTES: u64 = 4 * 1024 * 1024 * 1024; // 4 GiB
    let f = fs::File::open(zip_path).map_err(|e| format!("open zip: {e}"))?;
    let mut z = zip::ZipArchive::new(f).map_err(|e| format!("read zip: {e}"))?;
    let mut entry = z
        .by_name(entry_name)
        .map_err(|e| format!("read zip entry {entry_name}: {e}"))?;
    let declared = entry.size();
    if declared > MAX_BYTES {
        return Err(format!(
            "合并包条目过大：{}（{} bytes，超过上限 {} bytes）",
            entry_name, declared, MAX_BYTES
        ));
    }
    if let Some(parent) = out_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create tmp dir: {e}"))?;
    }
    let mut out = fs::File::create(out_path).map_err(|e| format!("create tmp zip: {e}"))?;
    let mut buf = [0u8; 1024 * 64];
    let mut total: u64 = 0;
    loop {
        let n = entry.read(&mut buf).map_err(|e| format!("read entry: {e}"))?;
        if n == 0 {
            break;
        }
        total = total.saturating_add(n as u64);
        if total > MAX_BYTES {
            return Err("合并包条目内容超过上限（可能是损坏或恶意压缩包）".to_string());
        }
        out.write_all(&buf[..n])
            .map_err(|e| format!("write tmp zip: {e}"))?;
    }
    out.flush().map_err(|e| format!("flush tmp zip: {e}"))?;
    Ok(())
}

fn read_manifest_session_id(zip_path: &Path) -> Result<String, String> {
    let f = fs::File::open(zip_path).map_err(|e| format!("open zip: {e}"))?;
    let mut z = zip::ZipArchive::new(f).map_err(|e| format!("read zip: {e}"))?;
    let mut file = z
        .by_name("manifest.json")
        .map_err(|e| format!("read manifest.json: {e}"))?;
    const MAX_BYTES: u64 = 1024 * 1024;
    if file.size() > MAX_BYTES {
        return Err("manifest.json 过大".to_string());
    }
    let mut s = String::new();
    file.read_to_string(&mut s)
        .map_err(|e| format!("read manifest.json: {e}"))?;
    let m: BundleManifest = serde_json::from_str(&s).map_err(|e| format!("parse manifest: {e}"))?;
    Ok(m.session_id)
}

fn rewrite_session_id(src: &Path, old_id: &str, new_id: &str, dst: &Path) -> Result<(), String> {
    let input = fs::File::open(src).map_err(|e| format!("open rollout: {e}"))?;
    let reader = std::io::BufReader::new(input);
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create dir: {e}"))?;
    }
    let output = fs::File::create(dst).map_err(|e| format!("create rewritten rollout: {e}"))?;
    let mut writer = std::io::BufWriter::new(output);

    for line in reader.lines() {
        let line = line.map_err(|e| format!("read rollout line: {e}"))?;
        if line.trim().is_empty() {
            writeln!(writer).map_err(|e| format!("write rollout: {e}"))?;
            continue;
        }

        let mut v: serde_json::Value =
            serde_json::from_str(&line).map_err(|e| format!("parse rollout json line: {e}"))?;

        let should_rewrite = v
            .get("type")
            .and_then(|x| x.as_str())
            .map(|t| t == "session_meta")
            .unwrap_or(false)
            && v.pointer("/payload/id")
                .and_then(|x| x.as_str())
                .map(|id| id == old_id)
                .unwrap_or(false);

        if should_rewrite {
            if let Some(p) = v.pointer_mut("/payload/id") {
                *p = serde_json::Value::String(new_id.to_string());
            }
        }

        let out_line =
            serde_json::to_string(&v).map_err(|e| format!("serialize rollout json line: {e}"))?;
        writeln!(writer, "{out_line}").map_err(|e| format!("write rollout: {e}"))?;
    }

    writer
        .flush()
        .map_err(|e| format!("flush rewritten rollout: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        ffi::OsString,
        sync::{Mutex, OnceLock},
    };

    static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap()
    }

    struct EnvVarGuard {
        key: &'static str,
        prev: Option<OsString>,
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            match &self.prev {
                Some(v) => std::env::set_var(self.key, v),
                None => std::env::remove_var(self.key),
            }
        }
    }

    fn set_env_var(key: &'static str, value: &std::path::Path) -> EnvVarGuard {
        let prev = std::env::var_os(key);
        std::env::set_var(key, value);
        EnvVarGuard { key, prev }
    }

    fn temp_dir(prefix: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("codexrelay-{prefix}-{}", uuid::Uuid::now_v7()))
    }

    fn write_rollout(codex_home: &Path, session_id: &str, assistant_text: &str) -> PathBuf {
        let dir = codex_home
            .join("sessions")
            .join("2026")
            .join("02")
            .join("26");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("rollout-2026-02-26T20-33-00-{session_id}.jsonl"));
        let content = format!(
            concat!(
                r#"{{"type":"session_meta","payload":{{"id":"{sid}","cwd":"/tmp/proj","cli_version":"0.0.0","model_provider":"openai"}}}}"#,
                "\n",
                r#"{{"timestamp":"2026-02-26T20:33:00Z","type":"response_item","payload":{{"type":"message","role":"assistant","content":[{{"type":"output_text","text":"{text}"}}]}}}}"#,
                "\n"
            ),
            sid = session_id,
            text = assistant_text.replace('"', "\\\""),
        );
        std::fs::write(&path, content).unwrap();
        path
    }

    #[test]
    fn rewrite_session_id_only_updates_session_meta_payload_id() {
        let dir = std::env::temp_dir().join(format!("codexrelay-test-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("src.jsonl");
        let dst = dir.join("dst.jsonl");

        let input = r#"{"type":"session_meta","payload":{"id":"old","cwd":"/tmp"}}
{"type":"message","payload":{"text":"old should not change"}}
"#;
        std::fs::write(&src, input).unwrap();

        rewrite_session_id(&src, "old", "new", &dst).unwrap();

        let out = std::fs::read_to_string(&dst).unwrap();
        let mut lines = out.lines();
        let first = serde_json::from_str::<serde_json::Value>(lines.next().unwrap()).unwrap();
        let second = serde_json::from_str::<serde_json::Value>(lines.next().unwrap()).unwrap();

        assert_eq!(
            first.pointer("/payload/id").and_then(|v| v.as_str()),
            Some("new")
        );
        assert_eq!(
            second.pointer("/payload/text").and_then(|v| v.as_str()),
            Some("old should not change")
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn export_then_import_roundtrip_overwrite() {
        let _guard = env_lock();

        let app_data_dir = temp_dir("appdata");
        let _app_data = set_env_var("CODEXRELAY_APP_DATA_DIR", &app_data_dir);

        let codex_home_src = temp_dir("codexhome-src");
        let _codex_home = set_env_var("CODEX_HOME", &codex_home_src);

        let sid = "019d0000-1111-7777-8888-000000000001";
        let _rollout_src = write_rollout(&codex_home_src, sid, "hello from src");

        // Optional shell snapshot (export should include only when both checkbox and file exist).
        let shell_dir = codex_home_src.join("shell_snapshots");
        std::fs::create_dir_all(&shell_dir).unwrap();
        std::fs::write(shell_dir.join(format!("{sid}.sh")), "echo test\n").unwrap();

        let app = tauri::test::mock_app();
        let handle = app.handle();

        let exported = export_session(
            handle,
            ExportParams {
                session_id: sid.to_string(),
                name: "roundtrip".to_string(),
                note: Some("n".to_string()),
                include_shell_snapshot: true,
            },
        )
        .unwrap();

        assert!(Path::new(&exported.bundle_path).exists());
        assert_eq!(exported.manifest.session_id, sid);
        assert_eq!(exported.resume_cmd, format!("codex resume {sid}"));

        let codex_home_dst = temp_dir("codexhome-dst");
        let _codex_home2 = set_env_var("CODEX_HOME", &codex_home_dst);

        let imported = import_bundle(
            handle,
            ImportParams {
                bundle_path: exported.bundle_path.clone(),
                name: "import".to_string(),
                note: None,
                strategy: ConflictStrategy::Overwrite,
            },
        )
        .unwrap();

        assert_eq!(imported.status, "ok");
        assert_eq!(imported.effective_session_id, sid);
        let local_path = PathBuf::from(imported.local_rollout_path.unwrap());
        assert!(local_path.exists());
        assert_eq!(
            crate::codex::read_rollout_session_id(&local_path).unwrap(),
            sid
        );

        // Cleanup.
        let _ = std::fs::remove_dir_all(&app_data_dir);
        let _ = std::fs::remove_dir_all(&codex_home_src);
        let _ = std::fs::remove_dir_all(&codex_home_dst);
    }

    #[test]
    fn import_recommended_conflict_defaults_to_import_as_new() {
        let _guard = env_lock();

        let app_data_dir = temp_dir("appdata");
        let _app_data = set_env_var("CODEXRELAY_APP_DATA_DIR", &app_data_dir);

        let codex_home_src = temp_dir("codexhome-src");
        let _codex_home = set_env_var("CODEX_HOME", &codex_home_src);

        let sid = "019d0000-2222-7777-8888-000000000002";
        let _rollout_src = write_rollout(&codex_home_src, sid, "src v1");

        let app = tauri::test::mock_app();
        let handle = app.handle();

        let exported = export_session(
            handle,
            ExportParams {
                session_id: sid.to_string(),
                name: "conflict".to_string(),
                note: None,
                include_shell_snapshot: false,
            },
        )
        .unwrap();

        let codex_home_dst = temp_dir("codexhome-dst");
        let _codex_home2 = set_env_var("CODEX_HOME", &codex_home_dst);

        // Create an existing local rollout with the same session id but different content.
        let existing_path = write_rollout(&codex_home_dst, sid, "local divergent");
        let existing_sha = crate::hash::sha256_file_hex(&existing_path).unwrap();

        let imported = import_bundle(
            handle,
            ImportParams {
                bundle_path: exported.bundle_path.clone(),
                name: "import".to_string(),
                note: None,
                strategy: ConflictStrategy::Recommended,
            },
        )
        .unwrap();

        assert_eq!(imported.status, "ok");
        assert_ne!(imported.effective_session_id, sid);
        let new_path = PathBuf::from(imported.local_rollout_path.unwrap());
        assert!(new_path.exists());
        assert_eq!(
            crate::codex::read_rollout_session_id(&new_path).unwrap(),
            imported.effective_session_id
        );

        // Existing local file remains unchanged.
        assert!(existing_path.exists());
        assert_eq!(
            crate::hash::sha256_file_hex(&existing_path).unwrap(),
            existing_sha
        );

        let _ = std::fs::remove_dir_all(&app_data_dir);
        let _ = std::fs::remove_dir_all(&codex_home_src);
        let _ = std::fs::remove_dir_all(&codex_home_dst);
    }

    #[test]
    fn import_overwrite_backs_up_local_before_rollout_when_conflict() {
        let _guard = env_lock();

        let app_data_dir = temp_dir("appdata");
        let _app_data = set_env_var("CODEXRELAY_APP_DATA_DIR", &app_data_dir);

        let codex_home_src = temp_dir("codexhome-src");
        let _codex_home = set_env_var("CODEX_HOME", &codex_home_src);

        let sid = "019d0000-3333-7777-8888-000000000003";
        let _rollout_src = write_rollout(&codex_home_src, sid, "src v1");

        let app = tauri::test::mock_app();
        let handle = app.handle();

        let exported = export_session(
            handle,
            ExportParams {
                session_id: sid.to_string(),
                name: "overwrite".to_string(),
                note: None,
                include_shell_snapshot: false,
            },
        )
        .unwrap();

        let codex_home_dst = temp_dir("codexhome-dst");
        let _codex_home2 = set_env_var("CODEX_HOME", &codex_home_dst);

        // Divergent local session.
        let existing_path = write_rollout(&codex_home_dst, sid, "local divergent");
        let existing_sha = crate::hash::sha256_file_hex(&existing_path).unwrap();

        let imported = import_bundle(
            handle,
            ImportParams {
                bundle_path: exported.bundle_path.clone(),
                name: "import".to_string(),
                note: None,
                strategy: ConflictStrategy::Overwrite,
            },
        )
        .unwrap();

        assert_eq!(imported.status, "ok");
        assert_eq!(imported.effective_session_id, sid);
        let local_path = PathBuf::from(imported.local_rollout_path.unwrap());
        assert!(local_path.exists());
        assert_eq!(
            crate::codex::read_rollout_session_id(&local_path).unwrap(),
            sid
        );

        // Backup should exist in the import transfer vault dir.
        let backup = PathBuf::from(&imported.vault_dir).join("local_before_rollout.jsonl");
        assert!(backup.exists());
        assert_eq!(crate::hash::sha256_file_hex(&backup).unwrap(), existing_sha);

        let _ = std::fs::remove_dir_all(&app_data_dir);
        let _ = std::fs::remove_dir_all(&codex_home_src);
        let _ = std::fs::remove_dir_all(&codex_home_dst);
    }

    #[test]
    fn change_session_id_creates_new_rollout_and_bundle() {
        let _guard = env_lock();

        let app_data_dir = temp_dir("appdata");
        let _app_data = set_env_var("CODEXRELAY_APP_DATA_DIR", &app_data_dir);

        let codex_home = temp_dir("codexhome");
        let _codex_home = set_env_var("CODEX_HOME", &codex_home);

        let old_id = "019d0000-4444-7777-8888-000000000004";
        let old_path = write_rollout(&codex_home, old_id, "old session");
        let old_sha = crate::hash::sha256_file_hex(&old_path).unwrap();

        let new_id = uuid::Uuid::now_v7().to_string();

        let app = tauri::test::mock_app();
        let handle = app.handle();

        let changed = change_session_id(
            handle,
            ChangeIdParams {
                session_id: old_id.to_string(),
                name: "change".to_string(),
                note: None,
                new_session_id: Some(new_id.clone()),
            },
        )
        .unwrap();

        assert_eq!(changed.old_session_id, old_id);
        assert_eq!(changed.new_session_id, new_id);
        assert!(Path::new(&changed.bundle_path).exists());

        let new_path = PathBuf::from(&changed.local_rollout_path);
        assert!(new_path.exists());
        assert_eq!(
            crate::codex::read_rollout_session_id(&new_path).unwrap(),
            new_id
        );

        // Original local file remains unchanged.
        assert!(old_path.exists());
        assert_eq!(crate::hash::sha256_file_hex(&old_path).unwrap(), old_sha);

        let _ = std::fs::remove_dir_all(&app_data_dir);
        let _ = std::fs::remove_dir_all(&codex_home);
    }
}
