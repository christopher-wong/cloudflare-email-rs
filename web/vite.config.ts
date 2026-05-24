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
      // The hosted-download SW lives at /sw-download.js so the SPA can
      // request it from / and have it intercept /sw-download/<id>.
      // The dev server serves it from src/sw/hosted-download-sw.ts via a
      // synthetic entrypoint below — Vite handles the import graph and
      // hot-rebuild.
      '/api': { target: apiTarget, changeOrigin: true },
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      input: {
        // Main SPA bundle, anchored at the project root index.html.
        main: path.resolve(__dirname, 'index.html'),
        // The streaming-download service worker. Bundled as a separate
        // ES module entry so it can import shared decrypt code from
        // src/lib/secret-link.ts without us hand-rolling its deps.
        // Output filename is forced to `sw-download.js` (no hash) so
        // the registration URL is stable and predictable.
        'sw-download': path.resolve(__dirname, 'src/sw/hosted-download-sw.ts'),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === 'sw-download'
            ? '[name].js'
            : 'assets/[name]-[hash].js',
      },
    },
  },
});
