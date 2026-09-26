import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const desktopRoot = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: resolve(desktopRoot, 'src/renderer'),
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve(desktopRoot, 'src/shared'),
    },
  },
  build: {
    outDir: resolve(desktopRoot, 'out/renderer'),
    emptyOutDir: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
  },
})
