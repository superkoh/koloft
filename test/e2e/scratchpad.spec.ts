import { test, expect } from './helpers/app'
import {
  centerTerm,
  FAKE_SESSION_TITLE,
  gitCommitAll,
  gitInit,
  runIn,
  startSessionIn,
  waitBooted
} from './helpers/p1'
import { openTabs } from './helpers/browser'
import { activeKind, showBrowse, WORKBENCH, workbenchPanel } from './helpers/workbench'
import type { Page } from '@playwright/test'
import fs from 'fs'
import path from 'path'

const LONGER_THAN_RELIST_THROTTLE_MS = 1200

async function tickSessionActivityToRelist(page: Page): Promise<void> {
  await runIn(page, centerTerm(page), 'ping')
}

test.describe('the ⌗ Scratchpad node in Browse: Claude’s per-session scratch dir, outside every workspace root', () => {
  test('a file claude drops in its scratchpad with no tool_use behind it is listed in Browse and opens under its absolute path', async ({
    page,
    env
  }) => {
    test.setTimeout(150_000)

    gitInit(env.workspaces.a)
    gitCommitAll(env.workspaces.a)

    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    await expect(page.locator('.ws-tab-title', { hasText: FAKE_SESSION_TITLE })).toBeVisible({
      timeout: 40_000
    })

    await runIn(page, centerTerm(page), '/scratch analysis.py')
    await tickSessionActivityToRelist(page)

    await showBrowse(page)
    const panel = workbenchPanel(page)
    const scratchpad = panel.locator('.ft-scratchpad')
    await expect(scratchpad).toBeVisible({ timeout: 40_000 })
    await expect(scratchpad.locator('.ft-ext-icon')).toHaveText('⌗')
    await expect(scratchpad.locator('.ft-name')).toHaveText('Scratchpad')
    await expect(scratchpad.locator('.ft-dir-agg')).toHaveText('1')

    // CC§2
    const dir = await scratchpad.getAttribute('data-path')
    expect(dir?.startsWith(env.scratchpadBase + path.sep)).toBe(true)
    expect(path.basename(dir!)).toBe('scratchpad')
    expect(fs.existsSync(path.join(dir!, 'analysis.py'))).toBe(true)

    const analysis = panel.locator('.ft-node.ft-file', { hasText: /analysis\.py/ })
    await expect(analysis).toHaveCount(1)
    await expect(analysis).toBeVisible()

    await analysis.click()
    await expect.poll(() => activeKind(page), { timeout: 15_000 }).toBe('files')
    await expect(openTabs(page)).toHaveCount(0)
    const title = page.locator(WORKBENCH.readingTitle)
    await expect(title).toContainText('analysis.py', { timeout: 15_000 })
    await expect(title.locator('.dir')).toHaveText(`${dir}/`)
    await expect(page.locator(WORKBENCH.readingBody)).toContainText('koloft_e2e_scratch_body', {
      timeout: 15_000
    })
  })

  test('a session that has written nothing to its scratchpad shows no Scratchpad node, even after a re-list', async ({
    page
  }) => {
    test.setTimeout(120_000)
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    await expect(page.locator('.ws-tab-title', { hasText: FAKE_SESSION_TITLE })).toBeVisible({
      timeout: 40_000
    })

    await showBrowse(page)
    const panel = workbenchPanel(page)
    await expect(panel.locator('.ft-node.ft-file', { hasText: /NOTES\.md/ })).toHaveCount(1, {
      timeout: 40_000
    })
    await expect(panel.locator('.ft-scratchpad')).toHaveCount(0)

    await tickSessionActivityToRelist(page)
    await expect(centerTerm(page)).toContainText('handled: ping', { timeout: 30_000 })
    await page.waitForTimeout(LONGER_THAN_RELIST_THROTTLE_MS)
    await expect(panel.locator('.ft-scratchpad')).toHaveCount(0)
  })
})
