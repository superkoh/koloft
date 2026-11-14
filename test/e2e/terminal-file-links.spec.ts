import fs from 'fs'
import path from 'path'
import type { Page } from '@playwright/test'
import { test, expect, quitAndClose } from './helpers/app'
import { launchSettled } from './helpers/blackbox'
import { clickTerminalLink } from './helpers/browser'
import {
  installAgy,
  installCodex,
  installMuse,
  seedSettings,
  trustInAgy,
  trustInMuse,
  type E2EEnv
} from './helpers/env'
import {
  addRemoteWorkspace,
  launchWithRemote,
  type OtherAgentName,
  REMOTE_WS_NAME,
  remoteDir
} from './helpers/remote'
import {
  centerTerm,
  newSessionInWith,
  runIn,
  startSessionIn,
  waitBooted,
  writeTo,
  wsRows
} from './helpers/p1'
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

interface FoundLink {
  text: string
  startX: number
  endX: number
  underlined: boolean
}

function linksOnLineWith(page: Page, tabId: string, marker: string): Promise<FoundLink[]> {
  return page.evaluate(
    async ({ id, marker }) => {
      interface Link {
        text: string
        range: { start: { x: number }; end: { x: number } }
        decorations?: { underline: boolean }
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
      return replies.flat().map((l) => ({
        text: l.text,
        startX: l.range.start.x,
        endX: l.range.end.x,
        underlined: l.decorations?.underline ?? true
      }))
    },
    { id: tabId, marker }
  )
}

async function linkTextsOnLineWith(page: Page, tabId: string, marker: string): Promise<string[]> {
  return (await linksOnLineWith(page, tabId, marker)).map((l) => l.text)
}

async function commandClick(page: Page, text: string): Promise<void> {
  await page.keyboard.down('Meta')
  await clickTerminalLink(page, text)
  await page.keyboard.up('Meta')
}

const LOCAL_OTHER_AGENTS: {
  label: OtherAgentName
  install: (env: E2EEnv) => void
  start: (page: Page) => Promise<void>
}[] = [
  {
    label: 'Codex',
    install: (env) => installCodex(env),
    start: (page) => startSessionIn(page, 'ws-a', { method: 'Codex' })
  },
  {
    label: 'Muse',
    install: (env) => {
      installMuse(env)
      trustInMuse(env, env.workspaces.a)
    },
    start: (page) => startSessionIn(page, 'ws-a', { method: 'Muse' })
  },
  {
    label: 'Antigravity',
    install: (env) => {
      installAgy(env)
      trustInAgy(env, env.workspaces.a)
    },
    start: async (page) => {
      await newSessionInWith(page, 'ws-a', 'Antigravity')
      await runIn(page, centerTerm(page), 'warm up')
      await expect(wsRows(page, 'ws-a').filter({ hasText: 'warm up' })).toHaveClass(/st-waiting/, {
        timeout: 30_000
      })
    }
  }
]

test.describe('a file path an agent printed in its terminal opens in the Workbench on ⌘-click', () => {
  test('a path that exists becomes a link, shown only while ⌘ is held; a missing one, a label naming the path after it and the rest of a path broken at the row above do not; a plain click opens nothing, ⌘-click opens the file at its line', async ({
    page,
    env
  }) => {
    test.setTimeout(180_000)
    writeIn(env.workspaces.a, 'src/a.ts', numberedTs('tfl'))
    writeIn(env.workspaces.a, 'a.ts', numberedTs('tfroot'))
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    const tabId = await shownTabId(page)

    await writeTo(
      page,
      tabId,
      '\r\ntfl-mark 说明 src/a.ts:45 and nope/missing.ts:3 then a.ts (src/a.ts:7)\r\n' +
        'tfl-plain row\r\nsrc/a.ts:8\r\ntfl-broken /some/where/\r\nsrc/a.ts:9\r\n'
    )
    await expect
      .poll(() => linksOnLineWith(page, tabId, 'tfl-mark'), { timeout: 20_000 })
      .toEqual([
        { text: 'src/a.ts:45', startX: 15, endX: 25, underlined: false },
        { text: 'src/a.ts:7', startX: 60, endX: 69, underlined: false }
      ])
    expect(await linkTextsOnLineWith(page, tabId, 'src/a.ts:8')).toEqual(['src/a.ts:8'])
    expect(await linkTextsOnLineWith(page, tabId, 'src/a.ts:9')).toEqual([])

    const title = page.locator(WORKBENCH.readingTitle)
    await clickTerminalLink(page, 'src/a.ts:45')
    await page.waitForTimeout(ROOM_FOR_A_WRONG_OPEN_MS)
    await expect(title.filter({ hasText: 'a.ts' })).toHaveCount(0)

    await commandClick(page, 'src/a.ts:45')
    await expect(title).toHaveText('src/a.ts', { timeout: 30_000 })
    await expect(page.locator(WORKBENCH.readingBody).getByText('tfl-45').first()).toBeInViewport({
      timeout: 20_000
    })
  })

  for (const agent of LOCAL_OTHER_AGENTS) {
    test(`in a local ${agent.label} tab, a path resolves against the session folder and opens on ⌘-click`, async ({
      env
    }) => {
      test.setTimeout(180_000)
      agent.install(env)
      seedSettings(env, { hintsOff: true })
      writeIn(env.workspaces.a, 'src/o.ts', numberedTs('tfo'))
      const { app, page } = await launchSettled(env)
      try {
        await waitBooted(page)
        await agent.start(page)
        const tabId = await shownTabId(page)
        await writeTo(page, tabId, '\r\ntfo-mark see (src/o.ts:40)\r\n')
        await expect
          .poll(() => linkTextsOnLineWith(page, tabId, 'tfo-mark'), { timeout: 20_000 })
          .toEqual(['src/o.ts:40'])

        await commandClick(page, 'src/o.ts:40')
        await expect(page.locator(WORKBENCH.readingTitle)).toHaveText('src/o.ts', {
          timeout: 30_000
        })
      } finally {
        await quitAndClose(app)
      }
    })
  }

  test('in a remote tab, the path is looked up and opened on the machine', async ({ env }) => {
    test.setTimeout(300_000)
    const { app, page } = await launchWithRemote(env)
    try {
      writeIn(remoteDir(env), 'src/r.ts', numberedTs('tfr'))
      await addRemoteWorkspace(page, env)
      await startSessionIn(page, REMOTE_WS_NAME, { remote: true })
      await wsRows(page, REMOTE_WS_NAME).first().click()
      const tabId = await shownTabId(page)

      await writeTo(page, tabId, '\r\ntfr-mark src/r.ts:50 and src/gone.ts:1\r\n')
      await expect
        .poll(() => linkTextsOnLineWith(page, tabId, 'tfr-mark'), { timeout: 30_000 })
        .toEqual(['src/r.ts:50'])

      await commandClick(page, 'src/r.ts:50')
      await expect(page.locator(WORKBENCH.readingTitle)).toContainText('r.ts', { timeout: 30_000 })
      await expect(page.locator(WORKBENCH.readingBody).getByText('tfr-50').first()).toBeInViewport({
        timeout: 20_000
      })
    } finally {
      await quitAndClose(app)
    }
  })
})
