import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, launchApp, pendingAttention, quitAndClose } from './helpers/app'
import {
  E2E_AGY_ACCOUNT,
  agyTranscriptOf,
  installAgy,
  seedSettings,
  type E2EEnv
} from './helpers/env'
import {
  centerTerm,
  chooseBackend,
  gitCommitAll,
  gitInit,
  gitRepoWithAnIncludedEnv,
  INCLUDED_ENV,
  killSession,
  newSessionInWith,
  oneStillRunning,
  openWorktreeSession,
  runIn,
  sendShortcut,
  sendTwoLinesJoinedByShiftEnter,
  startSessionIn,
  terminalText,
  TWO_LINE_PROMPT,
  waitBooted,
  worktreeDialog,
  wsMenuTexts,
  wsRows
} from './helpers/p1'
import {
  REMOTE_WS_NAME,
  agyReady,
  boundRemoteSession,
  installFakeRemote,
  installRemoteAgy,
  killFakeRemote,
  liveTmuxSessions,
  machineAgyApiCalls,
  machineAgyCalls,
  machineHome,
  remoteDir,
  seedRemoteWorkspace,
  sshCommands
} from './helpers/remote'
import { turnOffItsOnlyAccountRestartAndSeeWhy } from './helpers/restartNoAccount'

test.afterEach(({ env }) => killFakeRemote(env))

const TURN_LONGER_THAN_A_MIRROR_PULL_MS = '5000'
const BACKGROUND_COMMAND_OUTLASTING_MIRROR_PULLS_S = 15
const MODEL_CALL_THAT_NEVER_ANSWERS_ON_ITS_OWN_MS = '600000'

const accountFolder = (env: E2EEnv): string =>
  path.join(machineHome(env), '.koloft', 'agy', E2E_AGY_ACCOUNT)

function setUp(env: E2EEnv): void {
  installAgy(env)
  installFakeRemote(env)
  installRemoteAgy(env)
  seedRemoteWorkspace(env)
  seedSettings(env, { hintsOff: true })
}

const worktreeAddsOnTheMachine = (env: E2EEnv): number =>
  sshCommands(env).filter((c) => c.includes("'worktree' 'add'")).length

const machineTranscriptOf = (env: E2EEnv, id: string): string =>
  agyTranscriptOf(env, id, path.join(machineHome(env), '.gemini'))

function accountForgetsTrustIn(env: E2EEnv, tree: string): void {
  const file = path.join(accountFolder(env), 'antigravity-cli', 'settings.json')
  const settings = JSON.parse(fs.readFileSync(file, 'utf8')) as { trustedWorkspaces: string[] }
  const before = settings.trustedWorkspaces.length
  settings.trustedWorkspaces = settings.trustedWorkspaces.filter(
    (dir) => !fs.existsSync(dir) || fs.realpathSync(dir) !== fs.realpathSync(tree)
  )
  expect(settings.trustedWorkspaces.length).toBeLessThan(before)
  fs.writeFileSync(file, JSON.stringify(settings))
}

async function coldRemoteAgyWorktreeRow(
  app: ElectronApplication,
  page: Page,
  env: E2EEnv,
  name: string
): Promise<{ id: string; tree: string; row: ReturnType<typeof wsRows> }> {
  await expect
    .poll(async () => (await wsMenuTexts(page, REMOTE_WS_NAME)).join(' | '), {
      timeout: 60_000
    })
    .toContain('New worktree session')
  await openWorktreeSession(page, REMOTE_WS_NAME)
  await worktreeDialog(page).locator('input').fill(name)
  await chooseBackend(page, 'Antigravity')
  await expect.poll(() => machineAgyCalls(env).length, { timeout: 90_000 }).toBe(1)
  const tree = machineAgyCalls(env)[0].cwd
  await agyReady(page)
  await runIn(page, centerTerm(page), `first words in ${name}`)
  const row = wsRows(page, REMOTE_WS_NAME).filter({ hasText: `first words in ${name}` })
  await expect(row).toHaveClass(/st-waiting/, { timeout: 60_000 })
  const { id } = await boundRemoteSession(page, 'agy')
  fs.writeFileSync(path.join(tree, 'kept.txt'), 'committed on the branch')
  gitCommitAll(tree)
  await sendShortcut(app, 'shortcut:close-tab')
  await expect(row).toHaveClass(/cold/, { timeout: 30_000 })
  expect(fs.existsSync(tree)).toBe(true)
  accountForgetsTrustIn(env, tree)
  return { id, tree, row }
}

async function resumedInTreeTakingFirstLineAsPrompt(
  page: Page,
  env: E2EEnv,
  id: string,
  tree: string
): Promise<void> {
  await expect.poll(() => machineAgyCalls(env).length, { timeout: 90_000 }).toBe(2)
  const resume = machineAgyCalls(env)[1]
  expect(resume.argv).toContain(`--conversation=${id}`)
  expect(fs.realpathSync(resume.cwd)).toBe(fs.realpathSync(tree))
  expect((await boundRemoteSession(page, 'agy')).id).toBe(id)
  await expect(page.locator('.term-wrap:visible .empty', { hasText: 'Resuming' })).toHaveCount(0)
  await runIn(page, centerTerm(page), 'words after resuming')
  await expect
    .poll(() => machineTranscriptOf(env, id), { timeout: 60_000 })
    .toContain('Answer to: words after resuming')
  expect(await terminalText(page, (await boundRemoteSession(page, 'agy')).tabId)).not.toContain(
    'Do you trust the contents of this project?'
  )
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
      const { id } = await boundRemoteSession(page, 'agy')
      expect(liveTmuxSessions(env)).toContain(`k-${id}`)
      await runIn(page, centerTerm(page), '/write remote-notes.txt')
      await expect(row.locator('.ws-tab-act')).toHaveText('Last: Wrote remote-notes.txt', {
        timeout: 60_000
      })
    } finally {
      await quitAndClose(app)
    }
  })

  // AGY§15 PLATFORM§35
  test('⇧⏎ in a remote Antigravity tab reaches agy through ssh and tmux as a new line in the prompt, and ⏎ then sends both lines as one prompt', async ({
    env
  }) => {
    setUp(env)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await newSessionInWith(page, REMOTE_WS_NAME, 'Antigravity')
      await agyReady(page)
      await sendTwoLinesJoinedByShiftEnter(page, centerTerm(page))
      const { id } = await boundRemoteSession(page, 'agy')
      await expect
        .poll(() => agyTranscriptOf(env, id, path.join(machineHome(env), '.gemini')), {
          timeout: 60_000
        })
        .toContain(JSON.stringify(`Answer to: ${TWO_LINE_PROMPT}`).slice(1, -1))
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

  // AGY§5
  test('a cold Antigravity worktree row in a remote workspace agy trusts resumes in its worktree on the machine, trusted there for it even on an account that never trusted that folder, so the first line typed is a prompt agy answers, not a reply to its trust question', async ({
    env
  }) => {
    setUp(env)
    gitInit(remoteDir(env))
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      const { id, tree, row } = await coldRemoteAgyWorktreeRow(app, page, env, 'agy-cold')
      await row.click()
      await resumedInTreeTakingFirstLineAsPrompt(page, env, id, tree)
    } finally {
      await quitAndClose(app)
    }
  })

  // AGY§5
  test('a cold Antigravity worktree row whose worktree is gone from the machine rebuilds it there with git and resumes the same conversation in it, trusted there for it, so the first line typed is a prompt agy answers, not a reply to its trust question', async ({
    env
  }) => {
    setUp(env)
    gitInit(remoteDir(env))
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      const { id, tree, row } = await coldRemoteAgyWorktreeRow(app, page, env, 'agy-gone')
      execFileSync('git', ['-C', remoteDir(env), 'worktree', 'remove', '--force', '--force', tree])
      expect(fs.existsSync(tree)).toBe(false)
      const addsBefore = worktreeAddsOnTheMachine(env)
      await row.click()
      await resumedInTreeTakingFirstLineAsPrompt(page, env, id, tree)
      expect(worktreeAddsOnTheMachine(env)).toBe(addsBefore + 1)
      expect(fs.readFileSync(path.join(tree, 'kept.txt'), 'utf8')).toBe('committed on the branch')
    } finally {
      await quitAndClose(app)
    }
  })

  // AGY§11 AGY§13
  test('a command agy leaves running in the background on the machine shows on its row breathing green with ↻, named by its command line, until it ends', async ({
    env
  }) => {
    setUp(env)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await newSessionInWith(page, REMOTE_WS_NAME, 'Antigravity')
      await agyReady(page)
      await runIn(
        page,
        centerTerm(page),
        `/bg sleep ${BACKGROUND_COMMAND_OUTLASTING_MIRROR_PULLS_S}`
      )
      const row = wsRows(page, REMOTE_WS_NAME)
      await expect(row).toHaveClass(/\bst-bg-run\b/, { timeout: 60_000 })
      await oneStillRunning(row).click()
      await expect(page.locator('.tbu-pop.parked')).toContainText(
        `command · sleep ${BACKGROUND_COMMAND_OUTLASTING_MIRROR_PULLS_S} · working`
      )
      await page.keyboard.press('Escape')
      await expect(row).not.toHaveClass(/\bst-bg-run\b/, { timeout: 60_000 })
      await expect(row).toHaveClass(/st-waiting/, { timeout: 60_000 })
    } finally {
      await quitAndClose(app)
    }
  })

  // AGY§29
  test('a command ask declined with 4 in a remote Antigravity tab takes its row off waiting for approval at once, before any next turn', async ({
    env
  }) => {
    setUp(env)
    seedSettings(env, { skipPermissions: false })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await newSessionInWith(page, REMOTE_WS_NAME, 'Antigravity')
      await agyReady(page)
      await runIn(page, centerTerm(page), 'first turn')
      const row = wsRows(page, REMOTE_WS_NAME)
      await expect(row).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })
      const { tabId } = await boundRemoteSession(page, 'agy')
      await page.evaluate((t) => window.api.terminal.write(t, '/bash echo declined\r'), tabId)
      await expect(row).toHaveClass(/\bst-approval\b/, { timeout: 60_000 })
      await page.evaluate((t) => window.api.terminal.write(t, '4'), tabId)
      await expect.poll(() => terminalText(page, tabId)).toContain('User declined the tool call')
      await expect(row).toHaveClass(/\bst-waiting\b/, { timeout: 30_000 })
    } finally {
      await quitAndClose(app)
    }
  })

  // AGY§29
  test('Esc in the middle of a turn in a remote Antigravity tab, which ends the turn with no Stop, takes its row off working at once, before any next turn', async ({
    env
  }) => {
    setUp(env)
    fs.writeFileSync(
      path.join(machineHome(env), 'fake-agy-delay'),
      MODEL_CALL_THAT_NEVER_ANSWERS_ON_ITS_OWN_MS
    )
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await newSessionInWith(page, REMOTE_WS_NAME, 'Antigravity')
      await agyReady(page)
      await runIn(page, centerTerm(page), 'a long turn')
      const row = wsRows(page, REMOTE_WS_NAME)
      await expect(row).toHaveClass(/\bst-working\b/, { timeout: 60_000 })
      const { tabId } = await boundRemoteSession(page, 'agy')
      await page.evaluate((t) => window.api.terminal.write(t, '\x1b'), tabId)
      await expect.poll(() => terminalText(page, tabId)).toContain('Interrupted')
      await expect(row).toHaveClass(/\bst-waiting\b/, { timeout: 30_000 })
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
      const { id } = await boundRemoteSession(page, 'agy')
      await sendShortcut(app, 'shortcut:close-tab')
      await expect.poll(() => liveTmuxSessions(env), { timeout: 30_000 }).not.toContain(`k-${id}`)
      await expect(row).toHaveClass(/cold/, { timeout: 30_000 })
      await row.click()
      await expect.poll(() => machineAgyCalls(env).length, { timeout: 90_000 }).toBe(2)
      expect(machineAgyCalls(env)[1].argv).toContain(`--conversation=${id}`)
      expect((await boundRemoteSession(page, 'agy')).id).toBe(id)
      await expect(page.locator('.term-wrap:visible .empty', { hasText: 'Resuming' })).toHaveCount(
        0
      )
    } finally {
      await quitAndClose(app)
    }
  })

  test('an Antigravity agent that dies on the machine keeps its tab: the screen says its exit code, Koloft says it ended unexpectedly with no key pressed, and its row stays saying “exited (code 137)” with the “exited” mark', async ({
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
      const { tabId } = await boundRemoteSession(page, 'agy')

      killSession(machineAgyCalls(env)[0].pid, env)

      await expect
        .poll(() => terminalText(page, tabId), { timeout: 30_000 })
        .toContain('stopped with exit code 137')
      await expect(
        page.locator('.toast', {
          hasText: 'Antigravity session ended unexpectedly (exit code 137)'
        })
      ).toBeVisible()
      await expect(row.locator('.ws-tab-sub')).toContainText('exited (code 137)')
      await expect
        .poll(() => terminalText(page, tabId))
        .toContain('[Koloft] Antigravity session ended unexpectedly (exit code 137)')
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

  test('with no Antigravity account usable, restarting a remote Antigravity session says why, keeps agy running in its tmux session on the machine, and starts no other there', async ({
    env
  }) => {
    setUp(env)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await newSessionInWith(page, REMOTE_WS_NAME, 'Antigravity')
      await agyReady(page)
      await runIn(page, centerTerm(page), 'one turn')
      const row = wsRows(page, REMOTE_WS_NAME).filter({ hasText: 'one turn' })
      await expect(row).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })
      const { id } = await boundRemoteSession(page, 'agy')

      await turnOffItsOnlyAccountRestartAndSeeWhy(app, page, 'agy')
      await expect(row).toHaveClass(/\bst-waiting\b/)
      await expect(row).not.toHaveClass(/\bcold\b/)
      expect(liveTmuxSessions(env)).toContain(`k-${id}`)
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
      const { id } = await boundRemoteSession(page, 'agy')
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
      await expect.poll(async () => (await boundRemoteSession(page, 'agy')).id).toBe(id)
      await expect(row).toHaveClass(/st-waiting/, { timeout: 30_000 })
      expect(machineAgyCalls(env)).toHaveLength(1)
      await agyReady(page)
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
      const agy = await boundRemoteSession(page, 'agy')

      await startSessionIn(page, 'ws-a', { method: 'Claude' })
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

  // AGY§19
  test('a plan a remote Antigravity session waits on is an Inbox card quoting the whole plan from the machine; Approve there tells agy on the machine the plan is approved', async ({
    env
  }) => {
    setUp(env)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await newSessionInWith(page, REMOTE_WS_NAME, 'Antigravity')
      await agyReady(page)
      await runIn(page, centerTerm(page), '/plan')
      await expect(wsRows(page, REMOTE_WS_NAME)).toHaveClass(/\bst-approval\b/, {
        timeout: 60_000
      })
      await page.locator('.ibx-entry').click()
      const card = page.locator('.inbox-page .ibx-item', {
        has: page.locator('.ibx-what', { hasText: 'asks you to approve a plan' })
      })
      await expect(card.locator('.ibx-quote')).toContainText('1. Do the thing.')
      await card.locator('.ibx-btn', { hasText: 'Approve' }).click()
      await expect
        .poll(
          () =>
            machineAgyApiCalls(env)
              .filter((c) => c.method === 'SendUserCascadeMessage')
              .map((c) => JSON.stringify(c.body))
              .join('\n'),
          { timeout: 60_000 }
        )
        .toContain('[Approved] implementation_plan.md')
    } finally {
      await quitAndClose(app)
    }
  })
})
