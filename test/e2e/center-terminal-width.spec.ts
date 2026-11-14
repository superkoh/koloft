import type { ElectronApplication, Page } from '@playwright/test'
import { BACKEND_LABEL, SESSION_BACKENDS } from '../../src/shared/sessionBackend'
import type { BackendId } from '../../src/shared/types'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { codexCalls } from './helpers/codex'
import {
  agySessionCalls,
  installAgy,
  installCodex,
  installMuse,
  museCalls,
  seedSettings,
  trustInAgy,
  trustInMuse,
  type E2EEnv
} from './helpers/env'
import { closeSettings, openSettings } from './helpers/extensions'
import {
  addRemoteWorkspace,
  agyReady,
  killFakeRemote,
  launchWithRemote,
  OTHER_AGENTS_ON_THE_MACHINE,
  REMOTE_WS_NAME,
  remoteCommandText,
  remoteKey,
  sshCalls,
  type OtherAgentName
} from './helpers/remote'
import {
  agyConversationOnceFirstTurnEnded,
  centerTerm,
  clickAppMenuItem,
  focusOwner,
  newSessionInWith,
  openMenu,
  openSessionTerminal,
  readCalls,
  runIn,
  sessionInRow,
  setWindowWidth,
  shownCenterTerm,
  startSessionIn,
  waitBooted,
  wsRows
} from './helpers/p1'
import { seedWorkbenchDefault } from './helpers/workbench'

const CENTER_MAX_COLS = 140
const MIN_SIDE_GUTTER_PX = 24
const SUBPIXEL_PX = 2
const BELOW_THE_WINDOW_MIN_WIDTH_PX = 900
const WIDE_WINDOW_PX = 1720
const FRAMES_A_BUSY_RENDERER_RUNS_FRAME_CALLBACKS_LATE = 4
const SHOWN_LONG_ENOUGH_TO_SETTLE_MS = 1500

test.afterEach(({ env }) => killFakeRemote(env))

function recordUnmaskedColsWithLateFrameCallbacks(page: Page): Promise<void> {
  return page.evaluate((late) => {
    const w = window as unknown as {
      __unmaskedCols: number[]
      __stopUnmaskedCols?: boolean
      __koloftTerms?: Record<string, { cols: number; element?: HTMLElement }>
    }
    const onTime = window.requestAnimationFrame.bind(window)
    const cancelOnTime = window.cancelAnimationFrame.bind(window)
    const pendingHop = new Map<number, number>()
    let lastId = 0
    window.requestAnimationFrame = (cb) => {
      const id = ++lastId
      let left = late
      const step = (t: number): void => {
        if (left-- > 0) {
          pendingHop.set(id, onTime(step))
        } else {
          pendingHop.delete(id)
          cb(t)
        }
      }
      pendingHop.set(id, onTime(step))
      return id
    }
    window.cancelAnimationFrame = (id) => {
      const hop = pendingHop.get(id)
      if (hop !== undefined) cancelOnTime(hop)
      pendingHop.delete(id)
    }
    w.__unmaskedCols = []
    w.__stopUnmaskedCols = false
    const tick = (): void => {
      const masked = !!document.querySelector('.term-island .empty')
      for (const t of masked ? [] : Object.values(w.__koloftTerms ?? {})) {
        const wrap = t.element?.closest<HTMLElement>('.term-island .term-wrap')
        if (wrap && wrap.style.display !== 'none' && wrap.style.visibility !== 'hidden') {
          const seen = w.__unmaskedCols
          if (seen[seen.length - 1] !== t.cols) seen.push(t.cols)
          break
        }
      }
      if (!w.__stopUnmaskedCols) onTime(tick)
    }
    onTime(tick)
  }, FRAMES_A_BUSY_RENDERER_RUNS_FRAME_CALLBACKS_LATE)
}

function recordedUnmaskedCols(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __unmaskedCols: number[]; __stopUnmaskedCols?: boolean }
    w.__stopUnmaskedCols = true
    return w.__unmaskedCols
  })
}

async function shownCenterCols(page: Page): Promise<number | undefined> {
  return (await shownCenterTerm(page))?.cols
}

function shownPanelCols(page: Page): Promise<number | undefined> {
  return page.evaluate(() => {
    const terms = (
      window as unknown as {
        __koloftTerms?: Record<string, { cols: number; element?: HTMLElement }>
      }
    ).__koloftTerms
    return Object.values(terms ?? {}).find(
      (t) => !!t.element?.closest('.wb-term') && !!t.element.getClientRects().length
    )?.cols
  })
}

function centerLayout(page: Page): Promise<{
  leftGap: number
  rightGap: number
  clockGap: number
  termMaxWidth: string
}> {
  return page.evaluate(() => {
    const wrap = [...document.querySelectorAll<HTMLElement>('.term-island .term-wrap')].find(
      (w) => w.style.display !== 'none' && w.style.visibility !== 'hidden'
    )!
    const termEl = wrap.querySelector<HTMLElement>('.term')!
    const term = termEl.getBoundingClientRect()
    const col = document.querySelector('.term-col')!
    let rightNeighbour = col.nextElementSibling
    while (rightNeighbour && getComputedStyle(rightNeighbour).position === 'absolute') {
      rightNeighbour = rightNeighbour.nextElementSibling
    }
    const row = document.querySelector('.center-row')!.getBoundingClientRect()
    const rightEdge = rightNeighbour ? rightNeighbour.getBoundingClientRect().left : row.right
    const clock = document.querySelector('.center-top .wc')!.getBoundingClientRect()
    const colLeft = col.getBoundingClientRect().left
    return {
      leftGap: term.left - colLeft,
      rightGap: rightEdge - term.right,
      clockGap: clock.left - colLeft,
      termMaxWidth: termEl.style.maxWidth
    }
  })
}

const LOCAL_OTHER_AGENTS: { label: OtherAgentName; install: (env: E2EEnv) => void }[] = [
  { label: 'Codex', install: (env) => installCodex(env) },
  { label: 'Muse', install: installMuse },
  { label: 'Antigravity', install: installAgy }
]

async function launchRemoteWithPanelShut(
  env: E2EEnv
): Promise<{ app: ElectronApplication; page: Page }> {
  seedWorkbenchDefault(env, false)
  seedSettings(env, { hintsOff: true })
  const { app, page } = await launchWithRemote(env)
  await setWindowWidth(app, WIDE_WINDOW_PX)
  await addRemoteWorkspace(page, env)
  return { app, page }
}

async function launchWithPanelShut(env: E2EEnv): Promise<{ app: ElectronApplication; page: Page }> {
  seedWorkbenchDefault(env, false)
  seedSettings(env, { hintsOff: true })
  const app = await launchApp(env)
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await waitBooted(page)
  return { app, page }
}

interface StartWidths {
  startsAt: string
  read: (env: E2EEnv) => (number | null | undefined)[]
}

const agentStart = (read: StartWidths['read']): StartWidths => ({
  startsAt: 'its agent starts',
  read
})

const TAB_TERMINAL_TO_THE_MACHINE = /tabs\/[^"]+\.sh"?\s+(attach|start)/

const TERMINAL_TO_THE_MACHINE: StartWidths = {
  startsAt: 'the terminal that links it to the machine opens',
  read: (env) =>
    sshCalls(env)
      .filter(
        (c) => c.phase === 'start' && TAB_TERMINAL_TO_THE_MACHINE.test(remoteCommandText(c.argv))
      )
      .map((c) => c.cols)
}

const CODEX_SCREEN = (env: E2EEnv): (number | null)[] => codexCalls(env).map((c) => c.cols)

const CODEX_SCREEN_ON_THIS_MAC: StartWidths = {
  startsAt: 'its Codex screen starts on this Mac',
  read: CODEX_SCREEN
}

async function boundOnScreen(page: Page): Promise<void> {
  const row = page.locator('.ws .ws-tab.active')
  await expect.poll(() => sessionInRow(page, row), { timeout: 60_000 }).toBeTruthy()
}

interface SessionTabKind {
  kind: string
  backend: BackendId
  remote: boolean
  startWidths: StartWidths
  install: (env: E2EEnv) => void
  startOnScreen: (page: Page) => Promise<unknown>
}

const backendLabelled = (label: OtherAgentName): BackendId =>
  SESSION_BACKENDS.find((b) => BACKEND_LABEL[b] === label)!

const EVERY_SESSION_TAB_KIND: SessionTabKind[] = [
  {
    kind: 'local Claude Code',
    backend: 'claude',
    remote: false,
    startWidths: agentStart((env) => readCalls(env).map((c) => c.cols)),
    install: () => {},
    startOnScreen: (page) => startSessionIn(page, 'ws-a')
  },
  {
    kind: 'local Codex',
    backend: 'codex',
    remote: false,
    startWidths: agentStart(CODEX_SCREEN),
    install: (env) => installCodex(env),
    startOnScreen: (page) => newSessionInWith(page, 'ws-a', 'Codex')
  },
  {
    kind: 'local Muse',
    backend: 'muse',
    remote: false,
    startWidths: agentStart((env) => museCalls(env).map((c) => c.cols)),
    install: (env) => {
      installMuse(env)
      trustInMuse(env, env.workspaces.a)
    },
    startOnScreen: (page) => newSessionInWith(page, 'ws-a', 'Muse')
  },
  {
    kind: 'local Antigravity',
    backend: 'agy',
    remote: false,
    startWidths: agentStart((env) => agySessionCalls(env).map((c) => c.cols)),
    install: (env) => {
      installAgy(env)
      trustInAgy(env, env.workspaces.a)
    },
    startOnScreen: async (page) => {
      await newSessionInWith(page, 'ws-a', 'Antigravity')
      await agyReady(page)
      await runIn(page, centerTerm(page), 'keep me running')
      await agyConversationOnceFirstTurnEnded(page)
    }
  },
  {
    kind: 'remote Claude Code',
    backend: 'claude',
    remote: true,
    startWidths: TERMINAL_TO_THE_MACHINE,
    install: () => {},
    startOnScreen: (page) => startSessionIn(page, REMOTE_WS_NAME, { remote: true })
  },
  ...OTHER_AGENTS_ON_THE_MACHINE.map((agent) => ({
    kind: `remote ${agent.label}`,
    backend: backendLabelled(agent.label),
    remote: true,
    startWidths: agent.label === 'Codex' ? CODEX_SCREEN_ON_THIS_MAC : TERMINAL_TO_THE_MACHINE,
    install: agent.install,
    startOnScreen: async (page: Page) => {
      await newSessionInWith(page, REMOTE_WS_NAME, agent.label)
      await agent.bound?.(page)
    }
  }))
]

async function launchFor(
  tab: SessionTabKind,
  env: E2EEnv
): Promise<{ app: ElectronApplication; page: Page }> {
  if (tab.remote) return launchRemoteWithPanelShut(env)
  const launched = await launchWithPanelShut(env)
  await setWindowWidth(launched.app, WIDE_WINDOW_PX)
  return launched
}

test.describe('the center session terminal stops at 140 columns and sits centred, with at least 24 px on each side; the Workbench terminal still fills its pane', () => {
  test('a narrow window fills the Claude tab 24 px in from each side; widened, it holds at 140 columns, centred, the pty told so, while the world clock stays at the left edge, at any font size; a click in the margin lands in the terminal; the Workbench terminal goes past 140', async ({
    env
  }) => {
    test.setTimeout(240_000)
    const { app, page } = await launchWithPanelShut(env)
    try {
      await setWindowWidth(app, BELOW_THE_WINDOW_MIN_WIDTH_PX)
      await startSessionIn(page, 'ws-a')
      await expect.poll(() => shownCenterCols(page), { timeout: 30_000 }).toBeGreaterThan(0)
      expect(await shownCenterCols(page)).toBeLessThan(CENTER_MAX_COLS)
      const narrow = await centerLayout(page)
      expect(Math.abs(narrow.leftGap - MIN_SIDE_GUTTER_PX)).toBeLessThanOrEqual(SUBPIXEL_PX)
      expect(Math.abs(narrow.rightGap - MIN_SIDE_GUTTER_PX)).toBeLessThanOrEqual(SUBPIXEL_PX)
      expect(Math.abs(narrow.clockGap - MIN_SIDE_GUTTER_PX)).toBeLessThanOrEqual(SUBPIXEL_PX)

      await setWindowWidth(app, WIDE_WINDOW_PX)
      await expect.poll(() => shownCenterCols(page), { timeout: 30_000 }).toBe(CENTER_MAX_COLS)
      await expect(centerTerm(page)).toContainText(`[fake-claude] winch ${CENTER_MAX_COLS}x`, {
        timeout: 30_000
      })
      const wide = await centerLayout(page)
      expect(wide.leftGap).toBeGreaterThan(MIN_SIDE_GUTTER_PX + SUBPIXEL_PX)
      expect(Math.abs(wide.leftGap - wide.rightGap)).toBeLessThanOrEqual(SUBPIXEL_PX)
      expect(Math.abs(wide.clockGap - MIN_SIDE_GUTTER_PX)).toBeLessThanOrEqual(SUBPIXEL_PX)

      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      expect(await focusOwner(page)).not.toBe('tui')
      const wrapBox = (await page.locator('.term-island .term-wrap:visible').boundingBox())!
      await page.mouse.click(wrapBox.x + MIN_SIDE_GUTTER_PX / 2, wrapBox.y + wrapBox.height / 2)
      await expect.poll(() => focusOwner(page)).toBe('tui')

      await openSettings(page)
      await page.locator('.set-ni', { hasText: 'Appearance' }).click()
      await page.getByRole('button', { name: 'Smaller' }).click()
      await page.getByRole('button', { name: 'Smaller' }).click()
      await closeSettings(page)
      await expect
        .poll(async () => (await centerLayout(page)).termMaxWidth, { timeout: 20_000 })
        .not.toBe(wide.termMaxWidth)
      expect(await shownCenterCols(page)).toBe(CENTER_MAX_COLS)
      const smaller = await centerLayout(page)
      expect(smaller.leftGap).toBeGreaterThan(wide.leftGap)
      expect(Math.abs(smaller.leftGap - smaller.rightGap)).toBeLessThanOrEqual(SUBPIXEL_PX)
      expect(Math.abs(smaller.clockGap - MIN_SIDE_GUTTER_PX)).toBeLessThanOrEqual(SUBPIXEL_PX)

      await clickAppMenuItem(app, page, 'toggle-sidebar')
      await expect(page.locator('.app.sb-off')).toHaveCount(1)
      await expect
        .poll(async () => (await centerLayout(page)).leftGap, { timeout: 20_000 })
        .toBeGreaterThan(smaller.leftGap)
      const noSidebar = await centerLayout(page)
      expect(Math.abs(noSidebar.leftGap - noSidebar.rightGap)).toBeLessThanOrEqual(SUBPIXEL_PX)
      expect(noSidebar.clockGap).toBeGreaterThan(MIN_SIDE_GUTTER_PX + SUBPIXEL_PX)
      expect(noSidebar.clockGap).toBeLessThan(noSidebar.leftGap)

      await openSessionTerminal(app, page)
      await clickAppMenuItem(app, page, 'toggle-focus-mode')
      await expect
        .poll(() => shownPanelCols(page), { timeout: 20_000 })
        .toBeGreaterThan(CENTER_MAX_COLS)
    } finally {
      await quitAndClose(app)
    }
  })

  test('a local Codex tab stops at 140 columns too', async ({ env }) => {
    test.setTimeout(180_000)
    installCodex(env)
    const { app, page } = await launchWithPanelShut(env)
    try {
      await setWindowWidth(app, WIDE_WINDOW_PX)
      await startSessionIn(page, 'ws-a', { method: 'Codex' })
      await expect.poll(() => shownCenterCols(page), { timeout: 20_000 }).toBe(CENTER_MAX_COLS)
    } finally {
      await quitAndClose(app)
    }
  })

  for (const tab of [
    {
      kind: 'a new local Claude Code tab',
      open: async (env: E2EEnv) => {
        const { app, page } = await launchWithPanelShut(env)
        await setWindowWidth(app, WIDE_WINDOW_PX)
        return { app, page, start: () => startSessionIn(page, 'ws-a') }
      }
    },
    ...LOCAL_OTHER_AGENTS.map((agent) => ({
      kind: `a new local ${agent.label} tab`,
      open: async (env: E2EEnv) => {
        agent.install(env)
        const { app, page } = await launchWithPanelShut(env)
        await setWindowWidth(app, WIDE_WINDOW_PX)
        return { app, page, start: () => newSessionInWith(page, 'ws-a', agent.label) }
      }
    })),
    {
      kind: 'a new remote Claude Code tab',
      open: async (env: E2EEnv) => {
        const { app, page } = await launchRemoteWithPanelShut(env)
        return {
          app,
          page,
          start: () => startSessionIn(page, REMOTE_WS_NAME, { remote: true })
        }
      }
    },
    ...OTHER_AGENTS_ON_THE_MACHINE.map((agent) => ({
      kind: `a new remote ${agent.label} tab`,
      open: async (env: E2EEnv) => {
        agent.install(env)
        const { app, page } = await launchRemoteWithPanelShut(env)
        return { app, page, start: () => newSessionInWith(page, REMOTE_WS_NAME, agent.label) }
      }
    })),
    {
      kind: 'a resumed Codex session',
      open: async (env: E2EEnv) => {
        installCodex(env)
        const { app, page } = await launchWithPanelShut(env)
        await setWindowWidth(app, WIDE_WINDOW_PX)
        await startSessionIn(page, 'ws-a', { method: 'Codex' })
        const row = wsRows(page, 'ws-a').first()
        await openMenu(page, row)
        await page.locator('.menu .mi', { hasText: /^Close$/ }).click()
        await expect(row).toHaveClass(/\bcold\b/, { timeout: 30_000 })
        return { app, page, start: () => row.click() }
      }
    }
  ]) {
    test(`${tab.kind} shows at its full width from its first unmasked frame, even when frame callbacks run late`, async ({
      env
    }) => {
      test.setTimeout(240_000)
      const { app, page, start } = await tab.open(env)
      try {
        await recordUnmaskedColsWithLateFrameCallbacks(page)
        await start()
        await expect.poll(() => shownCenterCols(page), { timeout: 30_000 }).toBe(CENTER_MAX_COLS)
        await expect(page.locator('.term-island .empty')).toHaveCount(0, { timeout: 30_000 })
        await page.waitForTimeout(SHOWN_LONG_ENOUGH_TO_SETTLE_MS)
        expect(await recordedUnmaskedCols(page)).toEqual([CENTER_MAX_COLS])
      } finally {
        await quitAndClose(app)
      }
    })
  }

  for (const tab of EVERY_SESSION_TAB_KIND) {
    test(`a ${tab.kind} session that koloft session new starts in a tab not on screen is as wide as the session on screen when ${tab.startWidths.startsAt}, not 80 columns until someone opens it`, async ({
      env
    }) => {
      test.setTimeout(240_000)
      tab.install(env)
      const { app, page } = await launchFor(tab, env)
      try {
        await startSessionIn(page, 'ws-a', tab.backend === 'claude' ? {} : { method: 'Claude' })
        await expect.poll(() => shownCenterCols(page), { timeout: 20_000 }).toBe(CENTER_MAX_COLS)
        const onScreen = await page.locator('.ws .ws-tab.active').getAttribute('data-tab-id')
        const before = tab.startWidths.read(env).length
        const where = tab.remote ? ` --workspace ${remoteKey(env)}` : ''
        await page.evaluate(([id, line]) => window.api.terminal.write(id, line), [
          onScreen!,
          `/koloft session new --backend ${tab.backend}${where} -- hello\r`
        ] as const)
        await expect
          .poll(() => tab.startWidths.read(env)[before], { timeout: 60_000 })
          .toBe(CENTER_MAX_COLS)
        await expect(page.locator('.ws .ws-tab.active')).toHaveAttribute('data-tab-id', onScreen!)
        const colsOffScreen = (): Promise<number[]> =>
          page.evaluate((shown) => {
            const terms = (window as unknown as { __koloftTerms: Record<string, { cols: number }> })
              .__koloftTerms
            return Object.entries(terms).flatMap(([id, t]) => (id === shown ? [] : [t.cols]))
          }, onScreen!)
        await expect.poll(colsOffScreen, { timeout: 20_000 }).toEqual([CENTER_MAX_COLS])
      } finally {
        await quitAndClose(app)
      }
    })

    test(`a ${tab.kind} session marked Keep running that comes back by itself when Koloft reopens is as wide as the session screen was when Koloft quit, when ${tab.startWidths.startsAt}`, async ({
      env
    }) => {
      test.setTimeout(300_000)
      tab.install(env)
      const first = await launchFor(tab, env)
      const workspace = tab.remote ? REMOTE_WS_NAME : 'ws-a'
      let before = 0
      try {
        await tab.startOnScreen(first.page)
        await boundOnScreen(first.page)
        await expect
          .poll(() => shownCenterCols(first.page), { timeout: 20_000 })
          .toBe(CENTER_MAX_COLS)
        const row = wsRows(first.page, workspace).first()
        await openMenu(first.page, row)
        await first.page.locator('.menu .mi', { hasText: 'Keep running' }).click()
        await expect(row.locator('.ws-tab-resident')).toBeVisible()
        await openMenu(first.page, row)
        await first.page.locator('.menu .mi', { hasText: /^Close$/ }).click()
        await expect(row).toHaveClass(/\bcold\b/, { timeout: 30_000 })
        before = tab.startWidths.read(env).length
      } finally {
        await quitAndClose(first.app)
      }

      const app = await launchApp(env)
      try {
        await expect
          .poll(() => tab.startWidths.read(env)[before], { timeout: 60_000 })
          .toBe(CENTER_MAX_COLS)
        const page = await app.firstWindow()
        await waitBooted(page)
        await expect(wsRows(page, workspace).first().locator('.ws-tab-resident')).toBeVisible()
        await expect(page.locator('.ws .ws-tab.active')).toHaveCount(0)
      } finally {
        await quitAndClose(app)
      }
    })
  }

  test('a remote Claude tab stops at 140 columns too', async ({ env }) => {
    test.setTimeout(240_000)
    seedWorkbenchDefault(env, false)
    seedSettings(env, { hintsOff: true })
    const { app, page } = await launchWithRemote(env)
    try {
      await setWindowWidth(app, WIDE_WINDOW_PX)
      await addRemoteWorkspace(page, env)
      await startSessionIn(page, REMOTE_WS_NAME, { remote: true })
      await expect.poll(() => shownCenterCols(page), { timeout: 30_000 }).toBe(CENTER_MAX_COLS)
    } finally {
      await quitAndClose(app)
    }
  })
})
