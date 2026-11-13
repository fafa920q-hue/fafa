import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig(({ mode }) => ({
  define: {
    'import.meta.env.VITE_API_ORIGIN': JSON.stringify(
      mode === 'production' ? 'https://fafa888.uk' : '',
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
