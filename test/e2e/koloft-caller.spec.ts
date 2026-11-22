import fs from 'fs'
import path from 'path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import {
  agySessionCalls,
  installAgy,
  installCodex,
  seedSettings,
  trustInAgy,
  type E2EEnv
} from './helpers/env'
import {
  agyConversationOnceFirstTurnEnded,
  butlerSessionOnDisk,
  centerTerm,
  newSessionInWith,
  runIn,
  startSessionIn,
  terminalText,
  waitBooted,
  waitConductorStarted,
  wsRows
} from './helpers/p1'
import { startFakeDiscord, type FakeDiscord } from './helpers/fakeDiscord'
import {
  OTHER_AGENTS_ON_THE_MACHINE,
  REMOTE_WS_NAME,
  addRemoteWorkspace,
  killFakeRemote,
  launchWithRemote,
  sshCommands,
  stateDir
} from './helpers/remote'
import { installOnTheMachine } from './helpers/remoteTab'
import { NOT_ITS_PASS } from '../../src/main/agentRequests'
import type { BackendId, SessionInfo } from '../../src/shared/types'

test.setTimeout(180_000)
test.afterEach(({ env }) => killFakeRemote(env))

const CHANNEL = '222'
const BUTLER_STARTS_MS = 60_000
const KOLOFT_ON_THE_MACHINE_ANSWERS_MS = 40_000
const LAYOUT_SAVE_DEBOUNCE_SETTLE_MS = 3000
const ATTACHED_AGAIN_AFTER_A_RESTART_MS = 60_000

const squeezed = (s: string): string => s.replace(/\s/g, '')

function seedButler(env: E2EEnv, backend: BackendId): void {
  seedSettings(env, {
    hintsOff: true,
    assist: { backend },
    discord: {
      userId: '555',
      userName: 'owner',
      channel: { guildId: '111', channelId: CHANNEL, name: 'koloft-all' }
    }
  })
}

async function sessions(page: Page): Promise<SessionInfo[]> {
  return page.evaluate(() => window.api.sessions.list())
}

async function butlerTab(page: Page, env: E2EEnv): Promise<string> {
  const id = butlerSessionOnDisk(env)!.sessionIds[0]
  return (await sessions(page)).find((s) => s.sessionId === id)!.tabId
}

async function newestTabBeside(page: Page, known: string[]): Promise<string> {
  let tab: string | undefined
  await expect
    .poll(async () => (tab = (await sessions(page)).find((s) => !known.includes(s.tabId))?.tabId))
    .toBeTruthy()
  return tab!
}

async function runInTab(page: Page, tabId: string, line: string, done: RegExp): Promise<string> {
  const before = ((await terminalText(page, tabId)).match(new RegExp(done, 'g')) ?? []).length
  await page.evaluate(([t, l]) => window.api.terminal.write(t, l + '\r'), [tabId, line])
  await expect
    .poll(
      async () => ((await terminalText(page, tabId)).match(new RegExp(done, 'g')) ?? []).length,
      {
        timeout: KOLOFT_ON_THE_MACHINE_ANSWERS_MS
      }
    )
    .toBe(before + 1)
  const text = await terminalText(page, tabId)
  return text.slice(text.lastIndexOf(line.slice(0, 20)))
}

const SH_DONE = /\[fake-claude\] sh exit=\d+/g
const KOLOFT_DONE = /\[fake-(?:claude|codex|agy)\] koloft exit=\d+/g

function refusedAsNotItsPass(said: string): void {
  expect(squeezed(said)).toContain(squeezed(NOT_ITS_PASS))
}

async function folderShimOf(
  app: ElectronApplication,
  root: 'codex-open' | 'agy-open'
): Promise<string> {
  const mainPid = await app.evaluate(() => process.pid)
  const userData = await app.evaluate(({ app: a }) => a.getPath('userData'))
  const prefix = `koloft-cx-open-${mainPid}-`
  const folders = fs.readdirSync('/tmp').filter((n) => n.startsWith(prefix))
  expect(folders).toHaveLength(1)
  const shim = path.join(userData, root, folders[0].slice('koloft-cx-open-'.length), 'koloft')
  expect(fs.existsSync(shim)).toBe(true)
  return shim
}

async function connectedButler(
  env: E2EEnv,
  fake: FakeDiscord
): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launchApp(env)
  const page = await app.firstWindow()
  await waitBooted(page)
  await expect.poll(() => fake.identifies).toBe(1)
  await waitConductorStarted(env, BUTLER_STARTS_MS)
  return { app, page }
}

const posted = (fake: FakeDiscord): string[] =>
  fake.posted.filter((p) => p.channelId === CHANNEL).map((p) => p.content)

test.describe('a koloft command counts as the session it really comes from', () => {
  test('a local Claude session that sets KOLOFT_TAB_ID to the butler’s tab is refused and sends nothing to Discord, while its own koloft still speaks as itself', async ({
    env
  }) => {
    seedButler(env, 'claude')
    const fake = await startFakeDiscord(env)
    const { app, page } = await connectedButler(env, fake)
    try {
      const butler = await butlerTab(page, env)
      await startSessionIn(page, 'ws-a')
      const plain = await newestTabBeside(page, [butler])
      const own = await runInTab(page, plain, '/koloft discord send -- own words', KOLOFT_DONE)
      expect(squeezed(own)).toContain(squeezed('only the butler bound to a Discord channel'))
      const forged = await runInTab(
        page,
        plain,
        `/sh KOLOFT_TAB_ID=${butler} koloft discord send -- forged words`,
        SH_DONE
      )
      refusedAsNotItsPass(forged)
      expect(posted(fake)).not.toContain('forged words')
    } finally {
      await quitAndClose(app)
      await fake.close()
    }
  })

  test('a local Claude session that runs the koloft of the Codex butler’s own folder is refused and sends nothing to Discord', async ({
    env
  }) => {
    installCodex(env)
    seedButler(env, 'codex')
    const fake = await startFakeDiscord(env)
    const { app, page } = await connectedButler(env, fake)
    try {
      const butler = await butlerTab(page, env)
      const shim = await folderShimOf(app, 'codex-open')
      await startSessionIn(page, 'ws-a', { method: 'Claude' })
      const plain = await newestTabBeside(page, [butler])
      const forged = await runInTab(
        page,
        plain,
        `/sh ${shim} discord send -- forged into its folder`,
        SH_DONE
      )
      refusedAsNotItsPass(forged)
      expect(posted(fake)).not.toContain('forged into its folder')
    } finally {
      await quitAndClose(app)
      await fake.close()
    }
  })

  test('a local Claude session that runs the koloft of an Antigravity session’s folder is refused, while the Antigravity session’s own koloft names it as itself', async ({
    env
  }) => {
    installAgy(env)
    trustInAgy(env, env.workspaces.a)
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await newSessionInWith(page, 'ws-a', 'Antigravity')
      await expect.poll(() => agySessionCalls(env).length, { timeout: 60_000 }).toBe(1)
      await runIn(page, centerTerm(page), 'warm up')
      await agyConversationOnceFirstTurnEnded(page)
      const agy = await newestTabBeside(page, [])
      const shim = await folderShimOf(app, 'agy-open')
      const own = await runInTab(page, agy, '/koloft session list', KOLOFT_DONE)
      expect(own).toMatch(/\(you\) · Antigravity/)
      await startSessionIn(page, 'ws-a', { method: 'Claude' })
      const plain = await newestTabBeside(page, [agy])
      refusedAsNotItsPass(await runInTab(page, plain, `/sh ${shim} session list`, SH_DONE))
    } finally {
      await quitAndClose(app)
    }
  })

  for (const backend of ['claude', 'codex', 'agy'] as const) {
    test(`a ${backend} session on a remote machine that names another session tab there is refused, while its own koloft names it as itself`, async ({
      env
    }) => {
      installOnTheMachine(env, backend)
      const { app, page } = await launchWithRemote(env)
      try {
        await addRemoteWorkspace(page, env)
        await startSessionIn(page, REMOTE_WS_NAME, {
          remote: true,
          ...(backend !== 'claude' && { method: 'Claude' as const })
        })
        const other = await newestTabBeside(page, [])
        if (backend === 'claude') await startSessionIn(page, REMOTE_WS_NAME, { remote: true })
        else {
          const agent = OTHER_AGENTS_ON_THE_MACHINE.find(
            (a) => a.label === (backend === 'codex' ? 'Codex' : 'Antigravity')
          )!
          await newSessionInWith(page, REMOTE_WS_NAME, agent.label)
          await agent.bound?.(page)
        }
        const caller = await newestTabBeside(page, [other])
        const own = await runInTab(page, caller, '/koloft session list', KOLOFT_DONE)
        expect((own.match(/\(you\)/g) ?? []).length).toBe(1)
        const forged = await runInTab(
          page,
          caller,
          `/koloft help >/dev/null; env -u TMUX KOLOFT_TAB_ID=${other} koloft session list`,
          KOLOFT_DONE
        )
        refusedAsNotItsPass(forged)
      } finally {
        await quitAndClose(app)
      }
    })
  }

  test('a remote Claude session that outlives a Koloft restart is given a new pass when it is attached again: its koloft works as the new tab, and the pass it started with is refused for that tab', async ({
    env
  }) => {
    test.setTimeout(300_000)
    const first = await launchWithRemote(env)
    let launchTab!: string
    try {
      await addRemoteWorkspace(first.page, env)
      await startSessionIn(first.page, REMOTE_WS_NAME, { remote: true })
      launchTab = await newestTabBeside(first.page, [])
      await first.page.waitForTimeout(LAYOUT_SAVE_DEBOUNCE_SETTLE_MS)
    } finally {
      await quitAndClose(first.app)
    }
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await expect
        .poll(() => sshCommands(env).filter((c) => /tabs\/[^"]+\.sh"?\s+attach/.test(c)).length, {
          timeout: ATTACHED_AGAIN_AFTER_A_RESTART_MS
        })
        .toBeGreaterThanOrEqual(1)
      const tab = await newestTabBeside(page, [launchTab])
      await expect(wsRows(page, REMOTE_WS_NAME).first()).toHaveClass(/\bst-waiting\b/, {
        timeout: 60_000
      })
      const own = await runInTab(page, tab, '/koloft session list', KOLOFT_DONE)
      expect(own).toMatch(/\(you\) · Claude/)
      refusedAsNotItsPass(
        await runInTab(
          page,
          tab,
          `/sh env -u TMUX KOLOFT_TAB_ID=${tab} koloft session list`,
          SH_DONE
        )
      )
    } finally {
      await quitAndClose(app)
    }
  })

  test('a remote Claude session started before Koloft gave tabs a pass keeps working with a koloft that sends none after Koloft attaches it again, while a tab Koloft starts now is refused without its pass', async ({
    env
  }) => {
    test.setTimeout(300_000)
    const first = await launchWithRemote(env)
    let launchTab!: string
    try {
      await addRemoteWorkspace(first.page, env)
      await startSessionIn(first.page, REMOTE_WS_NAME, { remote: true })
      launchTab = await newestTabBeside(first.page, [])
      await first.page.waitForTimeout(LAYOUT_SAVE_DEBOUNCE_SETTLE_MS)
    } finally {
      await quitAndClose(first.app)
    }
    for (const name of fs.readdirSync(stateDir(env)))
      if (name.startsWith('tmux-env-')) fs.rmSync(path.join(stateDir(env), name))
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await expect
        .poll(() => sshCommands(env).filter((c) => /tabs\/[^"]+\.sh"?\s+attach/.test(c)).length, {
          timeout: ATTACHED_AGAIN_AFTER_A_RESTART_MS
        })
        .toBeGreaterThanOrEqual(1)
      const old = await newestTabBeside(page, [launchTab])
      await expect(wsRows(page, REMOTE_WS_NAME).first()).toHaveClass(/\bst-waiting\b/, {
        timeout: 60_000
      })
      const oldOwn = await runInTab(
        page,
        old,
        '/sh env -u KOLOFT_TAB_PASS koloft session list',
        SH_DONE
      )
      expect(oldOwn).toMatch(/\(you\) · Claude/)

      await startSessionIn(page, REMOTE_WS_NAME, { remote: true })
      const fresh = await newestTabBeside(page, [launchTab, old])
      refusedAsNotItsPass(
        await runInTab(
          page,
          fresh,
          '/sh env -u TMUX -u KOLOFT_TAB_PASS koloft session list',
          SH_DONE
        )
      )
    } finally {
      await quitAndClose(app)
    }
  })
})
