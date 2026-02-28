import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { join } from "@tauri-apps/api/path";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./App.css";
import * as api from "./lib/api";
import { formatBytes, formatRfc3339, formatTimeMs, shortSha } from "./lib/format";
import { isTauriRuntime } from "./lib/runtime";
import {
  WEB_DEMO_HISTORY,
  WEB_DEMO_PREVIEW,
  WEB_DEMO_SESSIONS,
  WEB_DEMO_STATUS,
  WEB_DEMO_VAULT_USAGE,
} from "./lib/webDemo";
import RolloutPreviewView from "./components/RolloutPreviewView";
import type {
  AppStatus,
  ChangeIdResult,
  ConflictStrategy,
  ExportBundleMode,
  ExportSessionsResult,
  HistoryUpdateParams,
  ImportResult,
  ImportBundlesResult,
  InspectBundleResult,
  RolloutPreview,
  SessionSummary,
  TransferRecord,
  VaultUsage,
} from "./lib/types";

type TabKey =
  | "sessions"
  | "export"
  | "import"
  | "change_id"
  | "history"
  | "settings";

function toErrorMessage(e: unknown): string {
  const formatAppErrorLike = (o: any): string | null => {
    if (!o || typeof o !== "object") return null;
    const message = typeof o.message === "string" ? o.message : null;
    const code = typeof o.code === "string" ? o.code : null;
    const hint = typeof o.hint === "string" ? o.hint : null;
    if (!message) return null;
    let out = message;
    if (hint) out += `\n建议：${hint}`;
    if (code) out += `\n（错误码：${code}）`;
    return out;
  };

  const tryParseJson = (s: string): any | null => {
    const t = s.trim();
    if (!t.startsWith("{") && !t.startsWith("[")) return null;
    try {
      return JSON.parse(t);
    } catch {
      return null;
    }
  };

  // Tauri may give us either a structured object, or a stringified JSON.
  if (e instanceof Error) {
    const parsed = tryParseJson(e.message);
    return formatAppErrorLike(parsed) ?? e.message;
  }
  if (typeof e === "string") {
    const parsed = tryParseJson(e);
    return formatAppErrorLike(parsed) ?? e;
  }
  const formatted = formatAppErrorLike(e as any);
  return formatted ?? String(e);
}

const PREVIEW_MAX_MESSAGES_DEFAULT = 10;
const PREVIEW_MAX_MESSAGES_CAP = 1000;
const PREVIEW_LOAD_MORE_STEP = 10;
const PREVIEW_MAX_CHARS_PER_MESSAGE_DEFAULT = 4000;

const STORAGE_KEY_PREVIEW_MARKDOWN = "codexrelay.preview.markdown";
// v2: reset early-stage defaults (10 / +10), while keeping future persistence.
const STORAGE_KEY_PREVIEW_MAX_MESSAGES = "codexrelay.preview.max_messages.v2";
const STORAGE_KEY_PREVIEW_MAX_CHARS_PER_MESSAGE =
  "codexrelay.preview.max_chars_per_message.v2";
const STORAGE_KEY_PREVIEW_INCLUDE_META = "codexrelay.preview.include_meta.v1";

function parseSessionIdList(input: string): string[] {
  // Extract UUID-like ids from noisy text (paths/commands/markdown etc.).
  const re =
    /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of input.matchAll(re)) {
    const raw = m[0];
    const id = raw.toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function readStorageBool(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  try {
    const v = window.localStorage.getItem(key);
    if (v == null) return fallback;
    return v === "1" || v.toLowerCase() === "true";
  } catch {
    return fallback;
  }
}

function writeStorageBool(key: string, value: boolean) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // ignore
  }
}

function readStorageInt(key: string, fallback: number): number {
  if (typeof window === "undefined") return fallback;
  try {
    const v = window.localStorage.getItem(key);
    if (v == null) return fallback;
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

function writeStorageInt(key: string, value: number) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // ignore
  }
}

function parseTags(input?: string | null): string[] {
  if (!input) return [];
  // Support both "," and "，".
  const parts = input
    .split(/[,，]/g)
    .map((s) => s.trim())
    .filter(Boolean);
  // Deduplicate while keeping order.
  const uniq: string[] = [];
  for (const p of parts) {
    if (!uniq.includes(p)) uniq.push(p);
  }
  return uniq;
}

function normalizeTagsInput(input: string): string | null {
  const tags = parseTags(input);
  return tags.length ? tags.join(", ") : null;
}

function opZh(op: string): string {
  switch (op) {
    case "export":
      return "导出";
    case "import":
      return "导入";
    case "restore":
      return "恢复";
    case "change_id":
      return "改ID";
    default:
      return op || "-";
  }
}

function statusZh(status: string): string {
  switch (status) {
    case "ok":
      return "成功";
    case "canceled":
      return "已取消";
    case "failed":
      return "失败";
    default:
      return status || "-";
  }
}

function App() {
  const [tab, setTab] = useState<TabKey>("sessions");
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>("");
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(
    () => new Set<string>(),
  );
  const isTauri = useMemo(() => isTauriRuntime(), []);
  const [previewRenderMarkdown, setPreviewRenderMarkdown] = useState<boolean>(() =>
    readStorageBool(STORAGE_KEY_PREVIEW_MARKDOWN, false),
  );
  const [previewMaxMessages, setPreviewMaxMessages] = useState<number>(() =>
    readStorageInt(STORAGE_KEY_PREVIEW_MAX_MESSAGES, PREVIEW_MAX_MESSAGES_DEFAULT),
  );
  const [previewMaxCharsPerMessage, setPreviewMaxCharsPerMessage] = useState<number>(() =>
    readStorageInt(
      STORAGE_KEY_PREVIEW_MAX_CHARS_PER_MESSAGE,
      PREVIEW_MAX_CHARS_PER_MESSAGE_DEFAULT,
    ),
  );
  const [previewIncludeMeta, setPreviewIncludeMeta] = useState<boolean>(() =>
    readStorageBool(STORAGE_KEY_PREVIEW_INCLUDE_META, false),
  );

  const [busyAction, setBusyAction] = useState<string | null>(null);
  const busy = busyAction !== null;
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const selectAllSessionsRef = useRef<HTMLInputElement | null>(null);
  const selectAllHistoryRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    writeStorageBool(STORAGE_KEY_PREVIEW_MARKDOWN, previewRenderMarkdown);
  }, [previewRenderMarkdown]);

  useEffect(() => {
    writeStorageInt(STORAGE_KEY_PREVIEW_MAX_MESSAGES, previewMaxMessages);
  }, [previewMaxMessages]);

  useEffect(() => {
    writeStorageInt(STORAGE_KEY_PREVIEW_MAX_CHARS_PER_MESSAGE, previewMaxCharsPerMessage);
  }, [previewMaxCharsPerMessage]);

  useEffect(() => {
    writeStorageBool(STORAGE_KEY_PREVIEW_INCLUDE_META, previewIncludeMeta);
  }, [previewIncludeMeta]);

  // Drag & Drop (bundle.zip)
  const [dragActive, setDragActive] = useState(false);
  const [dragPaths, setDragPaths] = useState<string[]>([]);

  // Sessions UI
  const [sessionsFilter, setSessionsFilter] = useState("");
  const [sessionsDetailOpen, setSessionsDetailOpen] = useState(true);
  const [sessionPreview, setSessionPreview] = useState<RolloutPreview | null>(
    null,
  );
  const [sessionPreviewBusy, setSessionPreviewBusy] = useState(false);
  const [sessionPreviewError, setSessionPreviewError] = useState<string | null>(
    null,
  );
  const [latestTransferBySessionId, setLatestTransferBySessionId] = useState<
    Record<string, TransferRecord>
  >({});

  // Export UI
  const [exportSessionId, setExportSessionId] = useState("");
  const [exportName, setExportName] = useState("");
  const [exportNote, setExportNote] = useState("");
  const [exportIncludeShell, setExportIncludeShell] = useState(false);
  const [exportMode, setExportMode] = useState<ExportBundleMode>("merged");
  const [exportBatchResult, setExportBatchResult] =
    useState<ExportSessionsResult | null>(null);
  const [exportIdsExtractBusy, setExportIdsExtractBusy] = useState(false);
  const [exportIdsExtractInfo, setExportIdsExtractInfo] = useState<string | null>(
    null,
  );

  // Import UI
  const [importBundlePaths, setImportBundlePaths] = useState<string[]>([]);
  const [importPickInfo, setImportPickInfo] = useState<string | null>(null);
  const [inspectResult, setInspectResult] = useState<InspectBundleResult | null>(
    null,
  );
  const [importName, setImportName] = useState("");
  const [importNote, setImportNote] = useState("");
  const [importStrategy, setImportStrategy] =
    useState<ConflictStrategy>("overwrite");
  const [importBatchResult, setImportBatchResult] =
    useState<ImportBundlesResult | null>(null);
  const [bundlePreview, setBundlePreview] = useState<RolloutPreview | null>(
    null,
  );
  const [bundlePreviewBusy, setBundlePreviewBusy] = useState(false);
  const [bundlePreviewError, setBundlePreviewError] = useState<string | null>(
    null,
  );
  const [bundlePreviewOpen, setBundlePreviewOpen] = useState(true);
  const [localExistingPreview, setLocalExistingPreview] =
    useState<RolloutPreview | null>(null);
  const [localExistingPreviewBusy, setLocalExistingPreviewBusy] = useState(false);
  const [localExistingPreviewError, setLocalExistingPreviewError] = useState<
    string | null
  >(null);
  const [localExistingPreviewOpen, setLocalExistingPreviewOpen] = useState(true);

  // Change ID UI
  const [changeIdSessionId, setChangeIdSessionId] = useState("");
  const [changeIdName, setChangeIdName] = useState("");
  const [changeIdNote, setChangeIdNote] = useState("");
  const [changeIdNewId, setChangeIdNewId] = useState("");
  const [changeIdResult, setChangeIdResult] = useState<ChangeIdResult | null>(
    null,
  );

  // History UI
  const [history, setHistory] = useState<TransferRecord[]>([]);
  const [historySelectedId, setHistorySelectedId] = useState<string>("");
  const [historySelectedIds, setHistorySelectedIds] = useState<Set<string>>(
    () => new Set<string>(),
  );
  const [historyFilter, setHistoryFilter] = useState("");
  const [historyDetailOpen, setHistoryDetailOpen] = useState(true);
  const [historyFavoritesOnly, setHistoryFavoritesOnly] = useState(false);
  const [historyOpFilter, setHistoryOpFilter] = useState<string>("all");
  const [historyDeleteFiles, setHistoryDeleteFiles] = useState(false);
  const [historyEditBusy, setHistoryEditBusy] = useState(false);
  const [historyEditError, setHistoryEditError] = useState<string | null>(null);
  const [historyEditName, setHistoryEditName] = useState("");
  const [historyEditNote, setHistoryEditNote] = useState("");
  const [historyEditTags, setHistoryEditTags] = useState("");
  const [historyEditFavorite, setHistoryEditFavorite] = useState(false);
  const [restoreName, setRestoreName] = useState("");
  const [restoreNote, setRestoreNote] = useState("");
  const [restoreStrategy, setRestoreStrategy] =
    useState<ConflictStrategy>("recommended");
  const [restoreResult, setRestoreResult] = useState<ImportResult | null>(null);
  const [historyPreview, setHistoryPreview] = useState<RolloutPreview | null>(
    null,
  );
  const [historyPreviewBusy, setHistoryPreviewBusy] = useState(false);
  const [historyPreviewError, setHistoryPreviewError] = useState<string | null>(
    null,
  );
  const [historyPreviewOpen, setHistoryPreviewOpen] = useState(true);

  // Settings UI
  const [codexHomeOverrideInput, setCodexHomeOverrideInput] = useState("");
  const [vaultUsage, setVaultUsage] = useState<VaultUsage | null>(null);
  const [vaultUsageBusy, setVaultUsageBusy] = useState(false);
  const [vaultUsageError, setVaultUsageError] = useState<string | null>(null);
  const [vaultUsageLimit, setVaultUsageLimit] = useState(200);

  async function refreshStatusAndSessions() {
    setBusyAction("refresh");
    setError(null);
    try {
      if (!isTauri) {
        setStatus(WEB_DEMO_STATUS);
        setSessions(WEB_DEMO_SESSIONS);
        const map: Record<string, TransferRecord> = {};
        for (const r of WEB_DEMO_HISTORY) {
          const sid = r.effective_session_id ?? r.session_id_new ?? r.session_id_old;
          if (!sid) continue;
          map[sid] = r;
        }
        setLatestTransferBySessionId(map);
        if (!selectedSessionId && WEB_DEMO_SESSIONS.length) {
          setSelectedSessionId(WEB_DEMO_SESSIONS[0].id);
        }
        return;
      }
      const [s, list] = await Promise.all([api.appStatus(), api.listSessions()]);
      setStatus(s);
      setSessions(list);
      const latest = await api.historyLatestForSessions({
        session_ids: list.map((x) => x.id),
      });
      const map: Record<string, TransferRecord> = {};
      for (const r of latest) {
        const sid = r.effective_session_id ?? r.session_id_new ?? r.session_id_old;
        if (!sid) continue;
        map[sid] = r;
      }
      setLatestTransferBySessionId(map);
    } catch (e) {
      setError(toErrorMessage(e));
    } finally {
      setBusyAction(null);
    }
  }

  async function refreshHistory() {
    setBusyAction("history");
    setError(null);
    try {
      if (!isTauri) {
        setHistory(WEB_DEMO_HISTORY);
        if (WEB_DEMO_HISTORY.length > 0 && !historySelectedId) {
          setHistorySelectedId(WEB_DEMO_HISTORY[0].id);
        }
        return;
      }
      const records = await api.historyList();
      setHistory(records);
      if (records.length > 0 && !historySelectedId) {
        setHistorySelectedId(records[0].id);
      }
    } catch (e) {
      setError(toErrorMessage(e));
    } finally {
      setBusyAction(null);
    }
  }

  async function refreshVaultUsage() {
    setVaultUsageBusy(true);
    setVaultUsageError(null);
    try {
      if (!isTauri) {
        setVaultUsage(WEB_DEMO_VAULT_USAGE);
        return;
      }
      const usage = await api.vaultUsage(vaultUsageLimit);
      setVaultUsage(usage);
    } catch (e) {
      setVaultUsage(null);
      setVaultUsageError(toErrorMessage(e));
    } finally {
      setVaultUsageBusy(false);
    }
  }

  async function loadSessionPreview(rolloutPath: string) {
    setSessionPreviewBusy(true);
    setSessionPreviewError(null);
    try {
      if (!isTauri) {
        setSessionPreview({ ...WEB_DEMO_PREVIEW, source: rolloutPath });
        return;
      }
      const p = await api.previewRollout({
        path: rolloutPath,
        max_messages: previewMaxMessages,
        max_chars_per_message: previewMaxCharsPerMessage,
        include_meta: previewIncludeMeta,
      });
      setSessionPreview(p);
    } catch (e) {
      setSessionPreview(null);
      setSessionPreviewError(toErrorMessage(e));
    } finally {
      setSessionPreviewBusy(false);
    }
  }

  async function loadBundlePreview(bundlePath: string) {
    setBundlePreviewBusy(true);
    setBundlePreviewError(null);
    try {
      if (!isTauri) {
        setBundlePreview({
          ...WEB_DEMO_PREVIEW,
          kind: "bundle",
          source: bundlePath,
        });
        return;
      }
      const p = await api.previewBundle({
        bundle_path: bundlePath,
        max_messages: previewMaxMessages,
        max_chars_per_message: previewMaxCharsPerMessage,
        include_meta: previewIncludeMeta,
      });
      setBundlePreview(p);
    } catch (e) {
      setBundlePreview(null);
      setBundlePreviewError(toErrorMessage(e));
    } finally {
      setBundlePreviewBusy(false);
    }
  }

  async function loadLocalExistingPreview(rolloutPath: string) {
    setLocalExistingPreviewBusy(true);
    setLocalExistingPreviewError(null);
    try {
      if (!isTauri) {
        setLocalExistingPreview({ ...WEB_DEMO_PREVIEW, source: rolloutPath });
        return;
      }
      const p = await api.previewRollout({
        path: rolloutPath,
        max_messages: previewMaxMessages,
        max_chars_per_message: previewMaxCharsPerMessage,
        include_meta: previewIncludeMeta,
      });
      setLocalExistingPreview(p);
    } catch (e) {
      setLocalExistingPreview(null);
      setLocalExistingPreviewError(toErrorMessage(e));
    } finally {
      setLocalExistingPreviewBusy(false);
    }
  }

  async function loadHistoryPreview(record: TransferRecord) {
    setHistoryPreviewBusy(true);
    setHistoryPreviewError(null);
    try {
      if (!isTauri) {
        setHistoryPreview({
          ...WEB_DEMO_PREVIEW,
          kind: "history",
          source: record.vault_dir,
        });
        return;
      }
      if (record.vault_rollout_rel_path) {
        const p = await join(record.vault_dir, record.vault_rollout_rel_path);
        const r = await api.previewRollout({
          path: p,
          max_messages: previewMaxMessages,
          max_chars_per_message: previewMaxCharsPerMessage,
          include_meta: previewIncludeMeta,
        });
        setHistoryPreview(r);
        return;
      }

      if (record.bundle_path) {
        const r = await api.previewBundle({
          bundle_path: record.bundle_path,
          max_messages: previewMaxMessages,
          max_chars_per_message: previewMaxCharsPerMessage,
          include_meta: previewIncludeMeta,
        });
        setHistoryPreview(r);
        return;
      }

      if (record.local_rollout_path) {
        const r = await api.previewRollout({
          path: record.local_rollout_path,
          max_messages: previewMaxMessages,
          max_chars_per_message: previewMaxCharsPerMessage,
          include_meta: previewIncludeMeta,
        });
        setHistoryPreview(r);
        return;
      }

      setHistoryPreview(null);
      setHistoryPreviewError("缺少可预览的文件路径。");
    } catch (e) {
      setHistoryPreview(null);
      setHistoryPreviewError(toErrorMessage(e));
    } finally {
      setHistoryPreviewBusy(false);
    }
  }

  useEffect(() => {
    refreshStatusAndSessions();
  }, []);

  useEffect(() => {
    let unlisten: null | (() => void) = null;
    (async () => {
      try {
        unlisten = await getCurrentWindow().onDragDropEvent((event) => {
          const payload = event.payload as {
            type: string;
            paths?: string[];
          };
          if (payload.type === "enter") {
            setDragActive(true);
            setDragPaths(payload.paths ?? []);
            return;
          }
          if (payload.type === "over") {
            setDragActive(true);
            return;
          }
          if (payload.type === "leave") {
            setDragActive(false);
            setDragPaths([]);
            return;
          }
          if (payload.type === "drop") {
            setDragActive(false);
            setDragPaths([]);
            void handleDroppedPaths(payload.paths ?? []);
          }
        });
      } catch {
        // Drag & drop is non-critical.
      }
    })();
    return () => {
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (tab === "history") {
      refreshHistory();
    }
  }, [tab]);

  useEffect(() => {
    if (tab !== "settings") return;
    if (vaultUsage || vaultUsageBusy) return;
    void refreshVaultUsage();
  }, [tab]);

  useEffect(() => {
    setCodexHomeOverrideInput(status?.codex_home.override_home ?? "");
  }, [status?.codex_home.override_home]);

  useEffect(() => {
    if (tab === "export" && !exportSessionId) {
      const ids = selectedSessionIds.size
        ? Array.from(selectedSessionIds)
        : selectedSessionId
          ? [selectedSessionId]
          : [];
      if (ids.length) setExportSessionId(ids.join("\n"));
    }
    if (tab === "change_id" && !changeIdSessionId && selectedSessionId) {
      setChangeIdSessionId(selectedSessionId);
    }
  }, [tab, selectedSessionId, selectedSessionIds, exportSessionId, changeIdSessionId]);

  const filteredSessions = useMemo(() => {
    const q = sessionsFilter.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) => {
      return (
        s.id.toLowerCase().includes(q) ||
        (s.cwd ?? "").toLowerCase().includes(q)
      );
    });
  }, [sessions, sessionsFilter]);

  const filteredSessionsSelection = useMemo(() => {
    if (filteredSessions.length === 0) {
      return { all: false, some: false, selectedCount: 0 };
    }
    let selectedCount = 0;
    for (const s of filteredSessions) {
      if (selectedSessionIds.has(s.id)) selectedCount += 1;
    }
    const all = selectedCount > 0 && selectedCount === filteredSessions.length;
    const some = selectedCount > 0 && selectedCount < filteredSessions.length;
    return { all, some, selectedCount };
  }, [filteredSessions, selectedSessionIds]);

  useEffect(() => {
    if (!selectAllSessionsRef.current) return;
    selectAllSessionsRef.current.indeterminate =
      filteredSessionsSelection.some && !filteredSessionsSelection.all;
  }, [filteredSessionsSelection.some, filteredSessionsSelection.all]);

  const selectedSession = useMemo(
    () => sessions.find((s) => s.id === selectedSessionId) ?? null,
    [sessions, selectedSessionId],
  );

  useEffect(() => {
    setSelectedSessionIds((prev) => {
      if (prev.size === 0) return prev;
      const valid = new Set(sessions.map((s) => s.id));
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (valid.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [sessions]);

  useEffect(() => {
    setHistorySelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const valid = new Set(history.map((r) => r.id));
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (valid.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [history]);

  const exportSessionIds = useMemo(
    () => parseSessionIdList(exportSessionId),
    [exportSessionId],
  );

  const selectedHistory = useMemo(
    () => history.find((r) => r.id === historySelectedId) ?? null,
    [history, historySelectedId],
  );

  useEffect(() => {
    setHistoryEditError(null);
    if (!selectedHistory) return;
    setHistoryEditName(selectedHistory.name ?? "");
    setHistoryEditNote(selectedHistory.note ?? "");
    setHistoryEditTags(selectedHistory.tags ?? "");
    setHistoryEditFavorite(Boolean(selectedHistory.favorite));
  }, [selectedHistory?.id]);

  const filteredHistory = useMemo(() => {
    const q = historyFilter.trim().toLowerCase();
    return history.filter((r) => {
      if (historyFavoritesOnly && !r.favorite) return false;
      if (historyOpFilter !== "all" && r.op !== historyOpFilter) return false;
      if (!q) return true;
      const sid =
        r.effective_session_id ?? r.session_id_new ?? r.session_id_old ?? "";
      const hay = [
        r.id,
        r.created_at,
        r.updated_at ?? "",
        r.op,
        opZh(r.op),
        statusZh(r.status),
        r.name,
        r.note ?? "",
        r.tags ?? "",
        sid,
        r.rollout_sha256 ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [history, historyFilter, historyFavoritesOnly, historyOpFilter]);

  const filteredHistorySelection = useMemo(() => {
    if (filteredHistory.length === 0) {
      return { all: false, some: false, selectedCount: 0 };
    }
    let selectedCount = 0;
    for (const r of filteredHistory) {
      if (historySelectedIds.has(r.id)) selectedCount += 1;
    }
    const all = selectedCount > 0 && selectedCount === filteredHistory.length;
    const some = selectedCount > 0 && selectedCount < filteredHistory.length;
    return { all, some, selectedCount };
  }, [filteredHistory, historySelectedIds]);

  useEffect(() => {
    if (!selectAllHistoryRef.current) return;
    selectAllHistoryRef.current.indeterminate =
      filteredHistorySelection.some && !filteredHistorySelection.all;
  }, [filteredHistorySelection.some, filteredHistorySelection.all]);

  useEffect(() => {
    if (tab !== "history") return;
    if (filteredHistory.length === 0) return;
    if (!historySelectedId || !filteredHistory.some((r) => r.id === historySelectedId)) {
      setHistorySelectedId(filteredHistory[0].id);
    }
  }, [tab, filteredHistory, historySelectedId]);

  useEffect(() => {
    setSessionPreview(null);
    setSessionPreviewError(null);
    if (!sessionsDetailOpen) return;
    if (!selectedSession?.rollout_path) return;
    void loadSessionPreview(selectedSession.rollout_path);
  }, [
    sessionsDetailOpen,
    previewMaxMessages,
    previewMaxCharsPerMessage,
    selectedSession?.rollout_path,
  ]);

  useEffect(() => {
    setBundlePreview(null);
    setBundlePreviewError(null);
    if (!bundlePreviewOpen) return;
    if (!inspectResult) return;
    void loadBundlePreview(inspectResult.bundle_path);
  }, [
    bundlePreviewOpen,
    previewMaxMessages,
    previewMaxCharsPerMessage,
    inspectResult?.bundle_path,
  ]);

  useEffect(() => {
    setLocalExistingPreview(null);
    setLocalExistingPreviewError(null);
    if (!localExistingPreviewOpen) return;
    const p = inspectResult?.local_existing?.rollout_path;
    if (!p) return;
    void loadLocalExistingPreview(p);
  }, [
    localExistingPreviewOpen,
    previewMaxMessages,
    previewMaxCharsPerMessage,
    inspectResult?.local_existing?.rollout_path,
  ]);

  useEffect(() => {
    setHistoryPreview(null);
    setHistoryPreviewError(null);
    if (tab !== "history") return;
    if (!historyDetailOpen) return;
    if (!historyPreviewOpen) return;
    if (!selectedHistory) return;
    void loadHistoryPreview(selectedHistory);
  }, [
    tab,
    historyDetailOpen,
    historyPreviewOpen,
    previewMaxMessages,
    previewMaxCharsPerMessage,
    selectedHistory?.id,
  ]);

  const inspectHasConflict = useMemo(() => {
    if (!inspectResult?.local_existing) return false;
    return inspectResult.local_existing.sha256 !== inspectResult.manifest.rollout.sha256;
  }, [inspectResult]);

  async function inspectImportBundleFromPath(path: string) {
    setError(null);
    setImportBatchResult(null);
    setInspectResult(null);
    setImportPickInfo(null);
    setBusyAction("inspect");
    try {
      if (!isTauri) {
        setError("网页预览模式不支持导入检查，请在桌面版（Tauri）中使用。");
        return;
      }
      const inspected = await api.inspectBundle(path);
      setInspectResult(inspected);
      setImportName(`导入：${inspected.manifest.name}`);
      setImportNote(inspected.manifest.note ?? "");

      const hasConflict =
        !!inspected.local_existing &&
        inspected.local_existing.sha256 !== inspected.manifest.rollout.sha256;
      setImportStrategy(hasConflict ? "import_as_new" : "overwrite");
    } catch (e) {
      // 合并包（外层 zip）不一定包含 manifest.json/rollout.jsonl，检查会失败；
      // 这种情况下用户仍可以直接“导入”。
      setInspectResult(null);
      setImportPickInfo(
        `检查失败：${toErrorMessage(e)}\n提示：如果这是合并导出包，可以直接点击“导入”批量导入。`,
      );
    } finally {
      setBusyAction(null);
    }
  }

  async function handlePickImportBundles() {
    try {
      if (!isTauri) {
        setError("网页预览模式不支持选择文件，请在桌面版（Tauri）中使用。");
        return;
      }
      const selected = await open({
        title: "选择 zip（可多选）",
        multiple: true,
        filters: [{ name: "导出包 (zip)", extensions: ["zip"] }],
      });
      const paths = Array.isArray(selected)
        ? selected
        : selected
          ? [selected]
          : [];
      if (!paths.length) return;
      setError(null);
      setImportPickInfo(`已选择 ${paths.length} 个 zip。`);
      setImportBatchResult(null);
      setInspectResult(null);
      setImportBundlePaths(paths);
      // Best-effort inspect when selecting a single file.
      if (paths.length === 1) {
        await inspectImportBundleFromPath(paths[0]);
      }
    } catch (e) {
      setError(toErrorMessage(e));
    }
  }

  async function handlePickExportSessionIdsFile() {
    setError(null);
    setExportIdsExtractInfo(null);
    try {
      if (!isTauri) {
        setError("网页预览模式不支持选择文件，请在桌面版（Tauri）中使用。");
        return;
      }
      const selected = await open({
        title: "选择文本文件（.md / .txt）",
        multiple: false,
        filters: [{ name: "文本文件 (md/txt)", extensions: ["md", "txt"] }],
      });
      const path = Array.isArray(selected) ? selected[0] : selected;
      if (!path) return;

      setExportIdsExtractBusy(true);
      const r = await api.extractSessionIdsFromFile({
        path,
        max_bytes: 16 * 1024 * 1024,
      });
      setExportSessionId(r.ids.join("\n"));
      if (r.ids.length === 0) {
        setExportIdsExtractInfo("未在文件中识别到会话ID。");
      } else if (r.truncated) {
        setExportIdsExtractInfo(
          `已提取 ${r.ids.length} 个会话ID（文件较大，仅扫描前 ${formatBytes(r.scanned_bytes)}）。`,
        );
      } else {
        setExportIdsExtractInfo(
          `已从文件提取 ${r.ids.length} 个会话ID（扫描 ${formatBytes(r.scanned_bytes)}）。`,
        );
      }
    } catch (e) {
      setError(toErrorMessage(e));
    } finally {
      setExportIdsExtractBusy(false);
    }
  }

  async function handleDroppedPaths(paths: string[]) {
    if (!isTauri) {
      setError("网页预览模式不支持拖拽导入，请在桌面版（Tauri）中使用。");
      return;
    }
    const zips = paths.filter((p) => p.toLowerCase().endsWith(".zip"));
    if (!zips.length) {
      setError("只支持拖入 zip 文件。");
      return;
    }
    if (busyRef.current) {
      setError("当前有任务正在进行中，请稍后再试。");
      return;
    }
    setTab("import");
    setError(null);
    setImportPickInfo(`已选择 ${zips.length} 个 zip。`);
    setImportBatchResult(null);
    setInspectResult(null);
    setImportBundlePaths(zips);
    if (zips.length === 1) {
      await inspectImportBundleFromPath(zips[0]);
    }
  }

  async function handleExport() {
    setError(null);
    setExportBatchResult(null);
    setBusyAction("export");
    try {
      if (!isTauri) {
        setError("网页预览模式不支持导出，请在桌面版（Tauri）中使用。");
        return;
      }
      const ids = parseSessionIdList(exportSessionId);
      if (ids.length === 0) {
        setError("会话ID为必填项。");
        return;
      }
      const baseName = exportName.trim();
      if (!baseName) {
        setError("名称为必填项。");
        return;
      }
      const note = exportNote.trim() ? exportNote.trim() : null;
      const r = await api.exportSessions({
        session_ids: ids,
        name: baseName,
        note,
        include_shell_snapshot: exportIncludeShell,
        mode: exportMode,
      });
      setExportBatchResult(r);
      if (r.items.length) {
        await refreshHistory();
      }
      if (r.errors.length) {
        setError(`部分导出失败：${r.errors.length}/${ids.length}（详见导出结果）。`);
      }
    } catch (e) {
      setError(toErrorMessage(e));
    } finally {
      setBusyAction(null);
    }
  }

  async function handleImport() {
    setError(null);
    setImportBatchResult(null);
    setBusyAction("import");
    try {
      if (!isTauri) {
        setError("网页预览模式不支持导入，请在桌面版（Tauri）中使用。");
        return;
      }
      if (importBundlePaths.length === 0) {
        setError("请选择至少一个 zip 文件。");
        return;
      }
      if (!importName.trim()) {
        setError("名称为必填项。");
        return;
      }
      const r = await api.importBundles({
        bundle_paths: importBundlePaths,
        name: importName.trim(),
        note: importNote.trim() ? importNote.trim() : null,
        strategy: importStrategy,
      });
      setImportBatchResult(r);
      await refreshStatusAndSessions();
      await refreshHistory();
      if (r.failed) {
        setError(`部分导入失败：${r.failed}（详见导入结果）。`);
      }
    } catch (e) {
      setError(toErrorMessage(e));
    } finally {
      setBusyAction(null);
    }
  }

  async function handleChangeId() {
    setError(null);
    setChangeIdResult(null);
    setBusyAction("change_id");
    try {
      if (!isTauri) {
        setError("网页预览模式不支持更换会话ID，请在桌面版（Tauri）中使用。");
        return;
      }
      const r = await api.changeSessionId({
        session_id: changeIdSessionId.trim(),
        name: changeIdName.trim(),
        note: changeIdNote.trim() ? changeIdNote.trim() : null,
        new_session_id: changeIdNewId.trim() ? changeIdNewId.trim() : null,
      });
      setChangeIdResult(r);
      await refreshStatusAndSessions();
      await refreshHistory();
    } catch (e) {
      setError(toErrorMessage(e));
    } finally {
      setBusyAction(null);
    }
  }

  async function handleApplyCodexHomeOverride() {
    setError(null);
    setBusyAction("settings");
    try {
      if (!isTauri) {
        setError("网页预览模式不支持设置 CODEX_HOME，请在桌面版（Tauri）中使用。");
        return;
      }
      const next = await api.setCodexHomeOverride(
        codexHomeOverrideInput.trim() ? codexHomeOverrideInput.trim() : null,
      );
      setStatus(next);
      const list = await api.listSessions();
      setSessions(list);
    } catch (e) {
      setError(toErrorMessage(e));
    } finally {
      setBusyAction(null);
    }
  }

  async function handleBrowseCodexHomeOverride() {
    setError(null);
    try {
      if (!isTauri) {
        setError("网页预览模式不支持选择目录，请在桌面版（Tauri）中使用。");
        return;
      }
      const selected = await open({
        title: "选择 CODEX_HOME 目录",
        directory: true,
        multiple: false,
      });
      const dir = Array.isArray(selected) ? selected[0] : selected;
      if (!dir) return;
      setCodexHomeOverrideInput(dir);
    } catch (e) {
      setError(toErrorMessage(e));
    }
  }

  async function handleHistoryDelete(recordId: string) {
    if (!isTauri) {
      setError("网页预览模式不支持删除历史记录，请在桌面版（Tauri）中使用。");
      return;
    }
    const ok = window.confirm(
      historyDeleteFiles
        ? "删除这条记录并同时删除存档库文件？此操作不可撤销。"
        : "仅删除这条记录（保留存档库文件）？",
    );
    if (!ok) return;

    setError(null);
    setBusyAction("delete");
    try {
      await api.historyDelete(recordId, historyDeleteFiles);
      setHistorySelectedId("");
      await refreshHistory();
    } catch (e) {
      setError(toErrorMessage(e));
    } finally {
      setBusyAction(null);
    }
  }

  async function handleHistoryDeleteSelected() {
    if (!isTauri) {
      setError("网页预览模式不支持删除历史记录，请在桌面版（Tauri）中使用。");
      return;
    }
    const ids = Array.from(historySelectedIds);
    if (ids.length === 0) {
      setError("请先在左侧历史列表中勾选要删除的记录。");
      return;
    }
    const ok = window.confirm(
      historyDeleteFiles
        ? `删除选中 ${ids.length} 条记录并同时删除存档库文件？此操作不可撤销。`
        : `仅删除选中 ${ids.length} 条记录（保留存档库文件）？`,
    );
    if (!ok) return;

    setError(null);
    setBusyAction("delete_many");
    try {
      const r = await api.historyDeleteMany(ids, historyDeleteFiles);
      setHistorySelectedId("");
      setHistorySelectedIds(new Set());
      await refreshHistory();
      if (r.failed) {
        const max = 5;
        const detail = r.errors
          .slice(0, max)
          .map((it) => `${it.id}: ${it.message}`)
          .join("\n");
        setError(
          `批量删除部分失败：已删除 ${r.deleted}/${r.requested}。\n失败详情（前 ${Math.min(
            max,
            r.errors.length,
          )} 条）：\n${detail}`,
        );
      }
    } catch (e) {
      setError(toErrorMessage(e));
    } finally {
      setBusyAction(null);
    }
  }

  function resetHistoryEditFields() {
    setHistoryEditError(null);
    if (!selectedHistory) return;
    setHistoryEditName(selectedHistory.name ?? "");
    setHistoryEditNote(selectedHistory.note ?? "");
    setHistoryEditTags(selectedHistory.tags ?? "");
    setHistoryEditFavorite(Boolean(selectedHistory.favorite));
  }

  async function handleHistorySaveMeta(recordId: string) {
    setHistoryEditError(null);
    setHistoryEditBusy(true);
    try {
      if (!isTauri) {
        setHistoryEditError("网页预览模式不支持保存元信息，请在桌面版（Tauri）中使用。");
        return;
      }
      const params: HistoryUpdateParams = {
        id: recordId,
        name: historyEditName.trim(),
        note: historyEditNote.trim() ? historyEditNote.trim() : null,
        tags: normalizeTagsInput(historyEditTags),
        favorite: historyEditFavorite,
      };
      const updated = await api.historyUpdate(params);
      setHistory((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
      // Sync the edit inputs to what the DB actually saved.
      setHistoryEditName(updated.name ?? "");
      setHistoryEditNote(updated.note ?? "");
      setHistoryEditTags(updated.tags ?? "");
      setHistoryEditFavorite(Boolean(updated.favorite));
    } catch (e) {
      setHistoryEditError(toErrorMessage(e));
    } finally {
      setHistoryEditBusy(false);
    }
  }

  async function handleRestoreFromHistory(recordId: string) {
    setError(null);
    setRestoreResult(null);
    setBusyAction("restore");
    try {
      if (!isTauri) {
        setError("网页预览模式不支持恢复，请在桌面版（Tauri）中使用。");
        return;
      }
      const r = await api.restoreFromHistory({
        record_id: recordId,
        name: restoreName.trim(),
        note: restoreNote.trim() ? restoreNote.trim() : null,
        strategy: restoreStrategy,
      });
      setRestoreResult(r);
      await refreshStatusAndSessions();
      await refreshHistory();
    } catch (e) {
      setError(toErrorMessage(e));
    } finally {
      setBusyAction(null);
    }
  }

  async function handleReveal(path: string) {
    setError(null);
    try {
      if (!isTauri) {
        setError("网页预览模式不支持打开本地路径，请在桌面版（Tauri）中使用。");
        return;
      }
      await revealItemInDir(path);
    } catch (e) {
      setError(toErrorMessage(e));
    }
  }

  async function handleOpen(path: string) {
    setError(null);
    try {
      if (!isTauri) {
        setError("网页预览模式不支持打开本地路径，请在桌面版（Tauri）中使用。");
        return;
      }
      await openPath(path);
    } catch (e) {
      setError(toErrorMessage(e));
    }
  }

  async function handleCopy(text: string) {
    setError(null);
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      setError(`复制到剪贴板失败：${toErrorMessage(e)}`);
    }
  }

  function jumpToHistoryRecord(recordId: string, recordName?: string) {
    setHistoryFilter("");
    setHistoryFavoritesOnly(false);
    setHistoryOpFilter("all");
    setHistorySelectedId(recordId);
    if (recordName) {
      setRestoreName(`恢复：${recordName}`);
      setRestoreNote("");
      setRestoreStrategy("recommended");
      setRestoreResult(null);
    }
    setTab("history");
  }

  function codexHomeSourceLabel(source?: string | null): string {
    switch (source) {
      case "override":
        return "覆盖";
      case "env":
        return "环境变量";
      case "default":
        return "默认";
      default:
        return source ?? "-";
    }
  }

  return (
    <main className="container">
      <header className="header">
        <div>
          <h1>CodexRelay</h1>
          <div className="muted">
            {status ? (
              <>
                <span>
                  {status.product_name} {status.version}
                </span>
                <span className="dot">•</span>
                <span>
                  CODEX_HOME：
                  <span className="mono">{status.codex_home.effective_home}</span>{" "}
                  <span className="pill">
                    {codexHomeSourceLabel(status.codex_home.source)}
                  </span>
                </span>
              </>
            ) : (
              <span>加载中...</span>
            )}
          </div>
        </div>
        <div className="actions">
          <button
            onClick={refreshStatusAndSessions}
            disabled={busy}
            type="button"
          >
            {busyAction === "refresh" ? "刷新中..." : "刷新"}
          </button>
        </div>
      </header>

      <nav className="tabs">
        <button
          type="button"
          className={tab === "sessions" ? "tab active" : "tab"}
          onClick={() => setTab("sessions")}
        >
          会话
        </button>
        <button
          type="button"
          className={tab === "export" ? "tab active" : "tab"}
          onClick={() => setTab("export")}
        >
          导出
        </button>
        <button
          type="button"
          className={tab === "import" ? "tab active" : "tab"}
          onClick={() => setTab("import")}
        >
          导入
        </button>
        <button
          type="button"
          className={tab === "change_id" ? "tab active" : "tab"}
          onClick={() => setTab("change_id")}
        >
          更换会话ID
        </button>
        <button
          type="button"
          className={tab === "history" ? "tab active" : "tab"}
          onClick={() => setTab("history")}
        >
          历史
        </button>
        <button
          type="button"
          className={tab === "settings" ? "tab active" : "tab"}
          onClick={() => setTab("settings")}
        >
          设置
        </button>
      </nav>

      {error ? <div className="error">错误：{error}</div> : null}
      {!isTauri ? (
        <div className="previewWarn">
          网页预览模式：用于查看界面排版/中文文案，不会读取本地{" "}
          <code>CODEX_HOME</code>；导入/导出/恢复等功能请使用桌面版（Tauri）。
        </div>
      ) : null}

      {tab === "sessions" ? (
        <section className="panel">
	          <div className="panelHeader">
	            <h2>会话列表</h2>
	            <div className="row">
	              <input
	                value={sessionsFilter}
	                onChange={(e) => setSessionsFilter(e.target.value)}
	                placeholder="搜索 会话ID / 工作目录..."
	                className="grow"
	              />
	              <button
	                type="button"
	                  className="sideToggleBtn"
                  data-open={sessionsDetailOpen ? "1" : "0"}
	                  title={sessionsDetailOpen ? "折叠右侧面板" : "展开右侧面板"}
	                  aria-label={sessionsDetailOpen ? "折叠右侧面板" : "展开右侧面板"}
		                onClick={() => {
		                  const next = !sessionsDetailOpen;
		                  setSessionsDetailOpen(next);
		                  if (!next) {
		                    setSessionPreview(null);
		                    setSessionPreviewError(null);
		                  }
		                }}
	              >
	                <span className="sideChevron" aria-hidden="true" />
	              </button>
	            </div>
	          </div>

          {sessions.length === 0 ? (
            <div className="muted">
              {busyAction === "refresh" ? (
                "加载中..."
              ) : (
                <>
                  在 <code>CODEX_HOME/sessions</code> 下未找到会话。
                </>
              )}
            </div>
          ) : filteredSessions.length === 0 ? (
            <div className="muted">没有匹配会话。</div>
	          ) : (
	            <div className={sessionsDetailOpen ? "split" : "split splitCollapsed"}>
	              <div className="splitList">
	                <div className="tableWrap">
	                  <table className="table clickable">
		                    <thead>
		                      <tr>
		                        <th className="nowrap">
		                          <input
		                            ref={selectAllSessionsRef}
		                            type="checkbox"
		                            checked={filteredSessionsSelection.all}
		                            onChange={(e) => {
		                              const checked = e.target.checked;
		                              setSelectedSessionIds((prev) => {
		                                const next = new Set(prev);
		                                for (const s of filteredSessions) {
		                                  if (checked) next.add(s.id);
		                                  else next.delete(s.id);
		                                }
		                                return next;
		                              });
		                            }}
		                          />
		                        </th>
		                        <th>文件更新时间</th>
		                        <th>会话ID</th>
		                        <th>最后事件时间</th>
		                        <th>大小</th>
	                        <th>同步</th>
	                        <th>工作目录</th>
	                        <th>CLI</th>
	                        <th>模型提供方</th>
	                      </tr>
	                    </thead>
	                    <tbody>
		                      {filteredSessions.map((s) => {
		                        const selected = s.id === selectedSessionId;
		                        const checked = selectedSessionIds.has(s.id);
		                        const last = latestTransferBySessionId[s.id];
	                        const lastOpLabel = last ? opZh(last.op) : "-";
	                        const lastAtLabel = last ? formatRfc3339(last.created_at) : "-";
	                        const lastAtMs = last ? Date.parse(last.created_at) : NaN;
	                        const sizeChanged =
	                          last?.rollout_size != null &&
	                          s.file_size != null &&
	                          last.rollout_size !== s.file_size;
	                        const mtimeChanged =
	                          Number.isFinite(lastAtMs) &&
	                          s.mtime_ms != null &&
	                          s.mtime_ms > lastAtMs + 2000;
	                        const changed = Boolean(last) && (sizeChanged || mtimeChanged);
		                        return (
		                          <tr
		                            key={s.rollout_path}
		                            className={selected ? "selectedRow" : undefined}
		                            onClick={() => setSelectedSessionId(s.id)}
		                          >
		                            <td className="nowrap">
		                              <input
		                                type="checkbox"
		                                checked={checked}
		                                onClick={(e) => e.stopPropagation()}
		                                onChange={(e) => {
		                                  const nextChecked = e.target.checked;
		                                  setSelectedSessionIds((prev) => {
		                                    const next = new Set(prev);
		                                    if (nextChecked) next.add(s.id);
		                                    else next.delete(s.id);
		                                    return next;
		                                  });
		                                }}
		                              />
		                            </td>
		                            <td className="nowrap">{formatTimeMs(s.mtime_ms)}</td>
		                            <td className="mono small nowrap" title={s.id}>
		                              {s.id}
	                            </td>
	                            <td className="nowrap">
	                              {formatRfc3339(s.last_event_timestamp)}
	                            </td>
	                            <td className="nowrap">{formatBytes(s.file_size)}</td>
	                            <td className="nowrap">
	                              {last ? (
	                                <span
	                                  className={changed ? "pill warn" : "pill ok"}
	                                  title={`最近记录：${lastOpLabel} @ ${lastAtLabel}`}
	                                >
	                                  {changed ? "已变化" : "未变化"}
	                                </span>
	                              ) : (
	                                <span className="pill" title="没有找到历史记录">
	                                  未纳管
	                                </span>
	                              )}
	                            </td>
	                            <td className="truncate" title={s.cwd ?? ""}>
	                              {s.cwd ?? "-"}
	                            </td>
	                            <td className="nowrap">{s.cli_version ?? "-"}</td>
	                            <td className="nowrap">{s.model_provider ?? "-"}</td>
	                          </tr>
	                        );
	                      })}
                    </tbody>
                  </table>
                </div>

	                <div className="panelFooter">
	                  <div className="muted">
	                    当前：{" "}
	                    <span className="mono">{selectedSessionId ? selectedSessionId : "-"}</span>
	                    <span className="dot">•</span>
	                    勾选： <span className="mono">{selectedSessionIds.size}</span>
	                    {selectedSessionId ? (
	                      <>
	                        <span className="dot">•</span>
	                        <span className="mono">codex resume {selectedSessionId}</span>
	                      </>
	                    ) : null}
	                  </div>
                  <div className="row">
                    <button
                      type="button"
                      disabled={!selectedSessionId}
                      onClick={() => handleCopy(`codex resume ${selectedSessionId}`)}
                    >
                      复制恢复命令
                    </button>
                    <button
                      type="button"
                      disabled={!isTauri || !selectedSession?.rollout_path}
                      onClick={() =>
                        selectedSession?.rollout_path
                          ? handleReveal(selectedSession.rollout_path)
                          : null
                      }
                    >
                      显示会话文件
                    </button>
	                    <button
	                      type="button"
	                      disabled={!selectedSessionId && selectedSessionIds.size === 0}
	                      onClick={() => {
	                        const ids = selectedSessionIds.size
	                          ? Array.from(selectedSessionIds)
	                          : selectedSessionId
	                            ? [selectedSessionId]
	                            : [];
	                        setExportSessionId(ids.join("\n"));
	                        setTab("export");
	                      }}
	                    >
	                      导出选中会话
	                    </button>
                    <button
                      type="button"
                      disabled={!selectedSessionId}
                      onClick={() => setTab("change_id")}
                    >
                      更换会话ID
                    </button>
                  </div>
                </div>
              </div>

	              {sessionsDetailOpen ? (
	                <div className="splitDetail">
	                <div className="row sectionHeader">
	                  <h3 className="grow">预览（最近消息）</h3>
	                </div>
	                {selectedSession ? (
	                  <>
	                    <div className="row">
	                      <button
	                        type="button"
	                        disabled={sessionPreviewBusy}
	                        onClick={() => loadSessionPreview(selectedSession.rollout_path)}
	                      >
	                        {sessionPreviewBusy ? "预览中..." : "刷新预览"}
	                      </button>
	                      <button
	                        type="button"
	                        disabled={
	                          sessionPreviewBusy ||
	                          previewMaxMessages >= PREVIEW_MAX_MESSAGES_CAP
	                        }
	                        onClick={() =>
	                          setPreviewMaxMessages((v) =>
	                            Math.min(PREVIEW_MAX_MESSAGES_CAP, v + PREVIEW_LOAD_MORE_STEP),
	                          )
	                        }
	                      >
	                        加载更多（+{PREVIEW_LOAD_MORE_STEP}）
	                      </button>
	                      <button
	                        type="button"
	                        disabled={
	                          sessionPreviewBusy ||
	                          previewMaxMessages === PREVIEW_MAX_MESSAGES_DEFAULT
	                        }
	                        onClick={() => setPreviewMaxMessages(PREVIEW_MAX_MESSAGES_DEFAULT)}
	                      >
	                        重置
	                      </button>
	                      <span className="muted small">
	                        当前显示最近 {previewMaxMessages} 条
	                      </span>
	                      <span
	                        className="mono small truncatePath"
	                        title={selectedSession.rollout_path}
	                      >
	                        {selectedSession.rollout_path}
	                      </span>
	                    </div>
	                    {sessionPreviewError ? (
	                      <div className="error">预览失败：{sessionPreviewError}</div>
	                    ) : null}
	                    {sessionPreview ? (
	                      <RolloutPreviewView
	                        preview={sessionPreview}
	                        renderMarkdown={previewRenderMarkdown}
	                      />
	                    ) : (
	                      <div className="muted small">
	                        自动预览最近 {previewMaxMessages} 条消息（从文件尾部扫描）。
	                      </div>
	                    )}
	                  </>
	                ) : (
	                  <div className="muted">请选择一个会话以查看预览。</div>
	                )}
	              </div>
	              ) : null}
	            </div>
	          )}
	        </section>
	      ) : null}

		      {tab === "export" ? (
		        <section className="panel">
			          <h2>导出</h2>
			          <div className="row">
			            <button
			              type="button"
			              disabled={selectedSessionIds.size === 0}
			              onClick={() =>
			                setExportSessionId(Array.from(selectedSessionIds).join("\n"))
			              }
			            >
			              从会话列表带入勾选（{selectedSessionIds.size}）
			            </button>
			            <button
			              type="button"
			              disabled={!isTauri || exportIdsExtractBusy}
			              onClick={handlePickExportSessionIdsFile}
			            >
			              {exportIdsExtractBusy ? "提取中..." : "从 md/txt 提取会话ID"}
			            </button>
			            <button
			              type="button"
			              disabled={exportSessionIds.length === 0}
			              onClick={() => {
			                setExportSessionId(exportSessionIds.join("\n"));
			                setExportIdsExtractInfo(
			                  `已清洗并提取 ${exportSessionIds.length} 个会话ID。`,
			                );
			              }}
			            >
			              清洗为ID列表
			            </button>
			            <span className="muted small">
			              已识别 {exportSessionIds.length} 个会话ID
			            </span>
			          </div>
			          {exportIdsExtractInfo ? (
			            <div className="previewWarn">{exportIdsExtractInfo}</div>
			          ) : null}
			          <div className="grid">
			            <label className="field">
			              <div className="label">会话ID（可多条，每行一个）</div>
			              <textarea
			                value={exportSessionId}
			                onChange={(e) => {
			                  setExportSessionId(e.target.value);
			                  setExportIdsExtractInfo(null);
			                }}
			                placeholder="例如：019bf3ba-8b3f-7ef1-b1f1-212573c83872\n也支持粘贴包含无关文字的文本：会自动识别其中的会话ID"
			                rows={4}
			              />
			              <div className="hint muted">
			                支持空格/逗号/换行分隔，或直接粘贴“带噪声文本”；将自动识别 UUID 样式会话ID并去重。
			                批量导出时会自动在名称后追加短ID。
			              </div>
			            </label>
		            <label className="field">
		              <div className="label">名称（必填）</div>
		              <input
	                value={exportName}
	                onChange={(e) => setExportName(e.target.value)}
	                placeholder="例如：mac->win 兼容修复"
	              />
	            </label>
	            <label className="field">
	              <div className="label">备注</div>
	              <input
	                value={exportNote}
	                onChange={(e) => setExportNote(e.target.value)}
	                placeholder="可选"
	              />
	            </label>
	            <label className="field">
	              <div className="label">导出包数量</div>
	              <select
	                value={exportMode}
	                onChange={(e) => setExportMode(e.target.value as ExportBundleMode)}
	                disabled={!isTauri}
	              >
	                <option value="merged">合并为一个 zip（默认，推荐）</option>
	                <option value="per_session">每个会话单独一个 zip</option>
	              </select>
	              <div className="hint muted">
	                默认导出到系统下载目录（Downloads）。
	              </div>
	            </label>
            <label className="field checkbox">
              <input
                type="checkbox"
                checked={exportIncludeShell}
                onChange={(e) => setExportIncludeShell(e.target.checked)}
                disabled={!isTauri}
	              />
	              <span>
	                打包 <code>shell_snapshot.sh</code>（可能包含环境变量/路径）
	              </span>
	            </label>
	          </div>
		          <div className="row">
		            <button
		              type="button"
		              disabled={
		                !isTauri || busy || exportSessionIds.length === 0 || !exportName.trim()
		              }
		              onClick={handleExport}
		            >
		              {busyAction === "export"
		                ? "导出中..."
		                : exportSessionIds.length > 1
		                  ? exportMode === "merged"
		                    ? "生成合并导出包"
		                    : "生成多个导出包"
		                  : "生成导出包"}
		            </button>
		          </div>
	
	          {exportBatchResult ? (
	            <div className="result">
	              <h3>导出结果</h3>
	              <div className="kv">
	                <div>输出目录</div>
	                <div className="mono">{exportBatchResult.export_dir}</div>
	                <div>模式</div>
	                <div>
	                  {exportBatchResult.mode === "merged"
	                    ? "合并为一个 zip"
	                    : "每个会话单独 zip"}
	                </div>
	                {exportBatchResult.merged_bundle_path ? (
	                  <>
	                    <div>导出包</div>
	                    <div className="mono">{exportBatchResult.merged_bundle_path}</div>
	                  </>
	                ) : null}
	              </div>
	              {exportBatchResult.merged_bundle_path ? (
	                <div className="row">
	                  <button
	                    type="button"
	                    onClick={() => handleReveal(exportBatchResult.merged_bundle_path!)}
	                  >
	                    显示导出包
	                  </button>
	                </div>
	              ) : null}
	              {exportBatchResult.errors.length ? (
	                <div className="error">
	                  <div>以下会话导出失败：</div>
	                  <pre className="mono small">
	                    {exportBatchResult.errors
	                      .map((e) => `${e.session_id}: ${e.message}`)
	                      .join("\n")}
	                  </pre>
	                </div>
	              ) : null}
	              {exportBatchResult.items.map((r) => (
	                <div className="resultBlock" key={r.transfer_id}>
	                  <div className="kv">
	                    <div>会话ID</div>
	                    <div className="mono">{r.session_id}</div>
	                    <div>导出包</div>
	                    <div className="mono">
	                      {r.exported_bundle_path ??
	                        (exportBatchResult.merged_bundle_path
	                          ? "（已合并到单个 zip）"
	                          : r.vault_bundle_path)}
	                    </div>
	                    <div>存档库</div>
	                    <div className="mono">{r.vault_dir}</div>
	                    <div>SHA256</div>
	                    <div className="mono">{r.manifest.rollout.sha256}</div>
	                    <div>恢复命令</div>
	                    <div className="mono">{r.resume_cmd}</div>
	                  </div>
	                  <div className="row">
	                    <button
	                      type="button"
	                      onClick={() =>
	                        handleReveal(
	                          r.exported_bundle_path ??
	                            exportBatchResult.merged_bundle_path ??
	                            r.vault_bundle_path,
	                        )
	                      }
	                    >
	                      显示导出包
	                    </button>
	                    <button
	                      type="button"
	                      onClick={() => handleCopy(r.resume_cmd)}
	                    >
	                      复制恢复命令
	                    </button>
	                    <button
	                      type="button"
	                      onClick={() => handleOpen(r.vault_dir)}
	                    >
	                      打开存档库
	                    </button>
	                  </div>
	                </div>
	              ))}
	            </div>
	          ) : null}
	        </section>
	      ) : null}

      {tab === "import" ? (
        <section className="panel">
          <h2>导入</h2>
	          <div className="row">
	            <button
	              type="button"
	              onClick={handlePickImportBundles}
	              disabled={!isTauri || busy}
	            >
	              {busyAction === "inspect" ? "检查中..." : "选择 zip（可多选）"}
	            </button>
	            {importBundlePaths.length ? (
	              <span
	                className="mono small truncatePath"
	                title={importBundlePaths.join("\n")}
	              >
	                {importBundlePaths.length === 1
	                  ? importBundlePaths[0]
	                  : `已选择 ${importBundlePaths.length} 个 zip`}
	              </span>
	            ) : null}
	          </div>
	          <div className="hint muted small">
	            {isTauri
	              ? "也可以直接把 zip 文件拖进窗口（支持多选/合并包）。"
	              : "提示：拖拽/选择文件仅桌面版（Tauri）可用。"}
	          </div>
	          {importPickInfo ? (
	            <div className="previewWarn">{importPickInfo}</div>
	          ) : null}

	          {inspectResult ? (
            <div className="result">
		              <h3>包信息</h3>
		              <div className="kv">
		                <div>名称</div>
		                <div>{inspectResult.manifest.name}</div>
		                <div>备注</div>
		                <div>{inspectResult.manifest.note ?? "-"}</div>
		                <div>会话ID</div>
		                <div className="mono">{inspectResult.manifest.session_id}</div>
		                <div>创建时间</div>
		                <div>{formatRfc3339(inspectResult.manifest.created_at)}</div>
		                <div>最后事件</div>
		                <div>{formatRfc3339(inspectResult.rollout_last_event_timestamp)}</div>
		                <div>工作目录</div>
		                <div className="truncate" title={inspectResult.manifest.codex.cwd ?? ""}>
		                  <span className="mono small">
		                    {inspectResult.manifest.codex.cwd ?? "-"}
		                  </span>
		                </div>
		                <div>CLI / 模型提供方</div>
		                <div>
		                  <span className="mono small">
		                    {inspectResult.manifest.codex.cli_version ?? "-"}
		                  </span>
		                  <span className="dot">•</span>
		                  <span className="mono small">
		                    {inspectResult.manifest.codex.model_provider ?? "-"}
		                  </span>
		                </div>
		                <div>SHA256</div>
		                <div className="mono">{inspectResult.manifest.rollout.sha256}</div>
		                <div>大小</div>
		                <div>{formatBytes(inspectResult.manifest.rollout.size)}</div>
		                <div>完整性</div>
	                <div>
	                  {inspectResult.sha256_ok ? (
	                    <span className="pill ok">校验通过</span>
	                  ) : (
	                    <span className="pill warn">校验失败</span>
		                  )}
		                </div>
		                <div>本机状态</div>
	                <div>
	                  {inspectResult.local_existing ? (
	                    <>
		                      <span className="mono">
		                        {shortSha(inspectResult.local_existing.sha256)}
	                      </span>
	                      {inspectHasConflict ? (
	                        <span className="pill warn">冲突</span>
	                      ) : (
	                        <span className="pill ok">相同</span>
	                      )}
	                    </>
		                  ) : (
		                    <span className="muted">未找到</span>
		                  )}
		                </div>
		                {inspectResult.local_existing ? (
		                  <>
		                    <div>本机更新时间</div>
		                    <div>{formatTimeMs(inspectResult.local_existing.mtime_ms)}</div>
		                    <div>本机最后事件</div>
		                    <div>{formatRfc3339(inspectResult.local_existing.last_event_timestamp)}</div>
		                    <div>本机工作目录</div>
		                    <div
		                      className="truncate"
		                      title={inspectResult.local_existing.cwd ?? ""}
	                    >
	                      <span className="mono small">
		                        {inspectResult.local_existing.cwd ?? "-"}
		                      </span>
		                    </div>
		                    <div>本机路径</div>
		                    <div
		                      className="truncate"
		                      title={inspectResult.local_existing.rollout_path}
	                    >
	                      <span className="mono small">
		                        {inspectResult.local_existing.rollout_path}
		                      </span>
		                    </div>
		                  </>
		                ) : null}
			              </div>

			              {inspectHasConflict ? (
			                <>
			                  <h3>冲突对比</h3>
			                  <div className="compare">
			                    <div className="compareCard">
			                      <h4>导入包版本</h4>
				                      <div className="kv">
				                        <div>创建时间</div>
				                        <div>{formatRfc3339(inspectResult.manifest.created_at)}</div>
				                        <div>最后事件</div>
				                        <div>{formatRfc3339(inspectResult.rollout_last_event_timestamp)}</div>
			                        <div>SHA256</div>
			                        <div className="mono">
			                          {shortSha(inspectResult.manifest.rollout.sha256)}
			                        </div>
				                        <div>大小</div>
				                        <div>{formatBytes(inspectResult.manifest.rollout.size)}</div>
				                      </div>
				                      <div className="row sectionHeader">
				                        <div className="grow muted small">
				                          预览（最近消息）
				                        </div>
				                        <button
				                          type="button"
				                          onClick={() => setBundlePreviewOpen((v) => !v)}
				                        >
				                          {bundlePreviewOpen ? "折叠预览" : "展开预览"}
				                        </button>
				                      </div>
				                      {bundlePreviewOpen ? (
				                        <>
					                          <div className="row">
					                            <button
					                              type="button"
					                              disabled={bundlePreviewBusy}
					                              onClick={() =>
					                                loadBundlePreview(inspectResult.bundle_path)
					                              }
					                            >
					                              {bundlePreviewBusy ? "预览中..." : "刷新预览"}
					                            </button>
					                            <button
					                              type="button"
					                              disabled={
					                                bundlePreviewBusy ||
					                                previewMaxMessages >= PREVIEW_MAX_MESSAGES_CAP
					                              }
					                              onClick={() =>
					                                setPreviewMaxMessages((v) =>
					                                  Math.min(
					                                    PREVIEW_MAX_MESSAGES_CAP,
					                                    v + PREVIEW_LOAD_MORE_STEP,
					                                  ),
					                                )
					                              }
					                            >
					                              加载更多（+{PREVIEW_LOAD_MORE_STEP}）
					                            </button>
					                            <button
					                              type="button"
					                              disabled={
					                                bundlePreviewBusy ||
					                                previewMaxMessages === PREVIEW_MAX_MESSAGES_DEFAULT
					                              }
					                              onClick={() =>
					                                setPreviewMaxMessages(PREVIEW_MAX_MESSAGES_DEFAULT)
					                              }
					                            >
					                              重置
					                            </button>
					                            <span className="muted small">
					                              当前显示最近 {previewMaxMessages} 条
					                            </span>
					                            <span className="hint muted">
					                              提示：zip 预览需要扫描整个文件，较大的会话可能会比较慢。
					                            </span>
					                          </div>
				                          {bundlePreviewError ? (
				                            <div className="error">
				                              预览失败：{bundlePreviewError}
				                            </div>
				                          ) : null}
				                          {bundlePreview ? (
				                            <RolloutPreviewView
				                              preview={bundlePreview}
				                              renderMarkdown={previewRenderMarkdown}
				                            />
				                          ) : bundlePreviewBusy ? (
				                            <div className="muted">预览加载中...</div>
				                          ) : (
				                            <div className="muted small">
				                              自动预览最近 {previewMaxMessages} 条消息。
				                            </div>
				                          )}
				                        </>
				                      ) : (
				                        <div className="muted small">
				                          已折叠：不会加载预览内容（点击“展开”加载）。
				                        </div>
				                      )}
				                    </div>

			                    <div className="compareCard">
			                      <h4>本机版本</h4>
			                      {inspectResult.local_existing ? (
			                        <>
			                          <div className="kv">
			                            <div>更新时间</div>
			                            <div>
			                              {formatTimeMs(
			                                inspectResult.local_existing.mtime_ms,
			                              )}
			                            </div>
			                            <div>最后事件</div>
			                            <div>
			                              {formatRfc3339(
			                                inspectResult.local_existing.last_event_timestamp,
			                              )}
			                            </div>
			                            <div>SHA256</div>
			                            <div className="mono">
			                              {shortSha(inspectResult.local_existing.sha256)}
			                            </div>
			                            <div>大小</div>
			                            <div>
			                              {formatBytes(inspectResult.local_existing.size)}
			                            </div>
				                          </div>
				                          <div className="row sectionHeader">
				                            <div className="grow muted small">
				                              预览（最近消息）
				                            </div>
				                            <button
				                              type="button"
				                              onClick={() =>
				                                setLocalExistingPreviewOpen((v) => !v)
				                              }
				                            >
				                              {localExistingPreviewOpen ? "折叠预览" : "展开预览"}
				                            </button>
				                          </div>
				                          {localExistingPreviewOpen ? (
				                            <>
					                              <div className="row">
					                                <button
					                                  type="button"
					                                  disabled={localExistingPreviewBusy}
					                                  onClick={() =>
					                                    loadLocalExistingPreview(
					                                      inspectResult.local_existing!.rollout_path,
					                                    )
					                                  }
					                                >
					                                  {localExistingPreviewBusy
					                                    ? "预览中..."
					                                    : "刷新预览"}
					                                </button>
					                                <button
					                                  type="button"
					                                  disabled={
					                                    localExistingPreviewBusy ||
					                                    previewMaxMessages >= PREVIEW_MAX_MESSAGES_CAP
					                                  }
					                                  onClick={() =>
					                                    setPreviewMaxMessages((v) =>
					                                      Math.min(
					                                        PREVIEW_MAX_MESSAGES_CAP,
					                                        v + PREVIEW_LOAD_MORE_STEP,
					                                      ),
					                                    )
					                                  }
					                                >
					                                  加载更多（+{PREVIEW_LOAD_MORE_STEP}）
					                                </button>
					                                <button
					                                  type="button"
					                                  disabled={
					                                    localExistingPreviewBusy ||
					                                    previewMaxMessages === PREVIEW_MAX_MESSAGES_DEFAULT
					                                  }
					                                  onClick={() =>
					                                    setPreviewMaxMessages(PREVIEW_MAX_MESSAGES_DEFAULT)
					                                  }
					                                >
					                                  重置
					                                </button>
					                                <span className="muted small">
					                                  当前显示最近 {previewMaxMessages} 条
					                                </span>
					                                <span
					                                  className="mono small truncatePath"
					                                  title={inspectResult.local_existing.rollout_path}
					                                >
					                                  {inspectResult.local_existing.rollout_path}
				                                </span>
				                              </div>
				                              {localExistingPreviewError ? (
				                                <div className="error">
				                                  预览失败：{localExistingPreviewError}
				                                </div>
				                              ) : null}
				                              {localExistingPreview ? (
				                                <RolloutPreviewView
				                                  preview={localExistingPreview}
				                                  renderMarkdown={previewRenderMarkdown}
				                                />
				                              ) : localExistingPreviewBusy ? (
				                                <div className="muted">预览加载中...</div>
				                              ) : (
				                                <div className="muted small">
				                                  自动预览最近 {previewMaxMessages} 条消息。
				                                </div>
				                              )}
				                            </>
				                          ) : (
				                            <div className="muted small">
				                              已折叠：不会加载预览内容（点击“展开”加载）。
				                            </div>
				                          )}
				                        </>
				                      ) : (
				                        <div className="muted">未找到本机版本。</div>
				                      )}
			                    </div>
			                  </div>

			                  <div className="hint muted">
			                    检测到同会话ID但内容不同：默认推荐
			                    <span className="mono"> 改ID导入</span>
			                    ，以保留分叉（两条都可 resume）。
			                  </div>
			                </>
				              ) : (
				                <>
				                  <div className="row sectionHeader">
				                    <h3 className="grow">预览（导入包，最近消息）</h3>
				                    <button
				                      type="button"
				                      onClick={() => setBundlePreviewOpen((v) => !v)}
				                    >
				                      {bundlePreviewOpen ? "折叠预览" : "展开预览"}
				                    </button>
				                  </div>
				                  {bundlePreviewOpen ? (
				                    <>
					                      <div className="row">
					                        <button
					                          type="button"
					                          disabled={bundlePreviewBusy}
					                          onClick={() =>
					                            loadBundlePreview(inspectResult.bundle_path)
					                          }
					                        >
					                          {bundlePreviewBusy ? "预览中..." : "刷新预览"}
					                        </button>
					                        <button
					                          type="button"
					                          disabled={
					                            bundlePreviewBusy ||
					                            previewMaxMessages >= PREVIEW_MAX_MESSAGES_CAP
					                          }
					                          onClick={() =>
					                            setPreviewMaxMessages((v) =>
					                              Math.min(
					                                PREVIEW_MAX_MESSAGES_CAP,
					                                v + PREVIEW_LOAD_MORE_STEP,
					                              ),
					                            )
					                          }
					                        >
					                          加载更多（+{PREVIEW_LOAD_MORE_STEP}）
					                        </button>
					                        <button
					                          type="button"
					                          disabled={
					                            bundlePreviewBusy ||
					                            previewMaxMessages === PREVIEW_MAX_MESSAGES_DEFAULT
					                          }
					                          onClick={() =>
					                            setPreviewMaxMessages(PREVIEW_MAX_MESSAGES_DEFAULT)
					                          }
					                        >
					                          重置
					                        </button>
					                        <span className="muted small">
					                          当前显示最近 {previewMaxMessages} 条
					                        </span>
					                        <span className="hint muted">
					                          提示：zip 预览需要扫描整个文件，较大的会话可能会比较慢。
					                        </span>
					                      </div>
				                      {bundlePreviewError ? (
				                        <div className="error">
				                          预览失败：{bundlePreviewError}
				                        </div>
				                      ) : null}
				                      {bundlePreview ? (
				                        <RolloutPreviewView
				                          preview={bundlePreview}
				                          renderMarkdown={previewRenderMarkdown}
				                        />
				                      ) : bundlePreviewBusy ? (
				                        <div className="muted">预览加载中...</div>
				                      ) : (
				                        <div className="muted small">
				                          自动预览最近 {previewMaxMessages} 条消息。
				                        </div>
				                      )}
				                    </>
				                  ) : (
				                    <div className="muted small">
				                      已折叠：不会加载预览内容（点击“展开”加载）。
				                    </div>
				                  )}
				                </>
				              )}

		              <div className="hint muted small">
		                （已完成检查）导入选项在下方设置。
		              </div>
	            </div>
	          ) : null}

	          {importBundlePaths.length ? (
	            <div className="result">
	              <h3>导入选项</h3>
	              <div className="grid">
	                <label className="field">
	                  <div className="label">名称（必填）</div>
	                  <input
	                    value={importName}
	                    onChange={(e) => setImportName(e.target.value)}
	                  />
	                  <div className="hint muted small">
	                    批量导入时会自动在名称后追加短ID（便于历史记录区分）。
	                  </div>
	                </label>
	                <label className="field">
	                  <div className="label">备注</div>
	                  <input
	                    value={importNote}
	                    onChange={(e) => setImportNote(e.target.value)}
	                  />
	                </label>
	                {inspectHasConflict ? (
	                  <div className="field">
	                    <div className="label">处理方式</div>
	                    <div className="radioGroup">
	                      <label className="radio">
	                        <input
	                          type="radio"
	                          name="import_strategy"
	                          checked={importStrategy === "import_as_new"}
	                          onChange={() => setImportStrategy("import_as_new")}
	                        />
	                        <span>改ID导入（推荐，保留分叉）</span>
	                      </label>
	                      <label className="radio">
	                        <input
	                          type="radio"
	                          name="import_strategy"
	                          checked={importStrategy === "overwrite"}
	                          onChange={() => setImportStrategy("overwrite")}
	                        />
	                        <span>覆盖本机（会自动备份本机版本到存档库）</span>
	                      </label>
	                      <label className="radio">
	                        <input
	                          type="radio"
	                          name="import_strategy"
	                          checked={importStrategy === "cancel"}
	                          onChange={() => setImportStrategy("cancel")}
	                        />
	                        <span>取消（仅存档，不写入 CODEX_HOME）</span>
	                      </label>
	                    </div>
	                  </div>
	                ) : (
	                  <label className="field">
	                    <div className="label">导入方式</div>
	                    <select
	                      value={importStrategy}
	                      onChange={(e) =>
	                        setImportStrategy(e.target.value as ConflictStrategy)
	                      }
	                    >
	                      <option value="recommended">推荐（有冲突则改ID）</option>
	                      <option value="overwrite">覆盖本机 / 写入原位置</option>
	                      <option value="import_as_new">改ID导入（新会话）</option>
	                      <option value="cancel">取消</option>
	                    </select>
	                    <div className="hint muted">
	                      默认：<span className="mono">覆盖本机</span>
	                    </div>
	                  </label>
	                )}
	              </div>
	              <div className="row">
	                <button
	                  type="button"
	                  disabled={!isTauri || busy || !importName.trim()}
	                  onClick={handleImport}
	                >
	                  {busyAction === "import" ? "导入中..." : "导入"}
	                </button>
	              </div>
	            </div>
	          ) : null}

	          {importBatchResult ? (
	            <div className="result">
	              <h3>导入结果</h3>
	              <div className="kv">
	                <div>选择的 zip</div>
	                <div>{importBatchResult.requested_paths}</div>
	                <div>导入成功</div>
	                <div>{importBatchResult.imported}</div>
	                <div>导入失败</div>
	                <div>{importBatchResult.failed}</div>
	              </div>
	              {importBatchResult.errors.length ? (
	                <div className="error">
	                  <div>以下条目导入失败：</div>
	                  <pre className="mono small">
	                    {importBatchResult.errors
	                      .map((e) => `${e.source}: ${e.message}`)
	                      .join("\n")}
	                  </pre>
	                </div>
	              ) : null}
	              {importBatchResult.items.map((it, idx) => (
	                <div
	                  className="resultBlock"
	                  key={`${it.result.transfer_id}-${idx}`}
	                >
	                  <div className="kv">
	                    <div>来源</div>
	                    <div className="mono small truncatePath" title={it.source}>
	                      {it.source}
	                    </div>
	                    <div>状态</div>
	                    <div>
	                      <span className="pill">
	                        {statusZh(it.result.status)}
	                      </span>
	                    </div>
	                    <div>实际会话ID</div>
	                    <div className="mono">{it.result.effective_session_id}</div>
	                    <div>恢复命令</div>
	                    <div className="mono">{it.result.resume_cmd ?? "-"}</div>
	                    <div>本机文件</div>
	                    <div className="mono">
	                      {it.result.local_rollout_path ?? "-"}
	                    </div>
	                    <div>存档库</div>
	                    <div className="mono">{it.result.vault_dir}</div>
	                  </div>
	                  <div className="row">
	                    {it.result.local_rollout_path ? (
	                      <button
	                        type="button"
	                        onClick={() =>
	                          handleReveal(it.result.local_rollout_path!)
	                        }
	                      >
	                        显示本机文件
	                      </button>
	                    ) : null}
	                    {it.result.resume_cmd ? (
	                      <button
	                        type="button"
	                        onClick={() => handleCopy(it.result.resume_cmd!)}
	                      >
	                        复制恢复命令
	                      </button>
	                    ) : null}
	                    <button
	                      type="button"
	                      onClick={() => handleOpen(it.result.vault_dir)}
	                    >
	                      打开存档库
	                    </button>
	                  </div>
	                </div>
	              ))}
	            </div>
	          ) : null}
	        </section>
	      ) : null}

      {tab === "change_id" ? (
        <section className="panel">
          <h2>更换会话ID</h2>
          <div className="grid">
            <label className="field">
              <div className="label">会话ID</div>
              <input
                value={changeIdSessionId}
                onChange={(e) => setChangeIdSessionId(e.target.value)}
              />
            </label>
            <label className="field">
              <div className="label">名称（必填）</div>
              <input
                value={changeIdName}
                onChange={(e) => setChangeIdName(e.target.value)}
                placeholder="例如：为 Windows 测试创建分叉"
              />
            </label>
            <label className="field">
              <div className="label">备注</div>
              <input
                value={changeIdNote}
                onChange={(e) => setChangeIdNote(e.target.value)}
              />
            </label>
            <label className="field">
              <div className="label">新会话ID（可选）</div>
              <input
                value={changeIdNewId}
                onChange={(e) => setChangeIdNewId(e.target.value)}
                placeholder="留空则自动生成 UUID v7"
              />
            </label>
          </div>
          <div className="row">
            <button
              type="button"
              disabled={
                !isTauri || busy || !changeIdSessionId.trim() || !changeIdName.trim()
              }
              onClick={handleChangeId}
            >
              {busyAction === "change_id" ? "处理中..." : "更换会话ID"}
            </button>
          </div>

          {changeIdResult ? (
            <div className="result">
              <h3>结果</h3>
		              <div className="kv">
		                <div>原会话ID</div>
		                <div className="mono">{changeIdResult.old_session_id}</div>
		                <div>新会话ID</div>
		                <div className="mono">{changeIdResult.new_session_id}</div>
		                <div>恢复命令</div>
		                <div className="mono">{changeIdResult.resume_cmd}</div>
		                <div>本机文件</div>
		                <div className="mono">{changeIdResult.local_rollout_path}</div>
		                <div>存档库</div>
		                <div className="mono">{changeIdResult.vault_dir}</div>
		                <div>导出包</div>
		                <div className="mono">{changeIdResult.bundle_path}</div>
		              </div>
		              <div className="row">
		                <button
		                  type="button"
		                  onClick={() => handleReveal(changeIdResult.local_rollout_path)}
		                >
		                  显示本机文件
		                </button>
		                <button
		                  type="button"
		                  onClick={() => handleReveal(changeIdResult.bundle_path)}
		                >
		                  显示导出包
		                </button>
		                <button
		                  type="button"
		                  onClick={() => handleCopy(changeIdResult.resume_cmd)}
		                >
		                  复制恢复命令
                </button>
                <button
                  type="button"
                  onClick={() => handleOpen(changeIdResult.vault_dir)}
                >
                  打开存档库
                </button>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

		      {tab === "history" ? (
		        <section className="panel">
				          <div className="panelHeader">
				            <h2>历史</h2>
				            <div className="row">
				              <button type="button" disabled={busy} onClick={refreshHistory}>
				                {busyAction === "history" ? "加载中..." : "刷新"}
				              </button>
                      <button
                        type="button"
                        disabled={!isTauri || busy || historySelectedIds.size === 0}
                        onClick={handleHistoryDeleteSelected}
                      >
                        {busyAction === "delete_many"
                          ? "删除中..."
                          : `删除选中（${historySelectedIds.size}）`}
                      </button>
				              <button
				                type="button"
		                        className="sideToggleBtn"
                        data-open={historyDetailOpen ? "1" : "0"}
				                title={historyDetailOpen ? "折叠右侧面板" : "展开右侧面板"}
	                        aria-label={historyDetailOpen ? "折叠右侧面板" : "展开右侧面板"}
				                onClick={() => {
				                  const next = !historyDetailOpen;
				                  setHistoryDetailOpen(next);
				                  if (!next) {
				                    setHistoryPreview(null);
				                    setHistoryPreviewError(null);
				                  }
				                }}
				              >
				                <span className="sideChevron" aria-hidden="true" />
				              </button>
				              <input
				                value={historyFilter}
				                onChange={(e) => setHistoryFilter(e.target.value)}
				                placeholder="搜索历史..."
			                className="grow"
			              />
			              <label className="field checkbox">
			                <input
			                  type="checkbox"
			                  checked={historyFavoritesOnly}
			                  onChange={(e) => setHistoryFavoritesOnly(e.target.checked)}
			                />
			                <span>仅看收藏</span>
			              </label>
			              <select
			                value={historyOpFilter}
			                onChange={(e) => setHistoryOpFilter(e.target.value)}
			              >
			                <option value="all">全部操作</option>
			                <option value="export">导出</option>
			                <option value="import">导入</option>
			                <option value="restore">恢复</option>
			                <option value="change_id">改ID</option>
			              </select>
			              <span className="muted small">
			                {filteredHistory.length}/{history.length}
			              </span>
			            </div>
			          </div>

		          {history.length === 0 ? (
		            <div className="muted">
		              {busyAction === "history" ? "加载中..." : "暂无历史记录。"}
		            </div>
			          ) : (
			            <div className={historyDetailOpen ? "split" : "split splitCollapsed"}>
			              <div className="splitList">
		                {filteredHistory.length === 0 ? (
		                  <div className="muted">没有匹配记录。</div>
		                ) : (
		                  <div className="tableWrap">
			                    <table className="table compact clickable">
				                  <thead>
				                    <tr>
                              <th className="nowrap">
                                <input
                                  ref={selectAllHistoryRef}
                                  type="checkbox"
                                  checked={filteredHistorySelection.all}
                                  onChange={(e) => {
                                    const checked = e.target.checked;
                                    setHistorySelectedIds((prev) => {
                                      const next = new Set(prev);
                                      for (const r of filteredHistory) {
                                        if (checked) next.add(r.id);
                                        else next.delete(r.id);
                                      }
                                      return next;
                                    });
                                  }}
                                />
                              </th>
				                      <th>★</th>
				                      <th>时间</th>
				                      <th>操作</th>
				                      <th>名称</th>
				                      <th>标签</th>
			                      <th>会话</th>
		                      <th>状态</th>
			                    </tr>
			                  </thead>
		                  <tbody>
			                    {filteredHistory.map((r) => {
                              const checked = historySelectedIds.has(r.id);
                              return (
		                      <tr
		                        key={r.id}
		                        className={r.id === historySelectedId ? "selectedRow" : undefined}
			                        onClick={() => {
		                          setHistorySelectedId(r.id);
		                          setRestoreName(`恢复：${r.name}`);
		                          setRestoreNote("");
		                          setRestoreStrategy("recommended");
			                          setRestoreResult(null);
			                        }}
				                      >
                              <td className="nowrap">
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onClick={(e) => e.stopPropagation()}
                                  onChange={(e) => {
                                    const nextChecked = e.target.checked;
                                    setHistorySelectedIds((prev) => {
                                      const next = new Set(prev);
                                      if (nextChecked) next.add(r.id);
                                      else next.delete(r.id);
                                      return next;
                                    });
                                  }}
                                />
                              </td>
		                        <td className="nowrap">{r.favorite ? "★" : ""}</td>
		                        <td className="nowrap">{formatRfc3339(r.created_at)}</td>
		                        <td className="nowrap">{opZh(r.op)}</td>
	                        <td className="truncate" title={r.name}>
	                          {r.name}
	                        </td>
	                        <td className="truncate small" title={r.tags ?? ""}>
	                          {r.tags ?? "-"}
	                        </td>
	                        {(() => {
	                          const sid =
	                            r.effective_session_id ??
	                            r.session_id_new ??
	                            r.session_id_old ??
	                            "-";
	                          return (
	                            <td className="mono small nowrap" title={sid}>
	                              {sid}
	                            </td>
	                          );
	                        })()}
	                        <td className="nowrap">
		                          <span className="pill">{statusZh(r.status)}</span>
		                        </td>
			                      </tr>
			                    );
                            })}
			                  </tbody>
		                </table>
		                  </div>
		                )}
			              </div>

	              {historyDetailOpen ? (
	              <div className="splitDetail">
	                {selectedHistory ? (
	                  <>
		                    <h3>详情</h3>
		                    <div className="kv">
		                      <div>记录ID</div>
		                      <div className="mono">{selectedHistory.id}</div>
		                      <div>创建时间</div>
		                      <div>{formatRfc3339(selectedHistory.created_at)}</div>
		                      <div>最后编辑</div>
		                      <div>{formatRfc3339(selectedHistory.updated_at)}</div>
		                      <div>操作</div>
		                      <div>{opZh(selectedHistory.op)}</div>
		                      <div>状态</div>
		                      <div>
		                        <span className="pill">{statusZh(selectedHistory.status)}</span>
		                      </div>
		                      <div>名称</div>
		                      <div>{selectedHistory.name}</div>
		                      <div>备注</div>
		                      <div>{selectedHistory.note ?? "-"}</div>
		                      <div>标签</div>
		                      <div>{selectedHistory.tags ?? "-"}</div>
		                      <div>收藏</div>
		                      <div>
		                        {selectedHistory.favorite ? (
		                          <span className="pill ok">★ 已收藏</span>
		                        ) : (
		                          <span className="muted">-</span>
		                        )}
		                      </div>
		                      <div>会话ID</div>
		                      <div className="mono">
		                        {selectedHistory.effective_session_id ??
		                          selectedHistory.session_id_new ??
		                          selectedHistory.session_id_old ??
	                          "-"}
	                      </div>
	                      <div>SHA256</div>
	                      <div className="mono">
	                        {selectedHistory.rollout_sha256 ?? "-"}
	                      </div>
	                      <div>存档库</div>
	                      <div className="mono">{selectedHistory.vault_dir}</div>
	                      <div>导出包</div>
	                      <div className="mono">
	                        {selectedHistory.bundle_path || "-"}
	                      </div>
	                      <div>本机文件</div>
	                      <div className="mono">
	                        {selectedHistory.local_rollout_path ?? "-"}
	                      </div>
	                    </div>

                    <div className="row">
	                      <button
	                        type="button"
                          disabled={!isTauri}
	                        onClick={() => handleOpen(selectedHistory.vault_dir)}
	                      >
	                        打开存档库
	                      </button>
	                      {selectedHistory.bundle_path ? (
	                        <button
	                          type="button"
                            disabled={!isTauri}
	                          onClick={() => handleReveal(selectedHistory.bundle_path)}
	                        >
	                          显示导出包
	                        </button>
	                      ) : null}
                      {(selectedHistory.effective_session_id ||
                        selectedHistory.session_id_new ||
                        selectedHistory.session_id_old) ? (
                        <button
                          type="button"
                          onClick={() =>
                            handleCopy(
                              `codex resume ${
                                selectedHistory.effective_session_id ??
                                selectedHistory.session_id_new ??
                                selectedHistory.session_id_old
                              }`,
                            )
                          }
	                        >
	                          复制恢复命令
	                        </button>
	                      ) : null}
		                      {selectedHistory.local_rollout_path ? (
		                        <button
		                          type="button"
                              disabled={!isTauri}
		                          onClick={() =>
		                            handleReveal(selectedHistory.local_rollout_path!)
		                          }
		                        >
		                          显示本机文件
		                        </button>
			                      ) : null}
			                    </div>

		                    <h3>编辑元信息</h3>
		                    <div className="grid">
		                      <label className="field">
		                        <div className="label">名称（必填）</div>
		                        <input
		                          value={historyEditName}
		                          onChange={(e) => setHistoryEditName(e.target.value)}
		                        />
		                      </label>
		                      <label className="field">
		                        <div className="label">备注</div>
		                        <input
		                          value={historyEditNote}
		                          onChange={(e) => setHistoryEditNote(e.target.value)}
		                        />
		                      </label>
		                      <label className="field">
		                        <div className="label">标签（用逗号分隔）</div>
		                        <input
		                          value={historyEditTags}
		                          onChange={(e) => setHistoryEditTags(e.target.value)}
		                          placeholder="例如：mac, win, bugfix"
		                        />
		                      </label>
		                      <label className="field checkbox">
		                        <input
		                          type="checkbox"
		                          checked={historyEditFavorite}
		                          onChange={(e) =>
		                            setHistoryEditFavorite(e.target.checked)
		                          }
		                        />
		                        <span>收藏</span>
		                      </label>
		                    </div>
		                    <div className="row">
		                      <button
		                        type="button"
		                        disabled={
		                          !isTauri || historyEditBusy || !historyEditName.trim()
		                        }
		                        onClick={() => handleHistorySaveMeta(selectedHistory.id)}
		                      >
		                        {historyEditBusy ? "保存中..." : "保存"}
		                      </button>
		                      <button
		                        type="button"
		                        disabled={historyEditBusy}
		                        onClick={resetHistoryEditFields}
		                      >
		                        重置
		                      </button>
		                    </div>
		                    {historyEditError ? (
		                      <div className="error">保存失败：{historyEditError}</div>
		                    ) : null}

				                    <div className="row sectionHeader">
				                      <h3 className="grow">预览（存档库版本，最近消息）</h3>
				                      <button
				                        type="button"
				                        onClick={() => setHistoryPreviewOpen((v) => !v)}
				                      >
				                        {historyPreviewOpen ? "折叠预览" : "展开预览"}
				                      </button>
				                    </div>
				                    {historyPreviewOpen ? (
				                      <>
					                        <div className="row">
					                          <button
					                            type="button"
					                            disabled={historyPreviewBusy}
					                            onClick={() => loadHistoryPreview(selectedHistory)}
					                          >
					                            {historyPreviewBusy ? "预览中..." : "刷新预览"}
					                          </button>
					                          <button
					                            type="button"
					                            disabled={
					                              historyPreviewBusy ||
					                              previewMaxMessages >= PREVIEW_MAX_MESSAGES_CAP
					                            }
					                            onClick={() =>
					                              setPreviewMaxMessages((v) =>
					                                Math.min(
					                                  PREVIEW_MAX_MESSAGES_CAP,
					                                  v + PREVIEW_LOAD_MORE_STEP,
					                                ),
					                              )
					                            }
					                          >
					                            加载更多（+{PREVIEW_LOAD_MORE_STEP}）
					                          </button>
					                          <button
					                            type="button"
					                            disabled={
					                              historyPreviewBusy ||
					                              previewMaxMessages === PREVIEW_MAX_MESSAGES_DEFAULT
					                            }
					                            onClick={() =>
					                              setPreviewMaxMessages(PREVIEW_MAX_MESSAGES_DEFAULT)
					                            }
					                          >
					                            重置
					                          </button>
					                          <span className="muted small">
					                            当前显示最近 {previewMaxMessages} 条
					                          </span>
					                          <span className="muted small">
					                            优先预览存档库中的会话文件（rollout），其次 bundle.zip，最后回退到本机文件。
					                          </span>
					                        </div>
				                        {historyPreviewError ? (
				                          <div className="error">
				                            预览失败：{historyPreviewError}
				                          </div>
				                        ) : null}
				                        {historyPreview ? (
				                          <RolloutPreviewView
				                            preview={historyPreview}
				                            renderMarkdown={previewRenderMarkdown}
				                          />
				                        ) : historyPreviewBusy ? (
				                          <div className="muted">预览加载中...</div>
				                        ) : (
				                          <div className="muted small">
				                            自动预览最近 {previewMaxMessages} 条消息。
				                          </div>
				                        )}
				                      </>
				                    ) : (
				                      <div className="muted small">
				                        已折叠：不会加载预览内容（点击“展开”加载）。
				                      </div>
				                    )}

		                    <h3>恢复</h3>
		                    <div className="grid">
		                      <label className="field">
		                        <div className="label">名称（必填）</div>
	                        <input
	                          value={restoreName}
	                          onChange={(e) => setRestoreName(e.target.value)}
	                        />
	                      </label>
	                      <label className="field">
	                        <div className="label">备注</div>
	                        <input
	                          value={restoreNote}
	                          onChange={(e) => setRestoreNote(e.target.value)}
	                        />
	                      </label>
	                      <label className="field">
	                        <div className="label">冲突策略</div>
	                        <select
	                          value={restoreStrategy}
	                          onChange={(e) =>
	                            setRestoreStrategy(e.target.value as ConflictStrategy)
	                          }
	                        >
	                          <option value="recommended">推荐</option>
	                          <option value="import_as_new">改ID导入（新会话）</option>
	                          <option value="overwrite">覆盖本机</option>
	                          <option value="cancel">取消</option>
	                        </select>
	                      </label>
	                    </div>
	                    <div className="row">
	                      <button
                        type="button"
	                        disabled={!isTauri || busy || !restoreName.trim()}
	                        onClick={() => handleRestoreFromHistory(selectedHistory.id)}
	                      >
	                        {busyAction === "restore" ? "恢复中..." : "恢复"}
	                      </button>
	                    </div>

	                    {restoreResult ? (
	                      <div className="result">
	                        <h3>恢复结果</h3>
	                        <div className="kv">
	                          <div>状态</div>
	                          <div>
	                            <span className="pill">{statusZh(restoreResult.status)}</span>
	                          </div>
	                          <div>实际会话ID</div>
	                          <div className="mono">
	                            {restoreResult.effective_session_id}
	                          </div>
	                          <div>恢复命令</div>
	                          <div className="mono">{restoreResult.resume_cmd ?? "-"}</div>
	                          <div>本机文件</div>
	                          <div className="mono">
	                            {restoreResult.local_rollout_path ?? "-"}
	                          </div>
	                        </div>
	                        {restoreResult.resume_cmd ? (
	                          <div className="row">
	                            <button
	                              type="button"
	                              onClick={() => handleCopy(restoreResult.resume_cmd!)}
	                            >
	                              复制恢复命令
	                            </button>
	                          </div>
	                        ) : null}
	                      </div>
	                    ) : null}

	                    <h3>删除</h3>
		                    <label className="field checkbox">
	                      <input
	                        type="checkbox"
	                        checked={historyDeleteFiles}
                          disabled={!isTauri}
	                        onChange={(e) => setHistoryDeleteFiles(e.target.checked)}
		                      />
	                      <span>同时删除存档库文件</span>
		                    </label>
	                    <div className="row">
	                      <button
                        type="button"
	                        disabled={!isTauri || busy}
	                        onClick={() => handleHistoryDelete(selectedHistory.id)}
	                      >
	                        {busyAction === "delete" ? "删除中..." : "删除记录"}
	                      </button>
	                    </div>
	                  </>
	                ) : (
	                  <div className="muted">请选择一条记录。</div>
		                )}
	              </div>
	              ) : null}
	            </div>
	          )}
	        </section>
      ) : null}

      {tab === "settings" ? (
        <section className="panel">
          <h2>设置</h2>

          <h3>CODEX_HOME</h3>
          {status ? (
            <div className="kv">
              <div>检测到</div>
              <div className="mono">{status.codex_home.detected_home}</div>
              <div>覆盖值</div>
              <div className="mono">{status.codex_home.override_home ?? "-"}</div>
              <div>实际生效</div>
              <div className="mono">{status.codex_home.effective_home}</div>
              <div>来源</div>
              <div>
                <span className="pill">
                  {codexHomeSourceLabel(status.codex_home.source)}
                </span>
              </div>
            </div>
          ) : (
            <div className="muted">加载中...</div>
          )}

          <div className="grid">
            <label className="field">
              <div className="label">覆盖 CODEX_HOME</div>
              <input
                value={codexHomeOverrideInput}
                onChange={(e) => setCodexHomeOverrideInput(e.target.value)}
                placeholder="留空后点击“应用”即可清除覆盖值"
                disabled={!isTauri}
              />
              <div className="hint muted">
                提示：当你需要指向 WSL 或自定义 Codex 数据目录时可用。
              </div>
            </label>
          </div>
          <div className="row">
            <button
              type="button"
              onClick={handleBrowseCodexHomeOverride}
              disabled={!isTauri || busy}
            >
              浏览...
            </button>
            <button
              type="button"
              onClick={handleApplyCodexHomeOverride}
              disabled={!isTauri || busy}
            >
              {busyAction === "settings" ? "应用中..." : "应用"}
            </button>
            <button
              type="button"
              onClick={() => {
                setCodexHomeOverrideInput("");
              }}
              disabled={!isTauri || busy}
            >
              清空（再点“应用”）
            </button>
          </div>

          <h3>设备</h3>
          {status ? (
            <div className="kv">
              <div>设备ID</div>
              <div className="mono">{status.device.device_id}</div>
              <div>系统 / 架构</div>
              <div className="mono">
                {status.device.os} / {status.device.arch}
              </div>
              <div>主机名</div>
              <div className="mono">{status.device.hostname ?? "-"}</div>
            </div>
          ) : null}

          <h3>路径</h3>
          {status ? (
            <>
              <div className="kv">
                <div>应用数据</div>
                <div className="mono">{status.app_data_dir}</div>
                <div>存档库</div>
                <div className="mono">{status.vault_dir}</div>
                <div>DB</div>
                <div className="mono">{status.db_path}</div>
              </div>
              <div className="row">
                <button
                  type="button"
                  disabled={!isTauri}
                  onClick={() => handleOpen(status.codex_home.effective_home)}
                >
                  打开 CODEX_HOME
                </button>
                <button
                  type="button"
                  disabled={!isTauri}
                  onClick={() => handleOpen(status.vault_dir)}
                >
                  打开存档库
                </button>
              </div>
            </>
          ) : null}

          <h3>预览</h3>
          <div className="grid">
            <label className="field checkbox">
              <input
                type="checkbox"
                checked={previewRenderMarkdown}
                onChange={(e) => setPreviewRenderMarkdown(e.target.checked)}
              />
              <span>消息内容使用 Markdown 渲染（可选）</span>
            </label>
            <label className="field checkbox">
              <input
                type="checkbox"
                checked={previewIncludeMeta}
                onChange={(e) => setPreviewIncludeMeta(e.target.checked)}
              />
              <span>包含系统/开发者/工具消息（高级）</span>
            </label>
            <label className="field">
              <div className="label">显示最近消息数</div>
              <input
                value={String(previewMaxMessages)}
                onChange={(e) => {
                  const n = Number.parseInt(e.target.value, 10);
                  if (!Number.isFinite(n)) return;
                  setPreviewMaxMessages(Math.min(PREVIEW_MAX_MESSAGES_CAP, Math.max(1, n)));
                }}
                placeholder={String(PREVIEW_MAX_MESSAGES_DEFAULT)}
                style={{ width: 180 }}
              />
              <div className="hint muted">范围：1 ~ {PREVIEW_MAX_MESSAGES_CAP}</div>
            </label>
            <label className="field">
              <div className="label">单条消息最大字符数</div>
              <input
                value={String(previewMaxCharsPerMessage)}
                onChange={(e) => {
                  const n = Number.parseInt(e.target.value, 10);
                  if (!Number.isFinite(n)) return;
                  setPreviewMaxCharsPerMessage(Math.min(20000, Math.max(200, n)));
                }}
                placeholder={String(PREVIEW_MAX_CHARS_PER_MESSAGE_DEFAULT)}
                style={{ width: 180 }}
              />
              <div className="hint muted">范围：200 ~ 20000（过大会影响性能）</div>
            </label>
            <div className="hint muted">
              提示：仅影响预览显示；默认不解析 HTML，适合阅读列表/代码块。
            </div>
          </div>

          <h3>存档库占用</h3>
          <div className="row">
            <button
              type="button"
              onClick={refreshVaultUsage}
              disabled={vaultUsageBusy || busy}
            >
              {vaultUsageBusy ? "统计中..." : "刷新统计"}
            </button>
            <label className="field">
              <div className="label">统计条数</div>
              <input
                value={String(vaultUsageLimit)}
                onChange={(e) => {
                  const n = Number.parseInt(e.target.value, 10);
                  setVaultUsageLimit(Number.isFinite(n) ? n : 200);
                }}
                placeholder="例如：200"
                style={{ width: 120 }}
              />
            </label>
            <span className="muted small">提示：统计会遍历存档库目录，可能较慢。</span>
          </div>
          {vaultUsageError ? (
            <div className="error">统计失败：{vaultUsageError}</div>
          ) : null}
          {vaultUsage ? (
            <>
              <div className="muted small">
                总计：{formatBytes(vaultUsage.total_bytes)}（{vaultUsage.total_files} 个文件）
                <span className="dot">•</span>
                已统计 {vaultUsage.items.length} 条记录
              </div>
              {vaultUsage.items.length ? (
                <div className="tableWrap">
                  <table className="table compact">
                    <thead>
                      <tr>
                        <th>大小</th>
                        <th>文件数</th>
                        <th>时间</th>
                        <th>操作</th>
                        <th>名称</th>
                        <th>会话</th>
                        <th>状态</th>
                        <th>管理</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...vaultUsage.items]
                        .sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0))
                        .slice(0, 30)
                        .map((it) => (
                          <tr key={it.id}>
                            <td className="nowrap">{formatBytes(it.bytes)}</td>
                            <td className="nowrap">{it.files}</td>
                            <td className="nowrap">{formatRfc3339(it.created_at)}</td>
                            <td className="nowrap">{opZh(it.op)}</td>
                            <td className="truncate" title={it.name}>
                              {it.name}
                            </td>
                            <td
                              className="mono small nowrap"
                              title={it.effective_session_id ?? "-"}
                            >
                              {it.effective_session_id ?? "-"}
                            </td>
                            <td className="nowrap">
                              <span className="pill">{statusZh(it.status)}</span>
                            </td>
                            <td className="nowrap">
                              <button
                                type="button"
                                disabled={!isTauri}
                                onClick={() => handleOpen(it.vault_dir)}
                              >
                                打开
                              </button>
                              <button
                                type="button"
                                onClick={() => jumpToHistoryRecord(it.id, it.name)}
                              >
                                查看记录
                              </button>
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="muted">暂无历史记录。</div>
              )}
            </>
          ) : (
            <div className="muted small">点击“刷新统计”以查看占用情况。</div>
          )}
        </section>
      ) : null}

      {dragActive ? (
        <div className="dropOverlay">
          <div className="dropCard">
            <div className="dropTitle">拖拽导入</div>
            <div className="dropHint">松开鼠标以导入 bundle.zip</div>
            {dragPaths.length ? (
              <div className="mono small truncatePath" title={dragPaths.join("\n")}>
                {dragPaths.join("  ")}
              </div>
            ) : (
              <div className="muted small">支持：bundle.zip</div>
            )}
          </div>
        </div>
      ) : null}
    </main>
  );
}

export default App;
