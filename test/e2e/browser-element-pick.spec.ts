import fs from 'fs'
import path from 'path'
import type { Page } from '@playwright/test'
import { test, expect } from './helpers/app'
import type { E2EEnv } from './helpers/env'
import {
  boundSessionId,
  centerTerm,
  runIn,
  startSessionIn,
  transcriptFile,
  waitBooted,
  wsRows
} from './helpers/p1'
import {
  BROWSER,
  INSPECT_MODE_SETTLES_MS,
  PICKED_LABEL,
  PICK_PAGE,
  cdpEndpointOf,
  clickInPickMode,
  connectCdp,
  guestByUrl,
  openPickPage,
  pickIntoSession,
  pictureCentre,
  tabByTitle
} from './helpers/browser'
import { claudePrompts } from './helpers/workbench'
import { startEchoServer } from './helpers/fixtureServer'

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47]

async function claudeTranscript(page: Page, env: E2EEnv): Promise<string> {
  const tabId = await wsRows(page, 'ws-a').first().getAttribute('data-tab-id')
  const sessionId = (await boundSessionId(page, tabId)) ?? ''
  return transcriptFile(env.home, env.workspaces.a, sessionId)
}

function picturePath(prompt: string): string {
  return /^Picture: (.+)$/m.exec(prompt)?.[1] ?? ''
}

test.describe('Pick an element in a Workbench web tab and paste it into the session', () => {
  test('BP-01: a pick pastes the page, the element, a picture of it, its HTML and its CSS into the Claude input box, unsent, the click never reaches the page, and the button is greyed while an approval is up', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    const server = await startEchoServer()
    try {
      await waitBooted(page)
      await startSessionIn(page, 'ws-a')
      const transcript = await claudeTranscript(page, env)
      const url = server.page('/pick', PICK_PAGE)
      const guest = await openPickPage(app, page, url)

      await pickIntoSession(page, guest, '#buy', ' make it green BP-01')

      const fromPick = (): string[] => claudePrompts(transcript).filter((p) => p.includes('BP-01'))
      await expect.poll(fromPick, { timeout: 30_000 }).toHaveLength(1)
      const [prompt] = fromPick()
      expect(prompt.startsWith('Element picked in the Workbench browser\n')).toBe(true)
      expect(prompt).toContain(`Page: ${url} ("Pick")`)
      expect(prompt).toContain(`Element: ${PICKED_LABEL}`)
      expect(prompt).toContain('<button id="buy" class="primary"')
      expect(prompt).toContain('background-color: rgb(10, 120, 250);')
      expect(prompt.endsWith(' make it green BP-01')).toBe(true)
      const picture = picturePath(prompt)
      expect(picture.startsWith(path.join(env.userData, 'picks') + path.sep)).toBe(true)
      expect([...fs.readFileSync(picture).subarray(0, 4)]).toEqual(PNG_SIGNATURE)
      expect(await pictureCentre(app, picture)).toEqual([10, 120, 250])
      expect(await guest.evaluate('window.clicks')).toBe(0)

      await runIn(page, centerTerm(page), '/need-approval')
      await expect(page.locator(BROWSER.pickButton)).toBeDisabled({ timeout: 30_000 })
      await runIn(page, centerTerm(page), 'back to work')
      await expect(page.locator(BROWSER.pickButton)).toBeEnabled({ timeout: 30_000 })
    } finally {
      await server.close()
    }
  })

  test('BP-02: Esc, the button again or a click outside the page stops picking and pastes nothing; the next pick pastes once', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    const server = await startEchoServer()
    try {
      await waitBooted(page)
      await startSessionIn(page, 'ws-a')
      const transcript = await claudeTranscript(page, env)
      const guest = await openPickPage(app, page, server.page('/pick', PICK_PAGE))
      const button = page.locator(BROWSER.pickButton)

      await button.click()
      await expect(button).toHaveAttribute('aria-pressed', 'true')
      await page.keyboard.press('Escape')
      await expect(button).toHaveAttribute('aria-pressed', 'false')

      await button.click()
      await expect(button).toHaveAttribute('aria-pressed', 'true')
      await button.click()
      await expect(button).toHaveAttribute('aria-pressed', 'false')

      await button.click()
      await expect(button).toHaveAttribute('aria-pressed', 'true')
      await page.locator(BROWSER.addressField).first().click()
      await expect(button).toHaveAttribute('aria-pressed', 'false')

      await guest.locator('#buy').click()
      expect(await guest.evaluate('window.clicks')).toBe(1)

      await pickIntoSession(page, guest, '#buy', ' BP-02 after')
      await expect
        .poll(() => claudePrompts(transcript).filter((p) => p.includes('BP-02')), {
          timeout: 30_000
        })
        .toHaveLength(1)
      expect(
        claudePrompts(transcript).filter((p) => p.includes('Element picked in the Workbench'))
      ).toHaveLength(1)
    } finally {
      await server.close()
    }
  })

  test('BP-03: a pick while an agent drives the same page through the CDP relay shares its debugger, and the agent can still click, read, screenshot and navigate afterwards', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    const server = await startEchoServer()
    try {
      await waitBooted(page)
      await startSessionIn(page, 'ws-a')
      const transcript = await claudeTranscript(page, env)
      const browser = await connectCdp(page, await cdpEndpointOf(env))
      const agentPage = await browser.contexts()[0].newPage()
      const url = server.page('/pick', PICK_PAGE)
      await agentPage.goto(url)
      await agentPage.locator('#buy').scrollIntoViewIfNeeded()
      const handle = await agentPage.$('#buy')
      await agentPage.click('#buy')
      const guest = await guestByUrl(app, url)
      await tabByTitle(page, 'Pick').click()

      await pickIntoSession(page, guest, '#buy', ' BP-03 shared')
      await expect
        .poll(() => claudePrompts(transcript).filter((p) => p.includes('BP-03')), {
          timeout: 30_000
        })
        .toHaveLength(1)

      await agentPage.click('#buy')
      expect(await agentPage.evaluate('window.clicks')).toBe(2)
      expect(await handle?.textContent()).toBe('Buy')
      expect((await agentPage.screenshot()).length).toBeGreaterThan(0)
      await agentPage.goto(
        server.page('/second', '<!doctype html><title>Second</title><p id="p">two')
      )
      await expect(agentPage.locator('#p')).toHaveText('two')
      await browser.close()
    } finally {
      await server.close()
    }
  })

  test('BP-04: an agent that attaches while a pick is open joins the debugger instead of being refused, and the pick still lands', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    const server = await startEchoServer()
    try {
      await waitBooted(page)
      await startSessionIn(page, 'ws-a')
      const transcript = await claudeTranscript(page, env)
      const url = server.page('/pick', PICK_PAGE)
      const endpoint = await cdpEndpointOf(env)
      const opener = await connectCdp(page, endpoint)
      const opened = await opener.contexts()[0].newPage()
      await opened.goto(url)
      await opened.locator('#buy').scrollIntoViewIfNeeded()
      await opener.close()
      const guest = await guestByUrl(app, url)
      await tabByTitle(page, 'Pick').click()
      const button = page.locator(BROWSER.pickButton)
      await button.click()
      await expect(button).toHaveAttribute('aria-pressed', 'true')

      const browser = await connectCdp(page, endpoint)
      const agentPages = (): Page[] =>
        browser.contexts().flatMap((c) => c.pages().filter((p) => p.url() === url))
      await expect.poll(() => agentPages().length, { timeout: 20_000 }).toBe(1)
      const agentPage = agentPages()[0]
      expect(await agentPage?.title()).toBe('Pick')
      await expect(button).toHaveAttribute('aria-pressed', 'true')

      const box = await guest.locator('#buy').boundingBox()
      if (!box) throw new Error('#buy has no box')
      await guest.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
      await expect(button).toHaveAttribute('aria-pressed', 'false', { timeout: 20_000 })
      await expect
        .poll(() => page.evaluate(() => !!document.activeElement?.closest('.term-island')))
        .toBe(true)
      await page.keyboard.type(' BP-04 joined')
      await page.keyboard.press('Enter')
      await expect
        .poll(() => claudePrompts(transcript).filter((p) => p.includes('BP-04')), {
          timeout: 30_000
        })
        .toHaveLength(1)
      await agentPage?.click('#buy')
      expect(await agentPage?.evaluate('window.clicks')).toBe(1)
      await browser.close()
    } finally {
      await server.close()
    }
  })

  test('BP-05: a click in pick mode with nothing else open leaves the guest without a debugger afterwards', async ({
    app,
    page
  }) => {
    test.setTimeout(180_000)
    const server = await startEchoServer()
    try {
      await waitBooted(page)
      await startSessionIn(page, 'ws-a')
      const url = server.page('/pick', PICK_PAGE)
      const guest = await openPickPage(app, page, url)
      await clickInPickMode(page, guest, '#buy')
      await expect
        .poll(() =>
          app.evaluate(
            ({ webContents }, u) =>
              webContents
                .getAllWebContents()
                .find((w) => w.getURL() === u)
                ?.debugger.isAttached(),
            url
          )
        )
        .toBe(false)
    } finally {
      await server.close()
    }
  })

  test('BP-08: a pick inside a cross-origin iframe picks the element there, names the frame and pictures it, while an agent driving the page keeps its own hold on that iframe', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    const server = await startEchoServer()
    try {
      await waitBooted(page)
      await startSessionIn(page, 'ws-a')
      const transcript = await claudeTranscript(page, env)
      const inner = server
        .page(
          '/inner',
          '<!doctype html><title>Inner</title><body style="margin:0"><button id="in" style="width:400px;height:200px;border:0;background:rgb(200,10,10)"></button>' +
            '<script>window.clicks=0;document.getElementById("in").onclick=()=>window.clicks++</script>'
        )
        .replace('127.0.0.1', 'localhost')
      const url = server.page(
        '/outer',
        `<!doctype html><title>Outer</title><div style="height:900px">tall</div><iframe id="f" src="${inner}" style="width:400px;height:200px;border:0"></iframe>`
      )
      const browser = await connectCdp(page, await cdpEndpointOf(env))
      const agentPage = await browser.contexts()[0].newPage()
      await agentPage.goto(url)
      await agentPage.locator('#f').scrollIntoViewIfNeeded()
      const agentFrame = (): ReturnType<Page['frames']>[number] | undefined =>
        agentPage.frames().find((f) => f.url() === inner)
      await expect.poll(() => !!agentFrame()).toBe(true)
      const guest = await guestByUrl(app, url)
      await tabByTitle(page, 'Outer').click()

      await pickIntoSession(page, guest, 'iframe#f', ' BP-08 inside the frame')
      const fromPick = (): string[] => claudePrompts(transcript).filter((p) => p.includes('BP-08'))
      await expect.poll(fromPick, { timeout: 30_000 }).toHaveLength(1)
      const [prompt] = fromPick()
      expect(prompt).toContain(`Inside the frame: ${inner}`)
      expect(prompt).toContain('Element: button#in')
      expect(await pictureCentre(app, picturePath(prompt))).toEqual([200, 10, 10])

      await page.waitForTimeout(INSPECT_MODE_SETTLES_MS)
      expect(agentFrame()?.isDetached()).toBe(false)
      expect(await agentFrame()?.evaluate('[document.title, window.clicks]')).toEqual(['Inner', 0])
      await browser.close()
    } finally {
      await server.close()
    }
  })
})
