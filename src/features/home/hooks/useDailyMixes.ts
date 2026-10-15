import { useEffect, useState } from "react";
import { api, getAuthSessionIdentity, toClientTrack, mediaUrl } from "@/shared/api";
import { queryCache } from "@/shared/cache/queryCache";
import type { Track } from "@/shared/types";
import type { CollectionPageData } from "@/features/collection/hooks/useCollection";

export interface DailyMix {
  id: string;
  title: string;
  description: string;
  clusterArtists: string[];
  coverUrl?: string;
  trackCount: number;
  tracks: Track[];
}

export function getDailyMixArtists(
  clusterArtists?: string[],
  tracks?: Track[],
  targetCount: number = 4,
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  const addName = (raw?: string) => {
    if (!raw) return;
    const name = raw.trim();
    if (!name || name.toLowerCase() === "unknown" || seen.has(name.toLowerCase())) {
      return;
    }
    seen.add(name.toLowerCase());
    result.push(name);
  };

  if (Array.isArray(clusterArtists)) {
    for (const name of clusterArtists) {
      addName(name);
      if (result.length >= targetCount) return result;
    }
  }

  if (Array.isArray(tracks)) {
    for (const track of tracks) {
      if (track.artistList && track.artistList.length > 0) {
        for (const a of track.artistList) {
          addName(a.name);
          if (result.length >= targetCount) return result;
        }
      } else if (track.artists) {
        const parts = track.artists.split(",").map((p) => p.trim()).filter(Boolean);
        for (const part of parts) {
          addName(part);
          if (result.length >= targetCount) return result;
        }
      }
    }
  }

  return result;
}

const cache = new Map<string, { data: DailyMix[]; timestamp: number }>();
const CACHE_TTL = 120_000;

export function getDailyMixesCollectionCacheKey(identity: string, id: string): string {
  return `collection:playlist:daily-mixes:${identity}:${id}`;
}

export function useDailyMixes() {
  const [authRevision, setAuthRevision] = useState(0);
  const identity = getAuthSessionIdentity();
  const cached = cache.get(identity);
  const [data, setData] = useState<DailyMix[]>(() => {
    return cached?.data ?? [];
  });
  const [isLoading, setIsLoading] = useState(() => !cached || cached.data.length === 0);

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
    if (requestIdentity === "anonymous") {
      setData([]);
      setIsLoading(false);
      return;
    }
    const current = cache.get(requestIdentity);
    if (current && current.data.length > 0 && Date.now() - current.timestamp < CACHE_TTL) {
      setData(current.data);
      setIsLoading(false);
      return;
    }

    let active = true;
    api
      .getDailyMixes()
      .then((res) => {
        if (!active || requestIdentity !== getAuthSessionIdentity()) return;
        const mixes: DailyMix[] = (res.items || []).map((mix) => {
          const clientTracks = (mix.tracks || []).map((t) => toClientTrack(t));
          const primaryCover =
            mix.cover?.url ? mediaUrl(mix.cover.url) :
            (clientTracks[0]?.coverUrl ||
            clientTracks[1]?.coverUrl);

          const computedArtists = getDailyMixArtists(mix.clusterArtists, clientTracks, 4);

          const mixItem: DailyMix = {
            id: mix.id,
            title: mix.title,
            description: mix.description,
            clusterArtists: computedArtists,
            coverUrl: primaryCover,
            trackCount: mix.trackCount || clientTracks.length,
            tracks: clientTracks,
          };

          // Pre-cache collection playlist page so clicking opens instantly
          const collectionData: CollectionPageData = {
            type: "playlist",
            title: mix.title,
            author: computedArtists.length > 0 ? computedArtists.join(", ") : "Daily Mix",
            description: mix.description,
            coverUrl: primaryCover || "",
            tracks: clientTracks,
          };
          queryCache.set(getDailyMixesCollectionCacheKey(requestIdentity, mix.id), collectionData);

          return mixItem;
        });

        cache.set(requestIdentity, { data: mixes, timestamp: Date.now() });
        setData(mixes);
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
  }, [identity, authRevision]);

  return { data, isLoading };
}
