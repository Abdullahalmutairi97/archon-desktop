import { chromium } from 'playwright-core'
import { resolve } from 'node:path'

const browser = await chromium.connectOverCDP('http://127.0.0.1:9334')
try {
  const context = browser.contexts()[0]
  const page = context.pages()[0]
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  await page.locator('.sidebar-new').waitFor({ timeout: 15_000 })
  const version = await page.evaluate(() => window.archon.getVersion())
  const connected = !(await page.getByRole('heading', { name: 'Connect to Archon' }).count())

  await page.locator('.sidebar-footer').getByRole('button', { name: /^Projects/ }).click()
  await page.getByRole('heading', { name: 'Projects' }).waitFor()
  const projectRows = await page.locator('.project-row').count()
  const firstProject = page.locator('.sidebar-project-toggle').first()
  let projectExpanded = false
  if (await firstProject.count()) { const before = await firstProject.getAttribute('aria-expanded'); await firstProject.click(); const after = await firstProject.getAttribute('aria-expanded'); projectExpanded = before !== after }

  await page.locator('.sidebar-footer').getByRole('button', { name: /^All sessions/ }).click()
  await page.getByRole('heading', { name: 'Sessions' }).waitFor()
  const sessionSort = await page.getByLabel('Sort sessions').count()

  await page.locator('.sidebar-footer').getByRole('button', { name: /^Skills/ }).click()
  await page.getByRole('heading', { name: 'Skills' }).waitFor()
  await page.waitForFunction(() => document.querySelectorAll('.skill-row').length > 0 || Boolean(document.querySelector('.empty-state')), undefined, { timeout: 15_000 })
  const skillRows = await page.locator('.skill-row').count()
  const skillSwitches = await page.getByRole('switch').count()

  await page.locator('.sidebar-footer').getByRole('button', { name: /^Logs/ }).click()
  await page.getByRole('heading', { name: 'Logs' }).waitFor()
  await page.locator('.log-row').first().waitFor({ timeout: 15_000 })
  const logRows = await page.locator('.log-row').count()

  await page.getByRole('button', { name: 'Terminal', exact: true }).click()
  await page.locator('.terminal-dock').waitFor()
  const terminalDock = await page.locator('.terminal-dock').count()

  await page.locator('.sidebar-footer').getByRole('button', { name: /^Settings/ }).click()
  await page.getByRole('button', { name: 'Appearance' }).click()
  const backgroundSwitch = page.getByRole('switch', { name: 'Toggle background effect' })
  await backgroundSwitch.waitFor()
  const backgroundToggle = await backgroundSwitch.getAttribute('aria-checked')

  await page.locator('.sidebar-footer').getByRole('button', { name: /^Chat/ }).click()
  await page.getByRole('heading', { name: 'Archon', exact: true }).waitFor()
  const mic = await page.getByRole('button', { name: 'Start microphone recording' }).count()
  const voice = await page.getByRole('switch', { name: 'Voice conversation' }).count()
  await page.screenshot({ path: resolve('/home/archon/projects/archon-desktop/desktop/artifacts/laptop-installed-0.6.0.png') })

  if (errors.length) throw new Error(errors.join('\n'))
  console.log(JSON.stringify({ version, connected, projectRows, projectExpanded, sessionSort, skillRows, skillSwitches, logRows, terminalDock, backgroundToggle, mic, voice }))
} finally {
  await browser.close()
}
