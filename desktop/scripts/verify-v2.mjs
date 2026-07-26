import { _electron as electron } from 'playwright-core'
import electronPath from 'electron'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const root = resolve(import.meta.dirname, '..')
const artifacts = process.env.ARCHON_E2E_ARTIFACTS ? resolve(process.env.ARCHON_E2E_ARTIFACTS) : resolve(root, 'artifacts', 'v2-verification')
const home = await mkdtemp(join(tmpdir(), 'archon-v2-home-'))
const serverUrl = process.env.ARCHON_E2E_SERVER_URL || 'http://127.0.0.1:8787'
const token = process.env.ARCHON_E2E_TOKEN
if (!token) throw new Error('ARCHON_E2E_TOKEN is required')
await mkdir(artifacts, { recursive: true })
await mkdir(join(home, '.config'), { recursive: true })
const imageFixture = resolve(root, 'src/renderer/src/assets/home-backdrop.png')

const checks = []
const check = (name, value, details = '') => {
  checks.push({ name, passed: Boolean(value), details })
  if (!value) throw new Error(`${name}${details ? `: ${details}` : ''}`)
}

async function launch() {
  const app = await electron.launch({
    executablePath: process.env.ARCHON_E2E_EXECUTABLE || electronPath,
    args: process.env.ARCHON_E2E_EXECUTABLE ? ['--no-sandbox', '--disable-gpu', '--password-store=basic'] : [resolve(root, 'out/main/index.js'), '--no-sandbox', '--disable-gpu', '--password-store=basic'],
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), ARCHON_E2E_ALLOW_PLAINTEXT_SAFE_STORAGE: '1' },
  })
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1380, height: 900 })
  await page.waitForFunction(() => Boolean(window.archon))
  return { app, page }
}

let errors = []
let launched = await launch()
let { app, page } = launched
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
page.on('pageerror', (error) => errors.push(error.message))
await page.evaluate(({ serverUrl, token }) => window.archon.setConnection({ serverUrl, token }), { serverUrl, token })
await page.reload()
try {
  await page.locator('.desktop-v2').waitFor({ timeout: 20_000 })
} catch (error) {
  await page.screenshot({ path: join(artifacts, '00-bootstrap-failure.png') })
  console.error(JSON.stringify({ url: page.url(), body: await page.locator('body').innerText(), errors, connection: await page.evaluate(() => window.archon?.getConnection()) }, null, 2))
  await app.close()
  throw error
}
await page.locator('.v2-start-canonical').waitFor({ timeout: 20_000 })

const shell = await page.evaluate(() => {
  const rect = (selector) => {
    const box = document.querySelector(selector)?.getBoundingClientRect()
    return box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null
  }
  return {
    viewport: { width: innerWidth, height: innerHeight },
    titlebar: rect('.titlebar'),
    sidebar: rect('.workspace-sidebar'),
    content: rect('.workspace-main'),
    root: rect('.desktop-v2'),
    bodyOverflow: getComputedStyle(document.body).overflow,
    middleOverflow: getComputedStyle(document.querySelector('.sidebar-scroll')).overflowY,
    titlebarButtons: document.querySelectorAll('.window-controls button').length,
    nav: [...document.querySelector('.sidebar-scroll').children].filter((node) => node.tagName === 'BUTTON').map((node) => node.querySelector('span')?.textContent?.trim()),
  }
})
check('36px titlebar', Math.abs(shell.titlebar.height - 36) < 0.1, JSON.stringify(shell.titlebar))
check('262px sidebar', Math.abs(shell.sidebar.width - 262) < 0.1, JSON.stringify(shell.sidebar))
check('100vh root', Math.abs(shell.root.height - shell.viewport.height) < 0.1, JSON.stringify(shell.root))
check('content consumes remaining width', Math.abs(shell.content.width - (shell.viewport.width - 262)) < 0.1, JSON.stringify(shell.content))
check('window controls present', shell.titlebarButtons === 3, String(shell.titlebarButtons))
check('shell body cannot scroll', shell.bodyOverflow === 'hidden', shell.bodyOverflow)
check('only sidebar middle scrolls', shell.middleOverflow === 'auto', shell.middleOverflow)
check('sidebar order', JSON.stringify(shell.nav) === JSON.stringify(['Chat','Sessions','Tasks','Projects','Skills','Automations','Backups','Logs']), JSON.stringify(shell.nav))
check('product version badge is not the Electron runtime version', await page.locator('.sidebar-brand > button').innerText() === 'v0.6.1', await page.locator('.sidebar-brand > button').innerText())
const homeFlow = await page.evaluate(() => {
  const hero = document.querySelector('.v2-start-heading')?.getBoundingClientRect()
  const composer = document.querySelector('.v2-start-composer')?.getBoundingClientRect()
  return hero && composer ? { heroTop: hero.top, heroBottom: hero.bottom, composerTop: composer.top, composerBottom: composer.bottom, viewport: innerHeight } : null
})
check('home hero and composer are ordered and fully visible', Boolean(homeFlow && homeFlow.heroTop >= 36 && homeFlow.heroBottom <= homeFlow.composerTop + 1 && homeFlow.composerBottom <= homeFlow.viewport), JSON.stringify(homeFlow))
await page.screenshot({ path: join(artifacts, '01-home-ltr.png') })

const approval = page.locator('.approval-button')
const initialApproval = (await approval.textContent()).trim()
const expectedCycle = initialApproval === 'Auto' ? ['Approve steps', 'Plan mode', 'Auto'] : initialApproval === 'Approve steps' ? ['Plan mode', 'Auto', 'Approve steps'] : ['Auto', 'Approve steps', 'Plan mode']
check('approval has a valid initial mode', ['Auto', 'Approve steps', 'Plan mode'].includes(initialApproval), initialApproval)
for (const expected of expectedCycle) {
  await approval.click()
  check(`approval cycles to ${expected}`, (await approval.textContent()).trim() === expected, (await approval.textContent()).trim())
}
await page.keyboard.press('Control+Shift+M')
await page.locator('.model-popover').waitFor()
check('model shortcut opens exactly one picker', await page.locator('.model-popover').count() === 1, String(await page.locator('.model-popover').count()))
await page.keyboard.press('Escape')

await page.getByLabel('Attach file').click()
await page.setInputFiles('input[type=file]', imageFixture)
await page.getByText('home-backdrop.png', { exact: true }).waitFor({ timeout: 10_000 })
check('attachment uploads to VPS staging', await page.getByText('home-backdrop.png', { exact: true }).isVisible())

await page.keyboard.press('Control+Backslash')
await page.waitForTimeout(200)
check('sidebar collapses completely', !(await page.locator('.workspace-sidebar').isVisible()))
check('content fills collapsed shell', await page.locator('.workspace-main').evaluate((el) => Math.abs(el.getBoundingClientRect().width - innerWidth) < 0.1))
await page.keyboard.press('Control+Backslash')
await page.locator('.workspace-sidebar').waitFor()

for (const name of ['Sessions', 'Tasks', 'Projects', 'Skills', 'Automations', 'Backups', 'Logs']) {
  await page.getByRole('button', { name: new RegExp(`^${name}`) }).first().click()
  await page.waitForTimeout(120)
  check(`${name} route renders`, await page.locator('.workspace-main').isVisible())
}
await page.getByRole('button', { name: /^Tasks/ }).first().click()
await page.screenshot({ path: join(artifacts, '02-tasks.png') })

await page.locator('.sidebar-footer > button').last().click()
await page.getByRole('dialog', { name: 'Settings' }).waitFor()
await page.getByRole('button', { name: 'Appearance', exact: true }).click()
const backgroundInput = page.locator('input[accept="image/png,image/jpeg,image/webp"]')
const markInput = page.locator('input[accept*="image/svg+xml"]')
await markInput.setInputFiles(imageFixture)
await backgroundInput.setInputFiles(imageFixture)
await page.getByRole('button', { name: /Obsidian/ }).click()
await page.waitForTimeout(250)
check('theme applied', await page.evaluate(() => document.documentElement.dataset.theme === 'obsidian'), await page.evaluate(() => document.documentElement.dataset.theme))
const appearanceState = await page.evaluate(() => window.archon.getSettings())
check('appearance saved to disk', appearanceState?.theme === 'obsidian' && appearanceState?.appearance?.canvas === '#1a1a1a', JSON.stringify(appearanceState?.appearance))
check('background stored as device metadata', Boolean(appearanceState?.appearance?.backgroundId) && !JSON.stringify(appearanceState).includes('data:image'), JSON.stringify(appearanceState?.appearance))
check('background library persists safe device metadata', Array.isArray(appearanceState?.appearance?.backgroundLibrary) && appearanceState.appearance.backgroundLibrary.length === 1, JSON.stringify(appearanceState?.appearance?.backgroundLibrary))
check('appearance shows exactly three user background slots', await page.locator('.background-reference-grid > button').count() === 5, String(await page.locator('.background-reference-grid > button').count()))
const customAssetsLoaded = await page.evaluate(async () => {
  const settings = await window.archon.getSettings()
  const urls = [settings?.appearance?.customMark, settings?.appearance?.backgroundImage].filter(Boolean)
  const loaded = await Promise.all(urls.map((url) => new Promise((resolve) => { const image = new Image(); image.onload = () => resolve(true); image.onerror = () => resolve(false); image.src = url })))
  const fetches = await Promise.all(urls.map(async (url) => { try { const response = await fetch(url); return { ok: response.ok, status: response.status, type: response.headers.get('content-type'), size: (await response.arrayBuffer()).byteLength } } catch (error) { return { error: String(error) } } }))
  return { urls, loaded, fetches }
})
check('custom mark and background load from protected device storage', customAssetsLoaded.urls.length === 2 && customAssetsLoaded.loaded.every(Boolean), `${JSON.stringify(customAssetsLoaded)} console=${JSON.stringify(errors)}`)

await page.getByRole('button', { name: 'Language', exact: true }).click()
await page.getByRole('button', { name: /العربية/ }).click()
check('RTL enabled', await page.evaluate(() => document.documentElement.dir === 'rtl'))
const rtl = await page.evaluate(() => {
  const sidebar = document.querySelector('.workspace-sidebar').getBoundingClientRect()
  const content = document.querySelector('.workspace-main').getBoundingClientRect()
  const existing = document.querySelector('code')
  const code = existing || document.body.appendChild(document.createElement('code'))
  if (!existing) code.textContent = '/tmp/archon-example'
  const codeDirection = getComputedStyle(code).direction
  if (!existing) code.remove()
  return { sidebarX: sidebar.x, contentX: content.x, sidebarWidth: sidebar.width, viewport: innerWidth, codeDirection }
})
check('RTL mirrors complete shell', Math.abs(rtl.sidebarX - (rtl.viewport - rtl.sidebarWidth)) < 0.1 && rtl.contentX === 0, JSON.stringify(rtl))
check('code remains LTR', rtl.codeDirection === 'ltr', rtl.codeDirection)
await page.screenshot({ path: join(artifacts, '03-settings-rtl.png') })
await page.keyboard.press('Escape')
check('Escape closes settings', !(await page.getByRole('dialog', { name: 'Settings' }).isVisible()))
const updateButton = page.getByTitle('Check for updates')
const updateHitTarget = await updateButton.evaluate((element) => {
  const box = element.getBoundingClientRect()
  const x = box.left + box.width / 2
  const y = box.top + box.height / 2
  const hit = document.elementFromPoint(x, y)
  return { box: { x: box.x, y: box.y, width: box.width, height: box.height }, hit: hit?.tagName, hitClass: hit?.getAttribute('class'), interactive: hit === element || element.contains(hit) }
})
check('update button has an unobstructed pointer target', updateHitTarget.interactive, JSON.stringify(updateHitTarget))
await updateButton.click()
await page.getByRole('dialog', { name: /Archon Desktop update/i }).waitFor()
check('update dialog shows version and task continuity', (await page.getByRole('dialog', { name: /Archon Desktop update/i }).innerText()).includes('Tasks and sessions live on the server'))
check('update dialog has exact actions', await page.getByRole('button', { name: 'Cancel' }).isVisible() && await page.getByRole('button', { name: 'Update and restart' }).isVisible())
await page.keyboard.press('Escape')
check('Escape closes update dialog', await page.getByRole('dialog', { name: /Archon Desktop update/i }).count() === 0)
await page.keyboard.press('Control+1')
await page.waitForTimeout(100)
const activityTitle = (await page.locator('.bench-tabs button.active').textContent())?.trim()
check('Activity shortcut works', activityTitle?.startsWith('Activity'), String(activityTitle))
await page.keyboard.press('Control+2')
await page.waitForTimeout(100)
const filesTitle = (await page.locator('.bench-tabs button.active').textContent())?.trim()
check('Files shortcut works', filesTitle === 'Files', String(filesTitle))
await page.keyboard.press('Control+3')
await page.waitForTimeout(100)
const terminalTitle = (await page.locator('.bench-tabs button.active').textContent())?.trim()
check('Terminal shortcut works', terminalTitle === 'Terminal', String(terminalTitle))

for (const [width,height] of [[1040,680],[1600,1000]]) {
  await page.setViewportSize({ width, height })
  const dimensions = await page.evaluate(() => ({ root:document.querySelector('.desktop-v2').getBoundingClientRect(), sidebar:document.querySelector('.workspace-sidebar').getBoundingClientRect(), overflow:getComputedStyle(document.body).overflow }))
  check(`${width}x${height} shell stays exact`, dimensions.root.width === width && dimensions.root.height === height && dimensions.sidebar.width === 262 && dimensions.overflow === 'hidden', JSON.stringify(dimensions))
}

await app.close()
launched = await launch(); app = launched.app; page = launched.page
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
page.on('pageerror', (error) => errors.push(error.message))
await page.waitForFunction(() => Boolean(window.archon))
await page.locator('.desktop-v2').waitFor({ timeout: 20_000 })
check('appearance survives relaunch', await page.evaluate(() => document.documentElement.dataset.theme === 'obsidian'), await page.evaluate(() => document.documentElement.dataset.theme))
check('connection survives relaunch through safeStorage', await page.locator('.workspace-sidebar').isVisible())
await app.close()

check('renderer produced no console errors', errors.length === 0, JSON.stringify(errors))
const report = { generatedAt: new Date().toISOString(), serverUrl, viewport: shell.viewport, home, checks }
await writeFile(join(artifacts, 'report.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify({ artifacts, checks: checks.length, passed: checks.filter((item) => item.passed).length }, null, 2))
