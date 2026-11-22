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
  agentShell,
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
  stateDir,
  tabScriptAttaches
} from './helpers/remote'
import { installOnTheMachine, koloftInSession } from './helpers/remoteTab'
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

async function koloftSays(page: Page, tabId: string, args: string): Promise<string> {
  await koloftInSession(page, tabId, args)
  return terminalText(page, tabId)
}

const shellOf = (page: Page, tabId: string): ((command: string) => Promise<string>) =>
  agentShell(page, tabId, KOLOFT_ON_THE_MACHINE_ANSWERS_MS)

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

async function attachedAgain(page: Page, env: E2EEnv): Promise<void> {
  await expect
    .poll(() => tabScriptAttaches(env), { timeout: ATTACHED_AGAIN_AFTER_A_RESTART_MS })
    .toBeGreaterThanOrEqual(1)
  await expect(wsRows(page, REMOTE_WS_NAME).first()).toHaveClass(/\bst-waiting\b/, {
    timeout: ATTACHED_AGAIN_AFTER_A_RESTART_MS
  })
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
      const own = await koloftSays(page, plain, 'discord send -- own words')
      expect(squeezed(own)).toContain(squeezed('only the butler bound to a Discord channel'))
      refusedAsNotItsPass(
        await shellOf(page, plain)(`KOLOFT_TAB_ID=${butler} koloft discord send -- forged words`)
      )
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
      refusedAsNotItsPass(
        await shellOf(page, plain)(`${shim} discord send -- forged into its folder`)
      )
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
      expect(await koloftSays(page, agy, 'session list')).toMatch(/\(you\) · Antigravity/)
      await startSessionIn(page, 'ws-a', { method: 'Claude' })
      const plain = await newestTabBeside(page, [agy])
      refusedAsNotItsPass(await shellOf(page, plain)(`${shim} session list`))
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
        const own = await koloftSays(page, caller, 'session list')
        expect((own.match(/\(you\)/g) ?? []).length).toBe(1)
        refusedAsNotItsPass(
          await koloftSays(
            page,
            caller,
            `help >/dev/null; env -u TMUX KOLOFT_TAB_ID=${other} koloft session list`
          )
        )
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
      await attachedAgain(page, env)
      const tab = await newestTabBeside(page, [launchTab])
      expect(await koloftSays(page, tab, 'session list')).toMatch(/\(you\) · Claude/)
      refusedAsNotItsPass(
        await shellOf(page, tab)(`env -u TMUX KOLOFT_TAB_ID=${tab} koloft session list`)
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
      await attachedAgain(page, env)
      const old = await newestTabBeside(page, [launchTab])
      expect(await shellOf(page, old)('env -u KOLOFT_TAB_PASS koloft session list')).toMatch(
        /\(you\) · Claude/
      )

      await startSessionIn(page, REMOTE_WS_NAME, { remote: true })
      const fresh = await newestTabBeside(page, [launchTab, old])
      refusedAsNotItsPass(
        await shellOf(page, fresh)('env -u TMUX -u KOLOFT_TAB_PASS koloft session list')
      )
    } finally {
      await quitAndClose(app)
    }
  })
})
