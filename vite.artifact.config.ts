// Builds one self-contained bundle for the hosted preview page (see scripts/make-preview.mjs).
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  clearScreen: false,
  build: {
    outDir: 'dist-artifact',
    target: 'es2022',
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    rollupOptions: {
      output: { inlineDynamicImports: true, entryFileNames: 'app.js', assetFileNames: 'app[extname]' },
    },
  },
});
