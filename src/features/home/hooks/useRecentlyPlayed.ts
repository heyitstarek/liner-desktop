import { useEffect, useState } from "react";
import { api, getAuthSessionIdentity, toClientTrack } from "@/shared/api";
import type { PopularItem } from "./usePopularTracks";

export const recentlyPlayedKeys = {
  all: ["recently_played"] as const,
};

const cache = new Map<string, { data: PopularItem[]; timestamp: number }>();
const CACHE_TTL = 60_000;

export function useRecentlyPlayed(limit = 20) {
  const [authRevision, setAuthRevision] = useState(0);
  const identity = getAuthSessionIdentity();
  const cacheKey = `${identity}:recent_${limit}`;
  const [data, setData] = useState<PopularItem[]>(
    () => cache.get(cacheKey)?.data ?? [],
  );
  const [isLoading, setIsLoading] = useState(
    () => !cache.has(cacheKey),
  );

  useEffect(() => {
    const onAuthChanged = () => {
      setData([]);
      setIsLoading(true);
      setAuthRevision((revision) => revision + 1);
    };
    window.addEventListener("auth:changed", onAuthChanged);
    return () => window.removeEventListener("auth:changed", onAuthChanged);
  }, []);

  useEffect(() => {
    const requestIdentity = getAuthSessionIdentity();
    const key = `${requestIdentity}:recent_${limit}`;
    if (requestIdentity === "anonymous") {
      setData([]);
      setIsLoading(false);
      return;
    }
    const cached = cache.get(key);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      setData(cached.data);
      setIsLoading(false);
      return;
    }

    let active = true;
    const fetchLimit = Math.min(100, Math.max(limit * 3, 60));
    api
      .getHistory(undefined, fetchLimit)
      .then((res) => {
        if (!active || requestIdentity !== getAuthSessionIdentity()) return;
        const seen = new Set<string>();
        const items: PopularItem[] = [];
        for (const entry of res.items || []) {
          if (!entry.track?.id) continue;

          const isAlbum = entry.context?.type === "album";
          const albumId = isAlbum ? (entry.context?.id || entry.track.album?.id) : undefined;

          if (albumId) {
            const albumKey = `album:${albumId}`;
            if (seen.has(albumKey)) continue;
            seen.add(albumKey);
            seen.add(`track:${entry.track.id}`);

            const clientTrack = toClientTrack(entry.track);
            items.push({
              type: "album",
              item: {
                id: albumId,
                title: entry.track.album?.title || clientTrack.title,
                artist: clientTrack.artists,
                coverUrl: clientTrack.coverUrl,
                totalTracks: 0,
                albumType: "album",
              },
              playCount: 1,
            });
          } else {
            const trackKey = `track:${entry.track.id}`;
            if (seen.has(trackKey)) continue;
            seen.add(trackKey);

            items.push({
              type: "track",
              item: toClientTrack(entry.track),
              playCount: 1,
            });
          }

          if (items.length >= limit) {
            break;
          }
        }
        cache.set(key, { data: items, timestamp: Date.now() });
        setData(items);
      })
      .catch(() => {
        if (active && requestIdentity === getAuthSessionIdentity()) setData([]);
      })
      .finally(() => {
        if (active && requestIdentity === getAuthSessionIdentity()) setIsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [limit, identity, authRevision]);

  return { data, isLoading };
}
