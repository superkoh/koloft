import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import type { Locator, Page } from '@playwright/test'
import { test, expect, launchApp, pretendWindowFocused, quitAndClose } from './helpers/app'
import {
  addRemoteWorkspace,
  breakConnection,
  dropTabLinkWhileItsSessionLives,
  healConnection,
  killFakeRemote,
  launchWithRemote,
  liveTmuxSessions,
  machineAgyCalls,
  machineCodexLog,
  machineHome,
  machineMuseCalls,
  OTHER_AGENTS_ON_THE_MACHINE,
  REMOTE_WS_NAME,
  remoteDir,
  sshCommands,
  tmuxClientsOf
} from './helpers/remote'
import {
  type AgentName,
  type ClaudeCall,
  boundSessionId,
  centerTerm,
  continuedInOf,
  killSession,
  listeningPortsOf,
  newSessionInWith,
  processAlive,
  readCalls,
  runIn,
  sessionInRow,
  startSessionIn,
  switchToRow,
  terminalText,
  transcriptFile,
  waitBooted,
  waitForCalls,
  wsRows
} from './helpers/p1'
import { seedSettings, type E2EEnv } from './helpers/env'
import { codexCalls } from './helpers/codex'
import { portFreeOnTheMac } from './helpers/fixtureServer'

const LAYOUT_SAVE_DEBOUNCE_SETTLE_MS = 3000
const SEVERAL_FAILED_2S_HEARTBEATS_MS = 8000
const IDLE_20S_HEARTBEAT_ROUND_TIMEOUT_MS = 60_000
const TMUX_ATTACH_SETTLE_MS = 2000
const TURN_LONGER_THAN_ONE_MIRROR_PULL = '/busy'
const WAITING_TO_IDLE_MS = 1000
const IDLE_TO_SLEEP_MS = 3000
const ONE_SLEEP_WINDOW_AND_A_STOP_THERE_MS = 5000

test.afterEach(({ env }) => killFakeRemote(env))

function layoutMembers(env: E2EEnv): string[] {
  const file = path.join(env.userData, 'layout.json')
  const layout = JSON.parse(fs.readFileSync(file, 'utf8')) as { members: string[] }
  return layout.members
}

const A_REPLY_OUTLASTING_SEVERAL_MIRROR_PULLS_MS = '15000'

function codexServersAliveThere(env: E2EEnv): string[] {
  const processes = execFileSync('ps', ['-eo', 'command='], { encoding: 'utf8' }).split('\n')
  const tabIds = machineCodexLog<{ argv: string[]; tabId: string | null }>(
    env,
    'fake-codex-server-calls.jsonl'
  )
    .filter((c) => c.argv.includes('--listen') && c.tabId)
    .map((c) => c.tabId!)
  return [...new Set(tabIds)].filter((tabId) =>
    processes.some(
      (line) => line.includes('--listen') && line.includes(machineHome(env)) && line.includes(tabId)
    )
  )
}

const attachesThere = (env: E2EEnv): number =>
  sshCommands(env).filter((c) => /tabs\/[^"]+\.sh"?\s+attach/.test(c)).length

const busyTurn = (_env: E2EEnv, page: Page): Promise<void> =>
  runIn(page, centerTerm(page), TURN_LONGER_THAN_ONE_MIRROR_PULL)

const turnWithAReplyDelayedBy =
  (delayFile: string) =>
  async (env: E2EEnv, page: Page): Promise<void> => {
    fs.writeFileSync(
      path.join(machineHome(env), delayFile),
      A_REPLY_OUTLASTING_SEVERAL_MIRROR_PULLS_MS
    )
    await runIn(page, centerTerm(page), 'a longer turn')
  }

async function boundInTheRemoteRow(page: Page): Promise<string> {
  let id: string | undefined
  await expect
    .poll(async () => (id = await sessionInRow(page, wsRows(page, REMOTE_WS_NAME).first())), {
      timeout: 60_000
    })
    .toBeTruthy()
  return id!
}

const ON_THE_MACHINE: Record<
  AgentName,
  {
    longTurn: (env: E2EEnv, page: Page) => Promise<void>
    launches: (env: E2EEnv) => number
    launchesARestartAdds: number
    runningThere: (env: E2EEnv) => string[]
    afterARestart: string
  }
> = {
  Claude: {
    longTurn: busyTurn,
    launches: (env) => readCalls(env).length,
    launchesARestartAdds: 0,
    runningThere: liveTmuxSessions,
    afterARestart: 'attached to the same claude there, never a second one'
  },
  Codex: {
    longTurn: busyTurn,
    launches: (env) => codexCalls(env).length,
    launchesARestartAdds: 1,
    runningThere: codexServersAliveThere,
    afterARestart: 'its thread resumed on one new app-server there, as the idle one ended at quit'
  },
  Muse: {
    longTurn: turnWithAReplyDelayedBy('fake-muse-delay'),
    launches: (env) => machineMuseCalls(env).length,
    launchesARestartAdds: 0,
    runningThere: liveTmuxSessions,
    afterARestart: 'attached to the same muse there, never a second one'
  },
  Antigravity: {
    longTurn: turnWithAReplyDelayedBy('fake-agy-delay'),
    launches: (env) => machineAgyCalls(env).length,
    launchesARestartAdds: 0,
    runningThere: liveTmuxSessions,
    afterARestart: 'attached to the same agy there, never a second one'
  }
}

const RUNS_A_COMMAND_IN_ITS_SESSION: Partial<Record<AgentName, (command: string) => string>> = {
  Claude: (command) => `/sh ${command}`,
  Codex: (command) => `/sh ${command}`,
  Muse: (command) => `/sh ${command}`,
  Antigravity: (command) => `!${command}`
}

const EVERY_AGENT_ON_THE_MACHINE: {
  label: AgentName
  install?: (env: E2EEnv) => void
  bound?: (page: Page) => Promise<unknown>
}[] = [{ label: 'Claude' }, ...OTHER_AGENTS_ON_THE_MACHINE]

async function startOnTheMachine(
  page: Page,
  agent: (typeof EVERY_AGENT_ON_THE_MACHINE)[number]
): Promise<string> {
  if (agent.label === 'Claude') {
    await startSessionIn(page, REMOTE_WS_NAME, { remote: true })
  } else {
    await newSessionInWith(page, REMOTE_WS_NAME, agent.label)
    await agent.bound?.(page)
  }
  await expect(wsRows(page, REMOTE_WS_NAME).first()).toHaveClass(/\bst-waiting\b/, {
    timeout: 60_000
  })
  return boundInTheRemoteRow(page)
}

async function untilItCameBackOnTheMachine(
  env: E2EEnv,
  agent: AgentName,
  launchesBeforeQuit: number
): Promise<void> {
  const there = ON_THE_MACHINE[agent]
  if (there.launchesARestartAdds)
    await expect
      .poll(() => there.launches(env), { timeout: 60_000 })
      .toBe(launchesBeforeQuit + there.launchesARestartAdds)
  else await expect.poll(() => attachesThere(env), { timeout: 60_000 }).toBeGreaterThanOrEqual(1)
}

const remoteTabIds = (page: Page): Promise<string[]> =>
  wsRows(page, REMOTE_WS_NAME).evaluateAll((rows) =>
    rows.map((r) => r.getAttribute('data-tab-id') ?? '')
  )

const tabRow = (page: Page, tabId: string): Locator =>
  page.locator(`.ws .ws-tab[data-tab-id="${tabId}"]`)

async function startOneMoreOnTheMachine(
  page: Page,
  agent: (typeof EVERY_AGENT_ON_THE_MACHINE)[number]
): Promise<string> {
  const before = await remoteTabIds(page)
  if (agent.label === 'Claude') await startSessionIn(page, REMOTE_WS_NAME, { remote: true })
  else await newSessionInWith(page, REMOTE_WS_NAME, agent.label)
  await expect(wsRows(page, REMOTE_WS_NAME)).toHaveCount(before.length + 1, { timeout: 60_000 })
  const tabId = (await remoteTabIds(page)).find((id) => !before.includes(id))!
  if (agent.label === 'Antigravity') {
    await expect
      .poll(() => terminalText(page, tabId), { timeout: 90_000 })
      .toContain('Antigravity CLI')
    await switchToRow(page, tabRow(page, tabId))
    await runIn(page, centerTerm(page), 'first words')
  }
  await expect.poll(() => boundSessionId(page, tabId), { timeout: 60_000 }).toBeTruthy()
  await expect(tabRow(page, tabId)).toHaveClass(/\bst-(waiting|idle)\b/, { timeout: 60_000 })
  return tabId
}

test.describe('losing and regaining the machine: Koloft never invents an ending for a remote session', () => {
  test('E-RW-07: heartbeats failing does not cool a remote row or close its tab', async ({
    env
  }) => {
    test.setTimeout(240_000)
    const { app, page } = await launchWithRemote(env)
    try {
      await addRemoteWorkspace(page, env)
      await startSessionIn(page, REMOTE_WS_NAME, { remote: true })
      const [first] = await waitForCalls(env, 1)
      const row = wsRows(page, REMOTE_WS_NAME).first()

      breakConnection(env)
      await page.waitForTimeout(SEVERAL_FAILED_2S_HEARTBEATS_MS)

      await expect(row).not.toHaveClass(/\bcold\b/)
      await expect(centerTerm(page)).toBeVisible()
      expect(processAlive(first.pid)).toBe(true)

      healConnection(env)
      await page.waitForTimeout(6000)
      await expect(row).not.toHaveClass(/\bcold\b/)
      expect(liveTmuxSessions(env)).toContain(`k-${first.sessionId}`)
    } finally {
      await quitAndClose(app)
    }
  })

  test('E-RW-08: after a Koloft restart the remote session that was open is attached again by itself — the same claude, never a second one — and its hooks still reach the attached tab', async ({
    env
  }) => {
    test.setTimeout(300_000)
    const { app, page } = await launchWithRemote(env)
    let first!: ClaudeCall
    try {
      await addRemoteWorkspace(page, env)
      await startSessionIn(page, REMOTE_WS_NAME, { remote: true })
      ;[first] = await waitForCalls(env, 1)
      await page.waitForTimeout(LAYOUT_SAVE_DEBOUNCE_SETTLE_MS)
    } finally {
      await quitAndClose(app)
    }

    expect(processAlive(first.pid)).toBe(true)
    expect(liveTmuxSessions(env)).toContain(`k-${first.sessionId}`)

    const app2 = await launchApp(env)
    try {
      const page2 = await app2.firstWindow()
      await page2.waitForLoadState('domcontentloaded')
      await waitBooted(page2)

      const row = wsRows(page2, REMOTE_WS_NAME).first()
      await expect(row).toBeVisible({ timeout: 30_000 })
      await expect(row).not.toHaveClass(/\bcold\b/, {
        timeout: IDLE_20S_HEARTBEAT_ROUND_TIMEOUT_MS
      })

      await expect
        .poll(() => sshCommands(env).filter((c) => /tabs\/[^"]+\.sh"?\s+attach/.test(c)).length, {
          timeout: 60_000
        })
        .toBeGreaterThanOrEqual(1)
      await expect(row).toHaveClass(/\bactive\b/, { timeout: 30_000 })
      await expect(centerTerm(page2)).toBeVisible({ timeout: 30_000 })
      expect(processAlive(first.pid)).toBe(true)
      await page2.waitForTimeout(TMUX_ATTACH_SETTLE_MS)
      const starts = sshCommands(env).filter((c) => /tabs\/[^"]+\.sh"?\s+start/.test(c))
      expect(starts).toHaveLength(1)

      await runIn(page2, centerTerm(page2), TURN_LONGER_THAN_ONE_MIRROR_PULL)
      await expect(row).toHaveClass(/\bst-working\b/, { timeout: 60_000 })
      await expect(row).toHaveClass(/\bst-waiting\b/, { timeout: 90_000 })
    } finally {
      await quitAndClose(app2)
    }
  })

  test('E-RW-38: a remote conversation Claude Code moved to a new session id is attached again after a Koloft restart — the same claude and tmux session, never a second --resume beside it', async ({
    env
  }) => {
    test.setTimeout(300_000)
    const { app, page } = await launchWithRemote(env)
    let first!: ClaudeCall
    let moved: string | undefined
    try {
      await addRemoteWorkspace(page, env)
      await startSessionIn(page, REMOTE_WS_NAME, { remote: true })
      ;[first] = await waitForCalls(env, 1)
      const row = wsRows(page, REMOTE_WS_NAME).first()
      const tabId = await row.getAttribute('data-tab-id')
      const boundOf = (): Promise<string | undefined> => boundSessionId(page, tabId)
      await expect.poll(boundOf, { timeout: 60_000 }).toBe(first.sessionId)
      const beforeTranscript = transcriptFile(machineHome(env), remoteDir(env), first.sessionId)

      await runIn(page, centerTerm(page), '/move-to-background')
      await expect.poll(() => continuedInOf(beforeTranscript), { timeout: 30_000 }).toBeTruthy()
      moved = continuedInOf(beforeTranscript)
      await expect.poll(boundOf, { timeout: 60_000 }).toBe(moved)
      await expect.poll(() => layoutMembers(env), { timeout: 30_000 }).toEqual([moved])
      await expect(row).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })
      await expect.poll(() => liveTmuxSessions(env), { timeout: 30_000 }).toEqual([`k-${moved}`])
      await page.waitForTimeout(LAYOUT_SAVE_DEBOUNCE_SETTLE_MS)
    } finally {
      await quitAndClose(app)
    }

    expect(processAlive(first.pid)).toBe(true)

    const app2 = await launchApp(env)
    try {
      const page2 = await app2.firstWindow()
      await page2.waitForLoadState('domcontentloaded')
      await waitBooted(page2)

      const row = wsRows(page2, REMOTE_WS_NAME).first()
      await expect(row).toBeVisible({ timeout: 30_000 })
      await expect(row).not.toHaveClass(/\bcold\b/, {
        timeout: IDLE_20S_HEARTBEAT_ROUND_TIMEOUT_MS
      })
      await expect
        .poll(
          () => sshCommands(env).filter((c) => /tabs\/[^"]+\.sh"?\s+(attach|start)/.test(c)).length,
          { timeout: 60_000 }
        )
        .toBeGreaterThanOrEqual(2)
      await page2.waitForTimeout(TMUX_ATTACH_SETTLE_MS)

      expect(sshCommands(env).filter((c) => /tabs\/[^"]+\.sh"?\s+start/.test(c))).toHaveLength(1)
      expect(readCalls(env).map((c) => c.sessionId)).toEqual([first.sessionId])
      expect(liveTmuxSessions(env)).toEqual([`k-${moved}`])
      expect(processAlive(first.pid)).toBe(true)
    } finally {
      await quitAndClose(app2)
    }
  })

  test('E-RW-39: when the link of a remote tab whose conversation Claude Code moved to a new session id drops, the tab reconnects to that tmux session and the same claude', async ({
    env
  }) => {
    test.setTimeout(240_000)
    const { app, page } = await launchWithRemote(env)
    try {
      await addRemoteWorkspace(page, env)
      await startSessionIn(page, REMOTE_WS_NAME, { remote: true })
      const [first] = await waitForCalls(env, 1)
      const row = wsRows(page, REMOTE_WS_NAME).first()
      const tabId = await row.getAttribute('data-tab-id')
      await expect
        .poll(() => boundSessionId(page, tabId), { timeout: 60_000 })
        .toBe(first.sessionId)
      const beforeTranscript = transcriptFile(machineHome(env), remoteDir(env), first.sessionId)

      await runIn(page, centerTerm(page), '/move-to-background')
      await expect.poll(() => continuedInOf(beforeTranscript), { timeout: 30_000 }).toBeTruthy()
      const moved = `k-${continuedInOf(beforeTranscript)}`
      await expect.poll(() => liveTmuxSessions(env), { timeout: 30_000 }).toEqual([moved])

      dropTabLinkWhileItsSessionLives(env, `k-${first.sessionId}`)
      await expect.poll(() => tmuxClientsOf(moved), { timeout: 30_000 }).toHaveLength(1)
      await page.waitForTimeout(TMUX_ATTACH_SETTLE_MS)
      expect(tmuxClientsOf(moved)).toHaveLength(1)
      await expect(row).not.toHaveClass(/\bcold\b/)
      expect(processAlive(first.pid)).toBe(true)
      expect(readCalls(env)).toHaveLength(1)
    } finally {
      await quitAndClose(app)
    }
  })

  for (const agent of EVERY_AGENT_ON_THE_MACHINE) {
    const there = ON_THE_MACHINE[agent.label]

    test(`a remote ${agent.label} session’s unread red dot survives a Koloft restart, stays when the row is clicked in a focused window, and goes once the session works again`, async ({
      env
    }) => {
      test.setTimeout(300_000)
      agent.install?.(env)
      seedSettings(env, { hintsOff: true })
      const { app, page } = await launchWithRemote(env)
      let id = ''
      let launches = 0
      try {
        await addRemoteWorkspace(page, env)
        id = await startOnTheMachine(page, agent)
        const row = wsRows(page, REMOTE_WS_NAME).first()
        const unread = row.locator('.ws-tab-unread')
        await there.longTurn(env, page)
        await expect(row).toHaveClass(/\bst-working\b/, { timeout: 60_000 })
        await expect(unread).toHaveCount(0)
        await expect(row).toHaveClass(/\bst-waiting\b/, { timeout: 90_000 })
        await expect(unread).toHaveCount(1)
        launches = there.launches(env)
      } finally {
        await quitAndClose(app)
      }

      const app2 = await launchApp(env)
      try {
        const page2 = await app2.firstWindow()
        await page2.waitForLoadState('domcontentloaded')
        await waitBooted(page2)
        const row = wsRows(page2, REMOTE_WS_NAME).first()
        await untilItCameBackOnTheMachine(env, agent.label, launches)
        await expect(row).toHaveClass(/\bst-(waiting|idle)\b/, {
          timeout: IDLE_20S_HEARTBEAT_ROUND_TIMEOUT_MS
        })
        expect(await boundInTheRemoteRow(page2)).toBe(id)
        await expect(row.locator('.ws-tab-unread')).toHaveCount(1)

        await pretendWindowFocused(app2)
        await switchToRow(page2, row)
        await expect(row.locator('.ws-tab-unread')).toHaveCount(1)
        await there.longTurn(env, page2)
        await expect(row.locator('.ws-tab-unread')).toHaveCount(0, { timeout: 60_000 })
      } finally {
        await quitAndClose(app2)
      }
    })

    test(`a remote ${agent.label} session marked Keep running comes back by itself after a Koloft restart on the same conversation, ${there.afterARestart}`, async ({
      env
    }) => {
      test.setTimeout(300_000)
      agent.install?.(env)
      seedSettings(env, { hintsOff: true })
      const { app, page } = await launchWithRemote(env)
      let id = ''
      let launches = 0
      try {
        await addRemoteWorkspace(page, env)
        id = await startOnTheMachine(page, agent)
        const row = wsRows(page, REMOTE_WS_NAME).first()
        await row.click({ button: 'right' })
        await page.locator('.menu .mi', { hasText: 'Keep running' }).click()
        await expect(row.locator('.ws-tab-resident')).toBeVisible()
        launches = there.launches(env)
        await page.waitForTimeout(LAYOUT_SAVE_DEBOUNCE_SETTLE_MS)
      } finally {
        await quitAndClose(app)
      }

      const app2 = await launchApp(env)
      try {
        const page2 = await app2.firstWindow()
        await page2.waitForLoadState('domcontentloaded')
        await waitBooted(page2)

        const row = wsRows(page2, REMOTE_WS_NAME).first()
        await untilItCameBackOnTheMachine(env, agent.label, launches)
        await expect(row).toHaveClass(/\bst-(working|waiting|idle)\b/, {
          timeout: IDLE_20S_HEARTBEAT_ROUND_TIMEOUT_MS
        })
        await expect(row.locator('.ws-tab-resident')).toBeVisible()
        expect(await boundInTheRemoteRow(page2)).toBe(id)
        await expect.poll(() => there.runningThere(env), { timeout: 30_000 }).toHaveLength(1)
        await page2.waitForTimeout(TMUX_ATTACH_SETTLE_MS)
        expect(there.launches(env)).toBe(launches + there.launchesARestartAdds)
        expect(there.runningThere(env)).toHaveLength(1)
      } finally {
        await quitAndClose(app2)
      }
    })

    test(`a remote ${agent.label} session marked Keep running never goes to sleep for being idle — it keeps running on the machine, never stopped and started again — while an ordinary one beside it does`, async ({
      env
    }) => {
      test.setTimeout(300_000)
      env.launchEnv.KOLOFT_IDLE_MS = String(WAITING_TO_IDLE_MS)
      env.launchEnv.KOLOFT_IDLE_CLOSE_MS = String(IDLE_TO_SLEEP_MS)
      agent.install?.(env)
      seedSettings(env, { hintsOff: true })
      const { app, page } = await launchWithRemote(env)
      try {
        await addRemoteWorkspace(page, env)
        const resident = tabRow(page, await startOneMoreOnTheMachine(page, agent))
        await resident.click({ button: 'right' })
        await page.locator('.menu .mi', { hasText: 'Keep running' }).click()
        await expect(resident.locator('.ws-tab-resident')).toBeVisible()
        await expect.poll(() => there.runningThere(env), { timeout: 30_000 }).toHaveLength(1)
        const kept = there.runningThere(env)

        const ordinary = tabRow(page, await startOneMoreOnTheMachine(page, agent))
        await expect.poll(() => there.runningThere(env), { timeout: 30_000 }).toHaveLength(2)

        await startSessionIn(page, 'ws-a', agent.install ? { method: 'Claude' } : {})
        const launches = there.launches(env)

        await expect.poll(() => there.runningThere(env), { timeout: 60_000 }).toEqual(kept)
        await expect(ordinary).toHaveClass(/\bst-idle\b/)
        await page.waitForTimeout(ONE_SLEEP_WINDOW_AND_A_STOP_THERE_MS)
        expect(there.runningThere(env)).toEqual(kept)
        expect(there.launches(env)).toBe(launches)
      } finally {
        await quitAndClose(app)
      }
    })
  }

  for (const agent of EVERY_AGENT_ON_THE_MACHINE) {
    const typedToRun = RUNS_A_COMMAND_IN_ITS_SESSION[agent.label]
    if (!typedToRun) continue

    // PLATFORM§67
    test(`after a Koloft restart brings a remote ${agent.label} tab back, its listening ports still list the server the session started before the restart, and one it starts after`, async ({
      env
    }) => {
      test.setTimeout(300_000)
      agent.install?.(env)
      seedSettings(env, { hintsOff: true })
      const [before, after] = [await portFreeOnTheMac(), await portFreeOnTheMac()]
      const pids = path.join(machineHome(env), 'servers.pid')
      let launchesBeforeQuit = 0
      const startServer = (page: Page, port: number): Promise<void> =>
        runIn(
          page,
          centerTerm(page),
          typedToRun(
            `nohup python3 -m http.server ${port} --bind 127.0.0.1 --directory ${machineHome(env)} >/dev/null 2>&1 & echo $! >> ${pids}`
          )
        )
      try {
        const { app, page } = await launchWithRemote(env)
        try {
          await addRemoteWorkspace(page, env)
          await startOnTheMachine(page, agent)
          const [tab] = await remoteTabIds(page)
          await startServer(page, before)
          await expect
            .poll(() => listeningPortsOf(page, tab), { timeout: 60_000 })
            .toEqual([before])
          await page.waitForTimeout(LAYOUT_SAVE_DEBOUNCE_SETTLE_MS)
          launchesBeforeQuit = ON_THE_MACHINE[agent.label].launches(env)
        } finally {
          await quitAndClose(app)
        }

        const app2 = await launchApp(env)
        try {
          const page2 = await app2.firstWindow()
          await waitBooted(page2)
          await untilItCameBackOnTheMachine(env, agent.label, launchesBeforeQuit)
          const row = wsRows(page2, REMOTE_WS_NAME).first()
          await expect(row).toHaveClass(/\bst-(waiting|idle)\b/, {
            timeout: IDLE_20S_HEARTBEAT_ROUND_TIMEOUT_MS
          })
          const [tab] = await remoteTabIds(page2)
          await expect
            .poll(() => listeningPortsOf(page2, tab), { timeout: 60_000 })
            .toEqual([before])
          await switchToRow(page2, row)
          await startServer(page2, after)
          await expect
            .poll(() => listeningPortsOf(page2, tab), { timeout: 60_000 })
            .toEqual([before, after].sort((a, b) => a - b))
        } finally {
          await quitAndClose(app2)
        }
      } finally {
        for (const pid of fs.existsSync(pids) ? fs.readFileSync(pids, 'utf8').split('\n') : [])
          if (pid) killSession(Number(pid), env)
      }
    })
  }

  test('E-RW-16: /exit after an attach drops the row from the working set', async ({ env }) => {
    test.setTimeout(300_000)
    const { app, page } = await launchWithRemote(env)
    let first!: ClaudeCall
    try {
      await addRemoteWorkspace(page, env)
      await startSessionIn(page, REMOTE_WS_NAME, { remote: true })
      ;[first] = await waitForCalls(env, 1)
      await page.waitForTimeout(LAYOUT_SAVE_DEBOUNCE_SETTLE_MS)
    } finally {
      await quitAndClose(app)
    }
    expect(layoutMembers(env)).toContain(first.sessionId)

    const app2 = await launchApp(env)
    try {
      const page2 = await app2.firstWindow()
      await page2.waitForLoadState('domcontentloaded')
      await waitBooted(page2)

      const row = wsRows(page2, REMOTE_WS_NAME).first()
      await expect(row).toBeVisible({ timeout: 30_000 })
      await expect(row).not.toHaveClass(/\bcold\b/, { timeout: 60_000 })
      await row.click()
      await expect
        .poll(() => sshCommands(env).filter((c) => /tabs\/[^"]+\.sh"?\s+attach/.test(c)).length, {
          timeout: 60_000
        })
        .toBeGreaterThanOrEqual(1)
      await expect(centerTerm(page2)).toBeVisible({ timeout: 30_000 })
      await page2.waitForTimeout(TMUX_ATTACH_SETTLE_MS)

      await runIn(page2, centerTerm(page2), '/exit')

      await expect.poll(() => processAlive(first.pid), { timeout: 60_000 }).toBe(false)
      await expect(wsRows(page2, REMOTE_WS_NAME)).toHaveCount(0, { timeout: 60_000 })
      await expect
        .poll(() => layoutMembers(env), { timeout: 30_000 })
        .not.toContain(first.sessionId)
    } finally {
      await quitAndClose(app2)
    }
  })
})
