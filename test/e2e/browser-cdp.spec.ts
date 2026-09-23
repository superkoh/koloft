import { chromium, type Browser, type Page } from '@playwright/test'
import { test, expect } from './helpers/app'
import type { E2EEnv } from './helpers/env'
import {
  centerTerm,
  openSessionTerminal,
  panelTerm,
  runIn,
  startSessionIn,
  waitBooted
} from './helpers/p1'
import {
  BROWSER,
  activeSurface,
  activeTab,
  addressValue,
  cdpEndpointOf,
  cdpRefusal,
  closeBrowser,
  connectCdp,
  globeIcon,
  openBrowser,
  openTabs,
  pinnedTab,
  tabByTitle
} from './helpers/browser'
import { startEchoServer, type FixtureServer } from './helpers/fixtureServer'

/**
 * Issue · P1 — the CDP relay, driven by a REAL Playwright client over the endpoint
 * Koloft injects (`connectOverCDP`), which is the same door playwright-mcp and the
 * Playwright CLI come through.
 *
 * The endpoint is discovered the way a tool discovers it: out of the env of the launch
 * itself, which fake-claude records. Nothing here asks an agent to echo anything, and
 * nothing reads Koloft's internals.
 *
 * Cases: BB-22 (+D9), BB-24/25/26, BB-34/35/37, BB-42/43, BB-45, BB-53…55, the input case
 * and the stage's give-back (one behaviour per case: the ones that shared a set-up are one
 * case each). BB-27/28/29 retired with the takeover confirmation itself.
 */

/** a live session in ws-a whose claude launch carries an endpoint. `startSessionIn`
 *  already waits for the session to bind (and the fake claude still records its launch
 *  env, because the product path launches through the real shim). */
async function drivenSession(page: Page, env: E2EEnv): Promise<string> {
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')
  return await cdpEndpointOf(env)
}

const connect = connectCdp

/** the relay's own transcript of this run (KOLOFT_CDP_LOG) — what a stalled handshake was
 *  waiting for is readable nowhere else */
function cdpTranscript(env: E2EEnv): string {
  const file = `${env.home}/cdp-log.txt`
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('fs') as typeof import('fs')
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
}

async function withServer<T>(fn: (server: FixtureServer) => Promise<T>): Promise<T> {
  const server = await startEchoServer()
  try {
    return await fn(server)
  } finally {
    await server.close()
  }
}

// ---- B: the endpoint, the injection and the gates --------------------------------------

// BB-22/24/25 — the endpoint itself, all read off ONE session: it arrives in the env of
// the launch (zero configuration is the whole point), it listens on loopback alone (it
// is a door into the user's logged-in browser), and a wrong path is told nothing.
test('BB-22/24/25: the endpoint is in the launch env, on loopback only, and an unknown path is refused', async ({
  page,
  env
}) => {
  test.setTimeout(180_000)
  const url = await drivenSession(page, env)
  // BB-22: both the tool-specific name and the generic one
  const { readCalls } = await import('./helpers/p1')
  const call = readCalls(env).at(-1)
  expect(call?.playwrightMcpEndpoint).toBe(url)
  expect(call?.cdpEndpoint).toBe(url)

  // BB-24: never reachable from another machine
  const port = new URL(url).port
  const { execFileSync } = await import('child_process')
  const listeners = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {
    encoding: 'utf8'
  })
  expect(listeners).toContain('127.0.0.1')
  expect(listeners).not.toMatch(/\*:\d+ \(LISTEN\)/) // never the wildcard address

  // BB-25: not what exists, not how many tabs, not even whether the path was ever valid
  const wrong = url.replace(/\/cdp\/[a-f0-9]{32}$/, `/cdp/${'0'.repeat(32)}`)
  expect(await cdpRefusal(wrong)).toEqual({ code: 1008, reason: 'unknown endpoint' })
})

// BB-22's other half (D9) — a terminal tab's shell is the one pty defined as having no
// agent in it, so it is handed no endpoint at all. (moved the entrance: the shell is a
// Workbench tab inside a live session now, not a global island. The subject is unchanged —
// a util shell gets no endpoint — and the session below is the tab that owns it.)
test('BB-22/D9: a shell in a terminal tab gets no endpoint', async ({ app, page, env }) => {
  test.setTimeout(180_000)
  await drivenSession(page, env)
  await openSessionTerminal(app, page)
  await runIn(page, panelTerm(page), 'echo "[cdp]${KOLOFT_BROWSER_CDP:-none}[/cdp]"')

  // read back off the SHELL, not off the island: `.gt-island` went and a locator
  // that matches nothing would have made this case unfalsifiable
  await expect(panelTerm(page)).toContainText('[cdp]none[/cdp]', { timeout: 30_000 })
})

// BB-26/45 — one client per endpoint (D8: two tools driving one strip would fight over
// the same pages with no way to tell whose command lost) and one shared context (the
// agent drives the browser the user is signed into). Both refusals are readable by the
// client, and neither touches the first client.
test('BB-26/45: a second client and a second context are refused; the first client keeps working', async ({
  page,
  env
}) => {
  test.setTimeout(180_000)
  const url = await drivenSession(page, env)
  let first: Browser
  try {
    first = await connect(page, url)
  } catch (e) {
    // a stalled handshake says nothing on either side — print what the relay saw
    console.log('CDP transcript:\n' + cdpTranscript(env))
    throw e
  }
  try {
    expect(first.version()).toMatch(/^\d+\.\d+\.\d+\.\d+$/) // a real Chromium version
    // BB-26: the rejection is caught AT CREATION — a connectOverCDP refused mid-handshake
    // and left unhandled for a tick takes the whole Playwright driver session down
    const second = chromium.connectOverCDP(url).then(
      () => null,
      (e: Error) => e
    )
    expect(await second).toBeInstanceOf(Error)
    // BB-45
    await expect(first.newContext()).rejects.toThrow()
    expect(first.contexts()).toHaveLength(1)
    // …and the first client really is untouched: a ROUND TRIP through the relay, not a
    // cached answer (`version()` and `contexts()` are local state and pass on a dead socket)
    const p = await first.contexts()[0].newPage()
    expect(await p.evaluate('1 + 1')).toBe(2)
  } finally {
    await first.close()
  }
})

// ---- C: targets and tabs ---------------------------------------------------------------

// BB-34/35/37/54 — a client's own pages, one story: they land as background tabs with
// an unread mark (D3), two calls are two pages even though both start blank (§4.1c: no
// dedup), every one of them wears the "an agent is driving this" mark (remote control
// with no indicator is a haunted browser), page.close() closes the tab it was, and the
// mark leaves with the client.
test('BB-34/35/37/54: a client’s pages are marked background tabs; close() closes one; the mark goes with the client', async ({
  page,
  env
}) => {
  test.setTimeout(180_000)
  const url = await drivenSession(page, env)
  // the fixture seeds `workbench.defaultOpen: true`, so "the panel is shut" is a
  // gesture now, not a starting state
  await closeBrowser(page)
  const browser = await connect(page, url)
  try {
    const ctx = browser.contexts()[0]
    const a = await ctx.newPage()
    const b = await ctx.newPage()
    expect(a).not.toBe(b)

    // main FR-51 removed the Globe's unread dot — a collapsed panel leaves ZERO titlebar
    // signal — so the background landing is read off the panel instead: it did not open
    // itself. `data-surface` is only on a SHOWING panel, hence null while it is collapsed.
    expect(await activeSurface(page)).toBeNull()
    await expect(globeIcon(page)).not.toHaveClass(/\bon\b/)

    await openBrowser(page)
    await expect(openTabs(page)).toHaveCount(2, { timeout: 30_000 })
    // …and neither of them took the front: the pinned `files` tab is still the active one
    await expect(pinnedTab(page)).toHaveClass(/\bon\b/)
    // BB-54: the tab's mark and the strip's badge say who is driving (a hover text was
    // tried too — the native tooltip never shows on this strip, so it went)
    await expect(page.locator(BROWSER.drivenTab)).toHaveCount(2, { timeout: 30_000 })
    await expect(page.locator(BROWSER.drivenBadge)).toBeVisible()

    // BB-37
    await b.close()
    await expect(openTabs(page)).toHaveCount(1, { timeout: 30_000 })
  } finally {
    await browser.close()
  }
  // …and the mark leaves with the client
  await expect(page.locator(BROWSER.drivenTab)).toHaveCount(0, { timeout: 30_000 })
})

// BB-42/43 + §4.1a — the Browser column is NOT on screen, and the client works anyway:
// a screenshot has pixels (measured to hang outright without the stage), a click lands,
// and the stage that makes the pixels possible takes none of the USER's clicks. A stage
// that came forward would sit on top of the app, and the first thing the user would
// notice is that it eats their clicks — so at the centre of the stage's own box, what the
// pointer reaches is the UI, not the page.
//
// The other half of "behind the UI" — that no trace of it is VISIBLE — has no oracle from
// in here: neither `page.screenshot()` nor Electron's own `win.capturePage()` composites
// a <webview>'s content (both come back with no trace of a driven
// page that is filling the stage edge to edge), so a pixel check would pass however far
// forward the stage came. That half stays an eyeball check.
test('BB-42/43: with the column closed a screenshot has pixels, a click lands, and the stage takes none of the user’s clicks', async ({
  page,
  env
}) => {
  test.setTimeout(240_000)
  await withServer(async (server) => {
    const url = await drivenSession(page, env)
    await closeBrowser(page) // the fixture ships the panel expanded (workbench.defaultOpen)
    const browser = await connect(page, url)
    try {
      const p = await browser.contexts()[0].newPage()
      await p.goto(
        server.page(
          '/click',
          '<body style="margin:0;background:#f00"><button id="b">hit</button><div id="out">idle</div>' +
            '<script>document.getElementById("b").onclick=function(){' +
            'document.getElementById("out").textContent="clicked"}</script>'
        )
      )
      // the column was collapsed before the client connected — this IS the closed state.
      // `data-surface` sits on a SHOWING panel only, so null is the collapsed reading.
      expect(await activeSurface(page)).toBeNull()

      // BB-42
      const shot = await p.screenshot({ timeout: 30_000 })
      expect(shot.length).toBeGreaterThan(500)
      // a real image of a real page, not a blank frame: compare against the same
      // client's shot of about:blank in this run (no cross-version baseline)
      const blank = await browser.contexts()[0].newPage()
      const blankShot = await blank.screenshot({ timeout: 30_000 })
      expect(Buffer.compare(shot, blankShot)).not.toBe(0)

      // BB-43
      await p.click('#b')
      expect(await p.textContent('#out')).toBe('clicked')

      // §4.1a: the stage is laid out at full size, and the pointer never reaches it
      await page.waitForTimeout(1000)
      const hit = await page.evaluate(() => {
        const guest = document.querySelector('webview')
        if (!guest) return { staged: false, at: 'no guest' }
        const r = guest.getBoundingClientRect()
        if (r.width < 100 || r.height < 100) return { staged: false, at: 'no stage' }
        const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
        return {
          staged: true,
          at: el ? el.tagName.toLowerCase() : 'nothing',
          inColumn: !!el?.closest('.wb-col')
        }
      })
      expect(hit.staged).toBe(true)
      expect(hit.at).not.toBe('webview')
      expect(hit.inColumn).toBe(false)
    } finally {
      await browser.close().catch(() => {})
    }
  })
})

// ---- E: the user can always see it (dialogs, the watched tab, the stage's give-back) ----

// §4.3 — input. Chromium routes key events and text commits by the WINDOW's focus, not
// by the CDP target, so on a guest that is not the host's focused element an agent's
// `fill` answered ok and changed nothing, and its keystrokes landed in the TUI the user
// was typing in; a real mouse click reached the page but made it the focused frame, and
// the TUI lost its focus (both measured). The relay now delivers keyboard, text and mouse
// inside the page (cdpInput.ts). Both halves are the case: the input lands — fill, typed
// characters, Backspace, Enter, a click — and the user's focus in the TUI is never
// touched, not even for a moment.
test('input through the relay lands in the driven page, and never touches the user’s focus', async ({
  page,
  env
}) => {
  test.setTimeout(240_000)
  await withServer(async (server) => {
    const url = await drivenSession(page, env)
    const browser = await connect(page, url)
    try {
      const p = await browser.contexts()[0].newPage()
      await p.goto(
        server.page(
          '/typed',
          '<title>Typed</title><body><form id="f"><input id="name"><button type="submit">go</button></form>' +
            '<b id="out">nothing</b><script>document.getElementById("f").addEventListener("submit",function(e){' +
            'e.preventDefault();document.getElementById("out").textContent="got "+document.getElementById("name").value})' +
            '</script></body>'
        )
      )
      // the user is typing in the TUI when the agent starts
      await centerTerm(page).click()
      await expect
        .poll(() => page.evaluate(() => document.activeElement?.className ?? ''))
        .toContain('xterm-helper-textarea')

      // a watch on the host's focus: any move at all, however brief, is recorded
      await page.evaluate(() => {
        const w = window as unknown as { __focusMoves: string[] }
        w.__focusMoves = []
        document.addEventListener(
          'focusin',
          (e) => w.__focusMoves.push('in:' + (e.target as Element).tagName),
          true
        )
        document.addEventListener(
          'focusout',
          (e) => w.__focusMoves.push('out:' + (e.target as Element).tagName),
          true
        )
      })

      await p.fill('#name', 'Kolof')
      await p.keyboard.type('t!')
      await p.keyboard.press('Backspace')
      await p.keyboard.press('Enter')
      expect(await p.textContent('#out')).toBe('got Koloft')
      await p.fill('#name', 'Again')
      await p.click('button') // the mouse path: a real one moved the host's focus
      expect(await p.textContent('#out')).toBe('got Again')

      // …and the user's focus never left the TUI, not even in passing
      expect(await page.evaluate(() => document.activeElement?.className ?? '')).toContain(
        'xterm-helper-textarea'
      )
      expect(
        await page.evaluate(() => (window as unknown as { __focusMoves: string[] }).__focusMoves)
      ).toEqual([])
    } finally {
      await browser.close()
    }
  })
})

// BB-53/§4.3 — Koloft does not answer a page's dialog on the agent's behalf (B7/B8 stand).
// So a driven page that calls confirm() blocks, and the client's own command blocks with
// it until the USER answers. That is documented behaviour rather than a defect, and it is
// pinned here so it cannot quietly drift into an auto-answer the user never saw.
test('BB-53: a dialog from a driven page blocks the client until the user answers', async ({
  page,
  env
}) => {
  test.setTimeout(240_000)
  await withServer(async (server) => {
    const url = await drivenSession(page, env)
    const browser = await connect(page, url)
    try {
      const p = await browser.contexts()[0].newPage()
      await p.goto(server.page('/ask', '<title>Ask</title><body><div id="out">idle</div></body>'))
      await openBrowser(page)

      // NOT awaited: a dialog that really blocks its page blocks this call too, so
      // awaiting it before answering would deadlock the test rather than the product
      let settled = false
      const answering = p
        .evaluate(() => {
          const r = confirm('proceed?')
          document.getElementById('out')!.textContent = `confirm:${r}`
          return r
        })
        .then((v) => {
          settled = true
          return v
        })

      const modal = page.locator(BROWSER.modal)
      await expect(modal).toBeVisible({ timeout: 30_000 })
      await expect(modal).toContainText('proceed?')
      // the tool is genuinely waiting on the human — this is the half an "it blocks"
      // claim needs, and the half a modal appearing on its own cannot give
      await page.waitForTimeout(1000)
      expect(settled).toBe(false)

      await modal.locator('.btn-primary').first().click()
      expect(await answering).toBe(true)
      await expect(modal).toHaveCount(0, { timeout: 20_000 })
      await expect(p.locator('#out')).toHaveText('confirm:true', { timeout: 20_000 })
    } finally {
      await browser.close().catch(() => {})
    }
  })
})

// BB-55/§4.3 — the agent is allowed to navigate the very tab the user is looking at. No
// arbitration, by decision; what the user gets instead is knowing: the address bar
// follows the agent's navigation, and the driving mark is on the tab while it happens.
test('BB-55: the agent may navigate the tab the user is watching, visibly', async ({
  page,
  env
}) => {
  test.setTimeout(240_000)
  await withServer(async (server) => {
    const url = await drivenSession(page, env)
    const browser = await connect(page, url)
    try {
      const p = await browser.contexts()[0].newPage()
      const first = server.page('/watched', '<title>Watched</title><body>watched</body>')
      await p.goto(first)

      // the user brings that very tab to the front and is looking at it
      await openBrowser(page)
      await tabByTitle(page, 'Watched').click()
      await expect(activeTab(page)).toContainText('Watched', { timeout: 30_000 })
      await expect.poll(() => addressValue(page), { timeout: 30_000 }).toContain('/watched')

      // …and the agent navigates it under them
      const next = server.page('/moved', '<title>Moved</title><body>moved</body>')
      await p.goto(next)

      await expect.poll(() => addressValue(page), { timeout: 30_000 }).toContain('/moved')
      await expect(activeTab(page)).toContainText('Moved', { timeout: 30_000 })
      await expect(activeTab(page)).toHaveClass(/\bdriven\b/)
    } finally {
      await browser.close().catch(() => {})
    }
  })
})

// §4.1a — the stage is borrowed for as long as a client is driving, and given back.
// Nothing cleared it before this case: the last driven guest kept its full-size box
// painted behind the UI, and the pane root stayed un-hidden, for the rest of the window's
// life — a page nobody is driving, rendering forever behind a closed column.
test('the stage is given back when the client lets go of the page', async ({ page, env }) => {
  test.setTimeout(240_000)
  await withServer(async (server) => {
    const url = await drivenSession(page, env)
    await closeBrowser(page) // the fixture ships the panel expanded (workbench.defaultOpen)
    const browser = await connect(page, url)
    const p = await browser.contexts()[0].newPage()
    await p.goto(server.page('/staged', '<title>Staged</title><body>s</body>'))
    await p.screenshot() // needs frames, so the page is on the stage now
    await expect(page.locator(BROWSER.stagedGuest)).toHaveCount(1, { timeout: 30_000 })
    await expect(page.locator(BROWSER.stagedColumn)).toHaveCount(1)
    expect(await activeSurface(page)).toBeNull()

    await browser.close()

    // no client, no stage: the guest is off it, and the column collapses again. On main
    // a closed panel is a ZERO-WIDTH column, never a `visibility: hidden` one — a
    // <webview> in a hidden subtree detaches and reloads (electron#28677) — so the
    // give-back is read as width rather than as visibility.
    await expect(page.locator(BROWSER.stagedGuest)).toHaveCount(0, { timeout: 30_000 })
    await expect(page.locator(BROWSER.stagedColumn)).toHaveCount(0, { timeout: 30_000 })
    await expect
      .poll(() =>
        page
          .locator('.wb-col')
          .first()
          .evaluate((el) => (el as HTMLElement).offsetWidth)
      )
      .toBe(0)
  })
})
