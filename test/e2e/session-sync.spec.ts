import fs from 'fs'
import path from 'path'
import type { Page } from '@playwright/test'
import { test, expect, launchApp, pendingAttention, quitAndClose } from './helpers/app'
import {
  installAgy,
  installCodex,
  installMuse,
  seedSettings,
  trustInAgy,
  trustInMuse,
  type E2EEnv
} from './helpers/env'
import { runGit } from './helpers/gitFixture'
import {
  centerTerm,
  newSessionInWith,
  runIn,
  startSessionIn,
  terminalText,
  termIds,
  waitBooted,
  wsRows
} from './helpers/p1'
import { startCodex } from './helpers/codex'
import {
  REMOTE_WS_NAME,
  addRemoteWorkspace,
  installCodexOnFakeRemote,
  installMuseOnMachine,
  installRemoteAgy,
  killFakeRemote,
  launchWithRemote,
  machineHome,
  remoteDir,
  remoteKey
} from './helpers/remote'
import type { AttentionEvent, BackendId } from '../../src/shared/types'

const NOTICE_ARRIVES_WITHIN_MS = 30_000
const REMOTE_NOTICE_ARRIVES_WITHIN_MS = 60_000
const LOCAL_SESSION_BINDS_WITHIN_MS = 30_000
const REMOTE_SESSION_BINDS_WITHIN_MS = 90_000
const told =
  /\(From Koloft:\) origin\/main moved from \w{7} to \w{7}, with 1 new commit: "fix: login keeps the session"\./
const toldSameFile =
  /changed files you changed too: shared\.txt\. It works in your folder, so read them again before you edit them\./

type Heard = (home: string) => string

function checkoutWithOrigin(ws: string, home: string): string {
  const origin = path.join(home, 'sync-origin.git')
  const author = path.join(home, 'sync-author')
  fs.mkdirSync(ws, { recursive: true })
  fs.mkdirSync(origin, { recursive: true })
  runGit(home, 'init', '--bare', '-q', origin)
  runGit(ws, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(ws, '.gitignore'), 'NOTES.md\n')
  runGit(ws, 'add', '-A')
  runGit(ws, 'commit', '-q', '-m', 'init')
  runGit(ws, 'remote', 'add', 'origin', `file://${origin}`)
  runGit(ws, 'push', '-q', '-u', 'origin', 'main')
  runGit(home, 'clone', '-q', `file://${origin}`, author)
  runGit(ws, 'checkout', '-q', '-b', 'fix-login')
  return author
}

function pushUpstream(author: string, subject: string): void {
  fs.writeFileSync(path.join(author, 'upstream.txt'), `${subject}\n`)
  runGit(author, 'add', '-A')
  runGit(author, 'commit', '-q', '-m', subject)
  runGit(author, 'push', '-q', 'origin', 'main')
}

function records(file: string): Record<string, unknown>[] {
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

function additionalContext(hookOutput: unknown): string {
  return (JSON.parse(String(hookOutput)) as { hookSpecificOutput: { additionalContext: string } })
    .hookSpecificOutput.additionalContext
}

const claudeHeard: Heard = (home) => {
  const dir = path.join(home, '.claude', 'projects')
  if (!fs.existsSync(dir)) return ''
  return fs
    .readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) => records(path.join(dir, f)))
    .flatMap((r) => {
      const a = r.attachment as { type?: string; content?: string[] } | undefined
      return a?.type === 'hook_additional_context' ? (a.content ?? []) : []
    })
    .join('\n')
}

const codexHeard: Heard = (home) =>
  records(path.join(home, 'fake-codex-hook-output.jsonl'))
    .filter((r) => r.stdout)
    .map((r) => additionalContext(r.stdout))
    .join('\n')

const museHeard: Heard = (home) =>
  records(path.join(home, 'fake-muse-prompt-context.jsonl'))
    .map((r) => additionalContext(r.out))
    .join('\n')

const agyHeard: Heard = (home) =>
  records(path.join(home, 'fake-agy-injected.jsonl'))
    .flatMap((r) => (r.ephemeralMessages as string[] | undefined) ?? [])
    .join('\n')

async function tabOf(page: Page, backendId: BackendId): Promise<string> {
  const all = await page.evaluate(() => window.api.sessions.list())
  return all.find((s) => s.backendId === backendId && s.alive)!.tabId
}

async function bound(page: Page, backendId: string, timeout: number): Promise<void> {
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.api.sessions.list())).some(
          (s) => s.backendId === backendId && s.alive && !!s.nativeSessionId
        ),
      { timeout }
    )
    .toBe(true)
}

async function agyReady(page: Page, timeout: number): Promise<void> {
  await expect
    .poll(
      async () => {
        for (const id of await termIds(page))
          if ((await terminalText(page, id)).includes('Antigravity CLI')) return true
        return false
      },
      { timeout }
    )
    .toBe(true)
}

async function museThenAgy(
  page: Page,
  ws: string,
  bindsWithinMs: number,
  beforeAgy = async () => {}
): Promise<void> {
  await newSessionInWith(page, ws, 'Muse')
  await bound(page, 'muse', bindsWithinMs)
  await beforeAgy()
  await newSessionInWith(page, ws, 'Antigravity')
  await agyReady(page, bindsWithinMs)
  await runIn(page, centerTerm(page), 'look around')
  await bound(page, 'agy', bindsWithinMs)
}

async function fetchNow(page: Page, ws: string): Promise<void> {
  await page.evaluate((p) => window.api.workspace.fetchFreshness(p), ws)
}

async function claudeThenCodex(page: Page, env: E2EEnv, beforeCodex = async () => {}) {
  await startSessionIn(page, 'ws-a', { method: 'Claude' })
  await expect(wsRows(page, 'ws-a')).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })
  await beforeCodex()
  await startCodex(page, env)
}

async function marksOnceAllWait(
  page: Page,
  ws: string,
  timeout: number
): Promise<AttentionEvent[]> {
  await expect(wsRows(page, ws).and(page.locator('.st-working'))).toHaveCount(0, { timeout })
  return (await pendingAttention(page)).sort((a, b) => a.tabId.localeCompare(b.tabId))
}

async function heldThenHandedIn(
  page: Page,
  sessions: { backendId: BackendId; heard: Heard }[],
  homes: { notices: string; agents: string },
  marks: AttentionEvent[],
  said: RegExp,
  timeout: number
): Promise<void> {
  const tabs = await Promise.all(sessions.map((s) => tabOf(page, s.backendId)))
  const left = tabs.map((tab) => path.join(homes.notices, `${tab}.notice`))
  for (const file of left) await expect.poll(() => fs.existsSync(file), { timeout }).toBe(true)
  for (const s of sessions) expect(s.heard(homes.agents), s.backendId).not.toMatch(said)
  expect((await pendingAttention(page)).sort((a, b) => a.tabId.localeCompare(b.tabId))).toEqual(
    marks
  )

  for (const tab of tabs)
    await page.evaluate((id) => window.api.terminal.write(id, 'look again\r'), tab)
  for (const s of sessions)
    await expect.poll(() => s.heard(homes.agents), { timeout }).toMatch(said)
  for (const file of left) expect(fs.existsSync(file), file).toBe(false)
}

test.describe('open sessions hear what changed around them, from Koloft, at their next prompt or tool call, never as a turn of their own', () => {
  test('when origin/main moves, a Claude session and a Codex session open on a feature branch of that repository are each told which commits came in, with their next prompt; their red dots stay as they were and no turn starts for it', async ({
    env
  }) => {
    test.setTimeout(180_000)
    const ws = env.workspaces.a
    const author = checkoutWithOrigin(ws, env.home)
    installCodex(env)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await claudeThenCodex(page, env)
      await fetchNow(page, ws)
      const marks = await marksOnceAllWait(page, 'ws-a', NOTICE_ARRIVES_WITHIN_MS)

      pushUpstream(author, 'fix: login keeps the session')
      await fetchNow(page, ws)

      await heldThenHandedIn(
        page,
        [
          { backendId: 'claude', heard: claudeHeard },
          { backendId: 'codex', heard: codexHeard }
        ],
        { notices: path.join(env.userData, 'hook-sessions'), agents: env.home },
        marks,
        told,
        NOTICE_ARRIVES_WITHIN_MS
      )
    } finally {
      await quitAndClose(app)
    }
  })

  test('when a Codex session writes a file a Claude session in the same folder wrote, each is told the other changed it and to read it again, with its next prompt', async ({
    env
  }) => {
    test.setTimeout(180_000)
    checkoutWithOrigin(env.workspaces.a, env.home)
    installCodex(env)
    const shared = path.join(env.workspaces.a, 'shared.txt')
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await claudeThenCodex(page, env, async () => {
        await runIn(page, centerTerm(page), '/write shared.txt')
        await expect.poll(() => fs.existsSync(shared), { timeout: 30_000 }).toBe(true)
      })

      await runIn(page, centerTerm(page), '/write shared.txt')
      const marks = await marksOnceAllWait(page, 'ws-a', NOTICE_ARRIVES_WITHIN_MS)

      await heldThenHandedIn(
        page,
        [
          { backendId: 'claude', heard: claudeHeard },
          { backendId: 'codex', heard: codexHeard }
        ],
        { notices: path.join(env.userData, 'hook-sessions'), agents: env.home },
        marks,
        toldSameFile,
        NOTICE_ARRIVES_WITHIN_MS
      )
    } finally {
      await quitAndClose(app)
    }
  })

  test('when origin/main moves, a Muse session and an Antigravity session open on a feature branch of that repository are each told which commits came in, with their next prompt; their red dots stay as they were and no turn starts for it', async ({
    env
  }) => {
    test.setTimeout(180_000)
    const ws = env.workspaces.a
    const author = checkoutWithOrigin(ws, env.home)
    installMuse(env)
    installAgy(env)
    trustInMuse(env, ws)
    trustInAgy(env, ws)
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await museThenAgy(page, 'ws-a', LOCAL_SESSION_BINDS_WITHIN_MS)
      await fetchNow(page, ws)
      const marks = await marksOnceAllWait(page, 'ws-a', NOTICE_ARRIVES_WITHIN_MS)

      pushUpstream(author, 'fix: login keeps the session')
      await fetchNow(page, ws)

      await heldThenHandedIn(
        page,
        [
          { backendId: 'muse', heard: museHeard },
          { backendId: 'agy', heard: agyHeard }
        ],
        { notices: path.join(env.userData, 'hook-sessions'), agents: env.home },
        marks,
        told,
        NOTICE_ARRIVES_WITHIN_MS
      )
    } finally {
      await quitAndClose(app)
    }
  })

  test('when an Antigravity session writes a file a Muse session in the same folder wrote, each is told the other changed it and to read it again, with its next prompt', async ({
    env
  }) => {
    test.setTimeout(180_000)
    checkoutWithOrigin(env.workspaces.a, env.home)
    installMuse(env)
    installAgy(env)
    trustInMuse(env, env.workspaces.a)
    trustInAgy(env, env.workspaces.a)
    seedSettings(env, { hintsOff: true })
    const shared = path.join(env.workspaces.a, 'shared.txt')
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await museThenAgy(page, 'ws-a', LOCAL_SESSION_BINDS_WITHIN_MS, async () => {
        await runIn(page, centerTerm(page), '/write shared.txt')
        await expect.poll(() => fs.existsSync(shared), { timeout: 30_000 }).toBe(true)
      })

      await runIn(page, centerTerm(page), '/write shared.txt')
      const marks = await marksOnceAllWait(page, 'ws-a', NOTICE_ARRIVES_WITHIN_MS)

      await heldThenHandedIn(
        page,
        [
          { backendId: 'muse', heard: museHeard },
          { backendId: 'agy', heard: agyHeard }
        ],
        { notices: path.join(env.userData, 'hook-sessions'), agents: env.home },
        marks,
        toldSameFile,
        NOTICE_ARRIVES_WITHIN_MS
      )
    } finally {
      await quitAndClose(app)
    }
  })

  test('on another machine over ssh, a Claude session and a Codex session on a feature branch are told with their next prompt there, when origin/main moves on that machine; their red dots stay as they were', async ({
    env
  }) => {
    test.setTimeout(300_000)
    installCodexOnFakeRemote(env)
    const author = checkoutWithOrigin(remoteDir(env), machineHome(env))
    const { app, page } = await launchWithRemote(env)
    try {
      await addRemoteWorkspace(page, env)
      await startSessionIn(page, REMOTE_WS_NAME, { remote: true, method: 'Claude' })
      await expect(wsRows(page, REMOTE_WS_NAME)).toHaveClass(/\bst-waiting\b/, {
        timeout: 60_000
      })
      await newSessionInWith(page, REMOTE_WS_NAME, 'Codex')
      await expect(
        wsRows(page, REMOTE_WS_NAME).filter({ hasText: 'Codex fixture session' })
      ).toHaveClass(/st-waiting/, { timeout: 60_000 })
      await fetchNow(page, remoteKey(env))
      const marks = await marksOnceAllWait(page, REMOTE_WS_NAME, REMOTE_NOTICE_ARRIVES_WITHIN_MS)

      pushUpstream(author, 'fix: login keeps the session')
      await fetchNow(page, remoteKey(env))

      await heldThenHandedIn(
        page,
        [
          { backendId: 'claude', heard: claudeHeard },
          { backendId: 'codex', heard: codexHeard }
        ],
        {
          notices: path.join(machineHome(env), '.koloft', 'hook-sessions'),
          agents: machineHome(env)
        },
        marks,
        told,
        REMOTE_NOTICE_ARRIVES_WITHIN_MS
      )
    } finally {
      await quitAndClose(app)
      killFakeRemote(env)
    }
  })

  test('on another machine over ssh, a Muse session and an Antigravity session on a feature branch are told with their next prompt there, when origin/main moves on that machine; their red dots stay as they were', async ({
    env
  }) => {
    test.setTimeout(300_000)
    installMuse(env)
    installAgy(env)
    installMuseOnMachine(env)
    installRemoteAgy(env)
    seedSettings(env, { hintsOff: true })
    const author = checkoutWithOrigin(remoteDir(env), machineHome(env))
    const { app, page } = await launchWithRemote(env)
    try {
      await addRemoteWorkspace(page, env)
      await museThenAgy(page, REMOTE_WS_NAME, REMOTE_SESSION_BINDS_WITHIN_MS)
      await fetchNow(page, remoteKey(env))
      const marks = await marksOnceAllWait(page, REMOTE_WS_NAME, REMOTE_NOTICE_ARRIVES_WITHIN_MS)

      pushUpstream(author, 'fix: login keeps the session')
      await fetchNow(page, remoteKey(env))

      await heldThenHandedIn(
        page,
        [
          { backendId: 'muse', heard: museHeard },
          { backendId: 'agy', heard: agyHeard }
        ],
        {
          notices: path.join(machineHome(env), '.koloft', 'hook-sessions'),
          agents: machineHome(env)
        },
        marks,
        told,
        REMOTE_NOTICE_ARRIVES_WITHIN_MS
      )
    } finally {
      await quitAndClose(app)
      killFakeRemote(env)
    }
  })
})
