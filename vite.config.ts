import { defineConfig } from 'vite';

// Works both as a plain web app (npm run dev / build) and inside Tauri.
export default defineConfig({
  base: './',
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: 'es2022', outDir: 'dist' },
});
