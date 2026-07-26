import { chromium } from 'playwright-core'

const endpoint = process.env.ARCHON_PROVISION_CDP || 'http://127.0.0.1:19229'
const serverUrl = process.env.ARCHON_PROVISION_SERVER_URL
const token = process.env.ARCHON_PROVISION_TOKEN
if (!serverUrl || !token) throw new Error('Provisioning environment is incomplete')

const browser = await chromium.connectOverCDP(endpoint)
try {
  const pages = browser.contexts().flatMap((context) => context.pages())
  const page = pages.find((candidate) => candidate.url().startsWith('file:')) || pages[0]
  if (!page) throw new Error('Archon renderer was not found')
  const workspace = page.locator('.workspace-sidebar')
  if (await workspace.isVisible().catch(() => false)) {
    console.log(JSON.stringify({ provisioned: false, already_configured: true, workspace_loaded: true }))
  } else {
    await page.getByRole('heading', { name: 'Connect to Archon' }).waitFor({ timeout: 10_000 })
    await page.getByLabel('Server URL').fill(serverUrl)
    await page.getByLabel('Device token').fill(token)
    await page.getByRole('button', { name: 'Continue' }).click()
    await workspace.waitFor({ timeout: 15_000 })
    console.log(JSON.stringify({ provisioned: true, workspace_loaded: true }))
  }
} finally {
  await browser.close()
}
