import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import type { Locator, Page } from '@playwright/test'
import { test, expect, osOutlets, pendingAttention, quitAndClose } from './helpers/app'
import { portOffset } from '../../src/shared/worktreeName'
import { barePath } from '../../src/shared/remoteKey'
import { CODEX_ASKS_AND_WAITS, STATUS_LINE_CONFIG } from '../../src/main/codexLaunchConfig'
import {
  agentRow,
  centerTerm,
  chooseBackend,
  gitInit,
  gitRepoWithAnIncludedEnv,
  INCLUDED_ENV,
  killSession,
  menuItemTexts,
  newSessionInWith,
  openMenu,
  openWorktreeSession,
  processAlive,
  readCalls,
  runIn,
  sendShortcut,
  sendTwoLinesJoinedByShiftEnter,
  settingsOnDisk,
  startSessionIn,
  switchToRow,
  terminalText,
  termIds,
  TWO_LINE_PROMPT,
  worktreeDialog,
  wsRows
} from './helpers/p1'
import {
  addRemoteWorkspace,
  breakConnection,
  installCodexOnFakeRemote,
  killFakeRemote,
  launchWithRemote,
  machineCodexLog,
  machineHome,
  MAC_CODEX_ACCESS_TOKEN,
  remoteDir,
  remoteKey,
  REMOTE_WS_NAME
} from './helpers/remote'
import { E2E_CODEX_ACCOUNT, seedSettings, type E2EEnv } from './helpers/env'
import { codexAnswers, codexPromptsSent, fakeCodexLog, type CodexWireLine } from './helpers/codex'
import { turnOffItsOnlyAccountRestartAndSeeWhy } from './helpers/restartNoAccount'

test.setTimeout(180_000)

const KOLOFT_SHIM_WAITS_UP_TO_10S_PLUS_ROOM_MS = 30_000
const WAITING_TO_IDLE_MS = 1000
const IDLE_TO_SLEEP_MS = 3000
const TURN_OUTLIVES_THE_QUIT_MS = 15_000

interface TuiCall {
  pid: number
  argv: string[]
  cwd: string
  effectiveCwd: string
  sessionId: string
  method: string
}

interface ServerCall {
  pid: number
  argv: string[]
  cwd: string
  codexHome: string
  tabId: string | null
  portOffset: string | null
}

function tuiCalls(env: E2EEnv): TuiCall[] {
  const file = path.join(env.home, 'fake-codex-calls.jsonl')
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TuiCall)
}

function machineServers(env: E2EEnv): ServerCall[] {
  return machineCodexLog<ServerCall>(env, 'fake-codex-server-calls.jsonl').filter((c) =>
    c.argv.includes('--listen')
  )
}

function sideServers(env: E2EEnv): ServerCall[] {
  return machineCodexLog<ServerCall>(env, 'fake-codex-server-calls.jsonl').filter((c) =>
    c.argv.includes('--stdio')
  )
}

function historyListings(env: E2EEnv): number {
  return machineCodexLog<{ direction: string; frame: { method?: string } }>(
    env,
    'fake-codex-wire.jsonl'
  ).filter(({ direction, frame }) => direction === 'client' && frame.method === 'thread/list')
    .length
}

function serverAlive(env: E2EEnv, tabId: string): boolean {
  return execFileSync('ps', ['-eo', 'command='], { encoding: 'utf8' })
    .split('\n')
    .some(
      (line) => line.includes('--listen') && line.includes(machineHome(env)) && line.includes(tabId)
    )
}

async function startRemoteCodex(page: Page, env: E2EEnv): Promise<ServerCall> {
  const before = machineServers(env).length
  await newSessionInWith(page, REMOTE_WS_NAME, 'Codex')
  await expect.poll(() => machineServers(env).length, { timeout: 60_000 }).toBe(before + 1)
  await expect(
    wsRows(page, REMOTE_WS_NAME).filter({ hasText: 'Codex fixture session' })
  ).toHaveClass(/st-waiting/, { timeout: 60_000 })
  return machineServers(env)[before]
}

function proxyLines(env: E2EEnv): number[] {
  return execFileSync('ps', ['-eo', 'pid=,command='], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.includes('app-server proxy') && line.includes(machineHome(env)))
    .map((line) => Number(line.trim().split(/\s+/)[0]))
}

async function liveCodexThreads(page: Page): Promise<string[]> {
  const all = await page.evaluate(() => window.api.sessions.list())
  return all
    .filter((s) => s.backendId === 'codex' && s.alive && s.nativeSessionId)
    .map((s) => s.nativeSessionId!)
    .sort()
}

async function koloftExitsIn(page: Page, tabId: string): Promise<string[]> {
  return [...(await terminalText(page, tabId)).matchAll(/koloft exit=(\d+)/g)].map((m) => m[1])
}

test.describe('Codex on a remote workspace: its app-server runs on the machine, its screen on this Mac, signed in from this Mac', () => {
  test.afterEach(({ env }) => killFakeRemote(env))

  // ADR-0039 ADR-0047 CODEX§16
  test("E-RC-01: a Codex session there starts its own app-server on the machine in Koloft's Codex home, signed in with the Mac account's token that never lands on the machine, with its sandbox open to the network and Koloft's reply-language hook trusted and run there; it binds in the sidebar, and closing its tab ends that server", async ({
    env
  }) => {
    seedSettings(env, { skipPermissions: false })
    installCodexOnFakeRemote(env)
    const { app, page } = await launchWithRemote(env)
    try {
      await addRemoteWorkspace(page, env)
      const server = await startRemoteCodex(page, env)
      expect(server).toMatchObject({
        cwd: fs.realpathSync(remoteDir(env)),
        codexHome: path.join(machineHome(env), '.koloft', 'codex-home')
      })
      expect(server.tabId).toMatch(/^pty-/)
      expect(server.argv).toContain('sandbox_workspace_write.network_access=true')
      expect(machineCodexLog(env, 'fake-codex-logins.jsonl')).toEqual([
        { type: 'chatgptAuthTokens', accessToken: MAC_CODEX_ACCESS_TOKEN, accountId: 'mac-account' }
      ])
      expect(fs.existsSync(path.join(server.codexHome, 'auth.json'))).toBe(false)
      const tui = tuiCalls(env)
      expect(tui).toHaveLength(1)
      expect(tui[0]).toMatchObject({ cwd: remoteDir(env), effectiveCwd: remoteDir(env) })
      expect(tui[0].argv).not.toContain('-s')
      expect(serverAlive(env, server.tabId!)).toBe(true)
      const replyLanguage = machineCodexLog<{ event: string; stdout: string }>(
        env,
        'fake-codex-hook-output.jsonl'
      ).find((h) => h.event === 'UserPromptSubmit')
      expect(replyLanguage?.stdout).toContain(
        "The user's latest message begins: «Codex fixture session"
      )

      await sendShortcut(app, 'shortcut:close-tab')
      await expect(wsRows(page, REMOTE_WS_NAME)).toHaveClass(/cold/, { timeout: 30_000 })
      await expect.poll(() => serverAlive(env, server.tabId!), { timeout: 30_000 }).toBe(false)
    } finally {
      await quitAndClose(app)
    }
  })

  // ADR-0039 CODEX§15 CODEX§16
  test('E-RC-14: a Codex session there whose Mac account is a pasted OpenAI API key signs the machine’s app-server in with that key, which never lands on the machine, and binds in the sidebar', async ({
    env
  }) => {
    installCodexOnFakeRemote(env)
    const key = 'sk-proj-e2e-made-up-key'
    fs.writeFileSync(
      path.join(env.userData, 'codex-homes', E2E_CODEX_ACCOUNT, 'auth.json'),
      JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: key })
    )
    const { app, page } = await launchWithRemote(env)
    try {
      await addRemoteWorkspace(page, env)
      const server = await startRemoteCodex(page, env)
      expect(machineCodexLog(env, 'fake-codex-logins.jsonl')).toEqual([
        { type: 'apiKey', accessToken: null, accountId: null, apiKey: key }
      ])
      expect(fs.existsSync(path.join(server.codexHome, 'auth.json'))).toBe(false)
    } finally {
      await quitAndClose(app)
    }
  })

  // CODEX§2 CODEX§16
  test('E-RC-16: ⇧⏎ in a remote Codex tab starts a new line in the prompt instead of sending it, and ⏎ then sends both lines as one prompt to the app-server on the machine', async ({
    env
  }) => {
    installCodexOnFakeRemote(env)
    const { app, page } = await launchWithRemote(env)
    try {
      await addRemoteWorkspace(page, env)
      await startRemoteCodex(page, env)
      await sendTwoLinesJoinedByShiftEnter(page, centerTerm(page))
      await expect
        .poll(() => codexPromptsSent(machineCodexLog<CodexWireLine>(env, 'fake-codex-wire.jsonl')))
        .toContain(TWO_LINE_PROMPT)
    } finally {
      await quitAndClose(app)
    }
  })

  // CODEX§27
  test("E-RC-11:a file a shell command of a Codex session there made joins that session's written files, read from the machine through the mirror", async ({
    env
  }) => {
    installCodexOnFakeRemote(env)
    const { app, page } = await launchWithRemote(env)
    try {
      gitInit(remoteDir(env))
      await addRemoteWorkspace(page, env)
      await startRemoteCodex(page, env)
      await runIn(page, centerTerm(page), '/sh printf made > shell-made.txt')
      const made = path.join(fs.realpathSync(remoteDir(env)), 'shell-made.txt')
      await expect
        .poll(
          async () => {
            const all = await page.evaluate(() => window.api.sessions.list())
            const codex = all.find((s) => s.backendId === 'codex' && s.alive)
            return codex?.files?.filter((f) => f.access === 'wrote').map((f) => barePath(f.src))
          },
          { timeout: 60_000 }
        )
        .toEqual([made])
    } finally {
      await quitAndClose(app)
    }
  })

  test('E-RC-08: a remote Codex whose screen on this Mac dies before its session starts keeps its tab, row and last screen, and ⇧⌘R starts it again in that tab', async ({
    env
  }) => {
    installCodexOnFakeRemote(env)
    const failOnStart = path.join(env.home, 'fake-codex-exit')
    fs.writeFileSync(failOnStart, '3')
    const { app, page } = await launchWithRemote(env)
    try {
      await addRemoteWorkspace(page, env)
      await newSessionInWith(page, REMOTE_WS_NAME, 'Codex')
      await expect(page.locator('.toast-msg')).toHaveText(
        'Codex closed before the session started (exit code 3)',
        { timeout: 60_000 }
      )
      const row = wsRows(page, REMOTE_WS_NAME)
      await expect(row).toHaveCount(1)
      await expect(row.locator('.ws-tab-sub')).toContainText('exited (code 3)')
      const [tabId] = await termIds(page)
      expect(await terminalText(page, tabId)).toContain('Codex fixture startup failure')

      fs.rmSync(failOnStart)
      const servers = machineServers(env).length
      await sendShortcut(app, 'shortcut:restart-session')
      await expect.poll(() => machineServers(env).length, { timeout: 60_000 }).toBe(servers + 1)
      await expect(row).toHaveCount(1)
      await expect(row).toHaveClass(/st-waiting/, { timeout: 60_000 })
      await expect(row.locator('.ws-tab-sub')).not.toContainText('exited')
      expect(await termIds(page)).toHaveLength(1)
    } finally {
      await quitAndClose(app)
    }
  })

  test('E-RC-10: a remote Codex that koloft session new started from a session on this Mac and whose screen dies before its session starts keeps its row, and ⇧⌘R starts it again in that tab', async ({
    env
  }) => {
    installCodexOnFakeRemote(env)
    seedSettings(env, { hintsOff: true })
    const failOnStart = path.join(env.home, 'fake-codex-exit')
    const { app, page } = await launchWithRemote(env)
    try {
      await addRemoteWorkspace(page, env)
      await startSessionIn(page, 'ws-a', { method: 'Claude' })
      fs.writeFileSync(failOnStart, '3')
      await runIn(
        page,
        centerTerm(page),
        `/koloft session new --backend codex --workspace ${remoteKey(env)} --name kid -- hello`
      )
      const row = wsRows(page, REMOTE_WS_NAME)
      await expect(row.locator('.ws-tab-sub')).toContainText('exited (code 3)', {
        timeout: 60_000
      })

      fs.rmSync(failOnStart)
      const servers = machineServers(env).length
      await switchToRow(page, row)
      await sendShortcut(app, 'shortcut:restart-session')
      await expect.poll(() => machineServers(env).length, { timeout: 60_000 }).toBe(servers + 1)
      await expect(row).toHaveCount(1)
      await expect(row).toHaveClass(/st-waiting/, { timeout: 60_000 })
      await expect(row.locator('.ws-tab-sub')).not.toContainText('exited')
      expect(await termIds(page)).toHaveLength(2)
    } finally {
      await quitAndClose(app)
    }
  })

  test('E-RC-18: /new in a remote Codex tab binds its one row to the new thread on the machine, as /clear does in a remote Claude tab; the old thread waits in Restore session, which resumes it there, and ⇧⌘R on the tab resumes the new thread on the machine', async ({
    env
  }) => {
    test.setTimeout(240_000)
    installCodexOnFakeRemote(env)
    seedSettings(env, { hintsOff: true })
    const nextTitle = (title: string): void =>
      fs.writeFileSync(path.join(machineHome(env), 'fake-codex-next-title'), title)
    const { app, page } = await launchWithRemote(env)
    try {
      await addRemoteWorkspace(page, env)
      const rows = wsRows(page, REMOTE_WS_NAME)
      nextTitle('Before new')
      await newSessionInWith(page, REMOTE_WS_NAME, 'Codex')
      await expect(rows.filter({ hasText: /Before new/ })).toHaveClass(/st-waiting/, {
        timeout: 60_000
      })
      const [before] = tuiCalls(env)
      const [firstServer] = machineServers(env)
      const tabs = await termIds(page)

      nextTitle('After new')
      await runIn(page, centerTerm(page), '/new')
      await expect.poll(() => tuiCalls(env).length, { timeout: 30_000 }).toBe(2)
      const after = tuiCalls(env)[1]
      expect(after.method).toBe('thread/start')
      await expect
        .poll(() => liveCodexThreads(page), { timeout: 30_000 })
        .toEqual([after.sessionId])
      await expect(rows).toHaveText(/After new/)
      await expect(rows).toHaveClass(/\bactive\b/)
      expect(await termIds(page)).toEqual(tabs)
      expect(machineServers(env)).toHaveLength(1)

      const listedBeforeTheDialog = historyListings(env)
      await openMenu(page, page.locator('.ws-head', { hasText: REMOTE_WS_NAME }))
      await page.locator('.menu .mi', { hasText: 'Restore session' }).click()
      const history = page.getByRole('dialog', {
        name: `Restore session · ${REMOTE_WS_NAME}`,
        exact: true
      })
      const entry = (title: RegExp): Locator =>
        history.getByRole('button').filter({ hasText: title })
      await expect(entry(/Before new/)).toHaveCount(1, { timeout: 30_000 })
      await expect
        .poll(() => historyListings(env), { timeout: 30_000 })
        .toBeGreaterThan(listedBeforeTheDialog)
      await expect(entry(/After new/)).toHaveCount(0)
      await entry(/Before new/).click()
      await expect.poll(() => tuiCalls(env).length, { timeout: 60_000 }).toBe(3)
      expect(tuiCalls(env)[2]).toMatchObject({
        method: 'thread/resume',
        sessionId: before.sessionId
      })
      expect(machineServers(env)).toHaveLength(2)
      await expect(rows).toHaveCount(2)

      const renewed = rows.filter({ hasText: /After new/ })
      await switchToRow(page, renewed)
      await sendShortcut(app, 'shortcut:restart-session')
      await expect.poll(() => tuiCalls(env).length, { timeout: 60_000 }).toBe(4)
      expect(tuiCalls(env)[3]).toMatchObject({
        method: 'thread/resume',
        sessionId: after.sessionId
      })
      expect(machineServers(env)).toHaveLength(3)
      await expect.poll(() => serverAlive(env, firstServer.tabId!), { timeout: 30_000 }).toBe(false)
      await expect(rows).toHaveCount(2)
    } finally {
      await quitAndClose(app)
    }
  })

  test('E-RC-19: a remote Codex whose screen on this Mac is killed after its session started keeps its tab saying so, turns its row cold reading “killed (signal 9)”, ends its app-server on the machine and raises the “exited” mark — a red dot on its row and an OS notification — as a local Codex does; ⇧⌘R resumes the same thread on a new server there', async ({
    env
  }) => {
    test.setTimeout(240_000)
    installCodexOnFakeRemote(env)
    const { app, page } = await launchWithRemote(env)
    try {
      await addRemoteWorkspace(page, env)
      const server = await startRemoteCodex(page, env)
      const row = wsRows(page, REMOTE_WS_NAME)
      const [tabId] = await termIds(page)
      const [{ pid, sessionId }] = tuiCalls(env)
      await expect.poll(() => pendingAttention(page), { timeout: 10_000 }).toHaveLength(1)
      expect(serverAlive(env, server.tabId!)).toBe(true)
      expect(processAlive(pid)).toBe(true)

      killSession(pid, env)

      await expect
        .poll(() => terminalText(page, tabId), { timeout: 30_000 })
        .toContain('Codex session ended: killed by signal 9')
      await expect(row).toHaveClass(/\bcold\b/, { timeout: 30_000 })
      await expect(row.locator('.ws-tab-sub')).toContainText('killed (signal 9)')
      await expect
        .poll(async () => (await pendingAttention(page)).map((a) => a.kind), { timeout: 30_000 })
        .toEqual(['exited'])
      await expect(row.locator('.ws-tab-unread')).toHaveCount(1)
      const [exited] = await pendingAttention(page)
      expect((await osOutlets(app)).notifications).toContainEqual({
        title: exited.title,
        body: `session exited unexpectedly · ${REMOTE_WS_NAME}`
      })
      await expect.poll(() => serverAlive(env, server.tabId!), { timeout: 30_000 }).toBe(false)
      expect(await termIds(page)).toEqual([tabId])

      await sendShortcut(app, 'shortcut:restart-session')
      await expect.poll(() => tuiCalls(env).length, { timeout: 60_000 }).toBe(2)
      expect(tuiCalls(env)[1]).toMatchObject({ method: 'thread/resume', sessionId })
      expect(machineServers(env)).toHaveLength(2)
      await expect.poll(() => liveCodexThreads(page), { timeout: 30_000 }).toEqual([sessionId])
      await expect(row).not.toHaveClass(/\bcold\b/)
      expect(await termIds(page)).toHaveLength(1)
    } finally {
      await quitAndClose(app)
    }
  })

  // ADR-0039 CODEX§16
  test("E-RC-02: a closed remote Codex session resumes from its row on a new server there; koloft inside it answers from this Koloft, and Koloft's Codex home there holds the koloft skill; and when its ssh line drops, the next prompt still gets its answer", async ({
    env
  }) => {
    installCodexOnFakeRemote(env)
    const { app, page } = await launchWithRemote(env)
    try {
      await addRemoteWorkspace(page, env)
      const first = await startRemoteCodex(page, env)
      const threadId = tuiCalls(env)[0].sessionId
      await sendShortcut(app, 'shortcut:close-tab')
      await expect(wsRows(page, REMOTE_WS_NAME)).toHaveClass(/cold/, { timeout: 30_000 })

      await wsRows(page, REMOTE_WS_NAME).click()
      await expect.poll(() => machineServers(env).length, { timeout: 60_000 }).toBe(2)
      await expect.poll(() => tuiCalls(env).length, { timeout: 60_000 }).toBe(2)
      const resumed = tuiCalls(env)[1]
      expect(resumed).toMatchObject({ method: 'thread/resume', sessionId: threadId })
      const tabId = machineServers(env)[1].tabId!
      expect(tabId).not.toBe(first.tabId)
      await expect(wsRows(page, REMOTE_WS_NAME)).toHaveClass(/st-waiting|st-idle/, {
        timeout: 30_000
      })

      await page.evaluate(
        ([id, line]) => window.api.terminal.write(id, line),
        [tabId, '/koloft help\r']
      )
      await expect
        .poll(() => koloftExitsIn(page, tabId), {
          timeout: KOLOFT_SHIM_WAITS_UP_TO_10S_PLUS_ROOM_MS
        })
        .toEqual(['0'])
      await expect(wsRows(page, REMOTE_WS_NAME).locator('.ws-tab-act')).toHaveText(
        'Last: Ran koloft help'
      )
      expect(
        fs.readFileSync(
          path.join(machineHome(env), '.koloft', 'codex-home', 'skills', 'koloft', 'SKILL.md'),
          'utf8'
        )
      ).toMatch(/^---\nname: koloft\n/)

      const turnsDone = async (): Promise<number> =>
        (await terminalText(page, tabId)).split('Codex done').length - 1
      const before = await turnsDone()
      const dropped = proxyLines(env)
      expect(dropped).toHaveLength(1)
      process.kill(dropped[0], 'SIGKILL')
      await expect
        .poll(() => proxyLines(env).filter((pid) => pid !== dropped[0]), { timeout: 30_000 })
        .toHaveLength(1)
      await page.evaluate(
        ([id, line]) => window.api.terminal.write(id, line),
        [tabId, 'after the drop\r']
      )
      await expect.poll(turnsDone, { timeout: 60_000 }).toBe(before + 1)
      expect(
        fs.readFileSync(path.join(machineHome(env), 'fake-codex-wire.jsonl'), 'utf8')
      ).toContain('Codex fixture answered: after the drop')
      expect(machineCodexLog(env, 'fake-codex-logins.jsonl')).toHaveLength(3)
    } finally {
      await quitAndClose(app)
    }
  })

  // CODEX§34
  test('E-RC-09: when the Codex screen on this Mac loses its connection mid-turn, it connects again over a new line to the same app-server on the machine, which finishes the turn it was running, and the tab answers the next prompt', async ({
    env
  }) => {
    installCodexOnFakeRemote(env)
    fs.writeFileSync(path.join(env.home, 'fake-codex-reconnects'), '')
    fs.writeFileSync(path.join(machineHome(env), 'fake-codex-busy-ms'), '4000')
    const { app, page } = await launchWithRemote(env)
    try {
      await addRemoteWorkspace(page, env)
      const server = await startRemoteCodex(page, env)
      const tabId = server.tabId!
      const row = wsRows(page, REMOTE_WS_NAME)
      const type = (line: string): Promise<void> => runIn(page, centerTerm(page), line)
      await type('/busy')
      await expect(row).toHaveClass(/st-working/, { timeout: 30_000 })
      await type('/drop')
      await expect
        .poll(() => fakeCodexLog<{ sessionId: string }>(env, 'fake-codex-reconnects.jsonl'))
        .toEqual([expect.objectContaining({ sessionId: tuiCalls(env)[0].sessionId })])
      await expect(row).toHaveClass(/st-waiting/, { timeout: 30_000 })
      await type('after the drop')
      const answers = (): string[] =>
        codexAnswers(machineCodexLog<CodexWireLine>(env, 'fake-codex-wire.jsonl'))
      await expect
        .poll(answers, { timeout: 60_000 })
        .toContain('Codex fixture answered: after the drop')
      expect(answers()).toContain('Codex fixture answered: /busy')
      expect(machineServers(env)).toHaveLength(1)
      expect(serverAlive(env, tabId)).toBe(true)
    } finally {
      await quitAndClose(app)
    }
  })

  // CODEX§11
  test('E-RC-03: a Codex worktree session there gets its worktree made on the machine with the ignored files .worktreeinclude lists copied in there, its server the port offset of that name, with skip permission prompts on, approvals and the sandbox off, and its screen on this Mac the same status line as a local tab, limits left included', async ({
    env
  }) => {
    installCodexOnFakeRemote(env)
    fs.mkdirSync(remoteDir(env), { recursive: true })
    fs.writeFileSync(path.join(remoteDir(env), 'README.md'), '# proj\n')
    gitRepoWithAnIncludedEnv(remoteDir(env))
    const { app, page } = await launchWithRemote(env)
    try {
      await addRemoteWorkspace(page, env)
      await expect
        .poll(
          async () => {
            await openMenu(page, page.locator('.ws-head', { hasText: REMOTE_WS_NAME }))
            const items = await menuItemTexts(page)
            await page.keyboard.press('Escape')
            await expect(page.locator('.menu')).toHaveCount(0)
            return items.join(' | ')
          },
          { timeout: 60_000 }
        )
        .toContain('New worktree session')
      await openWorktreeSession(page, REMOTE_WS_NAME)
      await worktreeDialog(page).locator('input').fill('rc-tree')
      await chooseBackend(page, 'Codex')
      await expect.poll(() => machineServers(env).length, { timeout: 60_000 }).toBe(1)
      const tree = path.join(remoteDir(env), '.claude', 'worktrees', 'rc-tree')
      expect(fs.existsSync(path.join(tree, '.git'))).toBe(true)
      expect(fs.readFileSync(path.join(tree, '.env'), 'utf8')).toBe(INCLUDED_ENV)
      expect(machineServers(env)[0]).toMatchObject({
        cwd: fs.realpathSync(tree),
        portOffset: String(portOffset('rc-tree'))
      })
      await expect.poll(() => tuiCalls(env).length, { timeout: 60_000 }).toBe(1)
      expect(tuiCalls(env)[0].argv.join(' ')).toContain('-a never -s danger-full-access')
      expect(tuiCalls(env)[0].argv).toContain(STATUS_LINE_CONFIG)
    } finally {
      await quitAndClose(app)
    }
  })

  // CODEX§16
  test('E-RC-05: closing a remote Codex tab, restarting its session and closing it again all ask one app-server on the machine, which ends when Koloft quits', async ({
    env
  }) => {
    installCodexOnFakeRemote(env)
    const { app, page } = await launchWithRemote(env)
    try {
      await addRemoteWorkspace(page, env)
      await startRemoteCodex(page, env)
      await sendShortcut(app, 'shortcut:close-tab')
      await expect(wsRows(page, REMOTE_WS_NAME)).toHaveClass(/cold/, { timeout: 30_000 })
      await expect.poll(() => sideServers(env).length, { timeout: 30_000 }).toBe(1)
      await wsRows(page, REMOTE_WS_NAME).click()
      await expect.poll(() => machineServers(env).length, { timeout: 60_000 }).toBe(2)
      await expect(wsRows(page, REMOTE_WS_NAME)).toHaveClass(/st-waiting|st-idle/, {
        timeout: 30_000
      })
      await sendShortcut(app, 'shortcut:restart-session')
      await expect.poll(() => machineServers(env).length, { timeout: 60_000 }).toBe(3)
      await expect(wsRows(page, REMOTE_WS_NAME)).toHaveClass(/st-waiting|st-idle/, {
        timeout: 30_000
      })
      const listedBeforeTheLastClose = historyListings(env)
      await sendShortcut(app, 'shortcut:close-tab')
      await expect(wsRows(page, REMOTE_WS_NAME)).toHaveClass(/cold/, { timeout: 30_000 })
      await expect
        .poll(() => historyListings(env), { timeout: 30_000 })
        .toBeGreaterThan(listedBeforeTheLastClose)
      expect(sideServers(env)).toHaveLength(1)
      expect(processAlive(sideServers(env)[0].pid)).toBe(true)
    } finally {
      await quitAndClose(app)
    }
    const [side] = sideServers(env)
    await expect.poll(() => processAlive(side.pid), { timeout: 10_000 }).toBe(false)
  })

  test('E-RC-17: with no Codex account usable, restarting a remote Codex session says why, keeps its Codex and its app-server on the machine running, and starts no other', async ({
    env
  }) => {
    installCodexOnFakeRemote(env)
    const { app, page } = await launchWithRemote(env)
    try {
      await addRemoteWorkspace(page, env)
      const server = await startRemoteCodex(page, env)
      const row = wsRows(page, REMOTE_WS_NAME).filter({ hasText: 'Codex fixture session' })

      await turnOffItsOnlyAccountRestartAndSeeWhy(app, page, 'codex')
      await expect(row).toHaveClass(/\bst-waiting\b/)
      await expect(row).not.toHaveClass(/\bcold\b/)
      expect(serverAlive(env, server.tabId!)).toBe(true)
      expect(machineServers(env)).toHaveLength(1)
      expect(tuiCalls(env)).toHaveLength(1)
    } finally {
      await quitAndClose(app)
    }
  })

  test('E-RC-15: ⌘W on a remote Codex tab with ssh down closes the tab and says Codex is still running on the machine, where its app-server stays up', async ({
    env
  }) => {
    installCodexOnFakeRemote(env)
    const { app, page } = await launchWithRemote(env)
    try {
      await addRemoteWorkspace(page, env)
      const server = await startRemoteCodex(page, env)
      const [tabId] = await termIds(page)

      breakConnection(env)
      await sendShortcut(app, 'shortcut:close-tab')

      await expect(page.locator('.toast .toast-msg')).toHaveText(
        'Could not stop Codex on devbox: ssh exited with 255. It is still running there.'
      )
      await expect.poll(() => termIds(page), { timeout: 30_000 }).not.toContain(tabId)
      expect(serverAlive(env, server.tabId!)).toBe(true)
    } finally {
      await quitAndClose(app)
    }
  })

  // ADR-0039
  test("E-RC-13: quitting Koloft leaves on the machine only the app-server of a remote Codex tab whose turn is working, which finishes that turn with no screen connected; an idle tab's server ends, and the next Koloft start ends the one left behind", async ({
    env
  }) => {
    installCodexOnFakeRemote(env)
    fs.writeFileSync(
      path.join(machineHome(env), 'fake-codex-busy-ms'),
      String(TURN_OUTLIVES_THE_QUIT_MS)
    )
    const answers = (): string[] =>
      codexAnswers(machineCodexLog<CodexWireLine>(env, 'fake-codex-wire.jsonl'))
    const first = await launchWithRemote(env)
    let idleTab = ''
    let workingTab = ''
    try {
      await addRemoteWorkspace(first.page, env)
      await newSessionInWith(first.page, REMOTE_WS_NAME, 'Codex')
      await expect.poll(() => machineServers(env).length, { timeout: 60_000 }).toBe(1)
      await newSessionInWith(first.page, REMOTE_WS_NAME, 'Codex')
      await expect.poll(() => machineServers(env).length, { timeout: 60_000 }).toBe(2)
      idleTab = machineServers(env)[0].tabId!
      workingTab = machineServers(env)[1].tabId!
      const rows = wsRows(first.page, REMOTE_WS_NAME)
      await expect(rows.and(first.page.locator('.st-waiting'))).toHaveCount(2, {
        timeout: 60_000
      })
      await first.page.evaluate(
        ([id, line]) => window.api.terminal.write(id, line),
        [workingTab, '/busy\r']
      )
      await expect(rows.and(first.page.locator('.st-working'))).toHaveCount(1, {
        timeout: 30_000
      })
    } finally {
      await quitAndClose(first.app)
    }
    await expect.poll(() => serverAlive(env, idleTab), { timeout: 30_000 }).toBe(false)
    await expect
      .poll(answers, { timeout: TURN_OUTLIVES_THE_QUIT_MS + 30_000 })
      .toContain('Codex fixture answered: /busy')
    expect(serverAlive(env, workingTab)).toBe(true)

    const again = await launchWithRemote(env)
    try {
      await expect.poll(() => serverAlive(env, workingTab), { timeout: 60_000 }).toBe(false)
    } finally {
      await quitAndClose(again.app)
    }
  })

  test('E-RC-06: an idle remote Codex session goes to sleep — its app-server on the machine ends while its row, red dot and tab stay — and clicking it wakes the same thread on a new server there', async ({
    env
  }) => {
    test.setTimeout(240_000)
    installCodexOnFakeRemote(env)
    env.launchEnv.KOLOFT_IDLE_MS = String(WAITING_TO_IDLE_MS)
    env.launchEnv.KOLOFT_IDLE_CLOSE_MS = String(IDLE_TO_SLEEP_MS)
    const { app, page } = await launchWithRemote(env)
    try {
      await addRemoteWorkspace(page, env)
      const first = await startRemoteCodex(page, env)
      const threadId = tuiCalls(env)[0].sessionId
      const remoteRow = wsRows(page, REMOTE_WS_NAME).first()
      await startSessionIn(page, 'ws-a', { method: 'Claude' })
      const localRow = wsRows(page, 'ws-a').first()
      await expect(localRow).toHaveClass(/st-waiting|st-idle/, { timeout: 30_000 })
      await localRow.click()
      const asleepTab = await remoteRow.getAttribute('data-tab-id')
      expect(asleepTab).toBe(first.tabId)

      await expect(remoteRow.locator('.ws-tab-unread')).toHaveCount(1)
      await expect.poll(() => serverAlive(env, first.tabId!), { timeout: 60_000 }).toBe(false)
      await expect(remoteRow).toHaveClass(/\bst-idle\b/)
      await expect(remoteRow.locator('.ws-tab-unread')).toHaveCount(1)
      expect(await termIds(page)).toContain(asleepTab)
      expect(tuiCalls(env)).toHaveLength(1)

      await remoteRow.click()
      await expect.poll(() => machineServers(env).length, { timeout: 60_000 }).toBe(2)
      await expect.poll(() => tuiCalls(env).length, { timeout: 60_000 }).toBe(2)
      expect(tuiCalls(env)[1]).toMatchObject({ method: 'thread/resume', sessionId: threadId })
      await expect(remoteRow).not.toHaveAttribute('data-tab-id', asleepTab ?? '', {
        timeout: 30_000
      })
      await expect(remoteRow).toHaveClass(/st-waiting|st-idle/, { timeout: 30_000 })
      await expect.poll(() => termIds(page), { timeout: 30_000 }).not.toContain(asleepTab)
    } finally {
      await quitAndClose(app)
    }
  })

  // CODEX§3 CODEX§25
  test('E-RC-20: Esc on an approval the app-server on the machine asks for takes the remote Codex row off waiting for approval at once, and Esc in the middle of a turn there takes it off working at once', async ({
    env
  }) => {
    installCodexOnFakeRemote(env)
    const { app, page } = await launchWithRemote(env)
    try {
      await addRemoteWorkspace(page, env)
      const { tabId } = await startRemoteCodex(page, env)
      const row = wsRows(page, REMOTE_WS_NAME)
      const interruptions = async (): Promise<number> =>
        (await terminalText(page, tabId!)).split('Conversation interrupted').length - 1

      await runIn(page, centerTerm(page), 'approve')
      await expect(row).toHaveClass(/st-approval/, { timeout: 30_000 })
      await page.keyboard.press('Escape')
      await expect.poll(interruptions, { timeout: 30_000 }).toBe(1)
      await expect(row).toHaveClass(/st-waiting/, { timeout: 30_000 })

      await runIn(page, centerTerm(page), 'hold')
      await expect(row).toHaveClass(/st-working/, { timeout: 30_000 })
      await page.keyboard.press('Escape')
      await expect.poll(interruptions, { timeout: 30_000 }).toBe(2)
      await expect(row).toHaveClass(/st-waiting/, { timeout: 30_000 })
    } finally {
      await quitAndClose(app)
    }
  })

  // CODEX§11 CODEX§16
  test('E-RC-04: with skip permission prompts off, a new Codex session in a folder the machine already trusts starts its screen on this Mac with the machine’s own choice for a trusted folder (ask first, write inside the folder), since that screen cannot see the machine’s trust', async ({
    env
  }) => {
    seedSettings(env, { skipPermissions: false })
    installCodexOnFakeRemote(env)
    fs.mkdirSync(remoteDir(env), { recursive: true })
    const codexHome = path.join(machineHome(env), '.koloft', 'codex-home')
    fs.mkdirSync(codexHome, { recursive: true })
    fs.writeFileSync(
      path.join(codexHome, 'config.toml'),
      `[projects."${fs.realpathSync(remoteDir(env))}"]\ntrust_level = "trusted"\n`
    )
    const { app, page } = await launchWithRemote(env)
    try {
      await addRemoteWorkspace(page, env)
      await startRemoteCodex(page, env)
      expect(tuiCalls(env)[0].argv.join(' ')).toContain('-a on-request -s workspace-write')
    } finally {
      await quitAndClose(app)
    }
  })

  // CODEX§8
  test('E-RC-07: with the built-in status line off, a Codex session there gets no status line from Koloft on its app-server on the machine or its screen on this Mac, so the screen shows the one in the owner’s own config.toml here', async ({
    env
  }) => {
    installCodexOnFakeRemote(env)
    seedSettings(env, { statuslineBuiltin: false })
    const { app, page } = await launchWithRemote(env)
    try {
      await addRemoteWorkspace(page, env)
      const server = await startRemoteCodex(page, env)
      const statusLine = (argv: string[]): string[] =>
        argv.filter((a) => a.startsWith('tui.status_line='))
      expect(tuiCalls(env)).toHaveLength(1)
      expect(statusLine(tuiCalls(env)[0].argv)).toEqual([])
      expect(server.argv).toContain(CODEX_ASKS_AND_WAITS)
      expect(statusLine(server.argv)).toEqual([])
    } finally {
      await quitAndClose(app)
    }
  })

  test('E-RC-12: with Claude switched off in Settings ▸ Sessions, Codex becomes the default and what Koloft Assist runs on, the last method left on cannot be switched off, and the New session menus of this Mac and of the remote workspace offer no Claude and start Codex', async ({
    env
  }) => {
    installCodexOnFakeRemote(env)
    seedSettings(env, { hintsOff: true })
    const { app, page } = await launchWithRemote(env)
    try {
      await addRemoteWorkspace(page, env)
      await sendShortcut(app, 'shortcut:open-settings')
      await page.getByRole('tab', { name: 'Sessions', exact: true }).click()
      const defaultMethod = page.getByRole('button', { name: 'Default session method' })
      const methodSwitch = (name: string): Locator =>
        page.getByRole('switch', { name: `Enable ${name}`, exact: true })
      await expect(defaultMethod).toHaveText('Claude')
      expect(settingsOnDisk(env).assist).toEqual({ on: true, backend: 'claude' })
      await methodSwitch('Claude').uncheck()
      await expect(defaultMethod).toHaveText('Codex')
      await expect.poll(() => settingsOnDisk(env).assist).toEqual({ on: true, backend: 'codex' })
      await methodSwitch('Muse').uncheck()
      await expect(methodSwitch('Codex')).toBeEnabled()
      await methodSwitch('Antigravity').uncheck()
      await expect(methodSwitch('Codex')).toBeChecked()
      await expect(methodSwitch('Codex')).toBeDisabled()
      await expect(methodSwitch('Claude')).toBeEnabled()
      await page.getByRole('tab', { name: 'Assist', exact: true }).click()
      const runsOn = page.getByRole('button', { name: 'Koloft Assist runs on' })
      await expect(runsOn).toHaveText('Codex')
      await runsOn.click()
      await expect(agentRow(page, 'Claude')).toHaveAttribute('aria-disabled', 'true')
      await expect(agentRow(page, 'Claude')).toContainText('Off')
      await page.keyboard.press('Escape')
      await expect(page.getByRole('listbox', { name: 'Agents' })).toHaveCount(0)
      await page.keyboard.press('Escape')
      await expect(page.locator('.set-main')).toHaveCount(0)

      const offeredIn = async (wsName: string): Promise<string[]> => {
        await openMenu(page, page.locator('.ws-head', { hasText: wsName }))
        const items = await menuItemTexts(page)
        await page.keyboard.press('Escape')
        await expect(page.locator('.menu')).toHaveCount(0)
        return items
      }
      const local = (await offeredIn('ws-a')).join(' | ')
      expect(local).toContain('New session')
      expect(local).not.toMatch(/Claude/)
      await expect
        .poll(async () => (await offeredIn(REMOTE_WS_NAME)).join(' | '), { timeout: 60_000 })
        .toContain('New session')
      expect((await offeredIn(REMOTE_WS_NAME)).join(' | ')).not.toMatch(/Claude/)

      await openMenu(page, page.locator('.ws-head', { hasText: 'ws-a' }))
      await page.locator('.menu .mi', { hasText: 'New session' }).click()
      await expect.poll(() => tuiCalls(env).length, { timeout: 60_000 }).toBe(1)
      expect(tuiCalls(env)[0].cwd).toBe(env.workspaces.a)
      await openMenu(page, page.locator('.ws-head', { hasText: REMOTE_WS_NAME }))
      await page.locator('.menu .mi', { hasText: 'New session' }).click()
      await expect.poll(() => machineServers(env).length, { timeout: 60_000 }).toBe(1)
      await expect.poll(() => tuiCalls(env).length, { timeout: 60_000 }).toBe(2)
      expect(readCalls(env)).toEqual([])
    } finally {
      await quitAndClose(app)
    }
  })
})
