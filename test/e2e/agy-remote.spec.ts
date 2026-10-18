import fs from 'fs'
import path from 'path'
import type { Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import {
  E2E_AGY_ACCOUNT,
  agyCalls,
  installAgy,
  seedSettings,
  type AgyCall,
  type E2EEnv
} from './helpers/env'
import {
  centerTerm,
  newSessionInWith,
  runIn,
  sendShortcut,
  terminalText,
  termIds,
  waitBooted,
  wsRows
} from './helpers/p1'
import {
  REMOTE_WS_NAME,
  installFakeRemote,
  installRemoteAgy,
  killFakeRemote,
  liveTmuxSessions,
  machineHome,
  remoteDir,
  seedRemoteWorkspace
} from './helpers/remote'

test.afterEach(({ env }) => killFakeRemote(env))

const TURN_LONGER_THAN_A_MIRROR_PULL_MS = '5000'

const remoteCalls = (env: E2EEnv): AgyCall[] =>
  agyCalls(env, machineHome(env)).filter((c) => !c.argv.includes('-p'))

const accountFolder = (env: E2EEnv): string =>
  path.join(machineHome(env), '.koloft', 'agy', E2E_AGY_ACCOUNT)

function setUp(env: E2EEnv): void {
  installAgy(env)
  installFakeRemote(env)
  installRemoteAgy(env)
  seedRemoteWorkspace(env)
  seedSettings(env, { hintsOff: true })
}

async function agyReady(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        for (const id of await termIds(page))
          if ((await terminalText(page, id)).includes('Antigravity CLI')) return true
        return false
      },
      { timeout: 90_000 }
    )
    .toBe(true)
}

async function boundRemote(page: Page): Promise<{ tabId: string; id: string }> {
  let found: { tabId: string; id: string } | undefined
  await expect
    .poll(
      async () => {
        const all = await page.evaluate(() => window.api.sessions.list())
        const s = all.find((x) => x.backendId === 'agy' && x.alive && x.nativeSessionId)
        found = s && { tabId: s.tabId, id: s.nativeSessionId! }
        return !!found
      },
      { timeout: 60_000 }
    )
    .toBe(true)
  return found!
}

test.describe('Antigravity sessions in a remote workspace, over the fake ssh with tmux and only the CLI faked', () => {
  test.setTimeout(240_000)

  // AGY§4 AGY§11 AGY§12
  test("an Antigravity session in a remote workspace runs agy in tmux on that machine, on the account's own folder there linked to the machine's ~/.gemini with Koloft's scripts and the API key; its row binds, takes agy's title and goes working then done", async ({
    env
  }) => {
    setUp(env)
    fs.writeFileSync(
      path.join(machineHome(env), 'fake-agy-delay'),
      TURN_LONGER_THAN_A_MIRROR_PULL_MS
    )
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await newSessionInWith(page, REMOTE_WS_NAME, 'Antigravity')
      await expect.poll(() => remoteCalls(env).length, { timeout: 90_000 }).toBe(1)
      const [call] = remoteCalls(env)
      expect(call.argv[0]).toBe(`--gemini_dir=${accountFolder(env)}`)
      expect(call.env.GEMINI_API_KEY).toBe(true)
      expect(fs.realpathSync(call.cwd)).toBe(fs.realpathSync(remoteDir(env)))
      const settings = JSON.parse(
        fs.readFileSync(path.join(accountFolder(env), 'antigravity-cli', 'settings.json'), 'utf8')
      ) as { title: { command: string }; trustedWorkspaces: string[] }
      expect(settings.title.command).toMatch(/\.koloft\/m-[0-9a-f]+\/agy-title\.sh/)
      expect(settings.trustedWorkspaces).toContain(remoteDir(env))
      expect(fs.readlinkSync(path.join(accountFolder(env), 'antigravity-cli', 'brain'))).toBe(
        path.join(machineHome(env), '.gemini', 'antigravity-cli', 'brain')
      )

      await agyReady(page)
      await runIn(page, centerTerm(page), 'remote words')
      const row = wsRows(page, REMOTE_WS_NAME).filter({ hasText: 'remote words' })
      await expect(row).toHaveClass(/st-working/, { timeout: 60_000 })
      await expect(row).toHaveClass(/st-waiting/, { timeout: 60_000 })
      const { id } = await boundRemote(page)
      expect(liveTmuxSessions(env)).toContain(`k-${id}`)
    } finally {
      await quitAndClose(app)
    }
  })

  // AGY§9
  test("closing the remote tab ends agy's tmux session there; its row stays, cold, and clicking it resumes the same conversation on the machine", async ({
    env
  }) => {
    setUp(env)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await newSessionInWith(page, REMOTE_WS_NAME, 'Antigravity')
      await agyReady(page)
      await runIn(page, centerTerm(page), 'keep remote')
      const row = wsRows(page, REMOTE_WS_NAME).filter({ hasText: 'keep remote' })
      await expect(row).toHaveClass(/st-waiting/, { timeout: 60_000 })
      const { id } = await boundRemote(page)
      await sendShortcut(app, 'shortcut:close-tab')
      await expect.poll(() => liveTmuxSessions(env), { timeout: 30_000 }).not.toContain(`k-${id}`)
      await expect(row).toHaveClass(/cold/, { timeout: 30_000 })
      await row.click()
      await expect.poll(() => remoteCalls(env).length, { timeout: 90_000 }).toBe(2)
      expect(remoteCalls(env)[1].argv).toContain(`--conversation=${id}`)
    } finally {
      await quitAndClose(app)
    }
  })

  // AGY§11
  test('an Antigravity tab on a remote machine keeps running there while Koloft is closed, and the restarted Koloft attaches to it and follows its turns', async ({
    env
  }) => {
    setUp(env)
    let app = await launchApp(env)
    try {
      let page = await app.firstWindow()
      await waitBooted(page)
      await newSessionInWith(page, REMOTE_WS_NAME, 'Antigravity')
      await agyReady(page)
      await runIn(page, centerTerm(page), 'survive a restart')
      await expect(
        wsRows(page, REMOTE_WS_NAME).filter({ hasText: 'survive a restart' })
      ).toHaveClass(/st-waiting/, { timeout: 60_000 })
      const { id } = await boundRemote(page)
      await quitAndClose(app)
      expect(liveTmuxSessions(env)).toContain(`k-${id}`)

      fs.writeFileSync(
        path.join(machineHome(env), 'fake-agy-delay'),
        TURN_LONGER_THAN_A_MIRROR_PULL_MS
      )
      app = await launchApp(env)
      page = await app.firstWindow()
      await waitBooted(page)
      const row = wsRows(page, REMOTE_WS_NAME).filter({ hasText: 'survive a restart' })
      await expect(row).not.toHaveClass(/cold/, { timeout: 90_000 })
      await expect.poll(async () => (await boundRemote(page)).id).toBe(id)
      expect(remoteCalls(env)).toHaveLength(1)
      await runIn(page, centerTerm(page), 'after the restart')
      await expect(row).toHaveClass(/st-working/, { timeout: 60_000 })
      await expect(row).toHaveClass(/st-waiting/, { timeout: 60_000 })
    } finally {
      await quitAndClose(app)
    }
  })
})
