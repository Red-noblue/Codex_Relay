export type ResolvedCodexHome = {
  detected_home: string;
  override_home?: string | null;
  effective_home: string;
  source: "override" | "env" | "default" | string;
};

export type DeviceInfo = {
  device_id: string;
  os: string;
  arch: string;
  hostname?: string | null;
};

export type AppStatus = {
  product_name: string;
  version: string;
  codex_home: ResolvedCodexHome;
  app_data_dir: string;
  vault_dir: string;
  db_path: string;
  device: DeviceInfo;
};

export type SessionSummary = {
  id: string;
  rollout_path: string;
  cwd?: string | null;
  cli_version?: string | null;
  model_provider?: string | null;
  mtime_ms?: number | null;
  last_event_timestamp?: string | null;
  file_size?: number | null;
};

export type ManifestFileInfo = {
  sha256: string;
  size: number;
};

export type ManifestDeviceInfo = {
  device_id: string;
  os: string;
  arch: string;
  hostname?: string | null;
};

export type ManifestCodexInfo = {
  cli_version?: string | null;
  model_provider?: string | null;
  cwd?: string | null;
  rollout_rel_path?: string | null;
  rollout_file_name?: string | null;
};

export type BundleManifest = {
  schema_version: number;
  name: string;
  note?: string | null;
  session_id: string;
  created_at: string;
  source_device: ManifestDeviceInfo;
  codex: ManifestCodexInfo;
  rollout: ManifestFileInfo;
  shell_snapshot?: ManifestFileInfo | null;
};

export type LocalSessionInfo = {
  session_id: string;
  rollout_path: string;
  sha256: string;
  size: number;
  mtime_ms?: number | null;
  last_event_timestamp?: string | null;
  cwd?: string | null;
  cli_version?: string | null;
  model_provider?: string | null;
};

export type InspectBundleResult = {
  bundle_path: string;
  manifest: BundleManifest;
  sha256_ok: boolean;
  rollout_last_event_timestamp?: string | null;
  local_existing?: LocalSessionInfo | null;
};

export type ExportParams = {
  session_id: string;
  name: string;
  note?: string | null;
  include_shell_snapshot: boolean;
};

export type ExportResult = {
  transfer_id: string;
  bundle_path: string;
  vault_dir: string;
  manifest: BundleManifest;
  resume_cmd: string;
};

export type ExportBundleMode = "merged" | "per_session";

export type ExportSessionsParams = {
  session_ids: string[];
  name: string;
  note?: string | null;
  include_shell_snapshot: boolean;
  mode: ExportBundleMode;
};

export type ExportSessionItem = {
  session_id: string;
  transfer_id: string;
  vault_dir: string;
  vault_bundle_path: string;
  exported_bundle_path?: string | null;
  manifest: BundleManifest;
  resume_cmd: string;
};

export type ExportSessionError = {
  session_id: string;
  message: string;
};

export type ExportSessionsResult = {
  mode: ExportBundleMode;
  export_dir: string;
  merged_bundle_path?: string | null;
  items: ExportSessionItem[];
  errors: ExportSessionError[];
};

export type ConflictStrategy =
  | "recommended"
  | "overwrite"
  | "import_as_new"
  | "cancel";

export type ImportParams = {
  bundle_path: string;
  name: string;
  note?: string | null;
  strategy: ConflictStrategy;
};

export type ImportResult = {
  transfer_id: string;
  vault_dir: string;
  effective_session_id: string;
  local_rollout_path?: string | null;
  resume_cmd?: string | null;
  status: "ok" | "canceled" | string;
};

export type ImportBundlesParams = {
  bundle_paths: string[];
  name: string;
  note?: string | null;
  strategy: ConflictStrategy;
};

export type ImportBundlesItem = {
  source: string;
  result: ImportResult;
};

export type ImportBundlesError = {
  source: string;
  message: string;
};

export type ImportBundlesResult = {
  requested_paths: number;
  imported: number;
  failed: number;
  items: ImportBundlesItem[];
  errors: ImportBundlesError[];
};

export type ChangeIdParams = {
  session_id: string;
  name: string;
  note?: string | null;
  new_session_id?: string | null;
};

export type ChangeIdResult = {
  transfer_id: string;
  vault_dir: string;
  bundle_path: string;
  old_session_id: string;
  new_session_id: string;
  local_rollout_path: string;
  resume_cmd: string;
};

export type TransferRecord = {
  id: string;
  created_at: string;
  op: string;
  name: string;
  note?: string | null;
  tags?: string | null;
  favorite: boolean;
  updated_at?: string | null;
  session_id_old?: string | null;
  session_id_new?: string | null;
  effective_session_id?: string | null;
  status: string;
  error_message?: string | null;
  vault_dir: string;
  bundle_path: string;
  vault_rollout_rel_path?: string | null;
  rollout_sha256?: string | null;
  rollout_size?: number | null;
  local_rollout_path?: string | null;
};

export type RestoreFromHistoryParams = {
  record_id: string;
  name: string;
  note?: string | null;
  strategy: ConflictStrategy;
};

export type HistoryUpdateParams = {
  id: string;
  name: string;
  note?: string | null;
  tags?: string | null;
  favorite: boolean;
};

export type HistoryDeleteManyResult = {
  requested: number;
  deleted: number;
  failed: number;
  errors: Array<{ id: string; message: string }>;
};

export type HistoryLatestForSessionsParams = {
  session_ids: string[];
};

export type PreviewMessage = {
  timestamp?: string | null;
  role: string;
  text: string;
  content_types: string[];
};

export type RolloutPreview = {
  kind: "file" | "bundle" | string;
  source: string;
  session_id?: string | null;
  // "full" when stats were computed by scanning the whole rollout.jsonl,
  // otherwise "tail_window" (stats reflect only the scanned tail window).
  stats_scope?: string;
  messages: PreviewMessage[];
  // Counts within `stats_scope` (may be larger than `max_messages`).
  message_counts: Record<string, number>;
  // Counts for the returned `messages` only.
  message_counts_preview?: Record<string, number>;
  tool_calls: number;
  tool_call_outputs: number;
  scanned_offset: number;
  scanned_bytes: number;
  max_messages: number;
  max_chars_per_message: number;
  warning?: string | null;
};

export type PreviewRolloutParams = {
  path: string;
  max_messages?: number | null;
  max_chars_per_message?: number | null;
  include_meta?: boolean | null;
};

export type PreviewBundleParams = {
  bundle_path: string;
  max_messages?: number | null;
  max_chars_per_message?: number | null;
  include_meta?: boolean | null;
};

export type ExtractSessionIdsFromFileParams = {
  path: string;
  max_bytes?: number | null;
};

export type ExtractSessionIdsResult = {
  source: string;
  scanned_bytes: number;
  truncated: boolean;
  ids: string[];
};

export type VaultUsageItem = {
  id: string;
  created_at: string;
  op: string;
  name: string;
  effective_session_id?: string | null;
  status: string;
  vault_dir: string;
  bytes: number;
  files: number;
};

export type VaultUsage = {
  total_bytes: number;
  total_files: number;
  items: VaultUsageItem[];
};
