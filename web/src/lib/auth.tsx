/**
 * Session state for the browser.
 *
 * The permission map from /auth/me lets the UI hide what a role cannot do. That
 * is presentation only -- every route re-checks server-side, and hiding a button
 * has never stopped anyone editing a URL. `can()` exists to keep the interface
 * honest, not to keep it secure.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { api, ApiError, markSessionEstablished, onSessionExpired } from './api.ts';

export type AccessScope = 'own' | 'all';

export type CurrentUser = {
  user_id: number;
  email: string;
  role_code: string;
  role_name: string;
  employee_id: number | null;
  employee_name: string | null;
  permissions: Record<string, AccessScope>;
};

type AuthState = {
  user: CurrentUser | null;
  loading: boolean;
  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  can(permission: string): boolean;
  scopeOf(permission: string): AccessScope | null;
  /**
   * True only between signing in and the shell acting on it.
   *
   * The distinction that makes this necessary: restoring a session on page
   * refresh and signing in both take `user` from null to a value, and only one
   * of them should move you. Without it, refreshing a payslip URL bounces you to
   * the dashboard, and reload becomes a control that loses your place.
   */
  arrivedBySignIn: boolean;
  clearArrival(): void;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [arrivedBySignIn, setArrivedBySignIn] = useState(false);

  useEffect(() => {
    api
      .get<{ user: CurrentUser }>('/auth/me')
      .then((response) => {
        setUser(response.user);
        markSessionEstablished(true);
      })
      .catch((error: unknown) => {
        // A 401 here is the normal "not signed in yet" case, not a failure worth
        // reporting. Anything else is genuinely unexpected.
        if (!(error instanceof ApiError) || error.status !== 401) {
          console.error('Could not restore session:', error);
        }
        setUser(null);
      })
      .finally(() => setLoading(false));
  }, []);

  /**
   * A session that lapses mid-use drops the whole app back to the login screen,
   * rather than leaving every panel showing "Sign in to continue." inside a shell
   * the user can no longer use.
   */
  useEffect(() => onSessionExpired(() => setUser(null)), []);

  const signIn = useCallback(async (email: string, password: string) => {
    const response = await api.post<{ user: CurrentUser }>('/auth/login', { email, password });
    setUser(response.user);
    setArrivedBySignIn(true);
    markSessionEstablished(true);
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } finally {
      // Sign out locally even if the request failed. Leaving someone apparently
      // signed in because the network dropped is the wrong way round for a
      // control whose whole purpose is to end the session.
      markSessionEstablished(false);
      setUser(null);
      setArrivedBySignIn(false);
    }
  }, []);

  const clearArrival = useCallback(() => setArrivedBySignIn(false), []);

  const value = useMemo<AuthState>(
    () => ({
      user,
      loading,
      signIn,
      signOut,
      can: (permission) => user !== null && permission in user.permissions,
      scopeOf: (permission) => user?.permissions[permission] ?? null,
      arrivedBySignIn,
      clearArrival,
    }),
    [user, loading, signIn, signOut, arrivedBySignIn, clearArrival],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (context === null) {
    throw new Error('useAuth must be used inside an AuthProvider.');
  }
  return context;
}
