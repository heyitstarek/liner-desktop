import { useEffect, useSyncExternalStore } from "react";
import { api, getAuthSession, getAuthSessionIdentity, toClientTrack } from "@/shared/api";
import { getAuthSessionBoundaryGeneration } from "@/shared/api/auth-session";
import type { Track } from "@/shared/types";

type LikedData = { tracks: Track[]; total: number };
const EMPTY: LikedData = { tracks: [], total: 0 };
let cache: LikedData = EMPTY;
let loaded = false;
let request: Promise<void> | null = null;
let requestIdentity: string | null = null;
let requestGeneration = 0;
let cacheIdentity: string | null = null;
const listeners = new Set<() => void>();
let view = { data: cache, isLoading: true };

const optimisticOverrides = new Map<string, boolean>();
const optimisticOperations = new Map<string, number>();
let nextOptimisticOperation = 0;

function buildView(isLoading: boolean): { data: LikedData; isLoading: boolean } {
  if (optimisticOverrides.size === 0) return { data: cache, isLoading };

  let tracks = cache.tracks.filter(
    (t) => optimisticOverrides.get(t.id) !== false
  );
  for (const [id, liked] of optimisticOverrides) {
    if (liked && !tracks.some((t) => t.id === id)) {
      tracks = [
        {
          id,
          title: "",
          artists: "",
          artistId: undefined,
          coverUrl: "",
          durationMs: 0,
          playCount: 0,
        } as Track,
        ...tracks,
      ];
    }
  }
  return { data: { tracks, total: tracks.length }, isLoading };
}

function emit(isLoading = false) {
  view = buildView(isLoading);
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot() {
  return view;
}

const SERVER_SNAPSHOT = { data: EMPTY, isLoading: true };

function load(force = false): Promise<void> {
  const session = getAuthSession();
  const identity = getAuthSessionIdentity();
  if (!session?.accessToken) {
    requestGeneration++;
    request = null;
    requestIdentity = null;
    cacheIdentity = null;
    cache = EMPTY;
    loaded = false;
    emit(false);
    return Promise.resolve();
  }
  if (cacheIdentity !== identity) {
    requestGeneration++;
    request = null;
    requestIdentity = null;
    cacheIdentity = identity;
    cache = EMPTY;
    loaded = false;
    optimisticOverrides.clear();
    optimisticOperations.clear();
    emit(true);
  }
  if (request && requestIdentity === identity && !force) return request;
  if (loaded && !force) return Promise.resolve();

  const generation = ++requestGeneration;
  requestIdentity = identity;

  if (!loaded) emit(true);

  request = (async () => {
    const tracks: Track[] = [];
    let cursor: string | undefined;
    do {
      const page = await api.listLikedTracks(100, cursor);
      if (generation !== requestGeneration || identity !== getAuthSessionIdentity()) return;
      tracks.push(...page.items.map(({ track }) => toClientTrack(track)));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    if (generation !== requestGeneration || identity !== getAuthSessionIdentity()) return;
    cache = { tracks, total: tracks.length };
    loaded = true;
    optimisticOverrides.clear();
    optimisticOperations.clear();
  })()
    .catch(() => {
      if (generation !== requestGeneration || identity !== getAuthSessionIdentity()) return;
      if (!loaded) cache = EMPTY;
      loaded = true;
    })
    .finally(() => {
      if (generation === requestGeneration) {
        request = null;
        requestIdentity = null;
        emit(false);
      }
    });
  return request;
}

function applyOptimisticOverride(trackId: string, liked: boolean): () => void {
  const prev = optimisticOverrides.get(trackId);
  const identity = getAuthSessionIdentity();
  const boundary = getAuthSessionBoundaryGeneration();
  const operation = ++nextOptimisticOperation;
  optimisticOperations.set(trackId, operation);
  optimisticOverrides.set(trackId, liked);
  emit(false);
  return () => {
    if (
      identity !== getAuthSessionIdentity() ||
      boundary !== getAuthSessionBoundaryGeneration() ||
      optimisticOperations.get(trackId) !== operation
    ) return;
    optimisticOperations.delete(trackId);
    if (prev === undefined) optimisticOverrides.delete(trackId);
    else optimisticOverrides.set(trackId, prev);
    emit(false);
  };
}

export function applyOptimisticLike(trackId: string): () => void {
  return applyOptimisticOverride(trackId, true);
}

export function applyOptimisticUnlike(trackId: string): () => void {
  return applyOptimisticOverride(trackId, false);
}

if (typeof window !== "undefined") {
  const handleRefresh = () => {
    const session = getAuthSession();
    if (!session?.accessToken) {
      requestGeneration++;
      request = null;
      requestIdentity = null;
      cacheIdentity = null;
      cache = EMPTY;
      loaded = false;
      optimisticOverrides.clear();
      optimisticOperations.clear();
      emit(false);
    } else {
      if (cacheIdentity !== getAuthSessionIdentity()) {
        cache = EMPTY;
        loaded = false;
        optimisticOverrides.clear();
        optimisticOperations.clear();
      }
      void load(true);
    }
  };
  window.addEventListener("library:changed", handleRefresh);
  window.addEventListener("auth:changed", handleRefresh);
}

export function useLikedTracks(_params?: { limit?: number; offset?: number }) {
  const state = useSyncExternalStore(subscribe, snapshot, () => SERVER_SNAPSHOT);
  useEffect(() => {
    void load();
  }, []);
  return state;
}

export function useLikedTrackCount() {
  const { data, isLoading } = useLikedTracks();
  return { data: data.total, isLoading };
}
