import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';

import './styles/base.css';
import { AuthProvider } from './lib/auth.tsx';
import { App } from './app/App.tsx';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('Root element is missing from index.html.');
}

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
