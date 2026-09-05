import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';

import './styles/base.css';
import { AuthProvider, roleSlug, useAuth } from './lib/auth.tsx';
import { App } from './app/App.tsx';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('Root element is missing from index.html.');
}

/**
 * Prefixes every route with the signed-in role (e.g. /admin/employees) so the
 * address bar shows who is looking at the screen. The prefix has to be known
 * before the router reads the current location, which is why this waits on
 * auth to resolve rather than living inside App.
 */
function RoutedApp() {
  const { user, loading } = useAuth();

  if (loading) {
    return <div className="loading">Loading PeoplePay360…</div>;
  }

  const basename = user === null ? '' : `/${roleSlug(user.role_code)}`;

  // A hand-typed or stale bookmark missing the current role prefix is
  // corrected in place rather than left to render a blank router.
  if (basename !== '' && !window.location.pathname.startsWith(basename)) {
    window.history.replaceState(null, '', `${basename}${window.location.pathname}${window.location.search}`);
  }

  return (
    <BrowserRouter basename={basename || undefined}>
      <App />
    </BrowserRouter>
  );
}

createRoot(container).render(
  <StrictMode>
    <AuthProvider>
      <RoutedApp />
    </AuthProvider>
  </StrictMode>,
);
