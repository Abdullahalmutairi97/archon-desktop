import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import packageJson from './package.json'

const desktopRoot = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: desktopRoot,
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve(desktopRoot, 'src/shared'),
    },
  },
  define: {
    __ARCHON_BUILD_METADATA__: JSON.stringify({
      appVersion: packageJson.version,
      channel: 'reconstruction',
      sourceCommit: 'test',
      baselineParity: 'unverified',
      liveConnectionsEnabled: false,
    }),
  },
  test: {
    environment: 'jsdom',
    setupFiles: [resolve(desktopRoot, 'vitest.setup.ts')],
    include: ['src/**/*.test.{ts,tsx}'],
    clearMocks: true,
    restoreMocks: true,
  },
})
