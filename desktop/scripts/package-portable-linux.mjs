import { createHash } from 'node:crypto'
import {
  copyFileSync,
  cpSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = resolve(desktopRoot, '..')
const packageJson = JSON.parse(readFileSync(resolve(desktopRoot, 'package.json'), 'utf8'))
const buildConfig = packageJson.build

function fail(message) {
  throw new Error(message)
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function inside(parent, path) {
  const relativePath = relative(parent, path)
  return relativePath !== '' && relativePath !== '..'
    && !relativePath.startsWith('..' + sep) && !isAbsolute(relativePath)
}

function assertRecorded(manifest, file) {
  const relativePath = relative(repositoryRoot, file).split(sep).join('/')
  const record = manifest.inputs.find((input) => input.path === relativePath)
  const bytes = readFileSync(file)
  if (!record || record.size !== bytes.length || record.sha256 !== hash(bytes)) {
    fail('Build manifest does not match packaging input: ' + relativePath)
  }
}

function verifyAndCopyOutputs(manifest, outRoot, appRoot) {
  const allowedRoots = new Set(['main', 'preload', 'renderer', 'runner'])
  const foundRoots = new Set()
  if (!Array.isArray(manifest.outputs) || manifest.outputs.length === 0) {
    fail('Build manifest has no compiled output inventory.')
  }

  for (const output of manifest.outputs) {
    const prefix = 'desktop/out/'
    if (typeof output.path !== 'string' || !output.path.startsWith(prefix)) {
      fail('Build manifest includes an output outside desktop/out/.')
    }
    const relativeOutput = output.path.slice(prefix.length)
    const segments = relativeOutput.split('/')
    if (
      segments.length < 2 || !allowedRoots.has(segments[0]) ||
      segments.some((segment) => segment === '' || segment === '.' || segment === '..')
    ) {
      fail('Build manifest includes a non-allowlisted output path: ' + output.path)
    }
    foundRoots.add(segments[0])
    const source = resolve(repositoryRoot, output.path)
    if (!inside(outRoot, source)) fail('Build output path escaped desktop/out/.')
    const metadata = lstatSync(source)
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      fail('Compiled output is not a regular file: ' + output.path)
    }
    const bytes = readFileSync(source)
    if (bytes.length !== output.size || hash(bytes) !== output.sha256) {
      fail('Compiled output differs from build manifest: ' + output.path)
    }
    const destination = resolve(appRoot, 'out', relativeOutput)
    if (!inside(appRoot, destination)) fail('Build output destination escaped package app directory.')
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, bytes, { mode: metadata.mode & 0o777 })
  }

  for (const root of allowedRoots) {
    if (!foundRoots.has(root)) fail('Build manifest is missing the ' + root + ' output tree.')
  }
}

function verifyElectronDistAllowlist(electronDist) {
  const files = new Set([
    'LICENSE',
    'LICENSES.chromium.html',
    'chrome-sandbox',
    'chrome_100_percent.pak',
    'chrome_200_percent.pak',
    'chrome_crashpad_handler',
    'electron',
    'icudtl.dat',
    'libffmpeg.so',
    'libvk_swiftshader.so',
    'libvulkan.so.1',
    'resources.pak',
    'snapshot_blob.bin',
    'v8_context_snapshot.bin',
    'version',
    'vk_swiftshader_icd.json',
  ])
  const entries = readdirSync(electronDist, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isSymbolicLink()) fail('Pinned Electron dist contains a symbolic link: ' + entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'locales' && entry.name !== 'resources') {
        fail('Pinned Electron dist contains an unallowlisted directory: ' + entry.name)
      }
      const children = readdirSync(resolve(electronDist, entry.name), { withFileTypes: true })
      for (const child of children) {
        if (child.isSymbolicLink() || !child.isFile()) {
          fail('Pinned Electron dist contains an unallowlisted nested entry: ' + entry.name + '/' + child.name)
        }
        const allowed = entry.name === 'locales'
          ? /^[a-zA-Z0-9-]+\.pak$/u.test(child.name)
          : child.name === 'default_app.asar'
        if (!allowed) fail('Pinned Electron dist contains an unallowlisted file: ' + entry.name + '/' + child.name)
      }
      if (entry.name === 'resources'
        && !children.some((child) => child.name === 'default_app.asar' && child.isFile())) {
        fail('Pinned Electron dist is missing resources/default_app.asar.')
      }
      if (entry.name === 'locales' && children.length === 0) {
        fail('Pinned Electron dist is missing its locale files.')
      }
      continue
    }
    if (!entry.isFile() || !files.delete(entry.name)) {
      fail('Pinned Electron dist contains an unallowlisted entry: ' + entry.name)
    }
  }
  if (files.size > 0) fail('Pinned Electron dist is missing required files: ' + [...files].join(', '))
  for (const directory of ['locales', 'resources']) {
    if (!entries.some((entry) => entry.name === directory && entry.isDirectory())) {
      fail('Pinned Electron dist is missing the ' + directory + ' directory.')
    }
  }
}

function pathExists(path) {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

function main() {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    fail('Portable packaging currently supports Linux x64 only.')
  }
  const expectedNode = readFileSync(resolve(repositoryRoot, '.node-version'), 'utf8').trim()
  const expectedNpm = packageJson.packageManager?.replace(/^npm@/u, '')
  const npmVersion = process.env.npm_config_user_agent?.match(/(?:^|\s)npm\/([^\s]+)/u)?.[1]
  if (process.versions.node !== expectedNode) fail('Portable packaging requires Node ' + expectedNode + '.')
  if (npmVersion !== expectedNpm) fail('Portable packaging requires npm ' + expectedNpm + ' via npm run.')

  const git = (args) => execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' }).trim()
  const sourceCommit = git(['rev-parse', '--verify', 'HEAD'])
  if (git(['status', '--porcelain', '--untracked-files=all']) !== '') {
    fail('Portable packaging requires a clean Git worktree.')
  }

  const manifestPath = resolve(desktopRoot, 'out/build-manifest.json')
  const manifestBytes = readFileSync(manifestPath)
  const manifest = JSON.parse(manifestBytes.toString('utf8'))
  const lockPath = resolve(desktopRoot, 'package-lock.json')
  const lockSha256 = hash(readFileSync(lockPath))
  if (manifest.appVersion !== packageJson.version || manifest.sourceCommit !== sourceCommit
    || manifest.sourceTreeHasChanges !== false || manifest.lockSha256 !== lockSha256
    || manifest.nodeVersion !== expectedNode || manifest.npmVersion !== expectedNpm
    || manifest.platform !== 'linux' || manifest.architecture !== 'x64') {
    fail('Build manifest does not describe the pinned toolchain and clean current Linux x64 source.')
  }
  for (const input of [
    resolve(repositoryRoot, 'package.json'),
    resolve(desktopRoot, 'package.json'),
    lockPath,
    resolve(desktopRoot, 'BUILD-PROVENANCE.md'),
    resolve(desktopRoot, 'PORTABLE-PACKAGE.md'),
    resolve(desktopRoot, 'THIRD-PARTY-LICENSES.md'),
    resolve(desktopRoot, 'scripts/package-portable-linux.mjs'),
    resolve(desktopRoot, 'scripts/write-build-manifest.mjs'),
  ]) {
    assertRecorded(manifest, input)
  }

  const electronRoot = resolve(desktopRoot, 'node_modules/electron')
  const electronVersion = JSON.parse(readFileSync(resolve(electronRoot, 'package.json'), 'utf8')).version
  const electronDist = resolve(electronRoot, 'dist')
  const electronExecutable = resolve(electronDist, 'electron')
  const distVersion = readFileSync(resolve(electronDist, 'version'), 'utf8').trim().replace(/^v/u, '')
  const electronPath = readFileSync(resolve(electronRoot, 'path.txt'), 'utf8').trim()
  const pinnedElectron = packageJson.devDependencies.electron
  if (electronVersion !== pinnedElectron || distVersion !== pinnedElectron || electronPath !== 'electron') {
    fail('Installed Electron runtime does not match the pinned ' + pinnedElectron + '.')
  }
  const executableStat = lstatSync(electronExecutable)
  if (!executableStat.isFile() || (executableStat.mode & 0o111) === 0) {
    fail('Pinned Electron Linux executable is missing or not executable.')
  }
  verifyElectronDistAllowlist(electronDist)

  const releaseDir = resolve(desktopRoot, buildConfig.directories.output)
  if (!inside(desktopRoot, releaseDir)) fail('Configured release directory escaped desktop/.')
  mkdirSync(releaseDir, { recursive: true })
  if (!lstatSync(releaseDir).isDirectory()) fail('Release output must be a real directory.')
  const artifactName = 'Archon-Desktop-Reconstruction-' + packageJson.version + '-linux-x64.tar.gz'
  const artifactPath = resolve(releaseDir, artifactName)
  const checksumPath = artifactPath + '.sha256'
  if (pathExists(artifactPath) || pathExists(checksumPath)) {
    fail('Refusing to overwrite an existing portable artifact or checksum: ' + artifactPath)
  }

  const temporaryRoot = mkdtempSync(join(releaseDir, '.portable-package-'))
  let artifactLinked = false
  try {
    const bundleName = artifactName.slice(0, -'.tar.gz'.length)
    const bundleRoot = resolve(temporaryRoot, bundleName)
    const runtimeRoot = resolve(bundleRoot, 'electron')
    mkdirSync(bundleRoot, { recursive: true })
    cpSync(electronDist, runtimeRoot, { recursive: true, preserveTimestamps: true })
    copyFileSync(resolve(electronRoot, 'LICENSE'), resolve(bundleRoot, 'ELECTRON-LICENSE.txt'))

    const appRoot = resolve(runtimeRoot, 'resources/app')
    mkdirSync(appRoot, { recursive: true })
    verifyAndCopyOutputs(manifest, resolve(desktopRoot, 'out'), appRoot)
    copyFileSync(manifestPath, resolve(appRoot, 'build-manifest.json'))
    copyFileSync(resolve(desktopRoot, 'THIRD-PARTY-LICENSES.md'), resolve(appRoot, 'THIRD-PARTY-LICENSES.md'))
    copyFileSync(resolve(desktopRoot, 'PORTABLE-PACKAGE.md'), resolve(bundleRoot, 'README.md'))
    if (!pathExists(resolve(appRoot, packageJson.main)) || !pathExists(resolve(appRoot, 'out/renderer/index.html'))) {
      fail('Packaged Electron main or renderer entry point is missing.')
    }
    writeFileSync(resolve(appRoot, 'package.json'), JSON.stringify({
      name: packageJson.name,
      version: packageJson.version,
      description: packageJson.description,
      private: true,
      main: packageJson.main,
      productName: buildConfig.productName,
    }, null, 2) + '\n')

    const launcherName = buildConfig.linux.executableName
    if (typeof launcherName !== 'string' || !/^[a-z0-9][a-z0-9.-]*$/u.test(launcherName)) {
      fail('Linux executableName must be a simple lowercase filename.')
    }
    writeFileSync(resolve(bundleRoot, launcherName), [
      '#!/bin/sh',
      'set -eu',
      'SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)',
      'exec "$SCRIPT_DIR/electron/electron" "$@"',
      '',
    ].join('\n'), { mode: 0o755 })

    writeFileSync(resolve(bundleRoot, 'PORTABLE-MANIFEST.json'), JSON.stringify({
      format: 'archon-desktop-portable-package',
      version: 1,
      application: {
        name: packageJson.name,
        productName: buildConfig.productName,
        appId: buildConfig.appId,
        version: packageJson.version,
        channel: 'reconstruction',
      },
      target: { platform: 'linux', architecture: 'x64', format: 'tar.gz' },
      source: {
        commit: sourceCommit,
        lockSha256,
        buildManifestSha256: hash(manifestBytes),
        compiledOutputs: manifest.outputs,
      },
      toolchain: { node: expectedNode, npm: expectedNpm, electron: electronVersion },
    }, null, 2) + '\n')

    const temporaryArchive = resolve(temporaryRoot, artifactName + '.partial')
    execFileSync('tar', [
      '--sort=name',
      '--mtime=@0',
      '--owner=0',
      '--group=0',
      '--numeric-owner',
      '-czf',
      temporaryArchive,
      '-C',
      temporaryRoot,
      bundleName,
    ], { stdio: 'inherit' })
    const digest = hash(readFileSync(temporaryArchive))
    const temporaryChecksum = resolve(temporaryRoot, artifactName + '.sha256')
    writeFileSync(temporaryChecksum, digest + '  ' + artifactName + '\n')
    linkSync(temporaryArchive, artifactPath)
    artifactLinked = true
    try {
      linkSync(temporaryChecksum, checksumPath)
    } catch (error) {
      unlinkSync(artifactPath)
      artifactLinked = false
      throw error
    }
    console.log('Portable package: ' + artifactPath)
    console.log('SHA-256: ' + digest)
    console.log('Source commit: ' + sourceCommit)
  } catch (error) {
    if (artifactLinked) {
      try { unlinkSync(artifactPath) } catch {}
      try { unlinkSync(checksumPath) } catch {}
    }
    throw error
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true })
  }
}

try {
  main()
} catch (error) {
  console.error('Portable packaging failed: ' + (error instanceof Error ? error.message : String(error)))
  process.exitCode = 1
}
