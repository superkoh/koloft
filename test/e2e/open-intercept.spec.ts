import fs from 'fs'
import path from 'path'
import { test, expect, withOpenPath } from './helpers/app'
import type { Page } from '@playwright/test'
import {
  centerTerm,
  clickAppMenuItem,
  focusOwner,
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
  test('an agent open <previewable file> shows at once in the Koloft reading area, not the OS app: Browse comes up, no tab is minted, and the caret stays in the terminal', async ({
    page,
    env
  }) => {
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    const tabsBefore = await wbTabs(page).count()

    await runIn(page, centerTerm(page), '/open README.md')
    await expect(centerTerm(page)).toContainText('opened README.md', { timeout: 30_000 })

    await expect(filesHalf(page, 'Browse')).toHaveAttribute('aria-pressed', 'true', {
      timeout: 15_000
    })
    await expect(readingTitle(page)).toHaveText('README.md', { timeout: 15_000 })
    await expect(readingArea(page)).toContainText('koloft-e2e-alpha')
    await expect.poll(() => wbTabs(page).count()).toBe(tabsBefore)
    await expect(page.locator(WORKBENCH.tabUnread)).toHaveCount(0)
    expect(await focusOwner(page)).toBe('tui')

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

  test('an agent open fired from a background tab leaves the person where they are, marks that session row, and the file is on screen in Browse once they switch there', async ({
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

    const rowA = wsRows(page, 'ws-a').first()
    await expect(rowA.locator('.ws-tab-opened')).toHaveCount(1, {
      timeout: TWO_LAUNCHES_AND_A_PANEL_SWAP_MS
    })
    await expect(wsRows(page, 'ws-b').first()).toHaveClass(/\bactive\b/)
    await expect(rowA).not.toHaveClass(/\bactive\b/)

    await rowA.click()
    await expect(rowA).toHaveClass(/\bactive\b/)
    await expect(rowA.locator('.ws-tab-opened')).toHaveCount(0)
    await expect(filesHalf(page, 'Browse')).toHaveAttribute('aria-pressed', 'true', {
      timeout: TWO_LAUNCHES_AND_A_PANEL_SWAP_MS
    })
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
