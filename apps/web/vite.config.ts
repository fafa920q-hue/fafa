import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  root: 'apps/web',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:4000', ws: true },
      '/auth': 'http://localhost:4000',
      '^/subscription/': 'http://localhost:4000',
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
