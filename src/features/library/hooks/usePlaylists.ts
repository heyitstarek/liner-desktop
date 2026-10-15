import { useEffect, useState, useSyncExternalStore } from "react";
import { api, getAuthSession, getAuthSessionIdentity, mediaUrl, toClientTrack, type ApiUserPlaylistItem } from "@/shared/api";
import { queryCache } from "@/shared/cache/queryCache";
import type { Track } from "@/shared/types";

export interface LibraryPlaylistSummary {
  id: string;
  title: string;
  description?: string;
  trackCount: number;
  coverUrl: string;
  coverUrls: string[];
  updatedAt: string;
  createdAt: string;
  revision: number;
}

export interface LibraryPlaylistDetail {
  id: string;
  title: string;
  description?: string;
  trackCount: number;
  coverUrl: string;
  coverUrls: string[];
  revision: number;
  tracks: Track[];
}

type PlaylistList = { playlists: LibraryPlaylistSummary[]; total: number };

const COVER_CACHE_KEY = "liner:playlist-covers-v2";
type CoverCacheEntry = { coverUrls: string[]; trackCount: number; updatedAt: string };
type CoverCache = Record<string, CoverCacheEntry>;
const volatileCoverCaches = new Map<string, CoverCache>();

function coverCacheKey(identity = getAuthSessionIdentity()): string {
  return `${COVER_CACHE_KEY}:${identity}`;
}

function readCoverCache(identity = getAuthSessionIdentity()): CoverCache {
  if (!identity.startsWith("user:")) return volatileCoverCaches.get(identity) ?? {};
  if (typeof window === "undefined") return {};
  try { return JSON.parse(localStorage.getItem(coverCacheKey(identity)) ?? "{}"); } catch { return {}; }
}

function writeCoverCache(c: CoverCache, identity = getAuthSessionIdentity()) {
  if (!identity.startsWith("user:")) {
    volatileCoverCaches.set(identity, c);
    return;
  }
  try { localStorage.setItem(coverCacheKey(identity), JSON.stringify(c)); } catch {}
}

function extractCovers(items: ApiUserPlaylistItem[]): string[] {
  return items
    .map((i) => (i.track.cover ? mediaUrl(i.track.cover.url) : ""))
    .filter(Boolean)
    .filter((url, idx, arr) => arr.indexOf(url) === idx)
    .slice(0, 4);
}

const EMPTY: PlaylistList = { playlists: [], total: 0 };
let cache = EMPTY;
let loaded = false;
let request: Promise<void> | null = null;
let requestIdentity: string | null = null;
let requestGeneration = 0;
let cacheIdentity: string | null = null;
const listeners = new Set<() => void>();
let view = { data: cache, error: undefined as unknown, isLoading: true };

export function notifyLibraryChanged() {
  window.dispatchEvent(new Event("library:changed"));
}

// optimistically drop playlist from store so ui reacts instantly without waiting on network
export function evictPlaylistFromCache(id: string) {
  cache = {
    playlists: cache.playlists.filter((p) => p.id !== id),
    total: Math.max(0, cache.total - 1),
  };
  queryCache.delete(`playlist:detail:${getAuthSessionIdentity()}:${id}`);
  emit();
}

function emit() {
  view = { data: cache, error: undefined, isLoading: false };
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot() {
  return view;
}

const SERVER_SNAPSHOT = { data: EMPTY, error: undefined as unknown, isLoading: true };

function load(force = false): Promise<void> {
  const session = getAuthSession();
  const identity = getAuthSessionIdentity();
  if (!session?.accessToken) {
    requestGeneration++;
    request = null;
    requestIdentity = null;
    cacheIdentity = identity;
    cache = EMPTY;
    loaded = false;
    emit();
    return Promise.resolve();
  }
  if (cacheIdentity !== identity) {
    requestGeneration++;
    request = null;
    requestIdentity = null;
    cacheIdentity = identity;
    cache = EMPTY;
    loaded = false;
    view = { data: cache, error: undefined, isLoading: true };
  }
  if (request && requestIdentity === identity && !force) return request;
  if (loaded && !force) return Promise.resolve();

  if (!loaded) {
    view = { data: cache, error: undefined, isLoading: true };
    emit();
  }

  const generation = ++requestGeneration;
  requestIdentity = identity;
  request = (async () => {
    const coverCache = readCoverCache(identity);
    const response = await api.listPlaylists();
    if (generation !== requestGeneration || identity !== getAuthSessionIdentity()) return;

    const playlists = await Promise.all(
      response.items.map(async (playlist) => {
        const emptySummary: LibraryPlaylistSummary = {
          ...playlist,
          trackCount: 0,
          coverUrl: "",
          coverUrls: [],
        };
        if (generation !== requestGeneration || identity !== getAuthSessionIdentity()) return emptySummary;
        const cached = coverCache[playlist.id];

        if (cached && cached.updatedAt === playlist.updatedAt) {
          return {
            ...playlist,
            trackCount: cached.trackCount,
            coverUrl: cached.coverUrls[0] ?? "",
            coverUrls: cached.coverUrls,
          };
        }

        const detail = await api.getUserPlaylist(playlist.id);
        if (generation !== requestGeneration || identity !== getAuthSessionIdentity()) return emptySummary;
        const covers = extractCovers(detail.items);
        const entry: CoverCacheEntry = {
          coverUrls: covers,
          trackCount: detail.items.length,
          updatedAt: playlist.updatedAt,
        };
        coverCache[playlist.id] = entry;
        return {
          ...playlist,
          trackCount: detail.items.length,
          coverUrl: covers[0] ?? "",
          coverUrls: covers,
        };
      })
    );

    const liveIds = new Set(response.items.map((p) => p.id));
    for (const id of Object.keys(coverCache)) {
      if (!liveIds.has(id)) delete coverCache[id];
    }
    if (generation !== requestGeneration || identity !== getAuthSessionIdentity()) return;
    writeCoverCache(coverCache, identity);

    cache = { playlists, total: playlists.length };
    loaded = true;
  })()
    .catch((err) => {
      if (generation !== requestGeneration || identity !== getAuthSessionIdentity()) return;
      if (!loaded) cache = EMPTY;
      loaded = true;
      view.error = err;
    })
    .finally(() => {
      if (generation === requestGeneration) {
        request = null;
        requestIdentity = null;
        emit();
      }
    });
  return request;
}

if (typeof window !== "undefined") {
  const handleRefresh = () => {
    const session = getAuthSession();
    if (!session?.accessToken) {
      requestGeneration++;
      request = null;
      requestIdentity = null;
      cacheIdentity = getAuthSessionIdentity();
      cache = EMPTY;
      loaded = false;
      emit();
    } else {
      void load(true);
    }
  };
  window.addEventListener("library:changed", handleRefresh);
  window.addEventListener("auth:changed", handleRefresh);
}

function toTrack(item: ApiUserPlaylistItem): Track {
  const base = toClientTrack(item.track);
  return {
    ...base,
    playlistItemId: item.id,
  };
}

export function usePlaylistsList() {
  const state = useSyncExternalStore(subscribe, snapshot, () => SERVER_SNAPSHOT);
  useEffect(() => {
    void load();
  }, []);
  return state;
}

export function usePlaylist(id: string | null) {
  const [authRevision, setAuthRevision] = useState(0);
  const session = getAuthSession();
  const identity = getAuthSessionIdentity();
  const cacheKey = id && session?.accessToken ? `playlist:detail:${identity}:${id}` : null;
  const cached = cacheKey ? queryCache.get<LibraryPlaylistDetail>(cacheKey) : undefined;
  const [data, setData] = useState<LibraryPlaylistDetail | null>(cached ?? null);
  const [error, setError] = useState<unknown>();
  const [isLoading, setIsLoading] = useState(!cached && Boolean(id));

  useEffect(() => {
    const onAuthChanged = () => {
      setData(null);
      setError(undefined);
      setIsLoading(Boolean(id));
      setAuthRevision((revision) => revision + 1);
    };
    window.addEventListener("auth:changed", onAuthChanged);
    return () => window.removeEventListener("auth:changed", onAuthChanged);
  }, [id]);

  useEffect(() => {
    if (!id || !cacheKey) {
      setData(null);
      setIsLoading(false);
      return;
    }

    const initial = queryCache.get<LibraryPlaylistDetail>(cacheKey);
    if (initial) {
      setData(initial);
      setIsLoading(false);
    } else {
      setData(null);
      setIsLoading(true);
    }
    let active = true;

    const fetchDetail = async (isBackground = false) => {
      if (!isBackground && !queryCache.get(cacheKey)) setIsLoading(true);
      try {
        const response = await api.getUserPlaylist(id);
        if (!active || identity !== getAuthSessionIdentity()) return;

        const covers = extractCovers(response.items);

        const coverCache = readCoverCache(identity);
        coverCache[id] = {
          coverUrls: covers,
          trackCount: response.items.length,
          updatedAt: response.playlist.updatedAt,
        };
        if (!active || identity !== getAuthSessionIdentity()) return;
        writeCoverCache(coverCache, identity);

        const detail: LibraryPlaylistDetail = {
          id: response.playlist.id,
          title: response.playlist.title,
          description: response.playlist.description,
          trackCount: response.items.length,
          coverUrl: covers[0] ?? "",
          coverUrls: covers,
          revision: response.playlist.revision,
          tracks: response.items.map(toTrack),
        };
        queryCache.set(cacheKey, detail);
        setData(detail);
      } catch (err) {
        if (active && identity === getAuthSessionIdentity()) setError(err);
      } finally {
        if (active && identity === getAuthSessionIdentity()) setIsLoading(false);
      }
    };

    void fetchDetail(Boolean(initial));
    const refresh = () => void fetchDetail(true);
    window.addEventListener("library:changed", refresh);
    return () => {
      active = false;
      window.removeEventListener("library:changed", refresh);
    };
  }, [id, cacheKey, identity, authRevision]);

  return { data, error, isLoading };
}
