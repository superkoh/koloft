import fs from 'fs'
import path from 'path'
import type { Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { installCodex, type E2EEnv } from './helpers/env'
import { runGit } from './helpers/gitFixture'
import {
  centerTerm,
  newSessionInWith,
  runIn,
  startSessionIn,
  waitBooted,
  wsRows
} from './helpers/p1'
import { fakeCodexLog, startCodex } from './helpers/codex'
import {
  REMOTE_WS_NAME,
  addRemoteWorkspace,
  installCodexOnFakeRemote,
  killFakeRemote,
  launchWithRemote,
  machineCodexLog,
  machineHome,
  remoteDir,
  remoteKey
} from './helpers/remote'

const NOTICE_ARRIVES_WITHIN_MS = 30_000
const REMOTE_NOTICE_ARRIVES_WITHIN_MS = 60_000
const told =
  /\(From Koloft:\) origin\/main moved from \w{7} to \w{7}, with 1 new commit: \\?"fix: login keeps the session\\?"\./

interface WireFrame {
  direction: string
  frame: { method?: string; params?: { input?: { text?: string }[] } }
}

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

function machineTranscripts(env: E2EEnv): string {
  const dir = path.join(machineHome(env), '.claude', 'projects')
  if (!fs.existsSync(dir)) return ''
  return fs
    .readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
    .join('\n')
}

function machineCodexHeard(env: E2EEnv): string {
  return machineCodexLog<WireFrame>(env, 'fake-codex-wire.jsonl')
    .filter((w) => w.direction === 'client' && w.frame.method === 'thread/queue/add')
    .flatMap((w) => w.frame.params?.input ?? [])
    .map((i) => i.text ?? '')
    .join('\n')
}

function pushUpstream(author: string, subject: string): void {
  fs.writeFileSync(path.join(author, 'upstream.txt'), `${subject}\n`)
  runGit(author, 'add', '-A')
  runGit(author, 'commit', '-q', '-m', subject)
  runGit(author, 'push', '-q', 'origin', 'main')
}

function claudeHeard(env: E2EEnv): string {
  const f = path.join(env.home, 'fake-claude-peer.jsonl')
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''
}

function codexHeard(env: E2EEnv): string {
  return fakeCodexLog<WireFrame>(env, 'fake-codex-wire.jsonl')
    .filter((w) => w.direction === 'client' && w.frame.method === 'thread/queue/add')
    .flatMap((w) => w.frame.params?.input ?? [])
    .map((i) => i.text ?? '')
    .join('\n')
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

test.describe('open sessions hear what changed around them, from Koloft, without anyone asking', () => {
  test('when origin/main moves, a Claude session and a Codex session open on a feature branch of that repository are each told which commits came in', async ({
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

      pushUpstream(author, 'fix: login keeps the session')
      await fetchNow(page, ws)

      await expect.poll(() => claudeHeard(env), { timeout: NOTICE_ARRIVES_WITHIN_MS }).toMatch(told)
      await expect.poll(() => codexHeard(env), { timeout: NOTICE_ARRIVES_WITHIN_MS }).toMatch(told)
    } finally {
      await quitAndClose(app)
    }
  })

  test('when a Codex session writes a file a Claude session in the same folder wrote, each is told the other changed it and to read it again', async ({
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
      expect(claudeHeard(env)).toBe('')

      await runIn(page, centerTerm(page), '/write shared.txt')

      const told =
        /changed files you changed too: shared\.txt\. It works in your folder, so read them again before you edit them\./
      await expect.poll(() => claudeHeard(env), { timeout: NOTICE_ARRIVES_WITHIN_MS }).toMatch(told)
      await expect.poll(() => codexHeard(env), { timeout: NOTICE_ARRIVES_WITHIN_MS }).toMatch(told)
    } finally {
      await quitAndClose(app)
    }
  })

  test('on another machine over ssh, a Claude session on a feature branch hears it typed in once its turn is over and a Codex session through its queue there, when origin/main moves on that machine', async ({
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

      pushUpstream(author, 'fix: login keeps the session')
      await fetchNow(page, remoteKey(env))

      await expect
        .poll(() => machineTranscripts(env), { timeout: REMOTE_NOTICE_ARRIVES_WITHIN_MS })
        .toMatch(told)
      await expect
        .poll(() => machineCodexHeard(env), { timeout: REMOTE_NOTICE_ARRIVES_WITHIN_MS })
        .toMatch(told)
    } finally {
      await quitAndClose(app)
      killFakeRemote(env)
    }
  })
})
