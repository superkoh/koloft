import fs from 'fs'
import path from 'path'
import { test, expect, launchApp, pendingAttention, quitAndClose } from './helpers/app'
import { E2E_AGY_ACCOUNT, installAgy, seedSettings, type E2EEnv } from './helpers/env'
import {
  centerTerm,
  chooseBackend,
  gitRepoWithAnIncludedEnv,
  INCLUDED_ENV,
  killSession,
  newSessionInWith,
  openWorktreeSession,
  runIn,
  sendShortcut,
  startSessionIn,
  terminalText,
  waitBooted,
  worktreeDialog,
  wsMenuTexts,
  wsRows
} from './helpers/p1'
import {
  REMOTE_WS_NAME,
  agyReady,
  boundRemoteAgy,
  installFakeRemote,
  installRemoteAgy,
  killFakeRemote,
  liveTmuxSessions,
  machineAgyApiCalls,
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

  // AGY§4 AGY§11 AGY§12 AGY§31
  test("an Antigravity session in a remote workspace runs agy in tmux on that machine, on the account's own folder there linked to the machine's ~/.gemini with Koloft's scripts, the koloft skill and the API key, the account named above agy's screen; its row binds, takes agy's title and goes working then done", async ({
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
      const skill = path.join(accountFolder(env), 'antigravity-cli', 'skills', 'koloft', 'SKILL.md')
      expect(fs.lstatSync(skill).isFile()).toBe(true)
      expect(fs.readFileSync(skill, 'utf8')).toMatch(/^---\nname: koloft\n/)

      await agyReady(page)
      await expect(page.locator('.term-wrap:visible .xterm')).toContainText(
        `koloft: → ${E2E_AGY_ACCOUNT}`
      )
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

  test('an Antigravity worktree session in a remote workspace runs agy on the machine in a worktree made there, with the ignored files .worktreeinclude lists copied in there', async ({
    env
  }) => {
    setUp(env)
    gitRepoWithAnIncludedEnv(remoteDir(env))
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await expect
        .poll(async () => (await wsMenuTexts(page, REMOTE_WS_NAME)).join(' | '), {
          timeout: 60_000
        })
        .toContain('New worktree session')
      await openWorktreeSession(page, REMOTE_WS_NAME)
      await worktreeDialog(page).locator('input').fill('agy-tree')
      await chooseBackend(page, 'Antigravity')
      await expect.poll(() => machineAgyCalls(env).length, { timeout: 90_000 }).toBe(1)
      const tree = path.join(remoteDir(env), '.claude', 'worktrees', 'agy-tree')
      expect(fs.realpathSync(machineAgyCalls(env)[0].cwd)).toBe(fs.realpathSync(tree))
      expect(fs.readFileSync(path.join(tree, '.env'), 'utf8')).toBe(INCLUDED_ENV)
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

  test('an Antigravity agent that dies on the machine leaves its tab saying it ended with its exit code until Enter, then Koloft says it ended unexpectedly and its row stays with the “exited” mark, not dropped as if it had quit on its own', async ({
    env
  }) => {
    setUp(env)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await newSessionInWith(page, REMOTE_WS_NAME, 'Antigravity')
      await agyReady(page)
      await runIn(page, centerTerm(page), 'die remote')
      const row = wsRows(page, REMOTE_WS_NAME).filter({ hasText: 'die remote' })
      await expect(row).toHaveClass(/st-waiting/, { timeout: 60_000 })
      const { tabId } = await boundRemoteAgy(page)

      killSession(machineAgyCalls(env)[0].pid, env)

      await expect
        .poll(() => terminalText(page, tabId), { timeout: 30_000 })
        .toContain('stopped with exit code 137')
      await page.evaluate((id) => window.api.terminal.write(id, '\r'), tabId)
      await expect(
        page.locator('.toast', {
          hasText: 'Antigravity session ended unexpectedly (exit code 137)'
        })
      ).toBeVisible()
      await expect
        .poll(async () => (await pendingAttention(page)).map((a) => a.kind), { timeout: 60_000 })
        .toContain('exited')
      await expect(row).toHaveCount(1)
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

  // AGY§16 AGY§29
  test("koloft session send from a session on this Mac reaches a remote Antigravity tab through agy's own API on that machine, not typed into its screen", async ({
    env
  }) => {
    setUp(env)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await newSessionInWith(page, REMOTE_WS_NAME, 'Antigravity')
      await agyReady(page)
      await runIn(page, centerTerm(page), 'first turn')
      await expect(wsRows(page, REMOTE_WS_NAME).filter({ hasText: 'first turn' })).toHaveClass(
        /st-waiting/,
        { timeout: 60_000 }
      )
      const agy = await boundRemoteAgy(page)

      await startSessionIn(page, 'ws-a')
      let sender = ''
      await expect
        .poll(async () => {
          const all = await page.evaluate(() => window.api.sessions.list())
          sender = all.find((s) => s.backendId === 'claude' && s.alive)?.tabId ?? ''
          return sender
        })
        .not.toBe('')
      await page.evaluate(
        ([tab, line]) => window.api.terminal.write(tab, line + '\r'),
        [sender, `/koloft session send ${agy.id} hello from the mac`]
      )

      await expect
        .poll(async () => (await terminalText(page, sender)).replace(/\s+/g, ''), {
          timeout: 60_000
        })
        .toMatch(/Sentto.+koloftexit=0/)
      const sentThroughTheApi = machineAgyApiCalls(env)
        .filter((c) => c.method === 'SendUserCascadeMessage' && c.authorized)
        .map((c) => JSON.stringify(c.body))
      expect(sentThroughTheApi.join('\n')).toMatch(
        new RegExp(`"cascadeId":"${agy.id}".*hello from the mac`)
      )
      const typedIntoAgy = fs.readFileSync(
        path.join(accountFolder(env), 'antigravity-cli', 'history.jsonl'),
        'utf8'
      )
      expect(typedIntoAgy).toContain('first turn')
      expect(typedIntoAgy).not.toContain('hello from the mac')
    } finally {
      await quitAndClose(app)
    }
  })
})
