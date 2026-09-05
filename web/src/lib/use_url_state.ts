/**
 * List state that lives in the URL rather than in the component.
 *
 * A list view's shape -- which view, what was searched, which filters, which page
 * -- is where the user is, not an implementation detail of the component that
 * happens to be mounted. Held in useState it is lost the moment they open a
 * record and come back, which is the one moment they most expect it to survive.
 *
 * Putting it in the URL fixes that for free (the browser restores the address on
 * Back) and makes a filtered list something you can bookmark or send to someone.
 *
 * Writes replace rather than push. Every keystroke in a search box would
 * otherwise be its own history entry, and Back would walk the user backwards
 * through their own typing instead of returning them to where they came from.
 */
import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';

export type UrlState<Keys extends string> = {
  /** Current values, with defaults applied for anything absent. */
  values: Record<Keys, string>;
  /** Merges a patch into the URL. Absent keys are left alone. */
  patch: (next: Partial<Record<Keys, string>>) => void;
};

export function useUrlState<Keys extends string>(
  defaults: Record<Keys, string>,
): UrlState<Keys> {
  const [params, setParams] = useSearchParams();

  const values = useMemo(() => {
    const resolved = {} as Record<Keys, string>;
    for (const key of Object.keys(defaults) as Keys[]) {
      resolved[key] = params.get(key) ?? defaults[key];
    }
    return resolved;
    // params is a new object each render; its string form is what actually changes.
  }, [params.toString(), defaults]);

  const patch = useCallback(
    (next: Partial<Record<Keys, string>>) => {
      const updated = new URLSearchParams(params);

      for (const [key, value] of Object.entries(next) as Array<[Keys, string]>) {
        // A value equal to its default is left out, so the common case stays a
        // clean URL rather than one carrying every field at its starting value.
        if (value === '' || value === defaults[key]) {
          updated.delete(key);
        } else {
          updated.set(key, value);
        }
      }

      setParams(updated, { replace: true });
    },
    [params, setParams, defaults],
  );

  return { values, patch };
}
