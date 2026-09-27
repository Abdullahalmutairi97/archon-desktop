#!/usr/bin/env node
/**
 * Isolated canonical comparison for the frozen v0.3.0 input and a rebuilt candidate.
 *
 * Verifies that the frozen archive's baseline files match `current/baseline.json`
 * exactly, and that a candidate built from it keeps the untouched baseline files
 * byte-identical while carrying the expected patched renderer, bundled PeerJS and
 * patched renderer CSP. It changes no official hashes and lowers no threshold.
 *
 * Usage: node testing/canonical-compare.cjs <frozen.asar> [candidate.asar]
 */
const crypto = require('crypto')
const path = require('path')
const asar = require('@electron/asar')

const baseline = require(path.join(__dirname, '..', 'baseline.json'))
// Files the kit intentionally leaves byte-identical, and files it intentionally patches.
const UNCHANGED = ['package.json', 'dist/main/preload.cjs']
const PATCHED = ['dist/main/main.cjs', baseline.rendererPath]

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex')

function extract(archive, file) {
  try {
    return asar.extractFile(archive, file)
  } catch {
    return undefined
  }
}

function baselineReport(archive) {
  const files = {}
  let ok = true
  for (const [file, expected] of Object.entries(baseline.files)) {
    const buffer = extract(archive, file)
    if (buffer === undefined) {
      files[file] = { present: false, expected, match: false }
      ok = false
      continue
    }
    const actual = sha256(buffer)
    const match = actual === expected
    files[file] = { present: true, expected, actual, match }
    if (!match) ok = false
  }
  return { ok, files }
}

function candidateReport(archive) {
  const files = {}
  for (const [file, expected] of Object.entries(baseline.files)) {
    const buffer = extract(archive, file)
    files[file] = buffer === undefined
      ? { present: false, matchesBaseline: false }
      : { present: true, sha256: sha256(buffer), matchesBaseline: sha256(buffer) === expected }
  }
  const peerjs = extract(archive, 'dist/renderer/peerjs.min.js')
  const html = extract(archive, 'dist/renderer/index.html')
  return {
    files,
    peerjsBundled: peerjs !== undefined,
    peerjsCsp: html !== undefined && html.toString('utf8').includes('wss://0.peerjs.com'),
  }
}

function main() {
  const [frozenPath, candidatePath] = process.argv.slice(2)
  if (!frozenPath) {
    console.error('usage: canonical-compare.cjs <frozen.asar> [candidate.asar]')
    process.exit(2)
  }
  const report = { frozen: { path: frozenPath, ...baselineReport(frozenPath) } }
  let candidateOk = true
  if (candidatePath) {
    const candidate = candidateReport(candidatePath)
    report.candidate = { path: candidatePath, ...candidate }
    candidateOk = UNCHANGED.every((file) => candidate.files[file]?.matchesBaseline)
      && PATCHED.every((file) => candidate.files[file]?.present && !candidate.files[file]?.matchesBaseline)
      && candidate.peerjsBundled
      && candidate.peerjsCsp
  }
  console.log(JSON.stringify(report, null, 2))
  process.exit(report.frozen.ok && candidateOk ? 0 : 1)
}

main()
