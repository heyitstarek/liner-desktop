import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ApiTrack } from "@/shared/api";
import { toClientTrack } from "@/shared/api";
import type { Track } from "@/shared/types";

export interface UseSearchTracksOptions {
  enabled?: boolean;
  limit?: number;
  debounceMs?: number;
}

export interface UseSearchTracksResult {
  tracks: Track[];
  loading: boolean;
  hasLoaded: boolean;
  error: Error | null;
  partialWarning?: string;
  runNow: () => void;
}

export function useSearchTracks(
  query: string,
  options: UseSearchTracksOptions = {},
): UseSearchTracksResult {
  const { enabled = true, debounceMs = 250 } = options;
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [partialWarning, setPartialWarning] = useState<string | undefined>();

  const latestRequestIdRef = useRef(0);
  const lastFetchedQueryRef = useRef("");
  const trimmed = query.trim();
  const shouldRunSearch = enabled && trimmed.length >= 2;

  const runRequest = useCallback(async (requestId: number, q: string) => {
    if (requestId !== latestRequestIdRef.current) return;
    setLoading(true);
    try {
      const res = await api.search(q, "track");
      if (requestId !== latestRequestIdRef.current) return;
      setTracks(
        res.items
          .filter(
            (it): it is ApiTrack & { type: "track" } => it.type === "track",
          )
          .map(toClientTrack),
      );
      setError(null);
      setPartialWarning(undefined);
      lastFetchedQueryRef.current = q;
      setHasLoaded(true);
    } catch (err) {
      if (requestId !== latestRequestIdRef.current) return;
      setTracks([]);
      setError(err instanceof Error ? err : new Error(String(err)));
      setPartialWarning(undefined);
      setHasLoaded(true);
    } finally {
      if (requestId === latestRequestIdRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const requestId = ++latestRequestIdRef.current;
    if (trimmed.length < 2 || !enabled) {
      setTracks([]);
      setHasLoaded(false);
      setLoading(false);
      setError(null);
      setPartialWarning(undefined);
      lastFetchedQueryRef.current = "";
      return;
    }

    if (lastFetchedQueryRef.current === trimmed) {
      setLoading(false);
      setHasLoaded(true);
      return;
    }

    lastFetchedQueryRef.current = "";
    setTracks([]);
    setHasLoaded(false);
    setError(null);
    setPartialWarning(undefined);
    setLoading(true);
    const timer = setTimeout(() => {
      if (requestId !== latestRequestIdRef.current) return;
      void runRequest(requestId, trimmed);
    }, debounceMs);

    return () => {
      clearTimeout(timer);
      if (latestRequestIdRef.current === requestId) latestRequestIdRef.current++;
    };
  }, [debounceMs, enabled, runRequest, trimmed]);

  const runNow = useCallback(() => {
    if (!shouldRunSearch) return;
    const requestId = ++latestRequestIdRef.current;
    void runRequest(requestId, trimmed);
  }, [runRequest, shouldRunSearch, trimmed]);

  return { tracks, loading, hasLoaded, error, partialWarning, runNow };
}
