import fs from 'fs'
import path from 'path'
import type { Page } from '@playwright/test'
import { test, expect, launchApp } from './helpers/app'
import { seedSettings } from './helpers/env'
import { addWorkspace, openMenu, seedJsonl, waitBooted } from './helpers/p1'

const OUT = process.env.PROBE_758_OUT
const DAY_MS = 24 * 60 * 60 * 1000

async function dump(page: Page, name: string): Promise<void> {
  if (!OUT) return
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, `${name}.html`), await page.content())
  const css = await page.evaluate(() =>
    [...document.styleSheets]
      .map((s) => [...s.cssRules].map((r) => r.cssText).join('\n'))
      .join('\n')
  )
  fs.writeFileSync(path.join(OUT, 'app.css'), css)
  await page.screenshot({ path: path.join(OUT, `${name}.png`) })
}

function pinOnly(env: { userData: string }, dir: string): void {
  fs.writeFileSync(
    path.join(env.userData, 'layout.json'),
    JSON.stringify({
      version: 6,
      workspaces: [{ path: dir }],
      workbench: { defaultOpen: true },
      members: [],
      panels: {}
    })
  )
}

test('758 probe: a folder added by hand that has past sessions shows none of them in the sidebar or the empty panel, while Restore session lists them', async ({
  env
}) => {
  test.setTimeout(180_000)
  seedSettings(env, { onboardingSeen: true })
  const dir = path.join(env.home, 'old-work')
  fs.mkdirSync(dir, { recursive: true })
  const now = Date.now()
  seedJsonl(env, dir, { summary: 'Fix the login redirect', owned: false, mtime: now - DAY_MS })
  seedJsonl(env, dir, {
    summary: 'Add CSV export to reports',
    owned: false,
    mtime: now - 3 * DAY_MS
  })
  seedJsonl(env, dir, {
    summary: 'Upgrade the build to Node 22',
    owned: false,
    mtime: now - 20 * DAY_MS
  })
  fs.writeFileSync(
    path.join(env.userData, 'layout.json'),
    JSON.stringify({
      version: 6,
      workspaces: [],
      workbench: { defaultOpen: true },
      members: [],
      panels: {}
    })
  )

  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await waitBooted(page)
    const panel = page.locator('.w-empty')
    await expect(panel.locator('.big')).toHaveText('No workspace yet', { timeout: 20_000 })
    expect((await addWorkspace(page, dir)).code).toBe('added')
    await expect(panel.locator('.big')).toHaveText('old-work', { timeout: 20_000 })
    await expect(panel.locator('.quiet').first()).toHaveText('No running session')
    await expect(panel.locator('.btn-primary')).toBeVisible()
    await expect(page.locator('.ws .ws-tab')).toHaveCount(0)
    await expect(panel.locator('.recent-list')).toHaveCount(0)
    await dump(page, 'empty-today')

    await openMenu(page, page.locator('.ws-head', { hasText: 'old-work' }))
    const item = page.locator('.menu .mi', { hasText: 'Restore session' })
    await expect(item).not.toHaveClass(/disabled/)
    await dump(page, 'menu')
    await item.click()
    const dialog = page.getByRole('dialog', { name: 'Restore session · old-work', exact: true })
    await expect(dialog.locator('.restore-row')).toHaveCount(3, { timeout: 15_000 })
    await expect(panel.locator('.recent-list')).toHaveCount(0)
    await expect(dialog).toHaveCSS('opacity', '1')
    await dump(page, 'restore-dialog')
  } finally {
    await app.close().catch(() => {})
  }
})

test('758 probe: the same panel with sessions that are in the list, for the Recent block markup', async ({
  env
}) => {
  test.setTimeout(180_000)
  seedSettings(env, { onboardingSeen: true })
  const dir = path.join(env.home, 'old-work')
  fs.mkdirSync(dir, { recursive: true })
  pinOnly(env, dir)
  const now = Date.now()
  seedJsonl(env, dir, { summary: 'Fix the login redirect', mtime: now - DAY_MS })
  seedJsonl(env, dir, { summary: 'Add CSV export to reports', mtime: now - 3 * DAY_MS })

  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await waitBooted(page)
    const panel = page.locator('.w-empty')
    await expect(panel.locator('.recent-list .recent-row')).toHaveCount(2, { timeout: 20_000 })
    await dump(page, 'recent-owned')
  } finally {
    await app.close().catch(() => {})
  }
})
