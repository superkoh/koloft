import fs from 'fs'
import path from 'path'
import type { Page } from '@playwright/test'
import { test, expect, launchApp, pendingAttention, quitAndClose } from './helpers/app'
import {
  agyApiCalls,
  agySessionCalls,
  installAgy,
  installCodex,
  trustInAgy,
  type E2EEnv
} from './helpers/env'
import { codexCalls, startCodex } from './helpers/codex'
import {
  agyConversationOnceFirstTurnEnded,
  centerTerm,
  killSession,
  newSessionInWith,
  readCalls,
  runIn,
  startSessionIn,
  waitBooted,
  wsRows
} from './helpers/p1'
import {
  OTHER_AGENTS_ON_THE_MACHINE,
  REMOTE_HOST,
  REMOTE_WS_NAME,
  addRemoteWorkspace,
  agyReady,
  installCodexOnFakeRemote,
  installFakeRemote,
  installRemoteAgy,
  killFakeRemote,
  machineAgyApiCalls,
  machineAgyCalls,
  machineHome
} from './helpers/remote'
import type { BackendId } from '../../src/shared/types'
import { identityOf } from '../../src/shared/sessionBackend'

const A_REMOTE_EXIT_REACHES_THE_INBOX_MS = 90_000
const A_RESUMED_SESSION_TAKES_A_MESSAGE_MS = 90_000
const A_CARD_CASE_TAKES_MS = 300_000

function inboxCard(page: Page, title: string) {
  return page.locator('.inbox-page .ibx-item', {
    has: page.locator('.ibx-what', { hasText: title })
  })
}

async function openInbox(page: Page): Promise<void> {
  await page.locator('.ibx-entry').click()
  await expect(page.locator('.inbox-page')).toBeVisible()
}

async function doneWith(page: Page, title: string, status: string) {
  await page.locator('.ibx-seg button[data-tab="closed"]').click()
  return inboxCard(page, title).filter({
    has: page.locator('.ibx-dstat', { hasText: status })
  })
}

const fileText = (file: string): string =>
  fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''

const squeezed = (text: string): string => text.replace(/\s+/g, '')

const remoteAgy = OTHER_AGENTS_ON_THE_MACHINE.find((a) => a.label === 'Antigravity')!

interface TabKind {
  name: string
  backend: BackendId
  remote: boolean
  install: (env: E2EEnv) => void
  start: (page: Page, env: E2EEnv) => Promise<void>
  launches: (env: E2EEnv) => { pid: number; cwd: string }[]
  heard: (env: E2EEnv) => string
}

const KINDS: TabKind[] = [
  {
    name: 'remote Claude Code',
    backend: 'claude',
    remote: true,
    install: () => {},
    start: async (page) => {
      await startSessionIn(page, REMOTE_WS_NAME, { remote: true })
      await expect(wsRows(page, REMOTE_WS_NAME).first()).toHaveClass(/st-waiting|st-idle/, {
        timeout: 60_000
      })
    },
    launches: readCalls,
    heard: (env) =>
      fileText(path.join(machineHome(env), 'fake-claude-peer.jsonl')) +
      JSON.stringify(readCalls(env))
  },
  {
    name: 'local Codex',
    backend: 'codex',
    remote: false,
    install: (env) => installCodex(env),
    start: async (page, env) => {
      await startCodex(page, env)
      await expect.poll(() => pendingAttention(page), { timeout: 10_000 }).toHaveLength(1)
    },
    launches: codexCalls,
    heard: (env) => fileText(path.join(env.home, 'fake-codex-wire.jsonl'))
  },
  {
    name: 'remote Codex',
    backend: 'codex',
    remote: true,
    install: installCodexOnFakeRemote,
    start: async (page) => {
      await newSessionInWith(page, REMOTE_WS_NAME, 'Codex')
      await expect(
        wsRows(page, REMOTE_WS_NAME).filter({ hasText: 'Codex fixture session' })
      ).toHaveClass(/st-waiting/, { timeout: 60_000 })
      await expect.poll(() => pendingAttention(page), { timeout: 10_000 }).toHaveLength(1)
    },
    launches: codexCalls,
    heard: (env) => fileText(path.join(machineHome(env), 'fake-codex-wire.jsonl'))
  },
  {
    name: 'local Antigravity',
    backend: 'agy',
    remote: false,
    install: (env) => {
      installAgy(env)
      trustInAgy(env, env.workspaces.a)
    },
    start: async (page) => {
      await newSessionInWith(page, 'ws-a', 'Antigravity')
      await agyReady(page)
      await runIn(page, centerTerm(page), 'keep me')
      await expect(wsRows(page, 'ws-a').filter({ hasText: 'keep me' })).toHaveClass(/st-waiting/, {
        timeout: 30_000
      })
      await agyConversationOnceFirstTurnEnded(page)
    },
    launches: agySessionCalls,
    heard: (env) => JSON.stringify(agyApiCalls(env)) + JSON.stringify(agySessionCalls(env))
  },
  {
    name: 'remote Antigravity',
    backend: 'agy',
    remote: true,
    install: (env) => {
      installAgy(env)
      installRemoteAgy(env)
    },
    start: async (page) => {
      await newSessionInWith(page, REMOTE_WS_NAME, 'Antigravity')
      await remoteAgy.bound!(page)
    },
    launches: machineAgyCalls,
    heard: (env) => JSON.stringify(machineAgyApiCalls(env)) + JSON.stringify(machineAgyCalls(env))
  }
]

async function aliveSessions(page: Page) {
  return (await page.evaluate(() => window.api.sessions.list())).filter((s) => s.alive)
}

test.describe(() => {
  test.describe.configure({ mode: 'parallel' })
  test.setTimeout(A_CARD_CASE_TAKES_MS)
  test.afterEach(({ env }) => killFakeRemote(env))

  for (const kind of KINDS)
    test(`a ${kind.name} session that stopped unexpectedly is a card; Start it again resumes it in its one row and tells it to carry on, and Hand to a new session starts a ${kind.name} session in the same workspace with the owner’s note`, async ({
      env
    }) => {
      kind.install(env)
      if (kind.remote) installFakeRemote(env)
      const ws = kind.remote ? REMOTE_WS_NAME : 'ws-a'
      const app = await launchApp(env)
      try {
        const page = await app.firstWindow()
        await waitBooted(page)
        if (kind.remote) await addRemoteWorkspace(page, env)
        await kind.start(page, env)
        await expect.poll(() => kind.launches(env).length).toBe(1)
        killSession(kind.launches(env)[0].pid, env)

        await openInbox(page)
        const card = inboxCard(page, 'stopped unexpectedly')
        await card
          .locator('.ibx-btn', { hasText: 'Start it again' })
          .click({ timeout: A_REMOTE_EXIT_REACHES_THE_INBOX_MS })
        await expect
          .poll(() => squeezed(kind.heard(env)), { timeout: A_RESUMED_SESSION_TAKES_A_MESSAGE_MS })
          .toContain(squeezed('Carry on where you left off'))
        await expect(wsRows(page, ws)).toHaveCount(1)
        await expect(await doneWith(page, 'stopped unexpectedly', 'Restarted')).toHaveCount(1)

        await expect.poll(() => kind.launches(env).length).toBe(2)
        killSession(kind.launches(env)[1].pid, env)
        await page.locator('.ibx-seg button[data-tab="needs-you"]').click()
        const next = inboxCard(page, 'stopped unexpectedly')
        await next
          .locator('.ibx-input')
          .fill('finish the docs', { timeout: A_REMOTE_EXIT_REACHES_THE_INBOX_MS })
        await next.locator('.ibx-btn', { hasText: 'Hand to a new session' }).click()
        await expect
          .poll(() => squeezed(kind.heard(env)), { timeout: A_RESUMED_SESSION_TAKES_A_MESSAGE_MS })
          .toContain(squeezed('Pick up the work of the session'))
        expect(squeezed(kind.heard(env))).toContain(squeezed('«finish the docs»'))
        await expect(
          await doneWith(page, 'stopped unexpectedly', 'Handed to a new session')
        ).toHaveCount(1)

        await expect(wsRows(page, ws)).toHaveCount(2)
        const [started] = await aliveSessions(page)
        expect((await aliveSessions(page)).map((s) => s.backendId)).toEqual([kind.backend])
        if (kind.remote)
          expect(started.remote?.host ?? identityOf(started.sessionId).sourceId).toBe(REMOTE_HOST)
        else expect(kind.launches(env)[2].cwd).toBe(env.workspaces.a)
      } finally {
        await quitAndClose(app)
      }
    })
})
