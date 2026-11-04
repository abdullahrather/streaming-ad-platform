import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = `http://localhost:${process.env.PORT ?? 3000}`;

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        watch: resolve(import.meta.dirname, 'watch.html'),
      },
    },
  },
  server: {
    proxy: Object.fromEntries(
      [
        '/auth',
        '/account',
        '/admin',
        '/alerts',
        '/campaigns',
        '/click',
        '/creatives',
        '/dev',
        '/docs',
        '/invitations',
        '/media',
        '/openapi.json',
        '/player',
        '/reports',
        '/segments',
        '/shows',
        '/team',
        '/track',
        '/vast',
      ].map((path) => [path, { target: api, changeOrigin: false }]),
    ),
  },
});
