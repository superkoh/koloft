import fs from 'fs'
import path from 'path'
import { test, expect, withOpenPath } from './helpers/app'
import type { Page } from '@playwright/test'
import {
  centerTerm,
  clickAppMenuItem,
  openSessionTerminal,
  panelTerm,
  runIn,
  startSessionIn,
  waitBooted,
  wsRows
} from './helpers/p1'
import { activeKind, wbTabs, workbenchIcon, workbenchPanel, WORKBENCH } from './helpers/workbench'

const TWO_LAUNCHES_AND_A_PANEL_SWAP_MS = 45_000

function readingArea(page: Page): ReturnType<Page['locator']> {
  return page.locator(WORKBENCH.readingBody)
}

function readingTitle(page: Page): ReturnType<Page['locator']> {
  return page.locator(WORKBENCH.readingTitle)
}

function filesHalf(page: Page, name: 'Changes' | 'Browse'): ReturnType<Page['locator']> {
  return page.locator('.wb-bar .seg[aria-label="Files view"] button', { hasText: name })
}

test.describe("`open <file>` inside a Koloft tab: previewable types render in Koloft's reading area instead of the OS app, everything else reaches the real `open` untouched", () => {
  test('an agent open <previewable file> renders in the Koloft reading area, not the OS app, yet moves nothing on screen: no tab, no unread mark, the Files half stays on Changes until the user opens Browse', async ({
    page,
    env
  }) => {
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    const tabsBefore = await wbTabs(page).count()

    await runIn(page, centerTerm(page), '/open README.md')
    await expect(centerTerm(page)).toContainText('opened README.md', { timeout: 30_000 })

    await expect.poll(() => wbTabs(page).count()).toBe(tabsBefore)
    await expect(page.locator(WORKBENCH.tabUnread)).toHaveCount(0)
    await expect(filesHalf(page, 'Changes')).toHaveAttribute('aria-pressed', 'true')
    await expect(readingTitle(page)).toHaveCount(0)

    await filesHalf(page, 'Browse').click()
    await expect(readingTitle(page)).toHaveText('README.md', { timeout: 15_000 })
    await expect(readingArea(page)).toContainText('koloft-e2e-alpha')

    expect(fs.existsSync(env.openCalls)).toBe(false)
  })

  test('open <unsupported file> passes through to the real open untouched', async ({
    page,
    env
  }) => {
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    await runIn(page, centerTerm(page), '/open notes.xyz')

    await expect
      .poll(() => (fs.existsSync(env.openCalls) ? fs.readFileSync(env.openCalls, 'utf8') : ''), {
        timeout: 15_000
      })
      .toContain('notes.xyz')

    expect(await readingTitle(page).count()).toBe(0)
  })

  test('an agent open fired from a background tab activates that tab and shows the preview, landing on Changes like any agent open', async ({
    page,
    env
  }) => {
    test.setTimeout(120_000)
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    await runIn(page, centerTerm(page), '/open-later README.md')
    await expect(centerTerm(page)).toContainText('armed open', { timeout: 30_000 })

    await startSessionIn(page, 'ws-b')
    fs.writeFileSync(path.join(env.home, 'go-open'), '')

    await expect(wsRows(page, 'ws-a').first()).toHaveClass(/\bactive\b/, {
      timeout: TWO_LAUNCHES_AND_A_PANEL_SWAP_MS
    })
    await filesHalf(page, 'Browse').click()
    await expect(readingTitle(page)).toHaveText('README.md', {
      timeout: TWO_LAUNCHES_AND_A_PANEL_SWAP_MS
    })
    await expect(readingArea(page)).toContainText('koloft-e2e-alpha')
  })

  test('a user open <previewable file> in a session terminal reopens the collapsed panel on `files`, still minting no tab', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    await openSessionTerminal(app, page)
    const tabsBefore = await wbTabs(page).count()

    await runIn(
      page,
      panelTerm(page),
      // PLATFORM§2
      withOpenPath(env, `cd '${env.workspaces.a}'; sleep 3; open README.md`)
    )

    await clickAppMenuItem(app, page, 'toggle-browser')
    await expect(workbenchPanel(page)).toBeHidden()

    await expect(workbenchPanel(page)).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => activeKind(page), { timeout: 20_000 }).toBe('files')
    await expect(readingTitle(page)).toHaveText('README.md', { timeout: 20_000 })
    await expect(readingArea(page)).toContainText('koloft-e2e-alpha')

    await expect.poll(() => wbTabs(page).count()).toBe(tabsBefore)
    await expect(page.locator(WORKBENCH.tabUnread)).toHaveCount(0)
    await expect(workbenchIcon(page)).not.toHaveClass(/unread/)

    expect(fs.existsSync(env.openCalls)).toBe(false)
  })
})
