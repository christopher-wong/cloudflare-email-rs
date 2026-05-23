import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// In dev, proxy /api/* to a locally running `wrangler dev` so the SPA works
// end-to-end without CORS. Override via VITE_API_TARGET if your worker is
// running on a non-default port.
const apiTarget = process.env.VITE_API_TARGET || 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
});
