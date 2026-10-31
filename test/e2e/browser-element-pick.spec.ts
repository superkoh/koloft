import fs from 'fs'
import path from 'path'
import type { Browser, ElectronApplication, Page } from '@playwright/test'
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
  clickPicked,
  connectCdp,
  guestByUrl,
  isPng,
  openPickPage,
  pickIntoSession,
  pictureCentre,
  picturePath,
  startPick,
  tabByTitle,
  typeAfterThePick
} from './helpers/browser'
import { claudePrompts } from './helpers/workbench'
import { startEchoServer, type FixtureServer } from './helpers/fixtureServer'

let server: FixtureServer
let transcript: string

test.beforeEach(async ({ page, env }) => {
  test.setTimeout(180_000)
  server = await startEchoServer()
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')
  const tabId = await wsRows(page, 'ws-a').first().getAttribute('data-tab-id')
  transcript = transcriptFile(env.home, env.workspaces.a, (await boundSessionId(page, tabId)) ?? '')
})

test.afterEach(async () => {
  await server.close()
})

async function onePromptWith(tag: string): Promise<string> {
  const withTag = (): string[] => claudePrompts(transcript).filter((p) => p.includes(tag))
  await expect.poll(withTag, { timeout: 30_000 }).toHaveLength(1)
  return withTag()[0]
}

async function agentOpens(
  app: ElectronApplication,
  page: Page,
  env: E2EEnv,
  url: string,
  title: string
): Promise<{ browser: Browser; agentPage: Page; guest: Page }> {
  const browser = await connectCdp(page, await cdpEndpointOf(env))
  const agentPage = await browser.contexts()[0].newPage()
  await agentPage.goto(url)
  const guest = await guestByUrl(app, url)
  await tabByTitle(page, title).click()
  return { browser, agentPage, guest }
}

test.describe('Pick an element in a Workbench web tab and paste it into the session', () => {
  test('BP-01: a pick pastes the page, the element, a picture of it, its HTML and its CSS into the Claude input box, unsent, the click never reaches the page; an approval coming up stops a pick and greys the button', async ({
    app,
    page,
    env
  }) => {
    const url = server.page('/pick', PICK_PAGE)
    const guest = await openPickPage(app, page, url)

    await pickIntoSession(page, guest, '#buy', ' make it green BP-01')

    const prompt = await onePromptWith('BP-01')
    expect(prompt.startsWith('Element picked in the Workbench browser\n')).toBe(true)
    expect(prompt).toContain(`Page: ${url} ("Pick")`)
    expect(prompt).toContain(`Element: ${PICKED_LABEL}`)
    expect(prompt).toContain('<button id="buy" class="primary"')
    expect(prompt).toContain('background-color: rgb(10, 120, 250);')
    expect(prompt.endsWith(' make it green BP-01')).toBe(true)
    const picture = picturePath(prompt)
    expect(picture.startsWith(path.join(env.userData, 'element-picks') + path.sep)).toBe(true)
    expect(isPng(picture)).toBe(true)
    expect(await pictureCentre(app, picture)).toEqual([10, 120, 250])
    expect(await guest.evaluate('window.clicks')).toBe(0)

    const button = page.locator(BROWSER.pickButton)
    await startPick(page)
    const tabId = await wsRows(page, 'ws-a').first().getAttribute('data-tab-id')
    await page.evaluate((id) => window.api.terminal.write(id ?? '', '/need-approval\r'), tabId)
    await expect(button).toBeDisabled({ timeout: 30_000 })
    await expect(button).toHaveAttribute('aria-pressed', 'false')
    await runIn(page, centerTerm(page), 'back to work')
    await expect(button).toBeEnabled({ timeout: 30_000 })
  })

  test('BP-09: a picture that cannot be saved says so in a toast, and the pick still pastes, without the picture', async ({
    app,
    page,
    env
  }) => {
    fs.writeFileSync(path.join(env.userData, 'element-picks'), 'not a folder')
    const guest = await openPickPage(app, page, server.page('/pick', PICK_PAGE))

    await startPick(page)
    await clickPicked(page, guest, '#buy')
    await expect(page.locator('.toast')).toContainText(
      'The picture of the element could not be saved:',
      { timeout: 10_000 }
    )
    await typeAfterThePick(page, ' BP-09')

    const prompt = await onePromptWith('BP-09')
    expect(prompt).toContain(`Element: ${PICKED_LABEL}`)
    expect(picturePath(prompt)).toBe('')
  })

  test('BP-02: Esc, the button again or a click outside the page stops picking and pastes nothing; the next pick pastes once', async ({
    app,
    page
  }) => {
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
    await onePromptWith('BP-02')
    expect(
      claudePrompts(transcript).filter((p) => p.includes('Element picked in the Workbench'))
    ).toHaveLength(1)
  })

  test('BP-03: a pick while an agent drives the same page through the CDP relay shares its debugger, and the agent can still click, read, screenshot and navigate afterwards', async ({
    app,
    page,
    env
  }) => {
    const url = server.page('/pick', PICK_PAGE)
    const { browser, agentPage, guest } = await agentOpens(app, page, env, url, 'Pick')
    await agentPage.locator('#buy').scrollIntoViewIfNeeded()
    const handle = await agentPage.$('#buy')
    await agentPage.click('#buy')

    await pickIntoSession(page, guest, '#buy', ' BP-03 shared')
    await onePromptWith('BP-03')

    await agentPage.click('#buy')
    expect(await agentPage.evaluate('window.clicks')).toBe(2)
    expect(await handle?.textContent()).toBe('Buy')
    expect((await agentPage.screenshot()).length).toBeGreaterThan(0)
    await agentPage.goto(
      server.page('/second', '<!doctype html><title>Second</title><p id="p">two')
    )
    await expect(agentPage.locator('#p')).toHaveText('two')
    await browser.close()
  })

  test('BP-04: an agent that attaches while a pick is open joins the debugger instead of being refused, and the pick still lands', async ({
    app,
    page,
    env
  }) => {
    const url = server.page('/pick', PICK_PAGE)
    const opened = await agentOpens(app, page, env, url, 'Pick')
    await opened.agentPage.locator('#buy').scrollIntoViewIfNeeded()
    await opened.browser.close()
    await startPick(page)

    const browser = await connectCdp(page, await cdpEndpointOf(env))
    const agentPages = (): Page[] =>
      browser.contexts().flatMap((c) => c.pages().filter((p) => p.url() === url))
    await expect.poll(() => agentPages().length, { timeout: 20_000 }).toBe(1)
    const [agentPage] = agentPages()
    expect(await agentPage.title()).toBe('Pick')
    await expect(page.locator(BROWSER.pickButton)).toHaveAttribute('aria-pressed', 'true')

    await clickPicked(page, opened.guest, '#buy')
    await typeAfterThePick(page, ' BP-04 joined')
    await onePromptWith('BP-04')
    await agentPage.click('#buy')
    expect(await agentPage.evaluate('window.clicks')).toBe(1)
    await browser.close()
  })

  test('BP-05: a pick with no agent on the page leaves the guest without a debugger afterwards', async ({
    app,
    page
  }) => {
    const url = server.page('/pick', PICK_PAGE)
    const guest = await openPickPage(app, page, url)
    await startPick(page)
    await clickPicked(page, guest, '#buy')
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
  })

  test('BP-08: a pick inside a cross-origin iframe picks the element there, names the frame and pictures it, while an agent driving the page keeps its own hold on that iframe', async ({
    app,
    page,
    env
  }) => {
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
    const { browser, agentPage, guest } = await agentOpens(app, page, env, url, 'Outer')
    await agentPage.locator('#f').scrollIntoViewIfNeeded()
    const agentFrame = (): ReturnType<Page['frames']>[number] | undefined =>
      agentPage.frames().find((f) => f.url() === inner)
    await expect.poll(() => !!agentFrame()).toBe(true)

    await pickIntoSession(page, guest, 'iframe#f', ' BP-08 inside the frame')
    const prompt = await onePromptWith('BP-08')
    expect(prompt).toContain(`Inside the frame: ${inner}`)
    expect(prompt).toContain('Element: button#in')
    expect(await pictureCentre(app, picturePath(prompt))).toEqual([200, 10, 10])

    await page.waitForTimeout(INSPECT_MODE_SETTLES_MS)
    expect(agentFrame()?.isDetached()).toBe(false)
    expect(await agentFrame()?.evaluate('[document.title, window.clicks]')).toEqual(['Inner', 0])
    await browser.close()
  })
})
