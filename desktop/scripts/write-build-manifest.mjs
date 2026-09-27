import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = resolve(desktopRoot, '..')
const packageJson = JSON.parse(readFileSync(resolve(desktopRoot, 'package.json'), 'utf8'))
const lockBytes = readFileSync(resolve(desktopRoot, 'package-lock.json'))
const lockSha256 = createHash('sha256').update(lockBytes).digest('hex')

function walkFiles(path) {
  const absolute = resolve(path)
  const metadata = statSync(absolute)
  if (metadata.isFile()) return [absolute]
  if (!metadata.isDirectory()) return []
  return readdirSync(absolute, { withFileTypes: true })
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .flatMap((entry) => walkFiles(resolve(absolute, entry.name)))
}

function recordFile(path) {
  const bytes = readFileSync(path)
  return {
    path: path.slice(repositoryRoot.length + 1).split(/[\\/]/).join('/'),
    size: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

function commandOutput(command, args, fallback) {
  try {
    return execFileSync(command, args, {
      cwd: repositoryRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return fallback
  }
}

const environmentCommit = process.env.SOURCE_COMMIT ?? ''
const sourceCommit = /^[0-9a-f]{40,64}$/i.test(environmentCommit)
  ? environmentCommit
  : commandOutput('git', ['rev-parse', '--verify', 'HEAD'], 'unavailable')
const dirtyState = commandOutput('git', ['status', '--porcelain', '--untracked-files=all'], '')
const npmVersion = process.env.npm_config_user_agent?.match(/(?:^|\s)npm\/([^\s]+)/)?.[1] ?? 'unknown'
const sourceInputs = [
  resolve(repositoryRoot, '.node-version'),
  resolve(repositoryRoot, 'package.json'),
  resolve(repositoryRoot, '.github/workflows/desktop-reconstruction.yml'),
  resolve(desktopRoot, 'package.json'),
  resolve(desktopRoot, 'package-lock.json'),
  resolve(desktopRoot, 'tsconfig.json'),
  resolve(desktopRoot, 'electron.vite.config.ts'),
  resolve(desktopRoot, 'vite.preview.config.ts'),
  resolve(desktopRoot, 'vitest.config.ts'),
  resolve(desktopRoot, 'vitest.setup.ts'),
  resolve(desktopRoot, 'BUILD-PROVENANCE.md'),
  resolve(desktopRoot, 'THIRD-PARTY-LICENSES.md'),
  resolve(desktopRoot, 'scripts/check-toolchain.mjs'),
  resolve(desktopRoot, 'scripts/license-inventory.mjs'),
  resolve(desktopRoot, 'scripts/write-build-manifest.mjs'),
  ...walkFiles(resolve(desktopRoot, 'src')),
]
const inputs = [...new Set(sourceInputs)]
  .map(recordFile)
  .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
const outputRoot = resolve(desktopRoot, 'out')
const outputs = ['main', 'preload', 'renderer']
  .flatMap((name) => walkFiles(resolve(outputRoot, name)))
  .map(recordFile)
  .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))

const manifest = {
  appVersion: packageJson.version,
  channel: 'reconstruction',
  sourceCommit,
  sourceTreeHasChanges: dirtyState.length > 0,
  baselineParity: 'unverified',
  liveConnectionsEnabled: true,
  nodeVersion: process.versions.node,
  npmVersion,
  lockSha256,
  platform: process.platform,
  architecture: process.arch,
  inputs,
  outputs,
}

const outputPath = resolve(desktopRoot, 'out/build-manifest.json')
mkdirSync(dirname(outputPath), { recursive: true })
writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`)
process.stdout.write(`Wrote reconstruction build metadata to ${outputPath}.\n`)
