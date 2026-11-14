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
  auxIcon,
  centerTerm,
  gitInit,
  launchWithWebGL,
  newSessionInWith,
  openWorktreeSession,
  runIn,
  startSessionIn,
  waitBooted,
  waitForCalls,
  waitStartupTurnOver,
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

async function linkTextsOnLineWith(page: Page, tabId: string, marker: string): Promise<string[]> {
  return (await linksOnLineWith(page, tabId, marker)).map((l) => l.text)
}

async function clickLinkCell(
  page: Page,
  tabId: string,
  marker: string,
  opts: { holdingCommand: boolean }
): Promise<void> {
  const at = await page.evaluate(
    async ({ id, marker }) => {
      interface Link {
        range: { start: { x: number; y: number }; end: { x: number } }
      }
      interface Term {
        cols: number
        rows: number
        element: HTMLElement
        buffer: {
          active: {
            length: number
            viewportY: number
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
      const providers = term._core._linkProviderService.linkProviders
      const ours = providers[providers.length - 1]
      const [link] = await new Promise<Link[]>((done) => ours.provideLinks(y, (l) => done(l ?? [])))
      const screen = term.element.querySelector('.xterm-screen')!.getBoundingClientRect()
      const cellW = screen.width / term.cols
      const cellH = screen.height / term.rows
      const midX = (link.range.start.x + link.range.end.x) / 2
      return {
        x: screen.left + (midX - 0.5) * cellW,
        y: screen.top + (link.range.start.y - 1 - buf.viewportY + 0.5) * cellH
      }
    },
    { id: tabId, marker }
  )
  // PLATFORM§18
  await page.mouse.move(at.x, at.y)
  await page.waitForTimeout(ROOM_FOR_A_WRONG_OPEN_MS)
  if (opts.holdingCommand) await page.keyboard.down('Meta')
  await page.mouse.click(at.x, at.y)
  if (opts.holdingCommand) await page.keyboard.up('Meta')
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
  test('a path that exists becomes a link; a missing one, a label naming the path after it and the rest of a path broken at the row above do not; a plain click opens nothing, ⌘-click opens the file at its line', async ({
    page,
    env
  }) => {
    test.setTimeout(180_000)
    writeIn(env.workspaces.a, 'src/a.ts', numberedTs('tfl'))
    writeIn(env.workspaces.a, 'a.ts', numberedTs('tfroot'))
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    await waitStartupTurnOver(page, 'ws-a')
    const tabId = await shownTabId(page)

    await writeTo(
      page,
      tabId,
      '\r\ntfl-mark 说明 src/a.ts:45 and nope/missing.ts:3\r\ntfl-label a.ts (src/a.ts:7)\r\n' +
        'tfl-plain row\r\nsrc/a.ts:8\r\ntfl-broken /some/where/\r\nsrc/a.ts:9\r\n'
    )
    await expect
      .poll(() => linksOnLineWith(page, tabId, 'tfl-mark'), { timeout: 20_000 })
      .toEqual([{ text: 'src/a.ts:45', startX: 15, endX: 25 }])
    expect(await linksOnLineWith(page, tabId, 'tfl-label')).toEqual([
      { text: 'src/a.ts:7', startX: 17, endX: 26 }
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

  test('in a worktree session, a relative path opens the worktree copy, not the main checkout one', async ({
    env
  }) => {
    test.setTimeout(240_000)
    gitInit(env.workspaces.a)
    seedSettings(env, { hintsOff: true })
    const { app, page } = await launchSettled(env)
    try {
      await waitBooted(page)
      const dlg = await openWorktreeSession(page, 'ws-a')
      await dlg.getByRole('textbox').click()
      await page.keyboard.type('wt821')
      await page.keyboard.press('Enter')
      await expect(dlg).toHaveCount(0)
      await waitForCalls(env, 1)
      await expect(auxIcon(page, 'Workbench')).toHaveAttribute('aria-disabled', 'false', {
        timeout: 60_000
      })
      const tree = path.join(env.workspaces.a, '.claude', 'worktrees', 'wt821')
      writeIn(env.workspaces.a, 'src/w.ts', numberedTs('tfmain'))
      writeIn(tree, 'src/w.ts', numberedTs('tftree'))
      const tabId = await shownTabId(page)

      await writeTo(page, tabId, '\r\ntfw-mark src/w.ts:30\r\n')
      await expect
        .poll(() => linkTextsOnLineWith(page, tabId, 'tfw-mark'), { timeout: 20_000 })
        .toEqual(['src/w.ts:30'])
      await commandClick(page, 'src/w.ts:30')
      await expect(
        page.locator(WORKBENCH.readingBody).getByText('tftree-30').first()
      ).toBeInViewport({ timeout: 30_000 })
    } finally {
      await quitAndClose(app)
    }
  })

  test('drawn with WebGL, on the alternate screen with mouse reporting on as a fullscreen agent has it, a plain click opens nothing and a ⌘-click after resting on the path opens it', async ({
    env
  }) => {
    test.setTimeout(180_000)
    writeIn(env.workspaces.a, 'src/g.ts', numberedTs('tfg'))
    const { app, page } = await launchWithWebGL(env)
    try {
      await startSessionIn(page, 'ws-a')
      await waitStartupTurnOver(page, 'ws-a')
      const tabId = await shownTabId(page)
      await writeTo(
        page,
        tabId,
        '\x1b[?1049h\x1b[?1002h\x1b[?1006h\x1b[H\r\ntfg-mark src/g.ts:33\r\n'
      )
      await expect
        .poll(() => linkTextsOnLineWith(page, tabId, 'tfg-mark'), { timeout: 20_000 })
        .toEqual(['src/g.ts:33'])

      const title = page.locator(WORKBENCH.readingTitle)
      await clickLinkCell(page, tabId, 'tfg-mark', { holdingCommand: false })
      await page.waitForTimeout(ROOM_FOR_A_WRONG_OPEN_MS)
      await expect(title.filter({ hasText: 'g.ts' })).toHaveCount(0)

      await clickLinkCell(page, tabId, 'tfg-mark', { holdingCommand: true })
      await expect(title).toHaveText('src/g.ts', { timeout: 30_000 })
      await expect(page.locator(WORKBENCH.readingBody).getByText('tfg-33').first()).toBeInViewport({
        timeout: 20_000
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
