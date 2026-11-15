import fs from 'fs'
import path from 'path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, launchApp, pendingAttention, quitAndClose } from './helpers/app'
import {
  agySessionCalls,
  agyTranscriptOf,
  installAgy,
  installMuse,
  museCalls,
  museSaid,
  seedSettings,
  trustInAgy,
  trustInMuse,
  type E2EEnv
} from './helpers/env'
import {
  type AgentName,
  agyConversationOnceFirstTurnEnded,
  centerTerm,
  newSessionInWith,
  processAlive,
  readCalls,
  resumedId,
  runIn,
  startSessionIn,
  switchToRow,
  terminalText,
  termIds,
  waitBooted,
  waitForCalls,
  wsRows
} from './helpers/p1'
import {
  addRemoteWorkspace,
  agyReady,
  boundRemoteSession,
  installCodexOnFakeRemote,
  installMuseOnMachine,
  installRemoteAgy,
  killLines,
  launchWithRemote,
  liveTmuxSessions,
  machineAgyCalls,
  machineCodexLog,
  machineHome,
  machineMuseCalls,
  REMOTE_WS_NAME,
  stateDir,
  tmuxClientsOf,
  tmuxName
} from './helpers/remote'
import { codexAnswers, codexCalls, type CodexWireLine } from './helpers/codex'

const ROOM_FOR_A_WRONG_FORCE_CLOSE_MODAL_MS = 1500
const WAITING_TO_IDLE_MS = 1000
const IDLE_TO_SLEEP_MS = 3000
const ROOM_FOR_A_WRONG_RESTART_MS = 2000
const ON_THE_MACHINE_WITHIN_MS = 60_000

// PLATFORM§18
function inRenderer<T>(app: ElectronApplication, expr: string): Promise<T> {
  return app.evaluate(
    ({ BrowserWindow }, js) =>
      BrowserWindow.getAllWindows()[0]!.webContents.executeJavaScript(js) as Promise<T>,
    expr
  )
}

test.describe("a renderer reload re-adopts main's live ptys instead of orphaning them, proven on process boundaries rather than DOM", () => {
  test('T-REL-01: a reload re-adopts the session — same pty, one claude, repaint, typing works', async ({
    page,
    env
  }) => {
    test.setTimeout(180_000)
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    const [launch] = await waitForCalls(env, 1)
    const idsBefore = await termIds(page)
    expect(idsBefore).toHaveLength(1)
    const row = wsRows(page, 'ws-a').first()

    await page.reload()
    await waitBooted(page)
    await expect.poll(() => termIds(page), { timeout: 30_000 }).toEqual(idsBefore)
    await expect(centerTerm(page)).toContainText('[fake-claude] winch', { timeout: 30_000 })

    await expect(row).not.toHaveClass(/\bcold\b/)
    await row.click()
    await page.waitForTimeout(ROOM_FOR_A_WRONG_FORCE_CLOSE_MODAL_MS)
    await expect(page.locator('.modal')).toHaveCount(0)

    await runIn(page, centerTerm(page), 'after-reload-marker')
    await expect(centerTerm(page)).toContainText('handled: after-reload-marker', {
      timeout: 30_000
    })
    expect(readCalls(env)).toHaveLength(1)
    expect(processAlive(launch.pid)).toBe(true)
  })

  test('T-REL-02: attention markers and the active tab survive the reload — the tab the user was on is reselected, not the last one adopted', async ({
    page,
    env
  }) => {
    test.setTimeout(180_000)
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    await waitForCalls(env, 1)
    await runIn(page, centerTerm(page), 'marker-a')
    await expect(centerTerm(page)).toContainText('handled: marker-a', { timeout: 30_000 })
    await startSessionIn(page, 'ws-b')
    await waitForCalls(env, 2)
    await runIn(page, centerTerm(page), 'marker-b')
    await expect(centerTerm(page)).toContainText('handled: marker-b', { timeout: 30_000 })
    await expect.poll(() => pendingAttention(page), { timeout: 15_000 }).toHaveLength(2)
    const rowA = wsRows(page, 'ws-a').first()
    await rowA.click()
    await expect(rowA).toHaveClass(/\bactive\b/)
    const ids = await termIds(page)
    expect(ids).toHaveLength(2)

    await page.reload()
    await waitBooted(page)
    await expect.poll(() => termIds(page), { timeout: 30_000 }).toEqual(ids)
    await expect(rowA).toHaveClass(/\bactive\b/, { timeout: 30_000 })
    await expect(wsRows(page, 'ws-b').first()).not.toHaveClass(/\bactive\b/)
    await expect.poll(() => pendingAttention(page), { timeout: 15_000 }).toHaveLength(2)
  })

  test('T-REL-03: a crashed renderer auto-recovers and re-adopts (the production path)', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    const [launch] = await waitForCalls(env, 1)
    const idsBefore = await termIds(page)

    const crashed = page.waitForEvent('crash')
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.forcefullyCrashRenderer()
    })
    await crashed
    // PLATFORM§18
    await page.waitForEvent('domcontentloaded', { timeout: 30_000 })
    await expect
      .poll(
        () =>
          inRenderer<boolean>(
            app,
            '!!(window.__koloftShortcutsReady && window.__koloftRowsReady)'
          ).catch(() => false),
        { timeout: 30_000 }
      )
      .toBe(true)
    await expect
      .poll(() => inRenderer<string[]>(app, 'Object.keys(window.__koloftTerms ?? {})'), {
        timeout: 30_000
      })
      .toEqual(idsBefore)
    await inRenderer<void>(
      app,
      `window.api.terminal.write(${JSON.stringify(idsBefore[0])}, 'after-crash-marker\\r')`
    )
    await expect
      .poll(
        () =>
          inRenderer<string>(
            app,
            `(() => { const t = (window.__koloftTerms ?? {})[${JSON.stringify(idsBefore[0])}];
             if (!t) return '';
             const b = t.buffer.active; const out = [];
             for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? '');
             return out.join('\\n') })()`
          ),
        { timeout: 30_000 }
      )
      .toContain('handled: after-crash-marker')
    expect(readCalls(env)).toHaveLength(1)
    expect(processAlive(launch.pid)).toBe(true)
  })

  test('T-REL-05: a renderer that crashed past its reload limit is closed for real by the red button, and the Dock opens a new window that brings back the tab the user was on, though that path runs the renderer teardown twice', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    await waitForCalls(env, 1)
    await startSessionIn(page, 'ws-b')
    await waitForCalls(env, 2)
    const rowA = wsRows(page, 'ws-a').first()
    await rowA.click()
    await expect(rowA).toHaveClass(/\bactive\b/)
    const ids = await termIds(page)
    expect(ids).toHaveLength(2)
    const crash = (): Promise<void> =>
      app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.webContents.forcefullyCrashRenderer()
      })
    await app.evaluate(({ BrowserWindow }) => {
      const seen = { crashes: 0, reloads: 0 }
      ;(globalThis as { rendererSeen?: typeof seen }).rendererSeen = seen
      const contents = BrowserWindow.getAllWindows()[0]!.webContents
      contents.on('did-start-navigation', (details) => {
        if (details.isMainFrame && !details.isSameDocument) seen.reloads += 1
      })
      contents.on('render-process-gone', () => {
        seen.crashes += 1
      })
    })
    const rendererSeen = (): Promise<{ crashes: number; reloads: number } | undefined> =>
      app.evaluate(
        () => (globalThis as { rendererSeen?: { crashes: number; reloads: number } }).rendererSeen
      )
    for (const [round, reloads] of [true, true, false].entries()) {
      await crash()
      await expect.poll(async () => (await rendererSeen())?.crashes).toBe(round + 1)
      if (!reloads) {
        expect((await rendererSeen())?.reloads).toBe(round)
        continue
      }
      await expect
        .poll(
          () =>
            inRenderer<boolean>(
              app,
              '!!(window.__koloftShortcutsReady && window.__koloftRowsReady)'
            ).catch(() => false),
          { timeout: 30_000 }
        )
        .toBe(true)
    }

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close())
    await expect
      .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length))
      .toBe(0)
    const opened = app.waitForEvent('window')
    await app.evaluate(({ app }) => app.emit('activate'))
    const reopened = await opened
    await waitBooted(reopened)
    await expect.poll(() => termIds(reopened), { timeout: 30_000 }).toEqual(ids)
    await expect(wsRows(reopened, 'ws-a').first()).toHaveClass(/\bactive\b/, { timeout: 30_000 })
    await expect(wsRows(reopened, 'ws-b').first()).not.toHaveClass(/\bactive\b/)
    expect(readCalls(env)).toHaveLength(2)
  })

  test('T-REL-06: a reload keeps a sleeping tab asleep — its row stays running, nothing restarts, and clicking it wakes the same session', async ({
    env
  }) => {
    test.setTimeout(180_000)
    env.launchEnv.KOLOFT_IDLE_MS = String(WAITING_TO_IDLE_MS)
    env.launchEnv.KOLOFT_IDLE_CLOSE_MS = String(IDLE_TO_SLEEP_MS)
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await waitBooted(page)
      await startSessionIn(page, 'ws-a')
      await startSessionIn(page, 'ws-b')
      const [a] = await waitForCalls(env, 2)
      const rowA = wsRows(page, 'ws-a').first()
      await expect.poll(() => pendingAttention(page), { timeout: 25_000 }).toHaveLength(2)
      await rowA.click()
      await wsRows(page, 'ws-b').first().click()
      await expect.poll(() => processAlive(a.pid), { timeout: 40_000 }).toBe(false)
      const asleepTab = await rowA.getAttribute('data-tab-id')

      await page.reload()
      await waitBooted(page)
      await expect.poll(() => termIds(page), { timeout: 30_000 }).toContain(asleepTab)
      await expect(rowA).toHaveClass(/\bst-idle\b/)
      await page.waitForTimeout(ROOM_FOR_A_WRONG_RESTART_MS)
      expect(readCalls(env)).toHaveLength(2)

      await rowA.click()
      const calls = await waitForCalls(env, 3)
      expect(resumedId(calls[2])).toBe(a.sessionId)
      await expect(rowA).toHaveClass(/\bst-(working|waiting|idle)\b/, { timeout: 30_000 })
    } finally {
      await quitAndClose(app)
    }
  })
})

interface RunningTab {
  tabId: string
  launches: () => number
  holders: () => number[]
  answers: () => Promise<string>
  reply: (line: string) => string
  asleep: () => boolean
  lastLaunchResumesIt: () => boolean
}

interface TabKind {
  agent: AgentName
  remote: boolean
  install: (env: E2EEnv) => void
  start: (page: Page, env: E2EEnv) => Promise<RunningTab>
}

const kindName = (kind: TabKind): string => `${kind.remote ? 'remote' : 'local'} ${kind.agent}`

const tabOf = async (page: Page, ws: string): Promise<string> =>
  (await wsRows(page, ws).first().getAttribute('data-tab-id')) ?? ''

function tmuxClientsHolding(env: E2EEnv, id: string): number[] {
  const record = path.join(stateDir(env), 'alive', tmuxName(id))
  const startedAs = fs.existsSync(record)
    ? (JSON.parse(fs.readFileSync(record, 'utf8')) as { io: string }).io
    : tmuxName(id)
  return [...new Set([...tmuxClientsOf(startedAs), ...tmuxClientsOf(tmuxName(id))])]
}

const codexServersOnTheMachine = (env: E2EEnv): { pid: number; argv: string[] }[] =>
  machineCodexLog<{ pid: number; argv: string[] }>(env, 'fake-codex-server-calls.jsonl').filter(
    (c) => c.argv.includes('--listen')
  )

const machineAgyTranscriptOf = (env: E2EEnv, id: string): string =>
  agyTranscriptOf(env, id, path.join(machineHome(env), '.gemini'))

const tmuxTabGone = (env: E2EEnv, id: string): boolean =>
  killLines(env, id).length === 1 && !liveTmuxSessions(env).includes(tmuxName(id))

const TAB_KINDS: TabKind[] = [
  {
    agent: 'Claude',
    remote: true,
    install: () => {},
    start: async (page, env) => {
      await startSessionIn(page, REMOTE_WS_NAME, { remote: true })
      const [first] = await waitForCalls(env, 1)
      const tabId = await tabOf(page, REMOTE_WS_NAME)
      return {
        tabId,
        launches: () => readCalls(env).length,
        holders: () => [first.pid, ...tmuxClientsHolding(env, first.sessionId)],
        answers: () => terminalText(page, tabId),
        reply: (line) => `handled: ${line}`,
        asleep: () => tmuxTabGone(env, first.sessionId),
        lastLaunchResumesIt: () => resumedId(readCalls(env).at(-1)!) === first.sessionId
      }
    }
  },
  {
    agent: 'Codex',
    remote: true,
    install: installCodexOnFakeRemote,
    start: async (page, env) => {
      await newSessionInWith(page, REMOTE_WS_NAME, 'Codex')
      await expect
        .poll(() => codexServersOnTheMachine(env).length, { timeout: ON_THE_MACHINE_WITHIN_MS })
        .toBe(1)
      await expect(
        wsRows(page, REMOTE_WS_NAME).filter({ hasText: 'Codex fixture session' })
      ).toHaveClass(/st-waiting/, { timeout: ON_THE_MACHINE_WITHIN_MS })
      const server = codexServersOnTheMachine(env)[0]
      const [tui] = codexCalls(env)
      return {
        tabId: await tabOf(page, REMOTE_WS_NAME),
        launches: () => codexCalls(env).length + codexServersOnTheMachine(env).length,
        holders: () => [tui.pid, server.pid],
        answers: async () =>
          codexAnswers(machineCodexLog<CodexWireLine>(env, 'fake-codex-wire.jsonl')).join('\n'),
        reply: (line) => `Codex fixture answered: ${line}`,
        asleep: () => !processAlive(server.pid),
        lastLaunchResumesIt: () => {
          const last = codexCalls(env).at(-1)!
          return last.method === 'thread/resume' && last.sessionId === tui.sessionId
        }
      }
    }
  },
  {
    agent: 'Muse',
    remote: false,
    install: (env) => {
      installMuse(env)
      trustInMuse(env, env.workspaces.a)
    },
    start: async (page, env) => {
      await newSessionInWith(page, 'ws-a', 'Muse')
      await expect.poll(() => museCalls(env).length).toBe(1)
      await expect(wsRows(page, 'ws-a').first()).toHaveClass(/st-waiting/)
      const [first] = museCalls(env)
      return {
        tabId: await tabOf(page, 'ws-a'),
        launches: () => museCalls(env).length,
        holders: () => [first.pid],
        answers: async () => museSaid(env, first.sessionId).join('\n'),
        reply: (line) => `echo: ${line}`,
        asleep: () => !processAlive(first.pid),
        lastLaunchResumesIt: () => museCalls(env).at(-1)!.sessionId === first.sessionId
      }
    }
  },
  {
    agent: 'Muse',
    remote: true,
    install: (env) => {
      installMuse(env)
      installMuseOnMachine(env)
    },
    start: async (page, env) => {
      await newSessionInWith(page, REMOTE_WS_NAME, 'Muse')
      await expect
        .poll(() => machineMuseCalls(env).length, { timeout: ON_THE_MACHINE_WITHIN_MS })
        .toBe(1)
      const [first] = machineMuseCalls(env)
      await expect
        .poll(() => liveTmuxSessions(env), { timeout: ON_THE_MACHINE_WITHIN_MS })
        .toContain(tmuxName(first.sessionId))
      await expect(wsRows(page, REMOTE_WS_NAME).first()).toHaveClass(/\bst-(waiting|idle)\b/, {
        timeout: ON_THE_MACHINE_WITHIN_MS
      })
      return {
        tabId: await tabOf(page, REMOTE_WS_NAME),
        launches: () => machineMuseCalls(env).length,
        holders: () => [first.pid, ...tmuxClientsHolding(env, first.sessionId)],
        answers: async () => museSaid(env, first.sessionId, machineHome(env)).join('\n'),
        reply: (line) => `echo: ${line}`,
        asleep: () => tmuxTabGone(env, first.sessionId),
        lastLaunchResumesIt: () =>
          machineMuseCalls(env).at(-1)!.argv.slice(-2).join(' ') === `resume ${first.sessionId}`
      }
    }
  },
  {
    agent: 'Antigravity',
    remote: false,
    install: (env) => {
      installAgy(env)
      trustInAgy(env, env.workspaces.a)
    },
    start: async (page, env) => {
      await newSessionInWith(page, 'ws-a', 'Antigravity')
      await expect.poll(() => agySessionCalls(env).length).toBe(1)
      const [first] = agySessionCalls(env)
      await runIn(page, centerTerm(page), 'first words')
      const { tabId, id } = await agyConversationOnceFirstTurnEnded(page)
      return {
        tabId,
        launches: () => agySessionCalls(env).length,
        holders: () => [first.pid],
        answers: async () => agyTranscriptOf(env, id),
        reply: (line) => `Answer to: ${line}`,
        asleep: () => !processAlive(first.pid),
        lastLaunchResumesIt: () =>
          agySessionCalls(env).at(-1)!.argv.includes(`--conversation=${id}`)
      }
    }
  },
  {
    agent: 'Antigravity',
    remote: true,
    install: (env) => {
      installAgy(env)
      installRemoteAgy(env)
    },
    start: async (page, env) => {
      await newSessionInWith(page, REMOTE_WS_NAME, 'Antigravity')
      await agyReady(page)
      await runIn(page, centerTerm(page), 'first words')
      const { tabId, id } = await boundRemoteSession(page, 'agy')
      await expect
        .poll(() => machineAgyTranscriptOf(env, id), { timeout: ON_THE_MACHINE_WITHIN_MS })
        .toContain('Answer to: first words')
      const [first] = machineAgyCalls(env)
      return {
        tabId,
        launches: () => machineAgyCalls(env).length,
        holders: () => [first.pid, ...tmuxClientsHolding(env, id)],
        answers: async () => machineAgyTranscriptOf(env, id),
        reply: (line) => `Answer to: ${line}`,
        asleep: () => tmuxTabGone(env, id),
        lastLaunchResumesIt: () =>
          machineAgyCalls(env).at(-1)!.argv.includes(`--conversation=${id}`)
      }
    }
  }
]

const THE_MOMENT_IT_FALLS_ASLEEP_MS = 20

const RELOAD_MOMENTS = [
  { caseId: 'T-REL-08', when: 'once its old terminal has exited' },
  { caseId: 'T-REL-09', when: 'the moment it falls asleep' }
] as const

const LISTED_TWICE_WHILE_FALLING_ASLEEP = ['remote Muse', 'remote Antigravity']
const LISTED_TWICE_ISSUE =
  'issue #1959: listed both live and asleep while its pty still runs, a reload keeps the live copy and a click no longer wakes it'

async function launchFor(
  kind: TabKind,
  env: E2EEnv
): Promise<{ app: ElectronApplication; page: Page; ws: string }> {
  kind.install(env)
  seedSettings(env, { hintsOff: true })
  if (kind.remote) {
    const { app, page } = await launchWithRemote(env)
    await addRemoteWorkspace(page, env)
    return { app, page, ws: REMOTE_WS_NAME }
  }
  const app = await launchApp(env)
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await waitBooted(page)
  return { app, page, ws: 'ws-a' }
}

test.describe('every other kind of session tab is re-adopted by a reload just as a local Claude Code tab is', () => {
  for (const kind of TAB_KINDS) {
    test(`T-REL-07: a reload re-adopts a ${kindName(kind)} tab — same terminal, the same agent and terminal processes, nothing launched again, and typing reaches the agent`, async ({
      env
    }) => {
      test.setTimeout(240_000)
      const { app, page, ws } = await launchFor(kind, env)
      try {
        const tab = await kind.start(page, env)
        const row = wsRows(page, ws).first()
        const idsBefore = await termIds(page)
        expect(idsBefore).toEqual([tab.tabId])
        const launches = tab.launches()
        const holders = tab.holders()
        expect(holders.length).toBeGreaterThanOrEqual(kind.remote ? 2 : 1)
        expect(holders.every(processAlive)).toBe(true)

        await page.reload()
        await waitBooted(page)
        await expect.poll(() => termIds(page), { timeout: 30_000 }).toEqual(idsBefore)
        await expect(row).not.toHaveClass(/\bcold\b/)
        await switchToRow(page, row)
        await page.waitForTimeout(ROOM_FOR_A_WRONG_FORCE_CLOSE_MODAL_MS)
        await expect(page.locator('.modal')).toHaveCount(0)

        await runIn(page, centerTerm(page), 'after reload')
        await expect
          .poll(tab.answers, { timeout: ON_THE_MACHINE_WITHIN_MS })
          .toContain(tab.reply('after reload'))
        expect(tab.launches()).toBe(launches)
        expect(tab.holders()).toEqual(holders)
        expect(holders.every(processAlive)).toBe(true)
      } finally {
        await quitAndClose(app)
      }
    })

    for (const moment of RELOAD_MOMENTS) {
      test(`${moment.caseId}: a reload ${moment.when} keeps a ${kindName(kind)} tab asleep — its row stays, nothing starts again, and clicking it wakes the same session`, async ({
        env
      }) => {
        test.fixme(
          moment.caseId === 'T-REL-09' &&
            LISTED_TWICE_WHILE_FALLING_ASLEEP.includes(kindName(kind)),
          LISTED_TWICE_ISSUE
        )
        test.setTimeout(300_000)
        env.launchEnv.KOLOFT_IDLE_MS = String(WAITING_TO_IDLE_MS)
        env.launchEnv.KOLOFT_IDLE_CLOSE_MS = String(IDLE_TO_SLEEP_MS)
        const { app, page, ws } = await launchFor(kind, env)
        try {
          const tab = await kind.start(page, env)
          const row = wsRows(page, ws).first()
          await switchToRow(page, row)
          await runIn(page, centerTerm(page), 'before sleep')
          await expect
            .poll(tab.answers, { timeout: ON_THE_MACHINE_WITHIN_MS })
            .toContain(tab.reply('before sleep'))
          const awake = tab.holders()
          await startSessionIn(page, 'ws-b', kind.agent === 'Claude' ? {} : { method: 'Claude' })
          const parked = wsRows(page, 'ws-b').first()
          await expect(parked).toHaveClass(/\bst-(waiting|idle)\b/, { timeout: 30_000 })
          await parked.click()
          await expect
            .poll(tab.asleep, {
              timeout: ON_THE_MACHINE_WITHIN_MS,
              intervals: [THE_MOMENT_IT_FALLS_ASLEEP_MS]
            })
            .toBe(true)
          if (moment.caseId === 'T-REL-08')
            await expect.poll(() => awake.some(processAlive), { timeout: 30_000 }).toBe(false)
          const launches = tab.launches()

          await page.reload()
          await waitBooted(page)
          await expect.poll(() => termIds(page), { timeout: 30_000 }).toContain(tab.tabId)
          await expect(row).toHaveClass(/\bst-idle\b/, { timeout: 30_000 })
          await expect(row).not.toHaveClass(/\bcold\b/)
          await page.waitForTimeout(ROOM_FOR_A_WRONG_RESTART_MS)
          expect(tab.launches()).toBe(launches)
          expect(tab.asleep()).toBe(true)

          await row.click()
          await expect
            .poll(tab.launches, { timeout: ON_THE_MACHINE_WITHIN_MS })
            .toBeGreaterThan(launches)
          await expect
            .poll(tab.lastLaunchResumesIt, { timeout: ON_THE_MACHINE_WITHIN_MS })
            .toBe(true)
          await expect(row).toHaveClass(/\bst-(working|waiting|idle)\b/, { timeout: 30_000 })
        } finally {
          await quitAndClose(app)
        }
      })
    }
  }
})
