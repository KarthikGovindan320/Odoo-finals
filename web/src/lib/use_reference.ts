/**
 * The dropdown data every form needs: departments, positions, types, schedules,
 * structures.
 *
 * Fetched once per session rather than once per component. useResource has no
 * cache, so opening the employee modal from the employee list fetched
 * /reference a second time while the parent already held it, and each leave form
 * fetched it again on every open.
 *
 * Reference data changes when someone edits configuration, which is rare and
 * always a deliberate act -- so an in-memory cache for the life of the page is
 * the right trade. `refreshReference()` exists for the screens that change it.
 */
import { useEffect, useState } from 'react';

import { api } from './api.ts';

export type Reference = {
  departments: Array<{ id: number; name: string; manager_employee_id: number | null }>;
  job_positions: Array<{ id: number; title: string; department_id: number | null }>;
  employment_types: Array<{ id: number; code: string; name: string }>;
  working_schedules: Array<{ id: number; name: string; schedule_type: string; hours_per_week: number }>;
  time_off_types: Array<{ id: number; code: string; name: string; unit: string; is_paid: boolean }>;
  salary_structures: Array<{ id: number; code: string; name: string; currency_code: string }>;
  salary_rule_categories: Array<{ id: number; code: string; name: string; sequence: number; sign: number }>;
};

type Listener = () => void;

let cached: Reference | null = null;
let inFlight: Promise<Reference> | null = null;
const listeners = new Set<Listener>();

function load(): Promise<Reference> {
  // One request even if six components mount at once.
  inFlight ??= api
    .get<Reference>('/reference')
    .then((reference) => {
      cached = reference;
      inFlight = null;
      for (const listener of listeners) listener();
      return reference;
    })
    .catch((error: unknown) => {
      inFlight = null;
      throw error;
    });

  return inFlight;
}

/** Drops the cache and refetches. Call after changing configuration. */
export function refreshReference(): void {
  cached = null;
  void load();
}

export function useReference(): { data: Reference | null; error: string | null } {
  const [, forceRender] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const listener = (): void => forceRender((value) => value + 1);
    listeners.add(listener);

    if (cached === null) {
      load().catch(() => setError('Could not load the reference data this form needs.'));
    }

    return () => {
      listeners.delete(listener);
    };
  }, []);

  return { data: cached, error };
}
