import { _electron as electron } from 'playwright-core'
import electronPath from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'

const project = '/home/archon/projects/archon-desktop'
const desktop = join(project, 'desktop')
const out = join(project, '.hermes', 'reference-inventory')
const prototype = join(project, 'reference/incoming-archon-design/extracted/Archon Desktop v2.dc.html')
await mkdir(out, { recursive: true })
const app = await electron.launch({ executablePath: electronPath, args: [join(desktop, 'scripts/reference-file-shell.cjs'), '--no-sandbox', '--disable-gpu'], env: { ...process.env, ARCHON_REFERENCE_FILE: prototype } })
const page = await app.firstWindow()
await page.setViewportSize({ width: 1440, height: 900 })
const diagnostics = []
page.on('console', (message) => diagnostics.push(`${message.type()}: ${message.text()}`))
page.on('pageerror', (error) => diagnostics.push(`pageerror: ${error.message}`))
await page.waitForTimeout(1500)
if (!(await page.locator('body').innerText()).includes('Evening, Abdullah.')) {
  await page.screenshot({ path: join(out, '00-load-failure.png') })
  console.error(JSON.stringify({ url: page.url(), title: await page.title(), body: (await page.locator('body').innerText()).slice(0, 4000), diagnostics }, null, 2))
  await app.close()
  throw new Error('Canonical prototype did not render')
}
const text = (value) => String(value || '').replace(/\s+/g, ' ').trim()
const buttons = (await page.locator('button').allTextContents()).map(text).filter(Boolean)
const geometry = await page.evaluate(() => {
  const all = [...document.querySelectorAll('*')]
  const byText = (tag, value) => all.find((el) => el.tagName === tag && el.textContent?.trim() === value)
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height } }
  const newButton = [...all].find((el) => el.tagName === 'BUTTON' && el.textContent?.includes('New chat'))
  const composerInput = document.querySelector('input[placeholder="Describe what you need"]')
  return {
    viewport:{width:innerWidth,height:innerHeight},
    titlebar:box(all.find((el) => getComputedStyle(el).height === '36px' && el.querySelectorAll('button').length >= 3)),
    sidebar:box(newButton?.closest('div[style*="width:262px"],div[style*="width: 262px"]')),
    newSession:box(newButton), composer:box(composerInput?.parentElement),
    body:{font:getComputedStyle(document.body).fontFamily,background:getComputedStyle(document.body).backgroundColor,overflow:getComputedStyle(document.body).overflow}
  }
})
await page.screenshot({ path: join(out, '00-home-1440x900.png') })
const internals = await page.evaluate(() => {
  const root = document.querySelector('x-dc')
  const own = root ? Object.getOwnPropertyNames(root).filter((key) => !key.startsWith('__react')) : []
  const descendants = [...document.querySelectorAll('[onclick]')].map((el) => ({ tag:el.tagName, text:el.textContent?.replace(/\s+/g,' ').trim().slice(0,100), title:el.getAttribute('title'), cls:el.className })).slice(0,200)
  return { own, descendants }
})
await writeFile(join(out, 'initial.json'), JSON.stringify({ buttons, geometry, internals }, null, 2))
console.log(JSON.stringify({ buttons, geometry, internals }, null, 2))
await app.close()
