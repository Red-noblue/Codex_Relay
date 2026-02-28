# Bundle Format

Bundle 是一个 zip 文件，用于跨设备传递某个 Codex CLI session（核心是 `rollout-*.jsonl`）。

## Zip Entries

- `manifest.json`
- `rollout.jsonl`
- `shell_snapshot.sh`（可选）

## Batch Bundle（合并导出包）

为便于一次性传输多个 session，CodexRelay 支持“合并为一个 zip”的批量导出包（外层仍是 `.zip`），其结构为：

- `batch_manifest.json`（可选，CodexRelay 生成的元信息）
- `bundles/<session_id>.zip`（一个或多个；每个都是上面定义的“单会话 Bundle”）

导入时，如果发现外层 zip **不包含** `manifest.json`+`rollout.jsonl`，但包含可导入的内层 `*.zip`（优先识别 `bundles/*.zip`，也支持用户手动把多个 bundle.zip 打到同一个 zip 的根目录），则会按“批量导入”逐个导入。

## Import Validation（导入校验规则）

- `manifest.schema_version` 必须是当前支持的版本（v1）。
- `rollout.jsonl` 会进行：
  - sha256 校验（与 `manifest.rollout.sha256` 一致）
  - size 校验（与 `manifest.rollout.size` 一致）
  - 会话ID一致性校验（`rollout.jsonl` 第一行 `session_meta.payload.id` == `manifest.session_id`）

## Safety Limits（防误伤/防滥用）

为避免损坏/恶意压缩包导致资源耗尽，解包时会对单个条目做大小上限（实现上为“声明大小 + 流式拷贝上限”双重约束）：

- `manifest.json`：1 MiB
- `shell_snapshot.sh`：64 MiB
- `rollout.jsonl`：2 GiB

## `manifest.json` Schema (v1)

示例（字段名与当前实现一致）：

```json
{
  "schema_version": 1,
  "name": "User provided name (required)",
  "note": "Optional note",
  "session_id": "019c....",
  "created_at": "2026-02-26T00:00:00Z",
  "source_device": {
    "device_id": "uuid-v7",
    "os": "macos|windows|linux",
    "arch": "arm64|x86_64|...",
    "hostname": "optional"
  },
  "codex": {
    "cli_version": "0.104.0",
    "model_provider": "openai|...",
    "cwd": "/path/to/project",
    "rollout_rel_path": "sessions/2026/02/26/rollout-...-<SESSION_ID>.jsonl",
    "rollout_file_name": "rollout-...-<SESSION_ID>.jsonl"
  },
  "rollout": {
    "sha256": "hex",
    "size": 12345
  },
  "shell_snapshot": {
    "sha256": "hex",
    "size": 234
  }
}
```

备注：
- `shell_snapshot` 若不包含则为 `null`。
- `rollout_rel_path` / `rollout_file_name` 用于“尽量保留原始路径信息”，但导入时不会完全信任该路径（会做安全校验）。
