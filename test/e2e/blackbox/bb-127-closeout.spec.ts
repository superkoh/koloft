import type { Page } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import { test, expect } from '../helpers/app'
import {
  BROWSER,
  addressValue,
  guestByUrl,
  guestPages,
  newWebTab,
  openBrowser,
  openTabs,
  pinnedTab,
  tabTitles,
  typeInAddressBar
} from '../helpers/browser'
import { startEchoServer, type FixtureServer } from '../helpers/fixtureServer'
import { startSessionIn } from '../helpers/p1'

/**
 * Black-box cases for the browser close-out
 *.
 *
 * Requirements only: every oracle here is a sentence from the close-out PRD
 * the original design notes (retired after the feature
 * merged, as is the session-browser design that later absorbed its B7–B12 decisions;
 * the deciding comments live at each implementation site), never a detail of how it
 * was built. The llm-driven cases (real
 * audio, a real OS file drag, the real clipboard, sensory judgement) are deliberately
 * NOT here — they stay in the cases file for the manual round, because an automated
 * version of them would either be vacuous or would put a window on the developer's
 * screen (R7).
 *
 * Retargeted for which merged the Browser pane into the Workbench panel. Every
 * oracle below is unchanged — FR-37 says the permission bar, downloads, ⋯ menu, tab
 * reordering and page fullscreen behave exactly as before the merge, so a case that had
 * to be weakened would be a finding, not a migration. Only two Givens moved:
 *   - the address row belongs to the `web` KIND now (FR-36) and the panel opens on the
 *     pinned `files` tab (FR-02), so a url needs `openTabOn` / `webTabUp` first;
 *   - the pinned tab occupies slot 0 and is not closable or draggable, so counts run
 *     against `openTabs` (the closable set) and `tabTitles` carries `Files` at its head.
 */

/** a page that asks for permissions on demand, plus a link and a fullscreen button */
const PROBE_PAGE = `<!doctype html><meta charset=utf-8><title>Probe</title><body>
<a id=link href="/second">second page</a>
<button id=full>full</button>
<div id=out></div>
<script>
  window.__ask = async (what) => {
    if (what === 'mic') return navigator.mediaDevices.getUserMedia({audio:true}).then(()=>'ok',e=>e.name)
    if (what === 'cam') return navigator.mediaDevices.getUserMedia({video:true}).then(()=>'ok',e=>e.name)
    if (what === 'notify') return Notification.requestPermission()
    if (what === 'geo') return new Promise(r=>navigator.geolocation.getCurrentPosition(()=>r('ok'),e=>r('denied')))
    if (what === 'clipread') return navigator.clipboard.readText().then(()=>'ok',e=>e.name)
    if (what === 'screen') return navigator.mediaDevices.getDisplayMedia().then(()=>'ok',e=>e.name)
    return 'unknown'
  }
  document.getElementById('full').onclick = () => {
    document.body.requestFullscreen().then(
      () => { window.__fs = 'ok' },
      (e) => { window.__fs = 'rejected:' + e.name + ':' + e.message }
    )
  }
  window.__notifState = () => Notification.permission
  window.__mark = 'fresh'
</script></body>`

const SECOND_PAGE = `<!doctype html><meta charset=utf-8><title>Second</title><body>second</body>`

let server: FixtureServer

test.beforeAll(async () => {
  server = await startEchoServer()
  server.page('/probe', PROBE_PAGE)
  server.page('/second', SECOND_PAGE)
})

test.afterAll(async () => {
  await server?.close()
})

/** a small attachment, and a big one that is still arriving while it is cancelled */
const SMALL = (): string => server.url('/download?name=small.txt&body=hello')
const SLOW = (): string => server.url('/download-slow?name=big.bin&ms=8000')

/** FR-02: the pinned `files` tab's label is always the first entry `tabTitles` reports. */
const FILES_LABEL = 'Files'

/** the Given every case here shares: a running session with the Workbench panel up. */
async function browserUp(page: Page): Promise<void> {
  await startSessionIn(page, 'ws-a')
  await openBrowser(page)
}

/**
 * Mint one `web` tab through the product's own door — ＋ ▸ "New web tab" (FR-52) — and
 * optionally load `url` in it.
 *
 * After this step is mandatory, not a convenience: the address row (`.baddr`) is the
 * `web` KIND's own bar (FR-36) and the panel always opens on the pinned `files` tab
 * (FR-02), whose bar has no address field at all. There is no bare "＋ = new browser tab"
 * any more either — the ＋ opens FR-52's two-item dropdown. Every B7–B12 surface this
 * file is about (permission bar, downloads, ⋯ menu) hangs off that same address row.
 */
async function openTabOn(page: Page, url?: string): Promise<void> {
  await newWebTab(page)
  await expect(page.locator(BROWSER.addressField).first()).toBeVisible({ timeout: 20_000 })
  if (url !== undefined) await typeInAddressBar(page, url)
}

/** …the Given plus one empty `web` tab, for the cases that type their own url. */
async function webTabUp(page: Page): Promise<void> {
  await browserUp(page)
  await openTabOn(page)
}

/** the probe page's guest — resolved by url, never by index (guests attach in any order) */
async function openProbe(page: Page, app: Parameters<typeof guestPages>[0]): Promise<Page> {
  await browserUp(page)
  await openTabOn(page, server.url('/probe'))
  const g = await guestByUrl(app, '/probe')
  await g.waitForFunction(() => (window as unknown as { __mark?: string }).__mark === 'fresh')
  return g
}

// ---------------------------------------------------------------- permission prompts B7 / B8

/**
 * Which media INPUT kinds this machine exposes to a guest, read from the page's own
 * `enumerateDevices()`.
 *
 * The gate for the three cases below that are ABOUT the microphone or the camera. It is a
 * probe rather than an env var so the cases come back by themselves on a machine that has
 * the hardware — nobody has to remember to export anything.
 *
 * Measured on a Mac mini: the guest reports `["audiooutput"]` and nothing
 * else, and `system_profiler SPAudioDataType` / `SPCameraDataType` agree — the box has
 * speakers and no input at all. With no device, Chromium rejects `getUserMedia` with
 * `NotFoundError` BEFORE `setPermissionRequestHandler` is ever consulted, so no prompt can
 * appear on any build: nothing in Koloft is reached, and there is no assertion left to make.
 */
async function mediaInputKinds(guest: Page): Promise<string[]> {
  return guest.evaluate(() =>
    navigator.mediaDevices.enumerateDevices().then(
      (devices) =>
        [...new Set(devices.map((d) => d.kind as string))].filter(
          (kind) => kind === 'audioinput' || kind === 'videoinput'
        ),
      () => [] as string[]
    )
  )
}

/** Skip — with the measurement in the message, so a reader on a laptop can tell
 *  "this box has no mic" from "this case is flaky". */
async function needsMediaInput(guest: Page, kind: 'audioinput' | 'videoinput'): Promise<void> {
  const found = await mediaInputKinds(guest)
  test.skip(
    !found.includes(kind),
    `no ${kind} on this machine — enumerateDevices reported [${found.join(', ') || 'none'}]. ` +
      'Chromium rejects getUserMedia with NotFoundError before any permission handler runs, ' +
      'so no prompt can appear on any build. Not flakiness; runs again on a box with the device.'
  )
}

test('BB-M01/M02: a page asking for the microphone shows a prompt, and Allow really hands it over', async ({
  page,
  app
}) => {
  const g = await openProbe(page, app)
  // the microphone IS the subject here ("Allow really hands it over" is about the stream arriving),
  // so this one is gated rather than re-vehicled onto a device-free permission
  await needsMediaInput(g, 'audioinput')
  const asked = g.evaluate(() =>
    (window as never as { __ask(w: string): Promise<string> }).__ask('mic')
  )

  const bar = page.locator(BROWSER.permissionBar)
  await expect(bar).toBeVisible()
  await expect(bar).toContainText('microphone')
  await expect(bar).toContainText(new URL(server.url('/probe')).origin)

  await page.locator(BROWSER.permissionAllow).click()
  await expect(bar).toBeHidden()
  // the page's own call is what decides this — a bar that lies is worse than no bar
  expect(await asked).not.toBe('NotAllowedError')
})

test('BB-M03: click Deny and the page gets a denial', async ({ page, app }) => {
  const g = await openProbe(page, app)
  // `NotAllowedError` is the microphone API's OWN word for a refusal — the whole claim is
  // that the page hears the denial in that exact form, so the vehicle cannot be swapped
  await needsMediaInput(g, 'audioinput')
  const asked = g.evaluate(() =>
    (window as never as { __ask(w: string): Promise<string> }).__ask('mic')
  )
  await page.locator(BROWSER.permissionDeny).click()
  expect(await asked).toBe('NotAllowedError')
})

test('BB-M04: all five permissions ask, and the prompt names the right one', async ({
  page,
  app
}) => {
  const g = await openProbe(page, app)
  // the case is "all five ask, and each names itself" — dropping the camera would leave a
  // different, smaller case wearing this id, so the whole thing is gated on the camera
  await needsMediaInput(g, 'videoinput')
  for (const [what, text] of [
    ['cam', 'camera'],
    ['notify', 'notifications'],
    ['geo', 'location'],
    ['clipread', 'clipboard']
  ] as const) {
    const asked = g.evaluate(
      (w) => (window as never as { __ask(w: string): Promise<string> }).__ask(w),
      what
    )
    await expect(page.locator(BROWSER.permissionBar)).toContainText(text)
    await page.locator(BROWSER.permissionDeny).click()
    await asked
  }
})

test('BB-M05/M06/C03: once answered it does not ask again, and only for the one that was answered', async ({
  page,
  app
}) => {
  // Re-vehicled off the mic/camera pair. B8's claim is about the MEMORY — one answer is
  // filed under this site AND this permission (`permissionKey`) — and it needs two
  // different promptable kinds, not two specific devices. notifications + geolocation are
  // two such kinds that need no hardware, so the case runs everywhere instead of only on a
  // machine with both a mic and a camera.
  //
  // Notifications carries the "once answered, no more asking" half better than the microphone did, too:
  // `requestPermission()` answers 'granted' / 'denied' in its own words, where
  // `getUserMedia` only let the old assertion say "not NotAllowedError".
  const g = await openProbe(page, app)
  const ask = (w: string): Promise<string> =>
    g.evaluate((x) => (window as never as { __ask(w: string): Promise<string> }).__ask(x), w)

  const first = ask('notify')
  await expect(page.locator(BROWSER.permissionBar)).toContainText('notifications')
  await page.locator(BROWSER.permissionAllow).click()
  expect(await first).toBe('granted')

  // same site, same permission: no more asking. The page still gets its answer, and no bar is raised —
  // a hung promise here would fail this line rather than pass it, which is what makes
  // "no more asking" falsifiable instead of merely unobserved.
  const second = ask('notify')
  expect(await second).toBe('granted')
  await expect(page.locator(BROWSER.permissionBar)).toBeHidden()

  // same site, a different permission: still asks
  const location = ask('geo')
  await expect(page.locator(BROWSER.permissionBar)).toContainText('location')
  await page.locator(BROWSER.permissionDeny).click()
  await location
})

test('BB-M07/C54: an unsupported permission is refused out loud', async ({ page, app }) => {
  const g = await openProbe(page, app)
  // a refused getDisplayMedia never settles in Electron — fire it and watch the UI
  void g
    .evaluate(() => (window as never as { __ask(w: string): Promise<string> }).__ask('screen'))
    .catch(() => {})
  const refused = page.locator(BROWSER.permissionRefused)
  await expect(refused).toBeVisible()
  await expect(refused).toContainText(new URL(server.url('/probe')).origin)
})

test('BB-C44: the address bar still works while the prompt bar is up', async ({ page, app }) => {
  const g = await openProbe(page, app)
  // geolocation, not the microphone: this case asserts nothing about audio — it needs SOME
  // prompt on screen while the address bar is used, and a device-free one keeps it running
  // on a machine with no mic (see `mediaInputKinds`)
  void g
    .evaluate(() => (window as never as { __ask(w: string): Promise<string> }).__ask('geo'))
    .catch(() => {})
  await expect(page.locator(BROWSER.permissionBar)).toBeVisible()

  await typeInAddressBar(page, server.url('/second'))
  await expect.poll(() => addressValue(page)).toContain('/second')
})

test('manual find: after the page navigates away, an unanswered prompt bar must not linger', async ({
  page,
  app
}) => {
  // Found in the manual round: an unanswered camera prompt survived a navigation and
  // then held the one bar slot, so the NEXT page's refusal notice never appeared at
  // all. A prompt that outlives its page asks in a name the user has already left.
  //
  // Automated with geolocation rather than the camera the manual round used: what the bug
  // was about is an UNANSWERED prompt outliving its page, and every promptable kind takes
  // the same `dropPermissions` path out. A device-free vehicle keeps it running on a
  // machine with no camera (see `mediaInputKinds`).
  const g = await openProbe(page, app)
  void g
    .evaluate(() => (window as never as { __ask(w: string): Promise<string> }).__ask('geo'))
    .catch(() => {})
  await expect(page.locator(BROWSER.permissionBar)).toBeVisible()

  await typeInAddressBar(page, server.url('/second'))
  await expect(page.locator(BROWSER.permissionBar)).toBeHidden()
})

test('BB-C45: closing the asking tab takes its prompt bar away', async ({ page, app }) => {
  const g = await openProbe(page, app)
  // geolocation for the same reason as BB-C44: the subject is the bar's lifetime against
  // its tab, and it asks nothing of the hardware
  void g
    .evaluate(() => (window as never as { __ask(w: string): Promise<string> }).__ask('geo'))
    .catch(() => {})
  await expect(page.locator(BROWSER.permissionBar)).toBeVisible()

  // the asking tab is the first CLOSABLE one — slot 0 is now the pinned `files` tab,
  // which has no ✕ at all (FR-02).
  // `.x`, not `BROWSER.tabClose`: that constant is the document-rooted `.wb-tab .x`, and
  // a chained locator resolves its selector RELATIVE to the tab, so it would be looking
  // for a `.wb-tab` nested inside a `.wb-tab` and never match. Same shape as
  // workbench-tabs.spec.ts's own `wbTabs(page).nth(0).locator('.x')`.
  await openTabs(page).first().locator('.x').click()
  await expect(page.locator(BROWSER.permissionBar)).toBeHidden()
})

// ---------------------------------------------------------------- downloads B9

test('BB-C12/M08: no download icon until something has been downloaded', async ({ page }) => {
  // the `web` tab is minted BEFORE the absence is asserted on purpose: the download
  // button lives in the address row, so with no web tab the count would be 0 because the
  // whole row is missing — the case would pass without ever observing what it is about
  await webTabUp(page)
  await expect(page.locator(BROWSER.downloadButton)).toHaveCount(0)

  await typeInAddressBar(page, SMALL())
  await expect(page.locator(BROWSER.downloadButton)).toBeVisible({ timeout: 20_000 })
})

test('BB-M11: a finished file is in the list and really lands on disk', async ({ page, env }) => {
  await webTabUp(page)
  await typeInAddressBar(page, SMALL())
  await page.locator(BROWSER.downloadButton).click()

  const row = page.locator(BROWSER.downloadRow).first()
  await expect(row).toContainText('small.txt')
  await expect(row).toContainText('Completed')
  await expect(row.getByRole('button', { name: 'Show in Finder' })).toBeVisible()

  await expect
    .poll(() => fs.existsSync(path.join(env.downloadDir, 'small.txt')), { timeout: 15_000 })
    .toBe(true)
})

test('BB-M09/M10: an in-progress download is visible, and after Cancel it never turns into Done', async ({
  page
}) => {
  await webTabUp(page)
  await typeInAddressBar(page, SLOW())
  await page.locator(BROWSER.downloadButton).click()

  const row = page.locator(BROWSER.downloadRow).first()
  const cancel = row.getByRole('button', { name: 'Cancel' })
  await expect(cancel).toBeVisible()
  await cancel.click()

  await expect(row).toContainText('Cancelled')
  // and it must not flip to Done afterwards
  await page.waitForTimeout(1500)
  await expect(row).not.toContainText('Completed')
})

test('BB-C08: Clear history only clears the list, the files stay', async ({ page, env }) => {
  await webTabUp(page)
  await typeInAddressBar(page, SMALL())
  await page.locator(BROWSER.downloadButton).click()
  await expect(page.locator(BROWSER.downloadRow)).toHaveCount(1)

  await page.locator(BROWSER.downloadClear).click()
  await expect(page.locator(BROWSER.downloadRow)).toHaveCount(0)

  expect(fs.existsSync(path.join(env.downloadDir, 'small.txt'))).toBe(true)
})

test('BB-C53: the downloads panel can be closed, and is never open together with the three-dot menu', async ({
  page
}) => {
  await webTabUp(page)
  await typeInAddressBar(page, SMALL())
  await page.locator(BROWSER.downloadButton).click()
  await expect(page.locator(BROWSER.downloadPanel)).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(page.locator(BROWSER.downloadPanel)).toBeHidden()

  await page.locator(BROWSER.downloadButton).click()
  await page.locator(BROWSER.overflowButton).click()
  await expect(page.locator(BROWSER.downloadPanel)).toBeHidden()
  await expect(page.locator(BROWSER.overflowMenu)).toBeVisible()
})

// ---------------------------------------------------------------- tab ordering B10

async function threeTabs(page: Page): Promise<void> {
  await browserUp(page)
  for (const p of ['/probe', '/second', '/probe?x=2']) {
    await openTabOn(page, server.url(p))
  }
  // the CLOSABLE set: the pinned `files` tab is always present (FR-02), so every
  // pre-merge count against `BROWSER.tab` is off by one
  await expect(openTabs(page)).toHaveCount(3)
}

test('BB-M16/C20/C21: a tab lands where it is dropped, the active tab stays, the page does not reload', async ({
  page,
  app
}) => {
  await browserUp(page)
  await openTabOn(page, server.url('/probe'))
  const g = await guestByUrl(app, '/probe')
  await g.evaluate(() => {
    ;(window as unknown as { __mark: string }).__mark = 'kept'
  })
  await openTabOn(page, server.url('/second'))
  await expect(openTabs(page)).toHaveCount(2)

  // wait for both labels to SETTLE on their page titles: an unloaded tab is labelled
  // from its url, so a snapshot taken mid-load compares two different naming schemes.
  // `tabTitles` reports EVERY tab, so the pinned `files` one heads the list (FR-02).
  await expect.poll(() => tabTitles(page)).toEqual([FILES_LABEL, 'Probe', 'Second'])
  const activeBefore = await page.locator(BROWSER.tabActive).innerText()

  // drop the last tab at the head of the REORDERABLE range — slot 0 belongs to the
  // pinned tab, which FR-21 excepts from dragging
  await openTabs(page).last().dragTo(openTabs(page).first())

  await expect.poll(() => tabTitles(page)).toEqual([FILES_LABEL, 'Second', 'Probe'])
  expect(await page.locator(BROWSER.tabActive).innerText()).toBe(activeBefore)
  // …and the drop landed BESIDE the pinned tab, never on top of it
  await expect(page.locator(BROWSER.tab).first()).toHaveClass(/pinned/)
  // the moved page was never reloaded — its mark survives
  const marks = await Promise.all(
    guestPages(app).map((p) =>
      p.evaluate(() => (window as unknown as { __mark?: string }).__mark).catch(() => undefined)
    )
  )
  expect(marks).toContain('kept')
})

test('BB-C43: with drag added, clicking a tab to switch and clicking × to close still work', async ({
  page
}) => {
  await threeTabs(page)
  // the closable set only: the pinned `files` tab neither switches to a page nor closes
  const tabs = openTabs(page)
  await expect(tabs).toHaveCount(3)

  await tabs.first().click()
  await expect(page.locator(BROWSER.tabActive)).toHaveText(await tabs.first().innerText())

  // `.x` rather than the `BROWSER.tabClose` constant: chained, its `.wb-tab .x` would be
  // resolved relative to this tab and match nothing (see BB-C45's comment)
  await tabs.nth(1).locator('.x').click()
  await expect(tabs).toHaveCount(2)
  // the ✕ closed a web tab, not the pinned one — FR-02 makes that impossible, and a
  // count that ignored the pinned tab could not tell the two apart
  await expect(pinnedTab(page)).toHaveCount(1)
})

// ---------------------------------------------------------------- three-dot menu B12

test('BB-M22/C34: the menu has Copy current URL, and Esc or clicking outside closes it', async ({
  page
}) => {
  await browserUp(page)
  await openTabOn(page, server.url('/probe'))
  await page.locator(BROWSER.overflowButton).click()

  const menu = page.locator(BROWSER.overflowMenu)
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Copy current URL' })).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
})

// ---------------------------------------------------------------- background tabs §07 #1

test('BB-M18/M28: ⌘+click opens a link in the background, the current page stays, the new tab gets an unread dot', async ({
  page,
  app
}) => {
  const g = await openProbe(page, app)
  const activeBefore = await page.locator(BROWSER.tabActive).innerText()

  await g.locator('#link').click({ modifiers: ['Meta'] })

  await expect(openTabs(page)).toHaveCount(2)
  // current tab did not navigate away, and did not change
  expect(await page.locator(BROWSER.tabActive).innerText()).toBe(activeBefore)
  await expect(page.locator(BROWSER.tabAgent)).toHaveCount(1)
})

test('BB-C26: a plain click still navigates in place, no new tab', async ({ page, app }) => {
  const g = await openProbe(page, app)
  await g.locator('#link').click()
  await expect(openTabs(page)).toHaveCount(1)
  await expect.poll(() => addressValue(page)).toContain('/second')
})

// ---------------------------------------------------------------- fullscreen §07 #3

test('BB-M20/M21/C29: page fullscreen fills the window, Esc leaves it, the Koloft window never enters system fullscreen', async ({
  page,
  app
}) => {
  // Measured, not guessed: with the app hidden (KOLOFT_TEST_BACKGROUND — the no-focus-steal
  // hard rule), a guest's requestFullscreen() never settles at all. Chromium will not
  // fullscreen a window that is not on screen, so this case cannot run in the default
  // suite. Same opt-in as persistence.spec.ts's real-fullscreen case: a machine nobody
  // is using. The window-stays-put half is what makes it worth keeping automated —
  // it is the one assertion §07 #3 calls non-negotiable.
  test.skip(
    process.env.KOLOFT_E2E_FULLSCREEN !== '1',
    'needs a visible window (hidden mode never settles requestFullscreen) — opt in with KOLOFT_E2E_FULLSCREEN=1'
  )
  const g = await openProbe(page, app)
  const wasFullscreen = await app.evaluate(
    async ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isFullScreen() ?? false
  )

  await g.locator('#full').click()
  // surface WHY if the page's own call was refused — otherwise this reads as a Koloft bug
  await expect
    .poll(() => g.evaluate(() => (window as unknown as { __fs?: string }).__fs ?? 'pending'))
    .toBe('ok')
  await expect(page.locator(BROWSER.pageFullscreen)).toBeVisible()
  await expect(page.locator(BROWSER.tabStrip)).toBeHidden()
  // the corner toggle goes with the strip: it must not cover the page's own top-right
  // control (found by code review,)
  await expect(page.locator('.aux-icons')).toBeHidden()

  // the Koloft window itself never went into macOS fullscreen
  expect(
    await app.evaluate(
      async ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isFullScreen() ?? false
    )
  ).toBe(wasFullscreen)

  await page.keyboard.press('Escape')
  await expect(page.locator(BROWSER.pageFullscreen)).toBeHidden()
  await expect(page.locator(BROWSER.tabStrip)).toBeVisible()
})
