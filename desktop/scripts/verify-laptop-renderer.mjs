import { chromium } from 'playwright-core'
import { resolve } from 'node:path'

const endpoint = process.env.ARCHON_VERIFY_CDP || 'http://127.0.0.1:19231'
const output = process.env.ARCHON_VERIFY_SCREENSHOT || resolve(import.meta.dirname, '..', 'artifacts', 'laptop-0.5.0-renderer.png')
const browser = await chromium.connectOverCDP(endpoint)
try {
  const pages = browser.contexts().flatMap((context) => context.pages())
  const page = pages.find((candidate) => candidate.url().startsWith('file:')) || pages[0]
  if (!page) throw new Error('Archon renderer was not found')
  await page.getByRole('button', { name: /^New chat/ }).click()
  await page.getByLabel('Project', { exact: true }).waitFor({ timeout: 15_000 })
  await page.getByRole('heading', { name: /^(Morning|Afternoon|Evening), Abdullah\.$/ }).waitFor({ timeout: 15_000 })
  const state = await page.evaluate(() => {
    const titlebar = document.querySelector('.desktop-titlebar')
    return {
      titlebarHeight: titlebar ? getComputedStyle(titlebar).height : '',
      sidebarWidth: document.querySelector('.workspace-sidebar')?.getBoundingClientRect().width || 0,
      online: Boolean(document.querySelector('.desktop-health.online')),
      projectCount: document.querySelectorAll('select[aria-label="Project"] option').length,
      pickupCount: document.querySelectorAll('.v2-pickup button').length,
      canvas: document.documentElement.style.getPropertyValue('--canvas'),
      brandViewBox: document.querySelector('.sidebar-brand .brand-glyph')?.getAttribute('viewBox'),
      brandHasCrown: Boolean(document.querySelector('.sidebar-brand .glyph-crown')),
    }
  })
  if (state.titlebarHeight !== '36px' || state.sidebarWidth < 250 || !state.online || state.projectCount < 1 || state.pickupCount > 4 || state.canvas !== '#161826' || state.brandViewBox !== '0 0 32 32' || !state.brandHasCrown) throw new Error(`Installed renderer verification failed: ${JSON.stringify(state)}`)
  await page.screenshot({ path: output })
  console.log(JSON.stringify({ installed_renderer_verified: true, archive_v2_design_verified: true, workspace_loaded: true, backend_online: true, project_count: state.projectCount, pickup_count: state.pickupCount, screenshot: output }))
} finally {
  await browser.close()
}
