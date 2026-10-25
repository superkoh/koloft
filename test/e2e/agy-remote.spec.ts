import fs from 'fs'
import path from 'path'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { E2E_AGY_ACCOUNT, installAgy, seedSettings, type E2EEnv } from './helpers/env'
import { centerTerm, newSessionInWith, runIn, sendShortcut, waitBooted, wsRows } from './helpers/p1'
import {
  REMOTE_WS_NAME,
  agyReady,
  boundRemoteAgy,
  installFakeRemote,
  installRemoteAgy,
  killFakeRemote,
  liveTmuxSessions,
  machineAgyCalls,
  machineHome,
  remoteDir,
  seedRemoteWorkspace
} from './helpers/remote'

test.afterEach(({ env }) => killFakeRemote(env))

const TURN_LONGER_THAN_A_MIRROR_PULL_MS = '5000'

const accountFolder = (env: E2EEnv): string =>
  path.join(machineHome(env), '.koloft', 'agy', E2E_AGY_ACCOUNT)

function setUp(env: E2EEnv): void {
  installAgy(env)
  installFakeRemote(env)
  installRemoteAgy(env)
  seedRemoteWorkspace(env)
  seedSettings(env, { hintsOff: true })
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
      await expect.poll(() => machineAgyCalls(env).length, { timeout: 90_000 }).toBe(1)
      const [call] = machineAgyCalls(env)
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
      const { id } = await boundRemoteAgy(page)
      expect(liveTmuxSessions(env)).toContain(`k-${id}`)
    } finally {
      await quitAndClose(app)
    }
  })

  // AGY§9
  test("closing the remote tab ends agy's tmux session there; its row stays, cold, and clicking it resumes the same conversation on the machine, whose resuming mask lifts once the tab binds to it", async ({
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
      const { id } = await boundRemoteAgy(page)
      await sendShortcut(app, 'shortcut:close-tab')
      await expect.poll(() => liveTmuxSessions(env), { timeout: 30_000 }).not.toContain(`k-${id}`)
      await expect(row).toHaveClass(/cold/, { timeout: 30_000 })
      await row.click()
      await expect.poll(() => machineAgyCalls(env).length, { timeout: 90_000 }).toBe(2)
      expect(machineAgyCalls(env)[1].argv).toContain(`--conversation=${id}`)
      expect((await boundRemoteAgy(page)).id).toBe(id)
      await expect(page.locator('.term-wrap:visible .empty', { hasText: 'Resuming' })).toHaveCount(
        0
      )
    } finally {
      await quitAndClose(app)
    }
  })

  // AGY§8
  test('⇧⌘R on a remote Antigravity tab before its first prompt restarts nothing and says there is nothing to restart yet; agy there keeps taking prompts', async ({
    env
  }) => {
    setUp(env)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await newSessionInWith(page, REMOTE_WS_NAME, 'Antigravity')
      await agyReady(page)

      await sendShortcut(app, 'shortcut:restart-session')
      await expect(page.locator('.toast-msg')).toHaveText(
        'Nothing to restart yet — this session has no conversation.',
        { timeout: 20_000 }
      )
      expect(machineAgyCalls(env)).toHaveLength(1)

      await runIn(page, centerTerm(page), 'still here')
      const row = wsRows(page, REMOTE_WS_NAME).filter({ hasText: 'still here' })
      await expect(row).toHaveClass(/st-waiting/, { timeout: 60_000 })
      expect(machineAgyCalls(env)).toHaveLength(1)
    } finally {
      await quitAndClose(app)
    }
  })

  // AGY§11
  test('an Antigravity tab on a remote machine keeps running there while Koloft is closed, and the restarted Koloft attaches to it, reads waiting from the turn that already ended, and follows its turns', async ({
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
      const { id } = await boundRemoteAgy(page)
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
      await expect.poll(async () => (await boundRemoteAgy(page)).id).toBe(id)
      await expect(row).toHaveClass(/st-waiting/, { timeout: 30_000 })
      expect(machineAgyCalls(env)).toHaveLength(1)
      await runIn(page, centerTerm(page), 'after the restart')
      await expect(row).toHaveClass(/st-working/, { timeout: 60_000 })
      await expect(row).toHaveClass(/st-waiting/, { timeout: 60_000 })
    } finally {
      await quitAndClose(app)
    }
  })
})
