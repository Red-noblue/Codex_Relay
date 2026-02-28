use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

use sha2::{Digest, Sha256};
use zip::{write::FileOptions, CompressionMethod};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestFileInfo {
    pub sha256: String,
    pub size: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestDeviceInfo {
    pub device_id: String,
    pub os: String,
    pub arch: String,
    pub hostname: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestCodexInfo {
    pub cli_version: Option<String>,
    pub model_provider: Option<String>,
    pub cwd: Option<String>,
    pub rollout_rel_path: Option<String>,
    pub rollout_file_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BundleManifest {
    pub schema_version: u32,
    pub name: String,
    pub note: Option<String>,
    pub session_id: String,
    pub created_at: String,
    pub source_device: ManifestDeviceInfo,
    pub codex: ManifestCodexInfo,
    pub rollout: ManifestFileInfo,
    pub shell_snapshot: Option<ManifestFileInfo>,
}

pub const BUNDLE_SCHEMA_VERSION: u32 = 1;

pub fn now_rfc3339_utc() -> Result<String, String> {
    use time::format_description::well_known::Rfc3339;
    time::OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .map_err(|e| format!("format rfc3339: {e}"))
}

pub fn write_manifest_json(path: &Path, manifest: &BundleManifest) -> Result<(), String> {
    let json =
        serde_json::to_string_pretty(manifest).map_err(|e| format!("serialize manifest: {e}"))?;
    fs::write(path, json).map_err(|e| format!("write manifest: {e}"))?;
    Ok(())
}

pub fn read_manifest_json(path: &Path) -> Result<BundleManifest, String> {
    let s = fs::read_to_string(path).map_err(|e| format!("read manifest: {e}"))?;
    serde_json::from_str(&s).map_err(|e| format!("parse manifest: {e}"))
}

pub fn write_bundle_zip(
    zip_path: &Path,
    manifest_path: &Path,
    rollout_path: &Path,
    shell_snapshot_path: Option<&Path>,
) -> Result<(), String> {
    if let Some(parent) = zip_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create zip dir: {e}"))?;
    }

    let f = fs::File::create(zip_path).map_err(|e| format!("create zip: {e}"))?;
    let mut w = zip::ZipWriter::new(f);

    let opts = FileOptions::default().compression_method(CompressionMethod::Deflated);

    write_zip_file(&mut w, "manifest.json", manifest_path, opts)?;
    write_zip_file(&mut w, "rollout.jsonl", rollout_path, opts)?;
    if let Some(p) = shell_snapshot_path {
        write_zip_file(&mut w, "shell_snapshot.sh", p, opts)?;
    }

    w.finish().map_err(|e| format!("finalize zip: {e}"))?;
    Ok(())
}

pub fn write_batch_zip_of_zips(
    zip_path: &Path,
    inner_zips: &[(String, PathBuf)],
    batch_manifest_json: Option<&str>,
) -> Result<(), String> {
    if let Some(parent) = zip_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create zip dir: {e}"))?;
    }

    let f = fs::File::create(zip_path).map_err(|e| format!("create zip: {e}"))?;
    let mut w = zip::ZipWriter::new(f);

    // Inner zip files are already compressed; store them to avoid wasting CPU and time.
    let stored = FileOptions::default().compression_method(CompressionMethod::Stored);
    for (entry_name, src_zip) in inner_zips {
        w.start_file(entry_name, stored)
            .map_err(|e| format!("zip start_file {entry_name}: {e}"))?;
        let mut f =
            fs::File::open(src_zip).map_err(|e| format!("open inner zip {entry_name}: {e}"))?;
        let mut buf = [0u8; 1024 * 64];
        loop {
            let n = f
                .read(&mut buf)
                .map_err(|e| format!("read inner zip {entry_name}: {e}"))?;
            if n == 0 {
                break;
            }
            w.write_all(&buf[..n])
                .map_err(|e| format!("write zip entry {entry_name}: {e}"))?;
        }
    }

    if let Some(json) = batch_manifest_json {
        let opts = FileOptions::default().compression_method(CompressionMethod::Deflated);
        w.start_file("batch_manifest.json", opts)
            .map_err(|e| format!("zip start_file batch_manifest.json: {e}"))?;
        w.write_all(json.as_bytes())
            .map_err(|e| format!("write batch_manifest.json: {e}"))?;
    }

    w.finish().map_err(|e| format!("finalize zip: {e}"))?;
    Ok(())
}

fn write_zip_file(
    w: &mut zip::ZipWriter<fs::File>,
    name: &str,
    src: &Path,
    opts: FileOptions,
) -> Result<(), String> {
    w.start_file(name, opts)
        .map_err(|e| format!("zip start_file {name}: {e}"))?;
    let mut f = fs::File::open(src).map_err(|e| format!("open src for zip {name}: {e}"))?;
    let mut buf = [0u8; 1024 * 64];
    loop {
        let n = f
            .read(&mut buf)
            .map_err(|e| format!("read src for zip {name}: {e}"))?;
        if n == 0 {
            break;
        }
        w.write_all(&buf[..n])
            .map_err(|e| format!("write zip entry {name}: {e}"))?;
    }
    Ok(())
}

#[derive(Debug, Clone)]
pub struct ExtractedFile {
    pub path: PathBuf,
    pub sha256: String,
    pub size: i64,
}

#[derive(Debug, Clone)]
pub struct ExtractedBundle {
    pub manifest: ExtractedFile,
    pub rollout: ExtractedFile,
}

pub fn extract_bundle_zip(zip_path: &Path, dest_dir: &Path) -> Result<ExtractedBundle, String> {
    fs::create_dir_all(dest_dir).map_err(|e| format!("create extract dir: {e}"))?;
    let f = fs::File::open(zip_path).map_err(|e| format!("open bundle zip: {e}"))?;
    let mut z = zip::ZipArchive::new(f).map_err(|e| format!("read bundle zip: {e}"))?;

    // Guardrails against malformed bundles / zip bombs. These limits are intentionally generous
    // for real-world Codex rollouts while still preventing accidental disk exhaustion.
    const MAX_MANIFEST_BYTES: u64 = 1024 * 1024; // 1 MiB
    const MAX_SHELL_SNAPSHOT_BYTES: u64 = 64 * 1024 * 1024; // 64 MiB
    const MAX_ROLLOUT_BYTES: u64 = 2 * 1024 * 1024 * 1024; // 2 GiB

    let manifest_path = dest_dir.join("manifest.json");
    let manifest =
        extract_zip_entry_exact(&mut z, "manifest.json", &manifest_path, MAX_MANIFEST_BYTES)?
            .ok_or_else(|| "导出包缺少 manifest.json".to_string())?;

    let rollout_path = dest_dir.join("rollout.jsonl");
    let rollout =
        extract_zip_entry_exact(&mut z, "rollout.jsonl", &rollout_path, MAX_ROLLOUT_BYTES)?
            .ok_or_else(|| "导出包缺少 rollout.jsonl".to_string())?;

    let shell_path = dest_dir.join("shell_snapshot.sh");
    // Optional entry: keep it in the vault if present, but it's not required for resume.
    let _ = extract_zip_entry_exact(
        &mut z,
        "shell_snapshot.sh",
        &shell_path,
        MAX_SHELL_SNAPSHOT_BYTES,
    )?;

    Ok(ExtractedBundle { manifest, rollout })
}

fn extract_zip_entry_exact(
    z: &mut zip::ZipArchive<fs::File>,
    entry_name: &str,
    out_path: &Path,
    max_bytes: u64,
) -> Result<Option<ExtractedFile>, String> {
    let mut file = match z.by_name(entry_name) {
        Ok(f) => f,
        Err(_) => return Ok(None),
    };

    // `size()` is the uncompressed size declared in the zip central directory. Still enforce an
    // absolute cap during streaming copy as a safety net.
    let declared = file.size();
    if declared > max_bytes {
        return Err(format!(
            "导出包条目过大：{}（{} bytes，超过上限 {} bytes）",
            entry_name, declared, max_bytes
        ));
    }

    let tmp = out_path.with_extension("tmp");
    if let Some(parent) = tmp.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create extract dir: {e}"))?;
    }
    let mut out =
        fs::File::create(&tmp).map_err(|e| format!("create extracted file {entry_name}: {e}"))?;
    let (bytes, sha256) = copy_reader_with_limit_and_sha256(&mut file, &mut out, max_bytes)
        .map_err(|e| format!("extract {entry_name}: {e}"))?;
    out.flush()
        .map_err(|e| format!("flush extracted file {entry_name}: {e}"))?;

    // Best-effort replace.
    if out_path.exists() {
        let _ = fs::remove_file(out_path);
    }
    fs::rename(&tmp, out_path).map_err(|e| format!("finalize extracted file {entry_name}: {e}"))?;

    let size =
        i64::try_from(bytes).map_err(|_| format!("导出包条目过大：{}（超过 i64）", entry_name))?;
    Ok(Some(ExtractedFile {
        path: out_path.to_path_buf(),
        sha256,
        size,
    }))
}

fn copy_reader_with_limit_and_sha256(
    r: &mut impl Read,
    w: &mut impl Write,
    max_bytes: u64,
) -> Result<(u64, String), String> {
    let mut total: u64 = 0;
    let mut buf = [0u8; 1024 * 64];
    let mut hasher = Sha256::new();
    loop {
        let n = r.read(&mut buf).map_err(|e| format!("read: {e}"))?;
        if n == 0 {
            break;
        }
        total = total.saturating_add(n as u64);
        if total > max_bytes {
            return Err("导出包条目内容超过上限（可能是损坏或恶意压缩包）".to_string());
        }
        w.write_all(&buf[..n]).map_err(|e| format!("write: {e}"))?;
        hasher.update(&buf[..n]);
    }
    Ok((total, hex::encode(hasher.finalize())))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(prefix: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("codexrelay-{prefix}-{}", uuid::Uuid::now_v7()))
    }

    #[test]
    fn extract_bundle_zip_rejects_oversized_manifest() {
        let dir = temp_dir("bundle-test");
        std::fs::create_dir_all(&dir).unwrap();

        let manifest_path = dir.join("manifest.json");
        let rollout_path = dir.join("rollout.jsonl");
        let zip_path = dir.join("bundle.zip");
        let extract_dir = dir.join("extract");

        // manifest > 1 MiB
        let big = "a".repeat(1024 * 1024 + 10);
        std::fs::write(&manifest_path, big).unwrap();
        std::fs::write(
            &rollout_path,
            "{\"type\":\"session_meta\",\"payload\":{\"id\":\"x\"}}\n",
        )
        .unwrap();

        write_bundle_zip(&zip_path, &manifest_path, &rollout_path, None).unwrap();

        let err = extract_bundle_zip(&zip_path, &extract_dir).unwrap_err();
        assert!(err.contains("manifest.json"));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
