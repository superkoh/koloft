import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import type { Page } from '@playwright/test'
import { test, expect, quitAndClose } from './helpers/app'
import { portOffset } from '../../src/shared/worktreeName'
import {
  chooseBackend,
  gitCommitAll,
  gitInit,
  menuItemTexts,
  newSessionInWith,
  openMenu,
  openWorktreeSession,
  sendShortcut,
  terminalText,
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
import type { E2EEnv } from './helpers/env'

test.setTimeout(180_000)

const KOLOFT_SHIM_WAITS_UP_TO_10S_PLUS_ROOM_MS = 30_000

interface TuiCall {
  argv: string[]
  cwd: string
  effectiveCwd: string
  sessionId: string
  method: string
}

interface ServerCall {
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

  // ADR-0038 CODEX§16
  test("E-RC-01: a Codex session there starts its own app-server on the machine in Koloft's Codex home, signed in with the Mac account's token that never lands on the machine; it binds in the sidebar, and closing its tab ends that server", async ({
    env
  }) => {
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
      expect(serverAlive(env, server.tabId!)).toBe(true)

      await sendShortcut(app, 'shortcut:close-tab')
      await expect(wsRows(page, REMOTE_WS_NAME)).toHaveClass(/cold/, { timeout: 30_000 })
      await expect.poll(() => serverAlive(env, server.tabId!), { timeout: 30_000 }).toBe(false)
    } finally {
      await quitAndClose(app)
    }
  })

  // ADR-0038 CODEX§16
  test('E-RC-02: a closed remote Codex session resumes from its row on a new server there; koloft inside it answers from this Koloft; and when its ssh line drops, the next prompt still gets its answer', async ({
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

  test('E-RC-03: a Codex worktree session there gets its worktree made on the machine, and its server the port offset of that name', async ({
    env
  }) => {
    installCodexOnFakeRemote(env)
    fs.mkdirSync(remoteDir(env), { recursive: true })
    fs.writeFileSync(path.join(remoteDir(env), 'README.md'), '# proj\n')
    gitInit(remoteDir(env))
    gitCommitAll(remoteDir(env))
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
      await chooseBackend(page, 'other')
      await expect.poll(() => machineServers(env).length, { timeout: 60_000 }).toBe(1)
      const tree = path.join(remoteDir(env), '.claude', 'worktrees', 'rc-tree')
      expect(fs.existsSync(path.join(tree, '.git'))).toBe(true)
      expect(machineServers(env)[0]).toMatchObject({
        cwd: fs.realpathSync(tree),
        portOffset: String(portOffset('rc-tree'))
      })
    } finally {
      await quitAndClose(app)
    }
  })
})
