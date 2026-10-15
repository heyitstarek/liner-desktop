import { create } from "zustand";
import { api, type ImportJob, type ImportReview } from "@/shared/api";
import { getAuthSessionIdentity } from "@/shared/api/auth-session";
import { showToast } from "@/shared/ui";
import { createTranslatorSync, getStoredLocale } from "@/languages";
import { notifyLibraryChanged } from "../hooks/usePlaylists";
import { useModalStore, type TrackDetail } from "./modalStore";

export interface ActiveImportState {
  job: ImportJob | null;
  isPolling: boolean;
  error: string | null;
  pendingTrack: TrackDetail | null;
  reviewItems: ImportReview[] | null;
  approvedTracks: any[] | null;
  startImport: (url: string, pendingTrack?: TrackDetail | null) => Promise<ImportJob>;
  listenToWebSocketWorker: (job: ImportJob) => void;
  pollJob: (jobId: string) => Promise<void>;
  cancelPolling: () => void;
  reset: () => void;
}

let activeWebSocket: WebSocket | null = null;
let activeAbortController: AbortController | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let operationGeneration = 0;
let observedIdentity = getAuthSessionIdentity();

function isCurrentOperation(generation: number, identity: string) {
  return generation === operationGeneration && identity === getAuthSessionIdentity();
}

function invalidateOperation() {
  operationGeneration++;
  cleanupActiveConnections();
  return operationGeneration;
}

function cleanupActiveConnections() {
  if (activeWebSocket) {
    try {
      activeWebSocket.onopen = null;
      activeWebSocket.onmessage = null;
      activeWebSocket.onerror = null;
      activeWebSocket.onclose = null;
      activeWebSocket.close();
    } catch {}
    activeWebSocket = null;
  }
  if (activeAbortController) {
    activeAbortController.abort();
    activeAbortController = null;
  }
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

export const useImportStore = create<ActiveImportState>((set, get) => ({
  job: null,
  isPolling: false,
  error: null,
  pendingTrack: null,
  reviewItems: null,
  approvedTracks: null,

  reset: () => {
    invalidateOperation();
    set({
      job: null,
      isPolling: false,
      error: null,
      pendingTrack: null,
      reviewItems: null,
      approvedTracks: null,
    });
  },

  cancelPolling: () => {
    invalidateOperation();
    set({ isPolling: false, pendingTrack: null });
  },

  startImport: async (url: string, pendingTrack: TrackDetail | null = null) => {
    get().cancelPolling();
    const generation = operationGeneration;
    const identity = getAuthSessionIdentity();
    observedIdentity = identity;
    set({
      error: null,
      isPolling: true,
      pendingTrack,
      reviewItems: null,
      approvedTracks: null,
    });
    try {
      const job = await api.createPlaylistImport(url);
      if (!isCurrentOperation(generation, identity)) return job;
      set({ job });

      // direct imports (e.g. soundcloud) complete immediately on backend without external worker
      if (job.status === "completed") {
        set({ isPolling: false, pendingTrack: null });
        notifyLibraryChanged();
        return job;
      }

      const targetWsUrl = job.workerWsUrl?.trim() || "wss://import.tryliner.fun/v1/ws";
      if (targetWsUrl && job.importToken) {
        set({ isPolling: true });
        get().listenToWebSocketWorker({ ...job, workerWsUrl: targetWsUrl });
      } else {
        set({ error: "Import worker unavailable", isPolling: false, pendingTrack: null, job: null });
      }
      return job;
    } catch (err) {
      if (!isCurrentOperation(generation, identity)) throw err;
      set({ error: "Failed to start import", isPolling: false, pendingTrack: null });
      throw err;
    }
  },

  listenToWebSocketWorker: (job: ImportJob) => {
    invalidateOperation();
    const generation = operationGeneration;
    const identity = getAuthSessionIdentity();
    observedIdentity = identity;
    set({ isPolling: true });

    let isFinished = false;
    let ws: WebSocket;

    try {
      const wsUrl = new URL(job.workerWsUrl!);
      if (wsUrl.username || wsUrl.password) throw new Error("Worker URL credentials are not allowed");
      const isLoopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(wsUrl.hostname.toLowerCase());
      const isLocalDevelopment = import.meta.env.DEV && isLoopback;
      if (wsUrl.protocol !== "wss:" && wsUrl.protocol !== "https:" &&
          !(isLocalDevelopment && (wsUrl.protocol === "ws:" || wsUrl.protocol === "http:"))) {
        throw new Error("Worker transport must be secure");
      }
      wsUrl.searchParams.set("token", job.importToken!);
      const protocol = wsUrl.protocol === "https:" ? "wss:" : wsUrl.protocol === "http:" ? "ws:" : wsUrl.protocol;
      const targetUrl = `${protocol}//${wsUrl.host}${wsUrl.pathname}${wsUrl.search}`;

      ws = new WebSocket(targetUrl);
      activeWebSocket = ws;
    } catch {
      set({ error: "Failed to connect to import service", isPolling: false });
      cleanupActiveConnections();
      return;
    }

    ws.onmessage = (event) => {
      if (!isCurrentOperation(generation, identity)) return;
      try {
        const msg = JSON.parse(event.data);
        if (!msg || typeof msg !== "object") return;

        if (msg.type === "job") {
          const current: ImportJob = {
            id: msg.id || job.id,
            source: msg.source || job.source,
            sourceUrl: msg.sourceUrl || job.sourceUrl,
            title: msg.title || job.title,
            description: msg.description || job.description,
            status: msg.status,
            queuePosition: typeof msg.queuePosition === "number" ? msg.queuePosition : undefined,
            requiresDecision: Boolean(msg.requiresDecision),
            playlistId: msg.playlistId,
            result: msg.result,
            error: msg.error,
            createdAt: msg.createdAt || job.createdAt,
          };

          const reviewItems =
            Array.isArray(msg.reviewItems) && msg.reviewItems.length > 0
              ? msg.reviewItems
              : get().reviewItems;
          const approvedTracks =
            Array.isArray(msg.approvedTracks) && msg.approvedTracks.length > 0
              ? msg.approvedTracks
              : get().approvedTracks;

          set({ job: current, reviewItems, approvedTracks });

          if (reviewItems && reviewItems.length > 0) {
            useModalStore.setState({
              importReviewPrefetched: reviewItems,
              importReviewApprovedTracks: approvedTracks,
            });
          }

          if (current.status === "awaiting_decision") {
            isFinished = true;
            set({ isPolling: false, job: current, reviewItems, approvedTracks });
            cleanupActiveConnections();
            useModalStore
              .getState()
              .openImportReview(current.id, reviewItems ?? undefined, approvedTracks ?? undefined);
            return;
          }

          if (current.status === "completed") {
            isFinished = true;
            cleanupActiveConnections();

            // sync final playlist id from backend if created asynchronously via redis
            if (!current.playlistId) {
              void (async () => {
                for (let i = 0; i < 20; i++) {
                  if (!isCurrentOperation(generation, identity)) return;
                  try {
                    const synced = await api.getPlaylistImport(job.id);
                    if (!isCurrentOperation(generation, identity)) return;
                    if (synced.playlistId) {
                      set({ isPolling: false, job: synced });
                      notifyLibraryChanged();
                      return;
                    }
                  } catch {
                    if (!isCurrentOperation(generation, identity)) return;
                  }
                  await new Promise((r) => setTimeout(r, 800));
                }
                if (!isCurrentOperation(generation, identity)) return;
                set({ isPolling: false, job: current });
                notifyLibraryChanged();
              })();
            } else {
              set({ isPolling: false, job: current });
              notifyLibraryChanged();
            }
            return;
          }

          if (current.status === "failed") {
            isFinished = true;
            set({ isPolling: false, job: current, error: current.error?.message || "Import failed" });
            cleanupActiveConnections();
            return;
          }
        }
      } catch {}
    };

    ws.onerror = () => {
      if (isFinished || !isCurrentOperation(generation, identity)) return;
      cleanupActiveConnections();
      set((prev) => ({
        isPolling: false,
        error: "Import service connection error",
        job: prev.job ? { ...prev.job, status: "failed", error: { code: "CONNECTION_ERROR", message: "Import service connection error" } } : null,
      }));
    };

    ws.onclose = () => {
      if (isFinished || !isCurrentOperation(generation, identity)) return;
      cleanupActiveConnections();
      set((prev) => ({
        isPolling: false,
        error: "Import service disconnected",
        job: prev.job ? { ...prev.job, status: "failed", error: { code: "DISCONNECTED", message: "Import service disconnected" } } : null,
      }));
    };
  },

  pollJob: async (jobId: string) => {
    const generation = invalidateOperation();
    const identity = getAuthSessionIdentity();
    observedIdentity = identity;
    set({ isPolling: true });
    await pollJobForGeneration(jobId, generation, identity, set);
  },
}));

async function pollJobForGeneration(
  jobId: string,
  generation: number,
  identity: string,
  set: (partial: Partial<ActiveImportState>) => void,
): Promise<void> {
  try {
    const current = await api.getPlaylistImport(jobId);
    if (!isCurrentOperation(generation, identity)) return;
    set({ job: current });

    if (current.status === "awaiting_decision") {
      set({ isPolling: false, job: current });
      return;
    }

    if (current.status === "completed") {
      set({ isPolling: false, job: current });
      notifyLibraryChanged();
      return;
    }

    if (current.status === "failed") {
      set({ isPolling: false, job: current, error: "Import failed" });
      return;
    }

    pollTimer = setTimeout(() => {
      if (isCurrentOperation(generation, identity)) {
        void pollJobForGeneration(jobId, generation, identity, set);
      }
    }, 1000);
  } catch {
    if (!isCurrentOperation(generation, identity)) return;
    pollTimer = setTimeout(() => {
      if (isCurrentOperation(generation, identity)) {
        void pollJobForGeneration(jobId, generation, identity, set);
      }
    }, 2500);
  }
}

let lastHandledCompletedJob: { id: string; generation: number } | null = null;

useImportStore.subscribe((state) => {
  const { job, pendingTrack } = state;
  if (!job || job.status !== "completed" || !job.playlistId || !pendingTrack) return;
  const generation = operationGeneration;
  const identity = getAuthSessionIdentity();
  if (lastHandledCompletedJob?.id === job.id && lastHandledCompletedJob.generation === generation) return;
  lastHandledCompletedJob = { id: job.id, generation };

  useImportStore.setState({ pendingTrack: null });

  void (async () => {
    const translate = createTranslatorSync(getStoredLocale());
    try {
      if (!isCurrentOperation(generation, identity)) return;
      await api.addPlaylistTrack(job.playlistId as string, pendingTrack.id);
      if (!isCurrentOperation(generation, identity)) return;
      notifyLibraryChanged();
      showToast(translate("common.added_to_playlist"), "checkmark", {
        description: pendingTrack.title || undefined,
      });
    } catch {
      if (isCurrentOperation(generation, identity)) {
        showToast(translate("common.failed_add_playlist"), "error");
      }
    }
  })();
});

if (typeof window !== "undefined") {
  window.addEventListener("auth:changed", () => {
    const identity = getAuthSessionIdentity();
    if (identity === observedIdentity) return;
    observedIdentity = identity;
    invalidateOperation();
    lastHandledCompletedJob = null;
    useImportStore.setState({
      job: null,
      isPolling: false,
      error: null,
      pendingTrack: null,
      reviewItems: null,
      approvedTracks: null,
    });
  });
}
