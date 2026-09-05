import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router';

/**
 * "Back to the list" that actually returns you to the list you left.
 *
 * navigate('/employees') looks like going back but is really going to a fresh
 * list: the view, search, filters and page all live in the address, and a bare
 * path discards every one of them. Stepping back through history returns the
 * exact address instead.
 *
 * Falls back to the plain path when there is nothing to step back to -- someone
 * who opened the record from a bookmark or a shared link has no list behind
 * them, and navigate(-1) would take them out of the application.
 */
export function useBackTo(fallbackPath: string): () => void {
  const navigate = useNavigate();
  const location = useLocation();

  return useCallback(() => {
    // react-router counts entries it created; anything above the first means
    // there is somewhere of ours to go back to.
    const idx = (location as { key?: string; idx?: number }).idx;
    const hasHistory = typeof idx === 'number' ? idx > 0 : window.history.length > 1;

    if (hasHistory) {
      navigate(-1);
    } else {
      navigate(fallbackPath);
    }
  }, [navigate, location, fallbackPath]);
}
