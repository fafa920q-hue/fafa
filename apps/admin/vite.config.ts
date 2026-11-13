import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig(({ mode }) => ({
  define: {
    // Same-origin admin UI: set ADMIN_API_SAME_ORIGIN=1 at build time to make
    // the admin UI call the backend on its own origin (through the Caddy
    // proxy), for example in isolated test environments. Otherwise production
    // builds call the production API origin and development builds stay
    // same-origin.
    'import.meta.env.VITE_API_ORIGIN': JSON.stringify(
      process.env.ADMIN_API_SAME_ORIGIN === '1'
        ? ''
        : mode === 'production'
          ? 'https://fafa888.uk'
          : '',
    ),
  },
  root: 'apps/admin',
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      '/api': { target: 'http://localhost:4000', ws: true },
      '/auth': 'http://localhost:4000',
      '^/subscription/': 'http://localhost:4000',
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
}));
