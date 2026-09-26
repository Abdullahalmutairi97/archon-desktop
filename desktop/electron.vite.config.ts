import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import packageJson from './package.json'

const desktopRoot = dirname(fileURLToPath(import.meta.url))

function sourceCommit(): string {
  const provided = process.env.SOURCE_COMMIT
  if (provided && /^[0-9a-f]{40,64}$/i.test(provided)) return provided
  try {
    return execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: desktopRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return 'unavailable'
  }
}

const buildMetadata = {
  appVersion: packageJson.version,
  channel: 'reconstruction',
  sourceCommit: sourceCommit(),
  baselineParity: 'unverified',
  liveConnectionsEnabled: false,
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: resolve(desktopRoot, 'out/main'),
      emptyOutDir: true,
    },
  },
  renderer: {
    root: resolve(desktopRoot, 'src/renderer'),
    base: './',
    plugins: [react()],
    resolve: {
      alias: {
        '@shared': resolve(desktopRoot, 'src/shared'),
      },
    },
    define: {
      __ARCHON_BUILD_METADATA__: JSON.stringify(buildMetadata),
    },
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
    },
    build: {
      outDir: resolve(desktopRoot, 'out/renderer'),
      emptyOutDir: true,
    },
  },
})
