import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Listen on the LAN so another device on the same Wi‑Fi can open the UI.
    // Friend URL: http://<this-machine-ip>:5173  (API still proxied to localhost:4000)
    host: true,
    // The shared/ validation schemas live above web/, so the dev server has to be
    // allowed to read outside its root. They are imported directly rather than
    // duplicated, so the browser and the server enforce the same rules.
    fs: { allow: ['..'] },
    // Proxying the API keeps the browser on one origin, which means the session
    // cookie is first-party and needs no CORS negotiation in development.
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: false,
      },
    },
  },
});
