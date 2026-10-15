import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ApiAlbum } from "@/shared/api";

export interface UseSearchAlbumsOptions {
  enabled?: boolean;
  limit?: number;
  debounceMs?: number;
}

export interface UseSearchAlbumsResult {
  albums: ApiAlbum[];
  loading: boolean;
  hasLoaded: boolean;
  error: Error | null;
  partialWarning?: string;
  runNow: () => void;
}

export function useSearchAlbums(
  query: string,
  options: UseSearchAlbumsOptions = {},
): UseSearchAlbumsResult {
  const { enabled = true, debounceMs = 250 } = options;
  const [albums, setAlbums] = useState<ApiAlbum[]>([]);
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
      const res = await api.search(q, "album");
      if (requestId !== latestRequestIdRef.current) return;
      setAlbums(
        res.items.filter((it): it is ApiAlbum => it.type === "album"),
      );
      setError(null);
      setPartialWarning(undefined);
      lastFetchedQueryRef.current = q;
      setHasLoaded(true);
    } catch (err) {
      if (requestId !== latestRequestIdRef.current) return;
      setAlbums([]);
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
      setAlbums([]);
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
    setAlbums([]);
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

  return { albums, loading, hasLoaded, error, partialWarning, runNow };
}
