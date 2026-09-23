import fs from 'fs'
import path from 'path'
import type { Page } from '@playwright/test'
import { test, expect, launchApp } from './helpers/app'
import {
  auxIcon,
  centerTerm,
  gitCommitAll,
  gitInit,
  layoutOnDisk,
  openMenu,
  runIn,
  seedJsonl,
  startSessionIn,
  waitForCalls,
  wsRows
} from './helpers/p1'
import {
  BROWSER,
  activeKind,
  activeSurface,
  browserSurface,
  downloadedFiles,
  globeIcon,
  guestByUrl,
  guestContents,
  newWebTab,
  openBrowser,
  openTabs,
  pinnedTab,
  typeInAddressBar
} from './helpers/browser'
import {
  WORKBENCH,
  openInBrowse,
  sessionWorkbenchOnDisk,
  showBrowse,
  wbActiveTab,
  wbFrozenTabs,
  wbTabByTitle,
  wbTabTitles,
  writeLegacyV2Layout
} from './helpers/workbench'
import { startEchoServer } from './helpers/fixtureServer'

const FILES_LABEL = 'Files'

const LATE_RELOAD_GRACE_MS = 5000

async function showWorkbench(page: Page): Promise<void> {
  await expect(globeIcon(page)).toBeVisible({ timeout: 20_000 })
  await openBrowser(page)
}

async function browseTo(page: Page, url: string, title: string): Promise<void> {
  await newWebTab(page)
  await expect(page.locator(BROWSER.addressField).first()).toBeVisible({ timeout: 20_000 })
  await typeInAddressBar(page, url)
  await expect(wbTabByTitle(page, title)).toHaveCount(1, { timeout: 30_000 })
}

test.describe('Workbench web tabs: an .html goes to a web tab, and the tab set survives kind switches, session switches, /clear, a cold resume, a restart and archiving', () => {
  test('BB-M05: clicking an .html in Browse renders it in a foreground Browser tab', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    await startSessionIn(page, 'ws-a')
    const docs = path.join(env.workspaces.a, 'docs')
    const html = path.join(docs, 'page.html')

    await showWorkbench(page)
    await expect(openTabs(page)).toHaveCount(0)
    expect(await activeKind(page)).toBe('files')

    await openInBrowse(page, html)

    await expect(browserSurface(page)).toBeVisible({ timeout: 20_000 })
    await expect.poll(() => activeKind(page), { timeout: 20_000 }).toBe('web')

    await expect(wbActiveTab(page)).toHaveCount(1)
    await expect(openTabs(page)).toHaveCount(1)
    const guest = await guestByUrl(app, html)
    expect(guest.url().startsWith('file://')).toBe(true)
    await expect(guest.locator('#top')).toHaveText('koloft-e2e-page-html', { timeout: 20_000 })

    await guest.locator('#to-anchor').click()
    await expect
      .poll(() => guest.evaluate(() => location.hash), { timeout: 15_000 })
      .toBe('#section')
    await expect
      .poll(
        () =>
          page
            .locator(`${BROWSER.addressBar} [aria-label="Back"]`)
            .evaluate((el) => (el as HTMLButtonElement).disabled),
        { timeout: 15_000 }
      )
      .toBe(false)

    await expect(page.locator(WORKBENCH.readingTitle)).toHaveCount(0)
  })

  test('BB-M16: View source on an .html opens its source and diff in the reading area', async ({
    page,
    env
  }) => {
    test.setTimeout(180_000)
    gitInit(env.workspaces.a)
    gitCommitAll(env.workspaces.a)
    const html = path.join(env.workspaces.a, 'docs', 'page.html')
    fs.appendFileSync(html, '<!-- koloft-e2e-html-edit -->\n')
    await startSessionIn(page, 'ws-a')

    await showBrowse(page)
    await page
      .locator(`${WORKBENCH.panel} .ft-node.ft-dir[data-path="${path.dirname(html)}"]`)
      .click({ timeout: 30_000 })
    await page
      .locator(`${WORKBENCH.panel} .ft-node.ft-file[data-path="${html}"]`)
      .click({ button: 'right', timeout: 30_000 })
    await page.locator('.ft-ctx-it', { hasText: 'View source' }).click({ timeout: 20_000 })

    await expect(page.locator(WORKBENCH.readingTitle)).toHaveText('docs/page.html', {
      timeout: 20_000
    })

    const segs = page.locator(
      `${WORKBENCH.panel} .fv-artifact-hd .seg[aria-label="View mode"] button`
    )
    await expect(segs).toHaveText(['Diff', 'Source'])
    await expect(page.locator(`${WORKBENCH.readingBody} .idiff`)).toContainText(
      'koloft-e2e-html-edit',
      {
        timeout: 20_000
      }
    )
    await segs.filter({ hasText: 'Source' }).click()
    await expect(page.locator(`${WORKBENCH.readingBody} .idiff`)).toHaveCount(0)
    await expect(page.locator(WORKBENCH.readingBody)).toContainText('<h1 id="top">', {
      timeout: 20_000
    })
    await segs.filter({ hasText: 'Diff' }).click()
    await expect(page.locator(`${WORKBENCH.readingBody} .idiff`)).toContainText(
      'koloft-e2e-html-edit'
    )
  })

  test('BB-M17: .html files stay visible under the Files tab’s Docs filter', async ({
    page,
    env
  }) => {
    test.setTimeout(180_000)
    gitInit(env.workspaces.a)
    await startSessionIn(page, 'ws-a')

    await runIn(page, centerTerm(page), '/write docs/report.html')
    const report = page.locator(`${WORKBENCH.panel} .cv-row[data-path="docs/report.html"]`)
    const code = page.locator(`${WORKBENCH.panel} .cv-row[data-path="src/app.ts"]`)
    await expect(report).toHaveCount(1, { timeout: 40_000 })
    await expect(code).toHaveCount(1)

    await page.locator(`${WORKBENCH.kindBar} .seg button`, { hasText: 'Filter' }).click()
    await page.locator('.fv-filters .ft-chip[data-chip="docs"]').click({ timeout: 20_000 })

    await expect(report).toHaveCount(1)
    await expect(report).toBeVisible()
    await expect(code).toHaveCount(0)

    await report.click()
    await expect(report).toHaveClass(/\bactive\b/, { timeout: 20_000 })
    expect(await activeKind(page)).toBe('files')
    await page.locator(`${WORKBENCH.panel} .cv-blk[data-path="docs/report.html"] .cv-split`).click()
    await expect(browserSurface(page)).toBeVisible({ timeout: 20_000 })
    await expect.poll(() => activeKind(page), { timeout: 20_000 }).toBe('web')
    await expect(page.locator(WORKBENCH.readingTitle)).toHaveCount(0)
  })

  test('BB-C49: a pre-merge (v2) layout.json loads and the panel works', async ({ env }) => {
    test.setTimeout(240_000)
    const id = seedJsonl(env, env.workspaces.a, { summary: 'Old layout session' })

    writeLegacyV2Layout(env, {
      version: 2,
      workspaces: (layoutOnDisk(env).workspaces ?? []) as { path: string }[],
      aux: { defaultMode: 'preview' },
      sessions: { [id]: { auxMode: 'preview' } }
    })

    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await expect(page.locator('.ws-head')).toHaveCount(2, { timeout: 20_000 })
      const row = page.locator('.ws-tab', { hasText: 'Old layout session' })
      await expect(row).toBeVisible({ timeout: 40_000 })

      await expect
        .poll(() => sessionWorkbenchOnDisk(env, id)?.open ?? null, { timeout: 30_000 })
        .toBe(false)
      expect(layoutOnDisk(env).version).toBe(4)

      await row.click()
      await expect(auxIcon(page, 'Workbench')).toHaveAttribute('aria-disabled', 'false', {
        timeout: 60_000
      })
      await showWorkbench(page)
      await openInBrowse(page, path.join(env.workspaces.a, 'README.md'))
      await expect(page.locator(WORKBENCH.readingTitle)).toHaveText('README.md', {
        timeout: 30_000
      })
      await expect(browserSurface(page)).toBeVisible()
      await expect(page.locator(WORKBENCH.readingBody)).toContainText('koloft-e2e-alpha')
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-C51: markdown still renders in the reading area with a working view control', async ({
    page,
    env
  }) => {
    test.setTimeout(180_000)
    gitInit(env.workspaces.a)
    gitCommitAll(env.workspaces.a)
    const readme = path.join(env.workspaces.a, 'README.md')
    fs.appendFileSync(readme, '\nkoloft-e2e-md-edit\n')
    await startSessionIn(page, 'ws-a')

    await openInBrowse(page, readme)

    await expect(page.locator(`${WORKBENCH.readingBody} .md-body`)).toContainText(
      'koloft-e2e-alpha',
      {
        timeout: 20_000
      }
    )

    const segs = page.locator(
      `${WORKBENCH.panel} .fv-artifact-hd .seg[aria-label="View mode"] button`
    )
    await expect(segs).toHaveText(['Rendered', 'Diff', 'Source'])
    await segs.filter({ hasText: 'Diff' }).click()
    await expect(page.locator(`${WORKBENCH.readingBody} .idiff`)).toContainText(
      'koloft-e2e-md-edit',
      {
        timeout: 20_000
      }
    )
    await segs.filter({ hasText: 'Rendered' }).click()
    await expect(page.locator(`${WORKBENCH.readingBody} .md-body`)).toContainText(
      'koloft-e2e-alpha'
    )
    await expect(page.locator(`${WORKBENCH.readingBody} .idiff`)).toHaveCount(0)
  })

  test('BB-C66: switching to the Files tab and back keeps the web tab set', async ({ page }) => {
    test.setTimeout(240_000)
    const srv = await startEchoServer()
    try {
      await startSessionIn(page, 'ws-a')
      await showWorkbench(page)
      await browseTo(page, srv.url('/a'), 'Page A')
      await browseTo(page, srv.url('/b'), 'Page B')
      expect(await wbTabTitles(page)).toEqual([FILES_LABEL, 'Page A', 'Page B'])

      await pinnedTab(page).click()
      await expect.poll(() => activeKind(page), { timeout: 20_000 }).toBe('files')
      await expect(page.locator(BROWSER.addressField)).toHaveCount(0)

      await wbTabByTitle(page, 'Page B').click()
      await expect.poll(() => activeKind(page), { timeout: 20_000 }).toBe('web')

      expect(await wbTabTitles(page)).toEqual([FILES_LABEL, 'Page A', 'Page B'])
    } finally {
      await srv.close()
    }
  })

  test('BB-C39: switching away and back preserves the tab set and the current page', async ({
    page
  }) => {
    test.setTimeout(300_000)
    const srv = await startEchoServer()
    try {
      await startSessionIn(page, 'ws-a')
      await startSessionIn(page, 'ws-b')
      const rowA = wsRows(page, 'ws-a').first()
      const rowB = wsRows(page, 'ws-b').first()

      await rowA.click()
      await showWorkbench(page)
      await browseTo(page, srv.url('/a'), 'Page A')
      await browseTo(page, srv.url('/b'), 'Page B')
      await wbTabByTitle(page, 'Page A').click()
      await expect(wbActiveTab(page).locator(BROWSER.tabLabel)).toHaveText('Page A')

      await rowB.click()
      await expect(rowB).toHaveClass(/\bactive\b/, { timeout: 20_000 })
      await rowA.click()
      await expect(rowA).toHaveClass(/\bactive\b/, { timeout: 20_000 })
      await showWorkbench(page)

      expect(await wbTabTitles(page)).toEqual([FILES_LABEL, 'Page A', 'Page B'])
      await expect(wbActiveTab(page).locator(BROWSER.tabLabel)).toHaveText('Page A')
    } finally {
      await srv.close()
    }
  })

  test('BB-C40: /clear carries the browser subtree onto the new session id without reloading or recycling its guests', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(300_000)
    const srv = await startEchoServer()
    try {
      await startSessionIn(page, 'ws-a')
      const [call] = await waitForCalls(env, 1)
      await showWorkbench(page)
      await browseTo(page, srv.url('/a'), 'Page A')
      await browseTo(page, srv.url('/b'), 'Page B')

      await expect.poll(() => srv.count('/a'), { timeout: 20_000 }).toBe(1)
      await expect.poll(() => srv.count('/b'), { timeout: 20_000 }).toBe(1)
      await guestByUrl(app, '/a')
      await guestByUrl(app, '/b')
      const guestIdsBefore = (await guestContents(app))
        .filter((g) => /\/[ab]$/.test(g.url))
        .map((g) => g.id)
        .sort()
      expect(guestIdsBefore).toHaveLength(2)

      await runIn(page, centerTerm(page), '/clear')

      let newId = ''
      await expect
        .poll(
          () => {
            const ids = Object.keys(layoutOnDisk(env).sessions as Record<string, unknown>)
            newId = ids.find((i) => i !== call.sessionId) ?? ''
            return newId
          },
          { timeout: 60_000 }
        )
        .not.toBe('')

      await showWorkbench(page)
      expect(await wbTabTitles(page)).toEqual([FILES_LABEL, 'Page A', 'Page B'])

      await page.waitForTimeout(LATE_RELOAD_GRACE_MS)
      expect(srv.count('/a')).toBe(1)
      expect(srv.count('/b')).toBe(1)
      const guestIdsAfter = (await guestContents(app))
        .filter((g) => /\/[ab]$/.test(g.url))
        .map((g) => g.id)
        .sort()
      expect(guestIdsAfter).toEqual(guestIdsBefore)
    } finally {
      await srv.close()
    }
  })

  test('BB-C41: a session that went cold resumes with its tab structure restored and nothing refetched until a tab is clicked', async ({
    page,
    env
  }) => {
    test.setTimeout(300_000)
    const srv = await startEchoServer()
    try {
      await startSessionIn(page, 'ws-a')
      const [call] = await waitForCalls(env, 1)
      await showWorkbench(page)
      await browseTo(page, srv.url('/a'), 'Page A')
      await browseTo(page, srv.url('/b'), 'Page B')
      const loadsOfA = srv.count('/a')
      const loadsOfB = srv.count('/b')

      const row = wsRows(page, 'ws-a').first()
      process.kill(call.pid, 'SIGHUP')
      await expect(row).toHaveClass(/\bcold\b/, { timeout: 60_000 })

      await row.click()
      await expect(auxIcon(page, 'Workbench')).toHaveAttribute('aria-disabled', 'false', {
        timeout: 60_000
      })
      await showWorkbench(page)

      expect(await wbTabTitles(page)).toEqual([FILES_LABEL, 'Page A', 'Page B'])
      await page.waitForTimeout(LATE_RELOAD_GRACE_MS)
      expect(srv.count('/a')).toBe(loadsOfA)
      expect(srv.count('/b')).toBe(loadsOfB)
      await expect(wbFrozenTabs(page)).toHaveCount(0, { timeout: 20_000 })

      await wbTabByTitle(page, 'Page A').click()
      await expect.poll(() => srv.count('/a'), { timeout: 30_000 }).toBeGreaterThan(loadsOfA)
    } finally {
      await srv.close()
    }
  })

  test('BB-C42: a Koloft restart loads no tab until a session is resumed', async ({ env }) => {
    test.setTimeout(420_000)
    const srv = await startEchoServer()
    try {
      const app1 = await launchApp(env)
      try {
        const page1 = await app1.firstWindow()
        await page1.waitForLoadState('domcontentloaded')
        await expect(page1.locator('.ws-head')).toHaveCount(2, { timeout: 20_000 })
        await startSessionIn(page1, 'ws-a')
        await showWorkbench(page1)
        await browseTo(page1, srv.url('/a'), 'Page A')
        await browseTo(page1, srv.url('/b'), 'Page B')
        expect(srv.count()).toBeGreaterThan(0)
      } finally {
        await app1.close().catch(() => {})
      }

      srv.reset()
      const app2 = await launchApp(env)
      try {
        const page2 = await app2.firstWindow()
        await page2.waitForLoadState('domcontentloaded')
        const row = wsRows(page2, 'ws-a').first()
        await expect(row).toHaveClass(/\bcold\b/, { timeout: 60_000 })
        expect(srv.count()).toBe(0)

        await row.click()
        await expect(auxIcon(page2, 'Workbench')).toHaveAttribute('aria-disabled', 'false', {
          timeout: 60_000
        })
        await showWorkbench(page2)
        expect(await wbTabTitles(page2)).toEqual([FILES_LABEL, 'Page A', 'Page B'])
        expect(srv.count()).toBe(0)
      } finally {
        await app2.close().catch(() => {})
      }
    } finally {
      await srv.close()
    }
  })

  test('BB-C43: archiving the viewed session destroys its guests, not its download', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(300_000)
    const srv = await startEchoServer()
    try {
      await startSessionIn(page, 'ws-a')
      const [call] = await waitForCalls(env, 1)
      await showWorkbench(page)
      await browseTo(page, srv.url('/a'), 'Page A')
      await browseTo(page, srv.url('/b'), 'Page B')
      await expect
        .poll(
          async () => (await guestContents(app)).filter((g) => g.url.startsWith(srv.origin)).length,
          { timeout: 30_000 }
        )
        .toBe(2)

      const address = page.locator(BROWSER.addressField).first()
      await address.click()
      await address.fill(srv.url('/download-slow?name=slow.bin&ms=8000'))
      await page.keyboard.press('Enter')
      await expect.poll(() => srv.count('/download-slow'), { timeout: 30_000 }).toBe(1)

      const row = wsRows(page, 'ws-a').first()
      process.kill(call.pid, 'SIGHUP')
      await expect(row).toHaveClass(/\bcold\b/, { timeout: 60_000 })
      await openMenu(page, row)
      await page.locator('.menu .mi', { hasText: 'Remove from list' }).click()
      await expect(row).toHaveCount(0, { timeout: 30_000 })

      await expect
        .poll(
          async () => (await guestContents(app)).filter((g) => g.url.startsWith(srv.origin)).length,
          { timeout: 30_000 }
        )
        .toBe(0)
      await expect(browserSurface(page)).toBeHidden()
      expect(await activeSurface(page)).toBeNull()
      await expect.poll(() => downloadedFiles(env), { timeout: 60_000 }).toContain('slow.bin')
    } finally {
      await srv.close()
    }
  })
})
