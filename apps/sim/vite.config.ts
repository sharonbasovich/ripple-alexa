import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './', // GitHub Pages project-site safe
  server: {
    host: '127.0.0.1',
    // Keep the MCP server loopback-only. The browser speaks same-origin HTTP
    // to Vite, which proxies only this path during local development.
    proxy: {
      '/mcp': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: false,
      },
    },
  },
  build: { outDir: 'dist' },
});
