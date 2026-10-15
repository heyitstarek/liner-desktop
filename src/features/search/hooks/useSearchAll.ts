import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ApiSearchItem } from "@/shared/api";

export interface UseSearchAllOptions {
  enabled: boolean;
  limit: number;
  debounceMs: number;
}

export interface UseSearchAllResult {
  items: ApiSearchItem[];
  loading: boolean;
  hasLoaded: boolean;
  partialWarning?: string;
  runNow: () => void;
}

export function useSearchAll(
  query: string,
  options: UseSearchAllOptions,
): UseSearchAllResult {
  const [items, setItems] = useState<ApiSearchItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [partialWarning, setPartialWarning] = useState<string | undefined>();

  const latestRequestIdRef = useRef(0);
  const lastFetchedQueryRef = useRef("");
  const trimmed = query.trim();
  const shouldRunSearch = options.enabled && trimmed.length >= 2;

  const runRequest = useCallback(
    async (requestId: number, q: string) => {
      if (requestId !== latestRequestIdRef.current) return;
      setLoading(true);
      try {
        const res = await api.search(q, "all");
        if (requestId !== latestRequestIdRef.current) return;
        setItems(res.items);
        setPartialWarning(undefined);
        lastFetchedQueryRef.current = q;
        setHasLoaded(true);
      } catch {
        if (requestId !== latestRequestIdRef.current) return;
        setItems([]);
        setPartialWarning(undefined);
        setHasLoaded(true);
      } finally {
        if (requestId === latestRequestIdRef.current) setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    const requestId = ++latestRequestIdRef.current;
    if (trimmed.length < 2 || !options.enabled) {
      setItems([]);
      setHasLoaded(false);
      setLoading(false);
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
    setItems([]);
    setHasLoaded(false);
    setPartialWarning(undefined);
    setLoading(true);
    const timer = setTimeout(() => {
      if (requestId !== latestRequestIdRef.current) return;
      void runRequest(requestId, trimmed);
    }, options.debounceMs ?? 320);

    return () => {
      clearTimeout(timer);
      if (latestRequestIdRef.current === requestId) latestRequestIdRef.current++;
    };
  }, [options.debounceMs, options.enabled, runRequest, trimmed]);

  const runNow = useCallback(() => {
    if (!shouldRunSearch) return;
    const requestId = ++latestRequestIdRef.current;
    void runRequest(requestId, trimmed);
  }, [runRequest, shouldRunSearch, trimmed]);

  return { items, loading, hasLoaded, partialWarning, runNow };
}
