import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Locator, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { seedSettings, type E2EEnv } from './helpers/env'
import { seedJsonl, snap, termIds } from './helpers/p1'

test.skip(
  process.env.KOLOFT_REAL_INSTALL !== '1',
  'real-install smoke: set KOLOFT_REAL_INSTALL=1 to download and run the official claude and codex installers into a temporary HOME'
)

const OFFICIAL_INSTALL_MS = 5 * 60_000

function nothingInstalled(env: E2EEnv): void {
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
  seedSettings(env, { onboardingSeen: false })
  seedJsonl(env, env.workspaces.a, { summary: 'A one', mtime: Date.now() - 60_000 })
  env.launchEnv.PATH = `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`
  env.launchEnv.CODEX_HOME = path.join(env.home, '.codex')
  delete env.launchEnv.KOLOFT_CODEX_CMD
}

function ownInstalls(): Record<string, string> {
  const home = os.userInfo().homedir
  const seen: Record<string, string> = {}
  for (const p of [
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.local', 'bin', 'codex'),
    path.join(home, '.codex')
  ]) {
    try {
      const st = fs.lstatSync(p)
      seen[p] = `${st.ino} ${st.mtimeMs} ${st.isSymbolicLink() ? fs.readlinkSync(p) : ''}`
    } catch {
      seen[p] = 'absent'
    }
  }
  return seen
}

function welcome(page: Page): Locator {
  return page.locator('.w-empty.onboarding')
}

function card(page: Page, title: string): Locator {
  return welcome(page)
    .locator('.ob-choices .choice')
    .filter({ has: page.locator('.choice-t', { hasText: new RegExp(`^${title}$`) }) })
}

async function installThrough(page: Page, title: string): Promise<void> {
  await card(page, title).click()
  await expect(welcome(page)).toHaveCount(0, { timeout: 20_000 })
  await expect.poll(() => termIds(page), { timeout: 20_000 }).toHaveLength(1)
  await snap(page, `REAL-INSTALL-${title}-tab`)
  await expect(welcome(page)).toBeVisible({ timeout: OFFICIAL_INSTALL_MS })
  await expect.poll(() => termIds(page), { timeout: 20_000 }).toHaveLength(0)
}

// CC§10 CODEX§22
test('REAL-INSTALL: the welcome installs Codex, then Claude Code, with the official scripts into an empty HOME, and finds each one right after', async ({
  env
}) => {
  test.setTimeout(3 * OFFICIAL_INSTALL_MS)
  nothingInstalled(env)
  const before = ownInstalls()

  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(welcome(page)).toBeVisible({ timeout: 20_000 })
    await welcome(page).locator('.btn-primary').click()
    await expect(welcome(page).locator('.disc-row')).not.toHaveCount(0, { timeout: 20_000 })
    await welcome(page).locator('.btn-primary').click()
    await expect(welcome(page).locator('.eyebrow')).toHaveText('Welcome · 3 of 4', {
      timeout: 20_000
    })
    await expect(card(page, 'Codex')).toContainText('Not on this Mac', { timeout: 30_000 })
    await expect(card(page, 'Claude')).toContainText('Not on this Mac')
    await welcome(page).locator('.btn-primary').click()
    await expect(welcome(page).locator('.eyebrow')).toHaveText('Welcome · 4 of 4')
    const primary = welcome(page).locator('.btn-primary')
    await expect(primary).toHaveText('Check again', { timeout: 30_000 })
    await primary.click()
    await expect(primary).toHaveText('Check again', { timeout: 30_000 })
    await snap(page, 'REAL-INSTALL-1-step4-nothing')

    await installThrough(page, 'Codex')
    await expect(welcome(page).locator('.eyebrow')).toHaveText('Welcome · 4 of 4')
    await expect(primary).toHaveText('＋ Start first session', { timeout: 30_000 })
    await snap(page, 'REAL-INSTALL-2-step4-codex-found')
    expect(fs.existsSync(path.join(env.home, '.local', 'bin', 'codex'))).toBe(true)
    expect(fs.existsSync(path.join(env.home, '.codex', 'packages', 'standalone', 'current'))).toBe(
      true
    )

    await welcome(page).locator('.ob-back').click()
    await expect(welcome(page).locator('.eyebrow')).toHaveText('Welcome · 3 of 4')
    await expect(card(page, 'Codex')).not.toContainText('Not on this Mac', { timeout: 30_000 })
    await expect(card(page, 'Claude')).toContainText('Not on this Mac')
    await installThrough(page, 'Claude')
    await expect(welcome(page).locator('.eyebrow')).toHaveText('Welcome · 3 of 4')
    await expect(card(page, 'Claude')).not.toContainText('Not on this Mac', { timeout: 30_000 })
    await snap(page, 'REAL-INSTALL-3-step3-both-installed')
    expect(fs.existsSync(path.join(env.home, '.local', 'bin', 'claude'))).toBe(true)

    const found = await page.evaluate(() => window.api.sessions.backends(true))
    expect(found.filter((b) => b.available).map((b) => b.id)).toEqual(['claude', 'codex'])
  } finally {
    await quitAndClose(app)
  }
  expect(ownInstalls()).toEqual(before)
})
