import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import type { Page } from '@playwright/test'
import { test, expect, quitAndClose } from './helpers/app'
import { portOffset } from '../../src/shared/worktreeName'
import { CODEX_ASKS_AND_WAITS, STATUS_LINE_CONFIG } from '../../src/main/codexLaunchConfig'
import {
  centerTerm,
  chooseBackend,
  gitRepoWithAnIncludedEnv,
  INCLUDED_ENV,
  menuItemTexts,
  newSessionInWith,
  openMenu,
  openWorktreeSession,
  processAlive,
  runIn,
  sendShortcut,
  startSessionIn,
  terminalText,
  termIds,
  worktreeDialog,
  wsRows
} from './helpers/p1'
import {
  addRemoteWorkspace,
  installCodexOnFakeRemote,
  killFakeRemote,
  launchWithRemote,
  machineCodexLog,
  machineHome,
  MAC_CODEX_ACCESS_TOKEN,
  remoteDir,
  REMOTE_WS_NAME
} from './helpers/remote'
import { seedSettings, type E2EEnv } from './helpers/env'
import { codexAnswers, fakeCodexLog, type CodexWireLine } from './helpers/codex'

test.setTimeout(180_000)

const KOLOFT_SHIM_WAITS_UP_TO_10S_PLUS_ROOM_MS = 30_000
const WAITING_TO_IDLE_MS = 1000
const IDLE_TO_SLEEP_MS = 3000

interface TuiCall {
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

async function koloftExitsIn(page: Page, tabId: string): Promise<string[]> {
  return [...(await terminalText(page, tabId)).matchAll(/koloft exit=(\d+)/g)].map((m) => m[1])
}

test.describe('Codex on a remote workspace: its app-server runs on the machine, its screen on this Mac, signed in from this Mac', () => {
  test.afterEach(({ env }) => killFakeRemote(env))

  // ADR-0039 CODEX§16
  test("E-RC-01: a Codex session there starts its own app-server on the machine in Koloft's Codex home, signed in with the Mac account's token that never lands on the machine, with Koloft's reply-language hook trusted and run there; it binds in the sidebar, and closing its tab ends that server", async ({
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
  test('E-RC-08: when the Codex screen on this Mac loses its connection mid-turn, it connects again to the same app-server on the machine: the turn it was running still ends in the tab, which answers the next prompt', async ({
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
      expect(await termIds(page)).not.toContain(asleepTab)
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
})
