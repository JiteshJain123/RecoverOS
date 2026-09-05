"use client";
/** Client data-fetching hook against the same-origin BFF, with loading/error state. */
import { useCallback, useEffect, useState } from "react";
import { fetchJson } from "./client";
import type { ApiError } from "./types";

export interface UseApi<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
}

export function useApi<T>(path: string | null): UseApi<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (path === null) return;
    let alive = true;
    setLoading(true);
    setError(null);
    void fetchJson<T>(path).then((res) => {
      if (!alive) return;
      setData(res.data);
      setError(res.error);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [path, nonce]);

  return { data, error, loading, reload };
}
