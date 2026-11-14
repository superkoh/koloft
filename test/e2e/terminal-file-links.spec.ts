import fs from 'fs'
import path from 'path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { installCodex, type E2EEnv } from './helpers/env'
import { addRemoteWorkspace, launchWithRemote, REMOTE_WS_NAME, remoteDir } from './helpers/remote'
import { startSessionIn, waitBooted, writeTo, wsRows } from './helpers/p1'
import { WORKBENCH } from './helpers/workbench'

const ROOM_FOR_A_WRONG_OPEN_MS = 1500

function numberedTs(tag: string): string {
  return Array.from({ length: 60 }, (_, i) => `export const l${i + 1} = '${tag}-${i + 1}'`).join(
    '\n'
  )
}

function writeIn(dir: string, rel: string, body: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
  fs.writeFileSync(path.join(dir, rel), body)
}

async function shownTabId(page: Page): Promise<string> {
  const id = await page.locator('.ws .ws-tab.active').getAttribute('data-tab-id')
  if (!id) throw new Error('no session row is active')
  return id
}

async function printInSessionTerminal(page: Page, tabId: string, line: string): Promise<void> {
  await writeTo(page, tabId, `\r\n${line}\r\n`)
}

interface FoundLink {
  text: string
  startX: number
  endX: number
}

function linksOnLineWith(page: Page, tabId: string, marker: string): Promise<FoundLink[]> {
  return page.evaluate(
    async ({ id, marker }) => {
      interface Link {
        text: string
        range: { start: { x: number }; end: { x: number } }
      }
      interface Term {
        buffer: {
          active: {
            length: number
            getLine(i: number): { translateToString(trim?: boolean): string } | undefined
          }
        }
        _core: {
          _linkProviderService: {
            linkProviders: { provideLinks(y: number, cb: (l?: Link[]) => void): void }[]
          }
        }
      }
      const term = (window as unknown as { __koloftTerms: Record<string, Term> }).__koloftTerms[id]
      const buf = term.buffer.active
      let y = -1
      for (let i = buf.length - 1; i >= 0 && y < 0; i--) {
        if ((buf.getLine(i)?.translateToString(true) ?? '').includes(marker)) y = i + 1
      }
      if (y < 0) return []
      const replies = await Promise.all(
        term._core._linkProviderService.linkProviders.map(
          (p) => new Promise<Link[]>((done) => p.provideLinks(y, (l) => done(l ?? [])))
        )
      )
      return replies
        .flat()
        .map((l) => ({ text: l.text, startX: l.range.start.x, endX: l.range.end.x }))
    },
    { id: tabId, marker }
  )
}

async function clickPathInTerminal(
  page: Page,
  text: string,
  opts: { holdingCommand: boolean }
): Promise<void> {
  const span = page.locator('.term-island .term-wrap:visible .xterm-rows span', { hasText: text })
  await expect(span.last()).toBeVisible({ timeout: 30_000 })
  const content = (await span.last().textContent()) ?? ''
  const box = (await span.last().boundingBox())!
  const cellWidth = box.width / Math.max(content.length, 1)
  const x = box.x + cellWidth * (content.indexOf(text) + text.length / 2)
  const y = box.y + box.height / 2
  // PLATFORM§18
  await page.mouse.move(x, y)
  await page.waitForTimeout(300)
  if (opts.holdingCommand) await page.keyboard.down('Meta')
  await page.mouse.click(x, y)
  if (opts.holdingCommand) await page.keyboard.up('Meta')
}

async function launched(env: E2EEnv): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launchApp(env)
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await waitBooted(page)
  return { app, page }
}

test.describe('a file path an agent printed in its terminal opens in the Workbench on ⌘-click', () => {
  test('a path that exists becomes a link and a missing one does not; a plain click opens nothing, ⌘-click opens the file at its line', async ({
    page,
    env
  }) => {
    test.setTimeout(180_000)
    writeIn(env.workspaces.a, 'src/a.ts', numberedTs('tfl'))
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    const tabId = await shownTabId(page)

    await printInSessionTerminal(
      page,
      tabId,
      'tfl-mark 说明 src/a.ts:45 and nope/missing.ts:3 then Update(src/a.ts)'
    )
    await expect
      .poll(() => linksOnLineWith(page, tabId, 'tfl-mark'), { timeout: 20_000 })
      .toEqual([
        { text: 'src/a.ts:45', startX: 15, endX: 25 },
        { text: 'src/a.ts', startX: 61, endX: 68 }
      ])

    const title = page.locator(WORKBENCH.readingTitle)
    await clickPathInTerminal(page, 'src/a.ts:45', { holdingCommand: false })
    await page.waitForTimeout(ROOM_FOR_A_WRONG_OPEN_MS)
    await expect(title.filter({ hasText: 'a.ts' })).toHaveCount(0)

    await clickPathInTerminal(page, 'src/a.ts:45', { holdingCommand: true })
    await expect(title).toHaveText('src/a.ts', { timeout: 30_000 })
    await expect(page.locator(WORKBENCH.readingBody).getByText('tfl-45').first()).toBeInViewport({
      timeout: 20_000
    })
  })

  test('in a local Codex tab, a path resolves against the session folder and opens on ⌘-click', async ({
    env
  }) => {
    test.setTimeout(180_000)
    installCodex(env)
    writeIn(env.workspaces.a, 'src/c.ts', numberedTs('tfc'))
    const { app, page } = await launched(env)
    try {
      await startSessionIn(page, 'ws-a', { method: 'Codex' })
      const tabId = await shownTabId(page)
      await printInSessionTerminal(page, tabId, 'tfc-mark app (src/c.ts:40)')
      await expect
        .poll(async () => (await linksOnLineWith(page, tabId, 'tfc-mark')).map((l) => l.text), {
          timeout: 20_000
        })
        .toEqual(['src/c.ts:40'])

      await clickPathInTerminal(page, 'src/c.ts:40', { holdingCommand: true })
      await expect(page.locator(WORKBENCH.readingTitle)).toHaveText('src/c.ts', {
        timeout: 30_000
      })
    } finally {
      await quitAndClose(app)
    }
  })

  test('in a remote tab, the path is looked up and opened on the machine', async ({ env }) => {
    test.setTimeout(300_000)
    const { app, page } = await launchWithRemote(env)
    try {
      writeIn(remoteDir(env), 'src/r.ts', numberedTs('tfr'))
      await addRemoteWorkspace(page, env)
      await startSessionIn(page, REMOTE_WS_NAME, { remote: true })
      await wsRows(page, REMOTE_WS_NAME).first().click()
      const tabId = await shownTabId(page)

      await printInSessionTerminal(page, tabId, 'tfr-mark src/r.ts:50 and src/gone.ts:1')
      await expect
        .poll(async () => (await linksOnLineWith(page, tabId, 'tfr-mark')).map((l) => l.text), {
          timeout: 30_000
        })
        .toEqual(['src/r.ts:50'])

      await clickPathInTerminal(page, 'src/r.ts:50', { holdingCommand: true })
      await expect(page.locator(WORKBENCH.readingTitle)).toContainText('r.ts', { timeout: 30_000 })
      await expect(page.locator(WORKBENCH.readingBody).getByText('tfr-50').first()).toBeInViewport({
        timeout: 20_000
      })
    } finally {
      await quitAndClose(app)
    }
  })
})
