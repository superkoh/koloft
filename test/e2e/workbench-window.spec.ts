import fs from 'fs'
import path from 'path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { installCodex } from './helpers/env'
import {
  openSessionTerminal,
  panelTerm,
  runIn,
  startSessionIn,
  terminalText,
  waitBooted
} from './helpers/p1'
import { WORKBENCH, workbenchPanel } from './helpers/workbench'
import { BROWSER, cdpEndpointOf, connectCdp, guestByUrl, openViaAgent } from './helpers/browser'
import { startEchoServer } from './helpers/fixtureServer'
import { setupChangeFixture } from './helpers/filesFixture'
import {
  addRemoteWorkspace,
  killFakeRemote,
  launchWithRemote,
  remoteDir,
  REMOTE_WS_NAME
} from './helpers/remote'

const POP_OUT = 'button[aria-label="Move to its own window"]'
const PUT_BACK = 'button[aria-label="Put back beside the session"]'
const AGENT_DRIVING_TOAST = /An agent is using a page in the Workbench/
const CHANGE_ROW = '.wb-panel .cv-row'

test.afterEach(({ env }) => killFakeRemote(env))

async function shortcutToMain(app: ElectronApplication, channel: string): Promise<void> {
  await app.evaluate(({ BrowserWindow }, ch) => {
    BrowserWindow.getAllWindows()
      .find((w) => w.webContents.getURL() !== 'about:blank')
      ?.webContents.send(ch)
  }, channel)
}

async function pretendWorkbenchWindowFocused(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL() === 'about:blank')
    if (!w) throw new Error('no Workbench window')
    w.isFocused = () => true
    w.emit('focus')
  })
}

function hostOfGuest(app: ElectronApplication, urlPart: string): Promise<string | null> {
  return app.evaluate(({ BrowserWindow, webContents }, part) => {
    const guest = webContents
      .getAllWebContents()
      .find((w) => w.getType() === 'webview' && w.getURL().includes(part))
    if (!guest) return null
    return BrowserWindow.fromWebContents(guest)?.webContents.getURL() ?? null
  }, urlPart)
}

async function showFilesView(scope: Page, view: 'Changes' | 'Browse'): Promise<void> {
  const pinned = scope.locator(WORKBENCH.tabFiles)
  if (!(await pinned.getAttribute('class'))?.split(/\s+/).includes('on')) await pinned.click()
  const button = scope
    .locator(`${WORKBENCH.kindBar} .seg[aria-label="Files view"] button`)
    .filter({ hasText: view })
  await expect(button).toBeVisible({ timeout: 20_000 })
  if ((await button.getAttribute('aria-pressed')) !== 'true') await button.click()
}

async function workbenchWindowPage(app: ElectronApplication): Promise<Page> {
  await expect
    .poll(() => app.windows().filter((p) => p.url() === 'about:blank').length, {
      timeout: 15_000
    })
    .toBe(1)
  return app.windows().find((p) => p.url() === 'about:blank') as Page
}

function openWindowCount(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
}

async function closeWorkbenchWindowLikeTheRedLight(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL() === 'about:blank')
    w?.close()
  })
}

async function shellTabId(page: Page): Promise<string> {
  const id = await page
    .locator(`${WORKBENCH.panel} .wb-term:visible`)
    .first()
    .getAttribute('data-pty')
  if (!id) throw new Error('no visible shell tab')
  return id
}

async function popOut(app: ElectronApplication, page: Page): Promise<Page> {
  await workbenchPanel(page).locator(POP_OUT).first().click()
  const aux = await workbenchWindowPage(app)
  await expect(aux.locator(WORKBENCH.panel)).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.wb-col')).toHaveCount(0)
  return aux
}

test.describe('Workbench window: the whole Workbench moves to a window of its own and back', () => {
  test('WB-WIN-01: popping out carries the shell with its screen, follows no reload of the shell, and closing the window puts the Workbench back beside the session', async ({
    app,
    page
  }) => {
    await startSessionIn(page, 'ws-a')
    await openSessionTerminal(app, page)
    await runIn(page, panelTerm(page), 'echo before_pop_marker')
    const ptyId = await shellTabId(page)
    await expect.poll(() => terminalText(page, ptyId)).toContain('before_pop_marker')

    const aux = await popOut(app, page)
    expect(await openWindowCount(app)).toBe(2)
    await expect(aux.locator(`${WORKBENCH.panel} .wb-term[data-pty="${ptyId}"]`)).toBeVisible()
    expect(await terminalText(page, ptyId)).toContain('before_pop_marker')

    await page.evaluate(
      ([id, line]) => window.api.terminal.write(id, line),
      [ptyId, 'echo after_pop_marker\r']
    )
    await expect.poll(() => terminalText(page, ptyId)).toContain('after_pop_marker')

    await closeWorkbenchWindowLikeTheRedLight(app)
    await expect.poll(() => openWindowCount(app)).toBe(1)
    await expect(workbenchPanel(page)).toBeVisible({ timeout: 15_000 })
    await expect(page.locator(`${WORKBENCH.panel} .wb-term[data-pty="${ptyId}"]`)).toHaveCount(1)
    const text = await terminalText(page, ptyId)
    expect(text).toContain('before_pop_marker')
    expect(text).toContain('after_pop_marker')
  })

  test('WB-WIN-02: a popped Workbench opens popped again on the next launch, and a put-back one opens beside the session', async ({
    env
  }) => {
    let app = await launchApp(env)
    let page = await app.firstWindow()
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })
    await popOut(app, page)
    await quitAndClose(app)

    app = await launchApp(env)
    page = await app.firstWindow()
    await waitBooted(page)
    const aux = await workbenchWindowPage(app)
    await expect(aux.locator('.wb-aux')).toHaveCount(1, { timeout: 15_000 })
    await aux.locator(`.wb-aux .empty ${PUT_BACK}`).click()
    await expect.poll(() => openWindowCount(app)).toBe(1)
    await quitAndClose(app)

    app = await launchApp(env)
    page = await app.firstWindow()
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })
    expect(await openWindowCount(app)).toBe(1)
    await quitAndClose(app)
  })

  test('WB-WIN-03: a web page in the Workbench opens again inside the Workbench window, and comes back with it', async ({
    app,
    page
  }) => {
    const server = await startEchoServer()
    try {
      await startSessionIn(page, 'ws-a')
      await openViaAgent(page, server.page('/carried', '<title>Carried</title><body>c</body>'))
      await guestByUrl(app, '/carried')
      await expect.poll(() => hostOfGuest(app, '/carried')).toBe(page.url())

      await popOut(app, page)
      await expect.poll(() => hostOfGuest(app, '/carried'), { timeout: 20_000 }).toBe('about:blank')
      expect(await (await guestByUrl(app, '/carried')).title()).toBe('Carried')

      await closeWorkbenchWindowLikeTheRedLight(app)
      await expect.poll(() => openWindowCount(app)).toBe(1)
      await expect.poll(() => hostOfGuest(app, '/carried'), { timeout: 20_000 }).toBe(page.url())
    } finally {
      await server.close()
    }
  })

  test('WB-WIN-04: while an agent drives a page the Workbench stays where it is; once popped, the agent drives it there and a minimized window answers its screenshot with an error, not a hang', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    const server = await startEchoServer()
    try {
      await waitBooted(page)
      await startSessionIn(page, 'ws-a')
      const endpoint = await cdpEndpointOf(env)
      let browser = await connectCdp(page, endpoint)
      const driven = await browser.contexts()[0].newPage()
      await driven.goto(server.page('/driven', '<title>Driven</title><body>d</body>'))
      await expect(workbenchPanel(page)).toBeVisible({ timeout: 20_000 })

      await workbenchPanel(page).locator(POP_OUT).first().click()
      await expect(page.locator('.toast')).toContainText(AGENT_DRIVING_TOAST)
      expect(await openWindowCount(app)).toBe(1)
      await browser.close()
      await expect(page.locator('.wb-panel .bdriven')).toHaveCount(0, { timeout: 20_000 })

      const aux = await popOut(app, page)
      browser = await connectCdp(page, endpoint)
      try {
        const there = await browser.contexts()[0].newPage()
        await there.goto(server.page('/there', '<title>There</title><body>t</body>'))
        expect(await there.title()).toBe('There')
        await expect.poll(() => hostOfGuest(app, '/there')).toBe('about:blank')
        expect((await there.screenshot()).length).toBeGreaterThan(0)

        await aux.locator(PUT_BACK).first().click()
        await expect(page.locator('.toast')).toContainText(AGENT_DRIVING_TOAST)
        await closeWorkbenchWindowLikeTheRedLight(app)
        expect(await openWindowCount(app)).toBe(2)

        await app.evaluate(({ BrowserWindow }) => {
          const w = BrowserWindow.getAllWindows().find(
            (x) => x.webContents.getURL() === 'about:blank'
          )
          if (w) w.isMinimized = () => true
        })
        await expect(there.screenshot({ timeout: 20_000 })).rejects.toThrow(/minimized/)
      } finally {
        await browser.close().catch(() => {})
      }
    } finally {
      await server.close()
    }
  })

  test('WB-WIN-05: unplugging the screen the Workbench window sits on puts the Workbench back beside the session', async ({
    app,
    page
  }) => {
    await startSessionIn(page, 'ws-a')
    await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })
    await popOut(app, page)
    await expect
      .poll(() =>
        app.evaluate(({ screen, BrowserWindow }) => {
          const w = BrowserWindow.getAllWindows().find(
            (x) => x.webContents.getURL() === 'about:blank'
          )
          if (!w) return 'docked'
          const b = w.getNormalBounds()
          screen.emit('display-removed', {}, { id: 424242, bounds: b, workArea: b })
          return 'still popped'
        })
      )
      .toBe('docked')
    await expect(workbenchPanel(page)).toBeVisible({ timeout: 15_000 })
  })

  test('WB-WIN-06: in the Workbench window, keys act on the Workbench — Find paints its marks there, ⌘W there never closes the session, Focus Mode is off and ⇧⌘B leaves the window where it is', async ({
    app,
    page,
    env
  }) => {
    const fx = setupChangeFixture(env.workspaces.a)
    fx.modifyTracked(2)
    await startSessionIn(page, 'ws-a')
    await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })
    const aux = await popOut(app, page)
    await showFilesView(aux, 'Changes')
    await expect(aux.locator(CHANGE_ROW)).toHaveCount(2, { timeout: 30_000 })

    expect(
      await app.evaluate(
        ({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('toggle-focus-mode')?.enabled
      )
    ).toBe(false)
    await app.evaluate(({ Menu }) =>
      Menu.getApplicationMenu()?.getMenuItemById('toggle-browser')?.click()
    )
    await expect(page.locator('.wb-col')).toHaveCount(0)
    expect(await openWindowCount(app)).toBe(2)

    await pretendWorkbenchWindowFocused(app)
    await aux.locator(CHANGE_ROW).first().click()
    await shortcutToMain(app, 'shortcut:find')
    const find = aux.locator('.find-bar .find-input')
    await expect(find).toBeVisible({ timeout: 10_000 })
    await find.fill('change')
    await expect
      .poll(() =>
        aux.evaluate(() => CSS.highlights.has('find-all') || CSS.highlights.has('find-active'))
      )
      .toBe(true)
    expect(await page.evaluate(() => CSS.highlights.size)).toBe(0)

    await aux.locator(CHANGE_ROW).first().click()
    await shortcutToMain(app, 'shortcut:close-tab')
    await expect(page.locator('.modal-header')).toHaveCount(0)
    await expect(page.locator('.term-island .term-wrap')).toHaveCount(1)
    await expect(aux.locator(`.wb-aux .empty ${PUT_BACK}`)).toHaveCount(0)
  })

  test('WB-WIN-07: a Codex session’s Workbench pops out and back the same way', async ({ env }) => {
    installCodex(env)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await startSessionIn(page, 'ws-a', { method: 'Codex' })
      await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })
      const aux = await popOut(app, page)
      await expect(aux.locator(WORKBENCH.panel)).toBeVisible()
      await closeWorkbenchWindowLikeTheRedLight(app)
      await expect(workbenchPanel(page)).toBeVisible({ timeout: 15_000 })
    } finally {
      await quitAndClose(app)
    }
  })

  test('WB-WIN-08: a remote session’s Workbench pops out with its remote files and back', async ({
    env
  }) => {
    test.setTimeout(300_000)
    const { app, page } = await launchWithRemote(env)
    try {
      fs.writeFileSync(path.join(remoteDir(env), 'remote-popped.txt'), 'r\n')
      expect((await addRemoteWorkspace(page, env)).code).toBe('added')
      await startSessionIn(page, REMOTE_WS_NAME, { remote: true })
      await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })
      const aux = await popOut(app, page)
      await showFilesView(aux, 'Browse')
      await expect(
        aux.locator('.wb-panel .ft-node', { hasText: 'remote-popped.txt' }).first()
      ).toBeVisible({
        timeout: 30_000
      })
      await closeWorkbenchWindowLikeTheRedLight(app)
      await expect(workbenchPanel(page)).toBeVisible({ timeout: 15_000 })
    } finally {
      await quitAndClose(app)
    }
  })

  test('WB-WIN-09: in the Workbench window a page’s dialog, the downloads list and a file row’s menu open in that window and close with Esc there', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    const server = await startEchoServer()
    try {
      const fx = setupChangeFixture(env.workspaces.a)
      fx.modifyTracked(1)
      await startSessionIn(page, 'ws-a')
      await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })
      const aux = await popOut(app, page)

      await openViaAgent(page, server.url('/dialogs'))
      const guest = await guestByUrl(app, '/dialogs')
      const alerted = guest.locator('#do-alert').click()
      const modal = aux.locator(BROWSER.modal)
      await expect(modal).toContainText('koloft alert', { timeout: 30_000 })
      expect(await page.locator(BROWSER.modal).count()).toBe(0)
      await modal.locator('button').last().click()
      await alerted
      await expect(modal).toHaveCount(0)

      await guest.evaluate(() => {
        location.href = '/download?name=popped-download.txt'
      })
      await aux.locator(BROWSER.downloadButton).click({ timeout: 30_000 })
      await expect(aux.locator(BROWSER.downloadRow)).toContainText('popped-download.txt')
      expect(await page.locator(BROWSER.downloadPanel).count()).toBe(0)
      await aux.locator(BROWSER.downloadPanel).press('Escape')
      await expect(aux.locator(BROWSER.downloadPanel)).toHaveCount(0)

      await showFilesView(aux, 'Changes')
      await aux.locator(CHANGE_ROW).first().click({ button: 'right' })
      const menu = aux.locator('.ft-ctx')
      await expect(menu).toBeVisible({ timeout: 10_000 })
      expect(await page.locator('.ft-ctx').count()).toBe(0)
      await menu.press('Escape')
      await expect(menu).toHaveCount(0)
    } finally {
      await server.close()
    }
  })

  test('WB-WIN-10: the Workbench window reopens where it was left, at the size it was left', async ({
    env
  }) => {
    let app = await launchApp(env)
    let page = await app.firstWindow()
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })
    await popOut(app, page)
    const placed = await app.evaluate(({ BrowserWindow, screen }) => {
      const area = screen.getPrimaryDisplay().workArea
      const b = { x: area.x + 40, y: area.y + 40, width: 820, height: 640 }
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL() === 'about:blank')
        ?.setBounds(b)
      return b
    })
    const stateFile = path.join(env.userData, 'window-state.json')
    await expect
      .poll(() => {
        try {
          return JSON.parse(fs.readFileSync(stateFile, 'utf8')).workbench?.bounds
        } catch {
          return null
        }
      })
      .toEqual(placed)
    await quitAndClose(app)

    app = await launchApp(env)
    page = await app.firstWindow()
    await waitBooted(page)
    await workbenchWindowPage(app)
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((w) => w.webContents.getURL() === 'about:blank')
          ?.getBounds()
      )
    ).toEqual(placed)
    await quitAndClose(app)
  })
})
