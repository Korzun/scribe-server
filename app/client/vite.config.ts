import path from 'path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const apiUrl = process.env['API_URL'] ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '~': path.resolve(import.meta.dirname, './src'),
    },
  },
  server: {
    proxy: {
      // Dev serves the SPA off vite's own port, so API calls need a
      // same-origin proxy to reach the real server (and for the refresh
      // cookie, scoped to /api/v1/session, to travel).
      '/api': apiUrl,
    },
    watch: process.env['DOCKER'] ? { usePolling: true } : {},
    host: true,
  },
  build: {
    outDir: 'dist',
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/setup.ts'],
  },
});
