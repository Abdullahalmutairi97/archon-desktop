import { _electron as electron } from 'playwright-core'
import electronPath from 'electron'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const artifacts = resolve(root, 'artifacts')
await mkdir(artifacts, { recursive: true })
const profile = await mkdtemp(join(tmpdir(), 'archon-desktop-e2e-'))
const packagedExecutable = process.env.ARCHON_E2E_EXECUTABLE
const serverUrl = process.env.ARCHON_E2E_SERVER_URL || 'http://127.0.0.1:8787'
const token = process.env.ARCHON_E2E_TOKEN || 'smoke-token-for-archon-desktop'
let app
try {
  app = await electron.launch({
    executablePath: packagedExecutable || electronPath,
    args: [...(packagedExecutable ? [] : ['.']), `--user-data-dir=${profile}`],
    cwd: root,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  })
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1440, height: 920 })
  await page.waitForLoadState('domcontentloaded')
  const errors = []
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  page.on('pageerror', (error) => errors.push(error.message))
  const preloadBridge = await page.evaluate(() => typeof window.archon === 'object' && typeof window.archon?.getConnection === 'function' && typeof window.archon?.setConnection === 'function' && typeof window.archon?.minimize === 'function' && typeof window.archon?.maximize === 'function' && typeof window.archon?.close === 'function')
  if (!preloadBridge) throw new Error('Sandboxed preload bridge or custom-window controls are unavailable')
  const maximizeCycle = await page.evaluate(async () => [await window.archon.maximize(), await window.archon.maximize()])
  if (!maximizeCycle.every((value) => typeof value === 'boolean')) throw new Error(`Custom maximize control failed: ${JSON.stringify(maximizeCycle)}`)

  await page.getByRole('heading', { name: 'Connect to Archon' }).waitFor()
  await page.screenshot({ path: resolve(artifacts, 'e2e-connect.png') })
  await page.getByLabel('Server URL').fill(serverUrl)
  await page.getByLabel('Device token').fill(token)
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: /^New chat/ }).waitFor({ timeout: 15_000 })
  await page.getByRole('heading', { name: 'Archon', exact: true }).waitFor({ timeout: 15_000 })
  const shell = await page.evaluate(() => {
    const titlebar = document.querySelector('.desktop-titlebar')
    const sidebar = document.querySelector('.workspace-sidebar')
    const glyph = document.querySelector('.sidebar-brand .brand-glyph')
    return {
      titlebarHeight: titlebar ? getComputedStyle(titlebar).height : '',
      sidebarWidth: sidebar ? Math.round(sidebar.getBoundingClientRect().width) : 0,
      glyphViewBox: glyph?.getAttribute('viewBox'),
      canvas: document.documentElement.style.getPropertyValue('--canvas'),
      theme: document.documentElement.dataset.theme,
      mark: document.documentElement.dataset.mark,
      background: document.documentElement.style.getPropertyValue('--custom-background-image'),
    }
  })
  if (shell.titlebarHeight !== '36px' || shell.sidebarWidth < 250 || shell.sidebarWidth > 380 || shell.glyphViewBox !== '0 0 32 32' || shell.canvas !== '#1a1a1a' || shell.theme !== 'obsidian' || shell.mark !== 'wing' || !shell.background.includes('home-backdrop')) throw new Error(`Exact supplied v2 shell contract failed: ${JSON.stringify(shell)}`)
  await page.screenshot({ path: resolve(artifacts, 'e2e-v2-new-chat.png') })

  await page.locator('.sidebar-footer').getByRole('button', { name: /^Projects/ }).click()
  await page.getByRole('heading', { name: 'Projects' }).waitFor()
  await page.screenshot({ path: resolve(artifacts, 'e2e-v2-projects.png') })
  const firstProject = page.locator('.sidebar-project-toggle').first()
  if (await firstProject.count()) {
    await firstProject.click()
    if (await firstProject.getAttribute('aria-expanded') !== 'true') throw new Error('Sidebar project did not expand')
  }
  await page.locator('.sidebar-footer').getByRole('button', { name: /^Chat/ }).click()
  await page.getByRole('heading', { name: 'Archon', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Start microphone recording' }).waitFor()
  await page.getByRole('switch', { name: 'Voice conversation' }).waitFor()

  const firstSession = page.locator('.sidebar-session-group button').first()
  await firstSession.waitFor({ timeout: 15_000 })
  await firstSession.click()
  await page.locator('.v2-thread').waitFor({ timeout: 15_000 })
  await page.locator('.message').first().waitFor({ timeout: 15_000 })
  await page.screenshot({ path: resolve(artifacts, 'e2e-v2-thread.png') })

  await page.getByRole('button', { name: 'Activity', exact: true }).click()
  await page.locator('.workspace-bench').waitFor()
  await page.screenshot({ path: resolve(artifacts, 'e2e-v2-activity-bench.png') })
  await page.getByRole('button', { name: /Open status/ }).click()
  await page.getByRole('heading', { name: 'VPS status' }).waitFor()
  await page.screenshot({ path: resolve(artifacts, 'e2e-v2-status.png') })
  await page.getByRole('button', { name: 'Activity', exact: true }).click()
  await page.locator('.workspace-bench').getByRole('button', { name: /Run center/ }).click()
  await page.getByRole('heading', { name: 'Background tasks' }).waitFor()
  await page.screenshot({ path: resolve(artifacts, 'e2e-v2-run-center.png') })

  await page.getByRole('button', { name: 'Files', exact: true }).click()
  await page.locator('.workspace-bench').waitFor()
  await page.getByRole('button', { name: /Open file workspace/ }).click()
  await page.getByRole('heading', { name: 'VPS files' }).waitFor()
  await page.screenshot({ path: resolve(artifacts, 'e2e-v2-files.png') })

  await page.getByRole('button', { name: 'Terminal', exact: true }).click()
  await page.locator('.terminal-dock').waitFor()
  await page.getByRole('button', { name: 'Create shell' }).waitFor()
  await page.screenshot({ path: resolve(artifacts, 'e2e-v2-terminal-dock.png') })
  await page.getByRole('button', { name: /Full page/ }).click()
  await page.getByRole('heading', { name: 'Persistent terminal' }).waitFor()
  await page.screenshot({ path: resolve(artifacts, 'e2e-v2-terminal.png') })

  for (const name of ['All sessions', 'Skills', 'Models', 'Automations', 'Backups']) {
    await page.locator('.sidebar-footer').getByRole('button', { name: new RegExp(`^${name}`) }).click()
    await page.waitForTimeout(250)
  }
  await page.screenshot({ path: resolve(artifacts, 'e2e-v2-backups.png') })

  await page.locator('.sidebar-footer').getByRole('button', { name: /^Logs/ }).click()
  await page.getByRole('heading', { name: 'Logs' }).waitFor()
  await page.getByLabel('Search logs').waitFor()
  await page.screenshot({ path: resolve(artifacts, 'e2e-v2-logs.png') })

  await page.locator('.sidebar-footer').getByRole('button', { name: /^Settings/ }).click()
  await page.getByRole('button', { name: 'Voice' }).click()
  await page.getByRole('heading', { name: 'Microphone & conversation' }).waitFor()
  await page.getByRole('button', { name: 'Appearance' }).click()
  await page.getByText('APPEARANCE STUDIO', { exact: true }).waitFor()
  const themeContracts = {
    Obsidian: { canvas: '#1a1a1a', accent: '#cfc9c1', radius: '4px' },
    Indigo: { canvas: '#14172c', accent: '#b5abfc', radius: '8px' },
    Carbon: { canvas: '#161616', accent: '#cfc9c1', radius: '2px' },
    Ivory: { canvas: '#f4f1eb', accent: '#8a5a2f', radius: '3px' },
    Blueprint: { canvas: '#f3f3f1', accent: '#e53d1a', radius: '0px' },
    Moss: { canvas: '#111c18', accent: '#7fb497', radius: '6px' },
    Ember: { canvas: '#1b1511', accent: '#d8833d', radius: '4px' },
  }
  for (const theme of ['Obsidian', 'Indigo', 'Carbon', 'Ivory', 'Blueprint', 'Moss', 'Ember']) {
    await page.getByRole('button', { name: new RegExp(`^${theme}`) }).click()
    await page.waitForTimeout(150)
    const actual = await page.evaluate(() => ({ canvas: document.documentElement.style.getPropertyValue('--canvas'), accent: document.documentElement.style.getPropertyValue('--accent'), radius: document.documentElement.style.getPropertyValue('--radius') }))
    const expected = themeContracts[theme]
    if (actual.canvas !== expected.canvas || actual.accent !== expected.accent || actual.radius !== expected.radius) throw new Error(`${theme} does not match the supplied design contract: ${JSON.stringify(actual)}`)
    await page.screenshot({ path: resolve(artifacts, `e2e-theme-${theme.toLowerCase()}.png`) })
  }
  const markButtons = page.locator('.mark-gallery button')
  if (await markButtons.count() !== 22) throw new Error(`Expected 22 supplied app marks, found ${await markButtons.count()}`)
  await markButtons.nth(10).click()
  const selectedMark = await page.evaluate(() => document.documentElement.dataset.mark)
  if (selectedMark !== 'meander') throw new Error(`App mark selection did not persist to the shell: ${selectedMark}`)
  await page.getByLabel('Navigation side').selectOption('right')
  await page.getByLabel('Glass surfaces').uncheck()
  const backdropSwitch = page.getByRole('switch', { name: 'Toggle background effect' })
  await backdropSwitch.click()
  const disabledBackdrop = await page.evaluate(() => document.documentElement.style.getPropertyValue('--custom-background-image'))
  if (disabledBackdrop !== 'none') throw new Error(`Backdrop effect did not turn off independently: ${disabledBackdrop}`)
  await backdropSwitch.click()
  const enabledBackdrop = await page.evaluate(() => document.documentElement.style.getPropertyValue('--custom-background-image'))
  if (!enabledBackdrop.includes('home-backdrop')) throw new Error(`Backdrop effect did not turn back on: ${enabledBackdrop}`)
  await page.locator('.range-control').filter({ hasText: 'Interface weight' }).locator('input[type=range]').fill('450')
  await page.locator('.range-control').filter({ hasText: 'Icon scale' }).locator('input[type=range]').fill('1.2')
  await page.locator('.range-control').filter({ hasText: 'Session sidebar' }).locator('input[type=range]').fill('320')
  await page.getByPlaceholder('Name this setup').fill('E2E Studio')
  await page.getByRole('button', { name: 'Save custom theme' }).click()
  await page.getByText('E2E Studio', { exact: true }).waitFor()
  const appearance = await page.evaluate(() => ({ side: document.documentElement.dataset.navSide, glass: document.documentElement.dataset.glass, sidebar: document.documentElement.style.getPropertyValue('--sidebar-width'), weight: document.documentElement.style.getPropertyValue('--font-weight'), iconScale: document.documentElement.style.getPropertyValue('--icon-scale') }))
  if (appearance.side !== 'right' || appearance.glass !== 'off' || appearance.sidebar !== '320px' || appearance.weight !== '450' || appearance.iconScale !== '1.2') throw new Error(`Appearance controls did not apply: ${JSON.stringify(appearance)}`)
  await page.locator('.settings-content').evaluate((element) => { element.scrollTop = 0 })
  await page.screenshot({ path: resolve(artifacts, 'e2e-v2-settings.png') })

  if (errors.length) throw new Error(`Renderer errors:\n${errors.join('\n')}`)
  console.log(JSON.stringify({ ok: true, reference: 'Archon Desktop v2.dc.html from exact user ZIP 1478577c…', shell_verified: true, supplied_background_verified: true, backdrop_toggle_verified: true, supplied_marks_verified: 22, custom_frame_verified: true, pages_checked: 12, benches_checked: 3, themes_checked: 7, screenshots: 20, project_expansion_verified: true, terminal_dock_verified: true, voice_controls_verified: true, logs_verified: true, appearance_studio_verified: true }))
} finally {
  try {
    if (app) await app.close()
  } finally {
    await rm(profile, { recursive: true, force: true })
  }
}
