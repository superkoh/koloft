import fs from 'fs'
import os from 'os'
import path from 'path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect } from './helpers/app'
import type { E2EEnv } from './helpers/env'
import { centerTerm, clickAppMenuItem, focusOwner, gitInit, startSessionIn } from './helpers/p1'
import {
  BROWSER,
  BROWSER_MENU_IDS,
  downloadedFiles,
  globeIcon,
  guestByUrl,
  newWebTab,
  openBrowser,
  openViaAgent,
  typeInAddressBar,
  windowStates
} from './helpers/browser'
import { wbUnreadTabs } from './helpers/workbench'
import { startEchoServer } from './helpers/fixtureServer'

/**
 * The Session Browser's non-functional discipline
 *. The suite runs on the developer's live
 * machine, so a browser feature that renders remote pages, downloads files, detaches
 * devtools windows and touches the pasteboard must stay completely imperceptible:
 * nothing on screen, no focus stolen, no sound, nothing written into the developer's
 * own home, and the real clipboard never read or overwritten.
 *
 * Every oracle here is the one its case names. Windows are counted through Electron's
 * own BrowserWindow.getAllWindows() (app.windows() mixes in guests and misses hidden
 * ones), and focus is never read from document.hasFocus() — offscreen it reports true
 * in three places at once.
 */

/** Every BrowserWindow's on-screen / activated pair, incl. a detached devtools window. */
function windowFocusStates(
  app: ElectronApplication
): Promise<{ visible: boolean; focused: boolean }[]> {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((w) => ({ visible: w.isVisible(), focused: w.isFocused() }))
  )
}

/**
 * The Given every Browser case shares: a running session, the Workbench panel up, and one
 * `web` tab under the address bar.
 *
 * The last step is new and is not a convenience: the address row (`.baddr`) is
 * the `web` KIND's own bar (FR-36), and the panel always opens on the pinned `files` tab
 * (FR-02), whose bar has no address field at all. Without ＋ ▸ "New web tab" every
 * `typeInAddressBar` below waits 30s on a field that is not in the document.
 */
async function browserSession(page: Page, env: E2EEnv): Promise<void> {
  gitInit(env.workspaces.a)
  await startSessionIn(page, 'ws-a')
  await expect(globeIcon(page)).toBeVisible({ timeout: 30_000 })
  await openBrowser(page)
  await newWebTab(page)
  await expect(page.locator(BROWSER.addressField).first()).toBeVisible({ timeout: 20_000 })
}

test('BB-N01: an agent-opened page never steals window focus', async ({ app, page, env }) => {
  test.setTimeout(180_000)
  const server = await startEchoServer()
  try {
    gitInit(env.workspaces.a)
    await startSessionIn(page, 'ws-a')
    // the user is at the TUI when the agent fires (background test mode: the window is
    // never OS-focused, so where the keystrokes would land is the DOM focus)
    await centerTerm(page).click()
    expect(await focusOwner(page)).toBe('tui')

    await openViaAgent(page, server.url('/a'))

    // TEST-3 barrier, NOT the oracle: wait for the positive signal that the agent open
    // really landed as a background tab, so the negative assertions below cannot pass
    // vacuously. MOVED that signal: FR-51 deletes every titlebar dot and count (the
    // old barrier here), and FR-13/FR-16 put the unread mark on the tab strip instead.
    // The strip resolves whatever the layout state is — a collapsed panel is
    // `visibility:hidden`, never unmounted (the same thing WB-K07 relies on) — so this
    // barrier does not depend on whether the panel happens to be expanded.
    //
    // FR-13's other clause — an agent open never EXPANDS the panel — is not observable
    // from here any more and is not missing: `workbench.defaultOpen` ships true, so the
    // panel is already up. It lives in workbench-layout.spec.ts WB-K07, which collapses to
    // T1 first. Don't "restore" it here; it would assert nothing.
    await expect(wbUnreadTabs(page)).toHaveCount(1, { timeout: 30_000 })

    // nothing was shown or activated, and the focus never left the TUI
    for (const w of await windowFocusStates(app)) {
      expect(w.visible).toBe(false)
      expect(w.focused).toBe(false)
    }
    expect(await focusOwner(page)).toBe('tui')
  } finally {
    await server.close()
  }
})

test('BB-N02: no Browser guest or devtools window is ever visible on screen in background test mode', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  const server = await startEchoServer()
  try {
    await browserSession(page, env)

    // a Browser guest is loaded...
    const url = server.url('/a')
    await typeInAddressBar(page, url)
    await guestByUrl(app, url)

    // ...and devtools is detached on top of it
    await clickAppMenuItem(app, page, BROWSER_MENU_IDS.devtools)
    // no positive barrier exists here: BB-N06 lets the detach be refused outright, so a
    // devtools window may legitimately never appear. Give it room to surface instead.
    await page.waitForTimeout(3000)

    const windows = await windowStates(app)
    expect(windows.length).toBeGreaterThan(0)
    for (const w of windows) expect(w.visible).toBe(false)
  } finally {
    await server.close()
  }
})

test('BB-N03: guests make no sound; audio autoplay is muted', async ({ app, page, env }) => {
  test.setTimeout(180_000)
  const server = await startEchoServer()
  try {
    await browserSession(page, env)

    const url = server.url('/audio')
    await typeInAddressBar(page, url)
    const guest = await guestByUrl(app, url)
    // R5's product half, and it is deterministic: no user gesture ever reaches the guest
    // here, so under `document-user-activation-required` the page's play() is always
    // refused — 'playing' would mean the policy is not in force at all.
    await expect(guest.locator('#played')).toHaveText('blocked', { timeout: 20_000 })

    // Sampled across two seconds: the blanket background-test mute holds on every guest.
    // The flag IS the oracle, deliberately not `isCurrentlyAudible()`: that signal is
    // stream-level and false-positives under load — measured (4 workers):
    // audible=true for seconds on a guest whose play() was refused AND whose contents
    // stayed muted, i.e. while no sound was possible. A muted flag that never drops is
    // what "makes no sound" observably means; an unmute slipping through would fail this
    // on the very sample it lands.
    const unmuted: boolean[] = []
    const found: boolean[] = []
    for (let i = 0; i < 7; i++) {
      const muted = await app.evaluate(({ webContents }) =>
        webContents
          .getAllWebContents()
          .filter((w) => w.getType() === 'webview')
          .map((w) => w.isAudioMuted())
      )
      // an empty sample proves nothing: the guest has to be THERE for its flag to count
      found.push(muted.length > 0)
      unmuted.push(muted.some((m) => !m))
      await page.waitForTimeout(300)
    }
    expect(found).not.toContain(false) // the guest never left mid-sample
    expect(unmuted).not.toContain(true)
  } finally {
    await server.close()
  }
})

test('BB-N04: downloads never write into the real user Downloads directory', async ({
  page,
  env
}) => {
  test.setTimeout(180_000)
  const server = await startEchoServer()
  try {
    await browserSession(page, env)

    // a name unique to this run: if the download escapes KOLOFT_DOWNLOAD_DIR, the stray
    // file in the developer's real ~/Downloads is identifiable rather than anonymous
    const name = `koloft-e2e-n04-${Date.now()}.txt`
    const realDownloads = path.join(os.homedir(), 'Downloads', name)

    await typeInAddressBar(page, server.url(`/download?name=${name}`))

    await expect.poll(() => downloadedFiles(env), { timeout: 30_000 }).toContain(name)
    expect(fs.existsSync(realDownloads)).toBe(false)
  } finally {
    await server.close()
  }
})

test('BB-N05: no browser flow reads or overwrites the real clipboard', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  const server = await startEchoServer()
  try {
    gitInit(env.workspaces.a)
    await startSessionIn(page, 'ws-a')

    // "the clipboard holding known content", R7-safe: the harness may not read or write
    // the developer's real pasteboard (the PRD bans main-side readText assertions for
    // exactly that reason), so the main-side clipboard API is swapped for a recorder
    // holding a known string. Every main-side read/write during the flow is recorded —
    // and cannot reach the machine's real clipboard.
    await app.evaluate(({ clipboard }) => {
      const g = globalThis as unknown as { __koloftClipboardCalls?: string[] }
      g.__koloftClipboardCalls = []
      clipboard.readText = ((): string => {
        g.__koloftClipboardCalls?.push('readText')
        return 'koloft-e2e-known-clipboard'
      }) as typeof clipboard.readText
      clipboard.writeText = ((text: string): void => {
        g.__koloftClipboardCalls?.push(`writeText:${text}`)
      }) as typeof clipboard.writeText
    })

    // a browser flow: open the Workbench, mint a `web` tab (FR-36: only that kind has an
    // address row), load a page, follow a link in it
    await expect(globeIcon(page)).toBeVisible({ timeout: 30_000 })
    await openBrowser(page)
    await newWebTab(page)
    await expect(page.locator(BROWSER.addressField).first()).toBeVisible({ timeout: 20_000 })
    const first = server.url('/a')
    await typeInAddressBar(page, first)
    const guest = await guestByUrl(app, first)
    await guest.locator('#to-b').click()
    await guestByUrl(app, server.url('/b'))

    const calls = await app.evaluate(
      () =>
        (globalThis as unknown as { __koloftClipboardCalls?: string[] }).__koloftClipboardCalls ??
        []
    )
    expect(calls).toEqual([])
  } finally {
    await server.close()
  }
})

test('BB-N06: a detached devtools window does not take screen or focus in background mode', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  const server = await startEchoServer()
  try {
    await browserSession(page, env)

    const url = server.url('/a')
    await typeInAddressBar(page, url)
    await guestByUrl(app, url)

    await clickAppMenuItem(app, page, BROWSER_MENU_IDS.devtools)
    // the detach is allowed to be refused instead of opening, so there is nothing
    // positive to wait for — give a window time to surface, then read every window
    await page.waitForTimeout(3000)

    // refused (no extra window) or opened with activate:false: either way nothing
    // surfaced and nothing took the focus
    for (const w of await windowFocusStates(app)) {
      expect(w.visible).toBe(false)
      expect(w.focused).toBe(false)
    }
  } finally {
    await server.close()
  }
})
