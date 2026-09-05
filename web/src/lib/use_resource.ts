/**
 * Minimal data fetching: load, reload, loading and error state.
 *
 * No query library. This app's server state is shallow -- a list, a record, a
 * dashboard -- and forty lines we can explain beats a dependency whose cache
 * semantics we would have to defend under questioning.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { api, ApiError } from './api.ts';

export type Resource<Data> = {
  data: Data | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
};

export function useResource<Data>(path: string | null, deps: unknown[] = []): Resource<Data> {
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const loadedPath = useRef<string | null>(path);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    if (path === null) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    // Drop the previous record when the address changes. Keeping it meant
    // navigating from one employee to another rendered the first one's name,
    // wage and bank details until the second arrived.
    if (path !== loadedPath.current) {
      setData(null);
      loadedPath.current = path;
    }

    api
      .get<Data>(path)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setError(caught instanceof ApiError ? caught.message : 'Something went wrong loading this page.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, nonce, ...deps]);

  return { data, loading, error, reload };
}

export type Page<Row> = {
  rows: Row[];
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
};
