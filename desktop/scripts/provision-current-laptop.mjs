import { chromium } from 'playwright-core'

const endpoint = process.env.ARCHON_CDP_URL || 'http://127.0.0.1:19225'
const token = process.env.ARCHON_DESKTOP_AUTH_TOKEN
if (!token) throw new Error('ARCHON_DESKTOP_AUTH_TOKEN is required')

let browser
for (let attempt = 0; attempt < 30; attempt += 1) {
  try {
    browser = await chromium.connectOverCDP(endpoint)
    break
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}
if (!browser) throw new Error('Electron CDP endpoint did not become ready')
const context = browser.contexts()[0]
const page = context.pages()[0]
if (!page) throw new Error('Electron renderer page is missing')
await page.waitForLoadState('domcontentloaded')
const bridge = await page.evaluate(() => Boolean(window.archon?.setConnection && window.archon?.getConnection))
if (!bridge) throw new Error('Secure preload bridge is unavailable')
await page.evaluate(async ({ serverUrl, token }) => {
  await window.archon.setConnection({ serverUrl, token })
}, { serverUrl: 'http://100.80.70.23:9700', token })
await page.reload()
await page.locator('.desktop-v2').waitFor({ timeout: 20_000 })
await page.locator('.workspace-sidebar').waitFor({ timeout: 20_000 })
const state = await page.evaluate(() => ({
  title: document.title,
  direction: document.documentElement.dir,
  sidebarWidth: Math.round(document.querySelector('.workspace-sidebar')?.getBoundingClientRect().width || 0),
  titlebarHeight: Math.round(document.querySelector('.titlebar')?.getBoundingClientRect().height || 0),
  navigation: [...document.querySelector('.sidebar-scroll').children]
    .filter((node) => node.tagName === 'BUTTON')
    .map((node) => node.querySelector('span')?.textContent?.trim()),
  backendError: Boolean(document.querySelector('.error-notice')),
  shell: Boolean(document.querySelector('.desktop-v2')),
}))
await page.screenshot({ path: '/home/archon/projects/archon-desktop/desktop/artifacts/current-on-laptop.png' })
console.log(JSON.stringify(state))
await browser.close()
