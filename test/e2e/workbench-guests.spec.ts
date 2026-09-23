import { test, expect, launchApp } from './helpers/app'
import type { Page } from '@playwright/test'
import { startEchoServer, type FixtureServer } from './helpers/fixtureServer'
import {
  centerTerm,
  killSession,
  runIn,
  sendShortcut,
  startSessionIn,
  waitBooted,
  waitForCalls,
  wsRows
} from './helpers/p1'
import { setGuestLimit } from './helpers/env'
import {
  waitPanelAttached,
  wbActiveTab,
  wbFrozenTabs,
  wbTabs,
  workbenchPanel
} from './helpers/workbench'

let server: FixtureServer

test.beforeAll(async () => {
  server = await startEchoServer()
})

test.afterAll(async () => {
  await server?.close()
})

const STATEFUL_PAGE = `<!doctype html><title>Stateful</title>
<input id="f" />
<div style="height:4000px">tall</div>`

async function agentOpen(page: Page, target: string): Promise<void> {
  await runIn(page, centerTerm(page), `/open ${target}`)
}

async function inGuest<T>(page: Page, expression: string): Promise<T> {
  return page.evaluate(async (expr) => {
    const el = document.querySelector(
      '.wb-panel webview:not([style*="display: none"])'
    ) as unknown as { executeJavaScript(code: string): Promise<unknown> } | null
    if (!el) throw new Error('no live guest')
    return el.executeJavaScript(expr) as Promise<never>
  }, expression) as Promise<T>
}

test.describe('Workbench web guests: no layout change tears one down, the tab cap closes, the live-guest cap only freezes', () => {
  test('WB-W04: a guest keeps its form value and scroll across tab and session switches', async ({
    page
  }) => {
    test.setTimeout(240_000)
    await startSessionIn(page, 'ws-a')
    const url = server.page('/stateful', STATEFUL_PAGE)
    await agentOpen(page, url)
    await wbTabs(page).nth(1).click()
    await expect.poll(() => server.count('/stateful'), { timeout: 30_000 }).toBeGreaterThan(0)

    await inGuest(page, `document.getElementById('f').value = 'koloft-w04'; scrollTo(0, 900); 1`)
    await expect.poll(() => inGuest<number>(page, 'scrollY')).toBeGreaterThan(0)

    await wbTabs(page).nth(0).click()
    await expect(wbActiveTab(page)).toHaveClass(/pinned/)
    await wbTabs(page).nth(1).click()
    expect(await inGuest<string>(page, `document.getElementById('f').value`)).toBe('koloft-w04')
    expect(await inGuest<number>(page, 'scrollY')).toBeGreaterThan(0)

    await startSessionIn(page, 'ws-a')
    await expect(page.locator('.ws-tab')).toHaveCount(2, { timeout: 25_000 })
    await page
      .locator('.hint-card[data-hint="worktree"]')
      .getByRole('button', { name: 'Got it', exact: true })
      .click()
    await page.locator('.ws-tab').nth(1).click()
    await expect(workbenchPanel(page)).toBeVisible()
    await page.locator('.ws-tab').nth(0).click()

    await expect
      .poll(() => inGuest<string>(page, `document.getElementById('f').value`))
      .toBe('koloft-w04')
    expect(await inGuest<number>(page, 'scrollY')).toBeGreaterThan(0)

    expect(server.count('/stateful')).toBe(1)

    // PLATFORM§9
    const displays = await page.evaluate(() =>
      [...document.querySelectorAll('.wb-panel webview')].map(
        (el) => getComputedStyle(el.parentElement ?? el).display
      )
    )
    expect(displays.every((d) => d !== 'none')).toBe(true)
  })

  test('WB-T13: over the global guest cap the least-recently-viewed freezes, and never closes', async ({
    app,
    env
  }) => {
    test.setTimeout(240_000)
    await app.close().catch(() => {})
    setGuestLimit(env, 2)
    const relaunched = await launchApp(env)
    const page = await relaunched.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')

    const urls = ['a', 'b', 'c', 'd'].map((n) =>
      server.page(`/t13-${n}`, `<!doctype html><title>T13 ${n}</title><p>${n}`)
    )
    for (const u of urls) await agentOpen(page, u)
    await expect(wbTabs(page)).toHaveCount(5)

    for (let i = 1; i <= 4; i++) {
      await wbTabs(page).nth(i).click()
      await expect
        .poll(() => server.count(`/t13-${['a', 'b', 'c', 'd'][i - 1]}`))
        .toBeGreaterThan(0)
    }

    await expect(wbTabs(page)).toHaveCount(5)
    await expect.poll(() => wbFrozenTabs(page).count()).toBeGreaterThan(0)
    const frozen = wbFrozenTabs(page).first()
    await expect(frozen).toBeVisible()
    await expect(frozen).not.toHaveText('')

    const label = (await frozen.textContent())?.trim() ?? ''
    await frozen.click()
    await expect(wbActiveTab(page)).toContainText(label.replace(/×$/, '').trim())
    await expect(wbTabs(page)).toHaveCount(5)
    await relaunched.close().catch(() => {})
  })

  test('a background session’s live guests spend from the same global live-guest cap as the on-screen session’s', async ({
    app,
    env
  }) => {
    test.setTimeout(300_000)
    await app.close().catch(() => {})
    setGuestLimit(env, 2)
    const relaunched = await launchApp(env)
    const page = await relaunched.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await waitBooted(page)

    const pageNamed = (n: string): string =>
      server.page(`/t13b-${n}`, `<!doctype html><title>T13b ${n}</title><p>${n}`)

    await startSessionIn(page, 'ws-a')
    await agentOpen(page, pageNamed('a'))
    await wbTabs(page).nth(1).click()
    await expect.poll(() => server.count('/t13b-a'), { timeout: 30_000 }).toBeGreaterThan(0)
    await wbTabs(page).nth(0).click()
    await expect(wbActiveTab(page)).toHaveClass(/pinned/)

    await startSessionIn(page, 'ws-b')
    for (const [i, n] of ['b', 'c'].entries()) {
      await agentOpen(page, pageNamed(n))
      await wbTabs(page)
        .nth(i + 1)
        .click()
      await expect.poll(() => server.count(`/t13b-${n}`), { timeout: 30_000 }).toBeGreaterThan(0)
    }

    await expect.poll(() => page.locator('.wb-panel webview').count()).toBe(2)

    const rowA = wsRows(page, 'ws-a').first()
    await rowA.click()
    await expect(rowA).toHaveClass(/\bactive\b/, { timeout: 20_000 })
    await expect(wbFrozenTabs(page)).toHaveCount(1)
    await expect(wbFrozenTabs(page).first()).toContainText(/T13b a|t13b-a/)
    await relaunched.close().catch(() => {})
  })

  test('WB-K04: ⌘W and ⌘F still work with the focus inside a guest', async ({ app, page }) => {
    test.setTimeout(240_000)
    await startSessionIn(page, 'ws-a')
    const url = server.page('/k04', '<!doctype html><title>K04</title><p>find me here')
    await agentOpen(page, url)
    await wbTabs(page).nth(1).click()
    await expect.poll(() => server.count('/k04'), { timeout: 30_000 }).toBeGreaterThan(0)

    await page.locator('.wb-panel webview').first().click()

    await sendShortcut(app, 'shortcut:find')
    await expect(page.locator('.wb-panel .find-bar')).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(page.locator('.wb-panel .find-bar')).toHaveCount(0)

    await sendShortcut(app, 'shortcut:close-tab')
    await expect(wbTabs(page)).toHaveCount(1)
    await expect(page.locator('.modal.lifecycle-modal')).toHaveCount(0)
    await expect(centerTerm(page)).toBeVisible()
  })

  test('WB-T10: the 9th web tab evicts the least-recently-viewed and the toast names it', async ({
    page
  }) => {
    test.setTimeout(300_000)
    await startSessionIn(page, 'ws-a')

    for (let i = 1; i <= 8; i++) {
      await agentOpen(page, server.page(`/cap-${i}`, `<!doctype html><title>Cap ${i}</title>`))
    }
    await expect(wbTabs(page)).toHaveCount(9)

    await agentOpen(page, server.page('/cap-9', '<!doctype html><title>Cap 9</title>'))

    await expect(wbTabs(page)).toHaveCount(9)
    await expect(page.locator('.wb-tab', { hasText: 'cap-1' })).toHaveCount(0)
    await expect(page.locator('.wb-tab', { hasText: 'cap-9' })).toHaveCount(1)
    await expect(page.locator('.toast')).toContainText('cap-1')
    await expect(wbTabs(page).nth(0)).toHaveClass(/pinned/)
  })

  test('WB-T14: a session’s tab set survives its death and comes back, unloaded, on resume', async ({
    page,
    env
  }) => {
    test.setTimeout(240_000)
    await startSessionIn(page, 'ws-a')
    const [session] = await waitForCalls(env, 1)
    const url = server.page('/cold', '<!doctype html><title>Cold</title><p>page')
    await agentOpen(page, url)
    await wbTabs(page).nth(1).click()
    await expect.poll(() => server.count('/cold'), { timeout: 30_000 }).toBeGreaterThan(0)
    await expect(wbTabs(page)).toHaveCount(2)
    const loads = server.count('/cold')

    killSession(session.pid, env)
    const row = wsRows(page, 'ws-a').first()
    await expect(row).toHaveClass(/\bcold\b/, { timeout: 40_000 })
    await expect(workbenchPanel(page)).not.toBeVisible()

    await row.click()
    await waitPanelAttached(page)
    await expect(wbTabs(page)).toHaveCount(2, { timeout: 30_000 })
    expect(server.count('/cold')).toBe(loads)
  })
})
