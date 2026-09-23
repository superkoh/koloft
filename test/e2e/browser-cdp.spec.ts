import fs from 'fs'
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

test.describe('CDP relay driven by a real Playwright client over the endpoint Koloft injects into the launch env', () => {
  async function drivenSession(page: Page, env: E2EEnv): Promise<string> {
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    return await cdpEndpointOf(env)
  }

  const connect = connectCdp

  function cdpTranscript(env: E2EEnv): string {
    const file = `${env.home}/cdp-log.txt`
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

  test('BB-22/24/25: the endpoint is in the launch env, on loopback only, and an unknown path is refused', async ({
    page,
    env
  }) => {
    test.setTimeout(180_000)
    const url = await drivenSession(page, env)
    const { readCalls } = await import('./helpers/p1')
    const call = readCalls(env).at(-1)
    expect(call?.playwrightMcpEndpoint).toBe(url)
    expect(call?.cdpEndpoint).toBe(url)

    const port = new URL(url).port
    const { execFileSync } = await import('child_process')
    const listeners = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8'
    })
    expect(listeners).toContain('127.0.0.1')
    expect(listeners).not.toMatch(/\*:\d+ \(LISTEN\)/)

    const wrong = url.replace(/\/cdp\/[a-f0-9]{32}$/, `/cdp/${'0'.repeat(32)}`)
    expect(await cdpRefusal(wrong)).toEqual({ code: 1008, reason: 'unknown endpoint' })
  })

  test('BB-22/D9: a shell in a terminal tab, the one pty with no agent in it, gets no endpoint', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    await drivenSession(page, env)
    await openSessionTerminal(app, page)
    await runIn(page, panelTerm(page), 'echo "[cdp]${KOLOFT_BROWSER_CDP:-none}[/cdp]"')

    await expect(panelTerm(page)).toContainText('[cdp]none[/cdp]', { timeout: 30_000 })
  })

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
      console.log('CDP transcript:\n' + cdpTranscript(env))
      throw e
    }
    try {
      expect(first.version()).toMatch(/^\d+\.\d+\.\d+\.\d+$/)
      const secondWithRejectionCaughtAtCreation = chromium.connectOverCDP(url).then(
        () => null,
        (e: Error) => e
      )
      expect(await secondWithRejectionCaughtAtCreation).toBeInstanceOf(Error)
      await expect(first.newContext()).rejects.toThrow()
      expect(first.contexts()).toHaveLength(1)
      const p = await first.contexts()[0].newPage()
      expect(await p.evaluate('1 + 1')).toBe(2)
    } finally {
      await first.close()
    }
  })

  test('BB-34/35/37/54: a client’s pages are marked background tabs; close() closes one; the mark goes with the client', async ({
    page,
    env
  }) => {
    test.setTimeout(180_000)
    const url = await drivenSession(page, env)
    await closeBrowser(page)
    const browser = await connect(page, url)
    try {
      const ctx = browser.contexts()[0]
      const a = await ctx.newPage()
      const b = await ctx.newPage()
      expect(a).not.toBe(b)

      expect(await activeSurface(page)).toBeNull()
      await expect(globeIcon(page)).not.toHaveClass(/\bon\b/)

      await openBrowser(page)
      await expect(openTabs(page)).toHaveCount(2, { timeout: 30_000 })
      await expect(pinnedTab(page)).toHaveClass(/\bon\b/)
      await expect(page.locator(BROWSER.drivenTab)).toHaveCount(2, { timeout: 30_000 })
      await expect(page.locator(BROWSER.drivenBadge)).toBeVisible()

      await b.close()
      await expect(openTabs(page)).toHaveCount(1, { timeout: 30_000 })
    } finally {
      await browser.close()
    }
    await expect(page.locator(BROWSER.drivenTab)).toHaveCount(0, { timeout: 30_000 })
  })

  // PLATFORM§9
  test('BB-42/43: with the column closed a screenshot has pixels, a click lands, and the stage takes none of the user’s clicks', async ({
    page,
    env
  }) => {
    test.setTimeout(240_000)
    await withServer(async (server) => {
      const url = await drivenSession(page, env)
      await closeBrowser(page)
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
        expect(await activeSurface(page)).toBeNull()

        const shot = await p.screenshot({ timeout: 30_000 })
        expect(shot.length).toBeGreaterThan(500)
        const blank = await browser.contexts()[0].newPage()
        const blankShot = await blank.screenshot({ timeout: 30_000 })
        expect(Buffer.compare(shot, blankShot)).not.toBe(0)

        await p.click('#b')
        expect(await p.textContent('#out')).toBe('clicked')

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

  // PLATFORM§16
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
        await centerTerm(page).click()
        await expect
          .poll(() => page.evaluate(() => document.activeElement?.className ?? ''))
          .toContain('xterm-helper-textarea')

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
        await p.click('button')
        expect(await p.textContent('#out')).toBe('got Again')

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

  test('BB-53: a dialog from a driven page blocks the client until the user answers; Koloft never answers it for the agent', async ({
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

        await openBrowser(page)
        await tabByTitle(page, 'Watched').click()
        await expect(activeTab(page)).toContainText('Watched', { timeout: 30_000 })
        await expect.poll(() => addressValue(page), { timeout: 30_000 }).toContain('/watched')

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

  test('the stage is given back when the client lets go of the page', async ({ page, env }) => {
    test.setTimeout(240_000)
    await withServer(async (server) => {
      const url = await drivenSession(page, env)
      await closeBrowser(page)
      const browser = await connect(page, url)
      const p = await browser.contexts()[0].newPage()
      await p.goto(server.page('/staged', '<title>Staged</title><body>s</body>'))
      await p.screenshot()
      await expect(page.locator(BROWSER.stagedGuest)).toHaveCount(1, { timeout: 30_000 })
      await expect(page.locator(BROWSER.stagedColumn)).toHaveCount(1)
      expect(await activeSurface(page)).toBeNull()

      await browser.close()

      // PLATFORM§9
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
})
