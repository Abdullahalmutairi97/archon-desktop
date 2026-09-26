import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const lockPath = resolve(desktopRoot, 'package-lock.json')
const outputPath = resolve(desktopRoot, 'THIRD-PARTY-LICENSES.md')
const lock = JSON.parse(readFileSync(lockPath, 'utf8'))

function packageNameFromLockPath(lockPath, metadata) {
  if (metadata.name) return metadata.name
  const marker = 'node_modules/'
  const markerIndex = lockPath.lastIndexOf(marker)
  return markerIndex >= 0 ? lockPath.slice(markerIndex + marker.length) : lockPath
}

const packages = Object.entries(lock.packages)
  .filter(([lockPath]) => lockPath.startsWith('node_modules/') || lockPath.includes('/node_modules/'))
  .map(([lockPath, metadata]) => ({
    name: packageNameFromLockPath(lockPath, metadata),
    version: metadata.version ?? 'unversioned',
    license: typeof metadata.license === 'string' ? metadata.license : 'UNDECLARED',
  }))
  .sort((left, right) =>
    `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`),
  )

const undeclared = packages.filter((pkg) => pkg.license === 'UNDECLARED')
if (undeclared.length > 0) {
  console.error(`Missing license metadata for ${undeclared.length} locked dependencies.`)
  process.exit(1)
}

const rows = packages.map(({ name, version, license }) => `| \`${name}@${version}\` | ${license} |`)
const content = [
  '# Third-party dependency license inventory',
  '',
  `Generated from \`package-lock.json\` (${packages.length} locked dependency entries).`,
  'This inventory records package metadata; it does not replace notices shipped by upstream packages.',
  '',
  '| Package | Declared license |',
  '| --- | --- |',
  ...rows,
  '',
].join('\n')

if (process.argv.includes('--write')) {
  writeFileSync(outputPath, content)
  process.stdout.write(`Wrote ${packages.length} dependency license entries.\n`)
} else if (process.argv.includes('--check')) {
  const existing = readFileSync(outputPath, 'utf8')
  if (existing !== content) {
    console.error('THIRD-PARTY-LICENSES.md is out of date; run npm run licenses.')
    process.exit(1)
  }
} else {
  console.error('Use --write or --check.')
  process.exit(2)
}
