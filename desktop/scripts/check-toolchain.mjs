import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = resolve(desktopRoot, '..')
const expectedNode = readFileSync(resolve(repositoryRoot, '.node-version'), 'utf8').trim()
const packageJson = JSON.parse(readFileSync(resolve(desktopRoot, 'package.json'), 'utf8'))
const expectedNpm = packageJson.packageManager.replace(/^npm@/, '')
const npmVersion = process.env.npm_config_user_agent?.match(/(?:^|\s)npm\/([^\s]+)/)?.[1]

if (process.versions.node !== expectedNode) {
  console.error(`Desktop reconstruction requires Node ${expectedNode}.`)
  process.exit(1)
}

if (npmVersion !== expectedNpm) {
  console.error(`Desktop reconstruction requires npm ${expectedNpm}.`)
  process.exit(1)
}
