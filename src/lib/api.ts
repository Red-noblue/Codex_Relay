import { invoke } from "@tauri-apps/api/core";
import type {
  AppStatus,
  ChangeIdParams,
  ChangeIdResult,
  ExtractSessionIdsFromFileParams,
  ExtractSessionIdsResult,
  ExportParams,
  ExportResult,
  ExportSessionsParams,
  ExportSessionsResult,
  ImportParams,
  ImportResult,
  ImportBundlesParams,
  ImportBundlesResult,
  InspectBundleResult,
  HistoryLatestForSessionsParams,
  HistoryUpdateParams,
  HistoryDeleteManyResult,
  PreviewBundleParams,
  PreviewRolloutParams,
  RolloutPreview,
  RestoreFromHistoryParams,
  SessionSummary,
  TransferRecord,
  VaultUsage,
} from "./types";

export async function appStatus(): Promise<AppStatus> {
  return invoke<AppStatus>("app_status");
}

export async function setCodexHomeOverride(
  codex_home_override: string | null,
): Promise<AppStatus> {
  return invoke<AppStatus>("settings_set_codex_home_override", {
    params: { codex_home_override },
  });
}

export async function listSessions(limit = 200): Promise<SessionSummary[]> {
  return invoke<SessionSummary[]>("codex_list_sessions", { limit });
}

export async function exportBundle(params: ExportParams): Promise<ExportResult> {
  return invoke<ExportResult>("export_bundle", { params });
}

export async function exportSessions(
  params: ExportSessionsParams,
): Promise<ExportSessionsResult> {
  return invoke<ExportSessionsResult>("export_sessions", { params });
}

export async function inspectBundle(
  bundle_path: string,
): Promise<InspectBundleResult> {
  return invoke<InspectBundleResult>("inspect_bundle", { bundle_path });
}

export async function importBundle(params: ImportParams): Promise<ImportResult> {
  return invoke<ImportResult>("import_bundle", { params });
}

export async function importBundles(
  params: ImportBundlesParams,
): Promise<ImportBundlesResult> {
  return invoke<ImportBundlesResult>("import_bundles", { params });
}

export async function changeSessionId(
  params: ChangeIdParams,
): Promise<ChangeIdResult> {
  return invoke<ChangeIdResult>("change_session_id", { params });
}

export async function historyList(limit = 200): Promise<TransferRecord[]> {
  return invoke<TransferRecord[]>("history_list", { limit });
}

export async function historyLatestForSessions(
  params: HistoryLatestForSessionsParams,
): Promise<TransferRecord[]> {
  return invoke<TransferRecord[]>("history_latest_for_sessions", { params });
}

export async function historyDelete(
  id: string,
  delete_files: boolean,
): Promise<void> {
  return invoke<void>("history_delete", { params: { id, delete_files } });
}

export async function historyDeleteMany(
  ids: string[],
  delete_files: boolean,
): Promise<HistoryDeleteManyResult> {
  return invoke<HistoryDeleteManyResult>("history_delete_many", {
    params: { ids, delete_files },
  });
}

export async function historyUpdate(
  params: HistoryUpdateParams,
): Promise<TransferRecord> {
  return invoke<TransferRecord>("history_update", { params });
}

export async function restoreFromHistory(
  params: RestoreFromHistoryParams,
): Promise<ImportResult> {
  return invoke<ImportResult>("restore_from_history", { params });
}

export async function previewRollout(
  params: PreviewRolloutParams,
): Promise<RolloutPreview> {
  return invoke<RolloutPreview>("preview_rollout", { params });
}

export async function previewBundle(
  params: PreviewBundleParams,
): Promise<RolloutPreview> {
  return invoke<RolloutPreview>("preview_bundle", { params });
}

export async function vaultUsage(limit = 200): Promise<VaultUsage> {
  return invoke<VaultUsage>("vault_usage", { limit });
}

export async function extractSessionIdsFromFile(
  params: ExtractSessionIdsFromFileParams,
): Promise<ExtractSessionIdsResult> {
  return invoke<ExtractSessionIdsResult>("extract_session_ids_from_file", { params });
}
