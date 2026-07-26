import { chromium } from 'playwright-core'
import { mkdir } from 'node:fs/promises'
const out = '/home/archon/projects/archon-desktop/reference/captures'
await mkdir(out, { recursive: true })
const browser = await chromium.connectOverCDP('http://127.0.0.1:9335')
try {
  const page = browser.contexts()[0].pages()[0]
  await page.reload()
  await page.getByRole('button', { name: /New session/ }).waitFor({ timeout: 20_000 })
  const capture = async (name) => page.screenshot({ path: `${out}/reference-${name}.png` })
  const metrics = await page.evaluate(() => {
    const rect = (el) => { const r = el.getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width,height:r.height } }
    const newSession = [...document.querySelectorAll('button')].find((el) => el.textContent.includes('New session'))
    const search = document.querySelector('input[placeholder="Search sessions"]')
    const composer = document.querySelector('input[placeholder="Describe what you need"]')?.parentElement
    const sidebar = newSession?.closest('div[style*="width: 262px"],div[style*="width:262px"]')
    const titlebar = document.querySelector('div[style*="height: 36px"],div[style*="height:36px"]')
    return { viewport:{width:innerWidth,height:innerHeight}, titlebar:titlebar&&rect(titlebar), sidebar:sidebar&&rect(sidebar), newSession:newSession&&rect(newSession), search:search&&rect(search.parentElement), composer:composer&&rect(composer), font:getComputedStyle(document.body).fontFamily, background:getComputedStyle(document.body).backgroundColor }
  })
  await capture('home')

  const clickButton = async (name) => { const label = page.getByText(name, { exact: true }).first(); await label.click(); await page.waitForTimeout(250) }
  await clickButton('Chat'); await capture('chat')
  await clickButton('Sessions'); await capture('sessions')
  await clickButton('Tasks'); await capture('tasks')
  await page.getByRole('button', { name: /Projects/ }).first().click(); await page.waitForTimeout(250); await capture('projects')
  await clickButton('Skills'); await capture('skills')
  await clickButton('Logs'); await capture('logs')
  await clickButton('Settings'); await capture('settings-general')
  await clickButton('Appearance'); await capture('settings-appearance')
  await clickButton('Language'); await capture('settings-language')
  console.log(JSON.stringify(metrics))
} finally { await browser.close() }
