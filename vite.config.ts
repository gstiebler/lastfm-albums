import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// No changeOrigin: the server builds the Last.fm callback URL from the Host header,
// so the sign-in cookie lands on the vite origin.
const proxy = Object.fromEntries(
  ['/api', '/login', '/callback', '/logout'].map((p) => [p, 'http://localhost:3000']),
);

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist', emptyOutDir: true },
  server: { proxy },
});
