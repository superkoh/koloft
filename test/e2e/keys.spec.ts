import fs from 'fs'
import path from 'path'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { runGit, setupGitFixture } from './helpers/gitFixture'
import { installStallingGit } from './helpers/gitSpawnLog'
import { codexCalls, codexRows, startCodex } from './helpers/codex'
import {
  agySessionCalls,
  installAgentFor,
  installCodex,
  seedSettings,
  type E2EEnv
} from './helpers/env'
import {
  addRemoteWorkspace,
  killFakeRemote,
  launchWithRemote,
  OTHER_AGENTS_ON_THE_MACHINE,
  REMOTE_WS_NAME,
  type OtherAgentName
} from './helpers/remote'
import {
  agyConversationOnceFirstTurnEnded,
  centerTerm,
  chooseBackend,
  FAKE_CODEX_SESSION_TITLE,
  gitCommitAll,
  gitInit,
  newSessionInWith,
  openWorktreeSession,
  processAlive,
  runIn,
  sendShortcut,
  snap,
  startSessionIn,
  waitBooted,
  waitForCalls,
  wsRows
} from './helpers/p1'
import { WORKBENCH, openInBrowse, showBrowse, workbenchPanel } from './helpers/workbench'

const A_WORKTREE_REMOVAL_SLOWER_THAN_THE_ROW_TAKES_TO_GO_MS = 10_000

test.describe('Keyboard shortcuts · native accelerators are driven as shortcut:* IPC', () => {
  test('T-KEY-03: ⌘⇧F toggles the file search row; collapsing clears the filter', async ({
    app,
    page
  }) => {
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    const panel = workbenchPanel(page)
    await showBrowse(page)
    await expect(panel.locator('.icobtn[aria-label="Search files"]')).toBeVisible({
      timeout: 20_000
    })
    const readmeRow = page.locator(WORKBENCH.browseRows, { hasText: 'README.md' })
    await expect(readmeRow).toBeVisible({ timeout: 20_000 })

    await sendShortcut(app, 'shortcut:find-files')
    const searchRow = panel.locator('.ft-search.open')
    await expect(searchRow).toBeVisible()
    const input = panel.locator('.ft-search-input')
    await expect(input).toBeFocused()

    await input.fill('app')
    const results = panel.locator('.ft-results')
    await expect(results).toBeVisible()
    await expect(results.locator('.ft-result .ft-name', { hasText: 'app.ts' })).toBeVisible()
    await expect(results.locator('.ft-result', { hasText: 'README.md' })).toHaveCount(0)
    await snap(page, 'T-KEY-03')

    await sendShortcut(app, 'shortcut:find-files')
    await expect(panel.locator('.ft-search.open')).toHaveCount(0)
    await expect(panel.locator('.ft-results')).toHaveCount(0)
    await expect(readmeRow).toBeVisible()

    await sendShortcut(app, 'shortcut:find-files')
    await expect(panel.locator('.ft-search.open')).toBeVisible()
    await expect(input).toHaveValue('')
  })

  test('T-KEY-04: ⌘F opens the preview find bar, counts matches typed through real key events without freezing the renderer, Esc closes it', async ({
    app,
    page,
    env
  }) => {
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    await openInBrowse(page, path.join(env.workspaces.a, 'README.md'))
    await expect(page.locator(WORKBENCH.readingTitle)).toHaveText('README.md', { timeout: 15_000 })

    await sendShortcut(app, 'shortcut:find')
    const bar = page.locator('.find-bar')
    await expect(bar).toBeVisible()
    await expect(bar.locator('.find-input')).toBeFocused()

    // PLATFORM§25
    await page.keyboard.type('koloft-e2e-alpha')
    await expect(bar.locator('.find-count')).toHaveText('1/1')
    await snap(page, 'T-KEY-04')

    await page.keyboard.press('Escape')
    await expect(page.locator('.find-bar')).toHaveCount(0)
    await expect(page.locator(WORKBENCH.readingTitle)).toHaveText('README.md')
  })

  test('T-KEY-05: File ▸ Close Tab on a working session confirms first — Esc/⏎ both cancel, only Close kills it, and the row stays cold', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(300_000)
    gitInit(env.workspaces.a)
    await startSessionIn(page, 'ws-a')
    const [session] = await waitForCalls(env, 1)
    const row = wsRows(page, 'ws-a').first()

    await runIn(page, centerTerm(page), '/busy')
    await expect(row).toHaveClass(/\bst-working\b/, { timeout: 30_000 })

    const dialog = page.locator('.modal', { hasText: 'Close running session?' })
    const raise = async (): Promise<void> => {
      await sendShortcut(app, 'shortcut:close-tab')
      await expect(dialog).toBeVisible({ timeout: 15_000 })
    }

    await centerTerm(page).click()
    await raise()
    await snap(page, 'T-KEY-05')
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    expect(processAlive(session.pid)).toBe(true)
    await expect(row).not.toHaveClass(/\bcold\b/)

    await row.click()
    await raise()
    await page.keyboard.press('Enter')
    await expect(dialog).toHaveCount(0)
    await page.waitForTimeout(2000)
    expect(processAlive(session.pid)).toBe(true)
    await expect(row).not.toHaveClass(/\bcold\b/)

    await raise()
    // CC§1
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect.poll(() => processAlive(session.pid), { timeout: 30_000 }).toBe(false)
    await expect(row).toHaveClass(/\bcold\b/, { timeout: 40_000 })
    await expect(wsRows(page, 'ws-a')).toHaveCount(1)
  })

  test('T-KEY-06: File ▸ Close Tab on a waiting session closes it silently and leaves a cold row', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(240_000)
    gitInit(env.workspaces.a)
    await startSessionIn(page, 'ws-a')
    const [session] = await waitForCalls(env, 1)
    const row = wsRows(page, 'ws-a').first()
    await expect(row).toHaveClass(/\bst-waiting\b/, { timeout: 40_000 })

    await row.click()
    await sendShortcut(app, 'shortcut:close-tab')
    await expect.poll(() => processAlive(session.pid), { timeout: 30_000 }).toBe(false)
    await expect(page.locator('.modal-backdrop')).toHaveCount(0)
    await expect(row).toHaveClass(/\bcold\b/, { timeout: 40_000 })
    await expect(wsRows(page, 'ws-a')).toHaveCount(1)
    await snap(page, 'T-KEY-06')
  })

  interface InWorktreeSession {
    app: ElectronApplication
    page: Page
    rows: Locator
    tree: string
    clone: string
  }

  async function inWorktreeSession(
    env: E2EEnv,
    body: (s: InWorktreeSession) => Promise<void>
  ): Promise<void> {
    const { clone } = setupGitFixture(env)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      const dlg = await openWorktreeSession(page, 'repo')
      await dlg.getByRole('textbox').click()
      await page.keyboard.type('done')
      await page.keyboard.press('Enter')
      const rows = wsRows(page, 'repo')
      await expect(rows).toHaveCount(1, { timeout: 60_000 })
      await expect(rows).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })
      const tree = path.join(clone, '.claude', 'worktrees', 'done')
      await expect.poll(() => fs.existsSync(path.join(tree, 'NOTES.md'))).toBe(true)
      await rows.click()
      await body({ app, page, rows, tree, clone })
    } finally {
      await quitAndClose(app)
    }
  }

  const fullCloseDialog = (page: Page): Locator =>
    page.locator('.modal', { hasText: 'Close session for good?' })

  test('T-KEY-07: ⌘W on a session whose worktree holds uncommitted work lists it and offers only Close tab only; Esc keeps the session, Close tab only leaves a cold row and the worktree', async ({
    env
  }) => {
    test.setTimeout(180_000)
    await inWorktreeSession(env, async ({ app, page, rows, tree }) => {
      const dialog = fullCloseDialog(page)

      await sendShortcut(app, 'shortcut:close-session')
      await expect(dialog.getByRole('button', { name: 'Close tab only' })).toBeEnabled({
        timeout: 30_000
      })
      await expect(dialog).toContainText('Changes not committed')
      await expect(dialog.getByRole('button', { name: 'Close for good' })).toHaveCount(0)
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
      await expect(rows).not.toHaveClass(/\bcold\b/)

      await sendShortcut(app, 'shortcut:close-session')
      await dialog.getByRole('button', { name: 'Close tab only' }).click()
      await expect(rows).toHaveClass(/\bcold\b/, { timeout: 40_000 })
      await expect(rows).toHaveCount(1)
      expect(fs.existsSync(tree)).toBe(true)
    })
  })

  test('T-KEY-08: ⌘W asks first with Cancel focused, then Close for good takes the row out at once, while git is still deleting the worktree, and deletes the worktree and its branch', async ({
    env
  }) => {
    test.setTimeout(180_000)
    await inWorktreeSession(env, async ({ app, page, rows, tree, clone }) => {
      fs.rmSync(path.join(tree, 'NOTES.md'))
      installStallingGit(env, {
        root: clone,
        subcommand: 'worktree',
        verb: 'remove',
        lastArg: tree,
        ms: A_WORKTREE_REMOVAL_SLOWER_THAN_THE_ROW_TAKES_TO_GO_MS
      })
      const dialog = fullCloseDialog(page)

      await sendShortcut(app, 'shortcut:close-session')
      const go = dialog.getByRole('button', { name: 'Close for good' })
      await expect(go).toBeEnabled({ timeout: 30_000 })
      await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused()
      await snap(page, 'T-KEY-08')
      await go.click()
      await expect(dialog).toHaveCount(0)
      await expect(rows).toHaveCount(0, { timeout: 5_000 })
      expect(fs.existsSync(tree), 'git is still deleting the worktree').toBe(true)

      await expect.poll(() => fs.existsSync(tree), { timeout: 30_000 }).toBe(false)
      await expect.poll(() => runGit(clone, 'branch', '--list', 'worktree-done').trim()).toBe('')
      await expect(rows).toHaveCount(0)
    })
  })

  test('T-KEY-09: ⌘W closes a Codex session for good the same way: its tab and its row go', async ({
    env
  }) => {
    test.setTimeout(180_000)
    installCodex(env)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await startCodex(page, env)
      await expect(codexRows(page)).toHaveCount(1)

      await sendShortcut(app, 'shortcut:close-session')
      const go = fullCloseDialog(page).getByRole('button', { name: 'Close for good' })
      await expect(go).toBeEnabled({ timeout: 30_000 })
      await go.click()
      await expect(codexRows(page)).toHaveCount(0, { timeout: 15_000 })
      await expect(page.locator('.modal-backdrop')).toHaveCount(0)
    } finally {
      await quitAndClose(app)
    }
  })

  async function onlyTabCloseOnAnotherMachine(
    app: ElectronApplication,
    page: Page,
    rows: Locator
  ): Promise<void> {
    await rows.first().click()
    await sendShortcut(app, 'shortcut:close-session')
    const dialog = fullCloseDialog(page)
    const tabOnly = dialog.getByRole('button', { name: 'Close tab only' })
    await expect(tabOnly).toBeEnabled({ timeout: 30_000 })
    await expect(dialog).toContainText('runs on another machine')
    await expect(dialog.getByRole('button', { name: 'Close for good' })).toHaveCount(0)
    await tabOnly.click()
    await expect(rows.first()).toHaveClass(/\bcold\b/, { timeout: 60_000 })
    await expect(rows).toHaveCount(1)
  }

  test('T-KEY-10: ⌘W on a session on another machine says Koloft cannot check what closing would lose there and offers only Close tab only', async ({
    env
  }) => {
    test.setTimeout(180_000)
    const { app, page } = await launchWithRemote(env)
    try {
      await addRemoteWorkspace(page, env)
      await startSessionIn(page, REMOTE_WS_NAME, { remote: true })
      await onlyTabCloseOnAnotherMachine(app, page, wsRows(page, REMOTE_WS_NAME))
    } finally {
      await quitAndClose(app)
      killFakeRemote(env)
    }
  })

  const WORKTREE_SESSIONS_OF_OTHER_AGENTS: {
    label: OtherAgentName
    caseId: string
    firstTurnEnded: (page: Page) => Promise<unknown>
    pidsIn: (env: E2EEnv, tree: string) => number[]
  }[] = [
    {
      label: 'Antigravity',
      caseId: 'T-KEY-11',
      firstTurnEnded: async (page) => {
        await runIn(page, centerTerm(page), 'work in the tree')
        await agyConversationOnceFirstTurnEnded(page)
      },
      pidsIn: (env, tree) =>
        agySessionCalls(env)
          .filter((c) => sameDir(c.cwd, tree))
          .map((c) => c.pid)
    },
    {
      label: 'Codex',
      caseId: 'T-KEY-12',
      firstTurnEnded: (page) =>
        expect(wsRows(page, 'ws-a').filter({ hasText: FAKE_CODEX_SESSION_TITLE })).toHaveClass(
          /\bst-waiting\b/,
          { timeout: 60_000 }
        ),
      pidsIn: (env, tree) =>
        codexCalls(env)
          .filter((c) => sameDir(c.cwd, tree))
          .map((c) => c.pid)
    }
  ]

  const sameDir = (a: string, b: string): boolean =>
    fs.existsSync(a) && fs.existsSync(b) && fs.realpathSync(a) === fs.realpathSync(b)

  const branchesNamed = (repo: string, branch: string): string =>
    runGit(repo, 'branch', '--list', branch).trim()

  for (const agent of WORKTREE_SESSIONS_OF_OTHER_AGENTS) {
    test(`${agent.caseId}: ⌘W closes ${agent.label} worktree sessions for good the same way: the tab ends, the row goes, and the worktree and its branch are deleted`, async ({
      env
    }) => {
      test.setTimeout(180_000)
      installAgentFor(env, agent.label, env.workspaces.a)
      seedSettings(env, { hintsOff: true })
      gitInit(env.workspaces.a)
      gitCommitAll(env.workspaces.a)
      const name = `${agent.label.toLowerCase()}-done`
      const app = await launchApp(env)
      try {
        const page = await app.firstWindow()
        await waitBooted(page)
        const dialog = await openWorktreeSession(page, 'ws-a')
        await dialog.locator('input').fill(name)
        await chooseBackend(page, agent.label)
        await agent.firstTurnEnded(page)
        const rows = wsRows(page, 'ws-a')
        await expect(rows).toHaveCount(1)
        const tabId = (await rows.getAttribute('data-tab-id'))!
        const live = await page.evaluate(() => window.api.sessions.list())
        const tree = live.find((s) => s.tabId === tabId)!.cwd
        expect(path.basename(tree)).toBe(name)
        const branch = `worktree-${name}`
        expect(branchesNamed(env.workspaces.a, branch)).not.toBe('')
        const pids = agent.pidsIn(env, tree)
        expect(pids.length).toBeGreaterThan(0)
        expect(pids.every(processAlive)).toBe(true)

        await sendShortcut(app, 'shortcut:close-session')
        const go = fullCloseDialog(page).getByRole('button', { name: 'Close for good' })
        await expect(go).toBeEnabled({ timeout: 30_000 })
        await go.click()
        await expect(page.locator('.modal-backdrop')).toHaveCount(0)
        await expect(rows).toHaveCount(0, { timeout: 15_000 })
        await expect.poll(() => pids.some(processAlive), { timeout: 30_000 }).toBe(false)
        await expect.poll(() => fs.existsSync(tree), { timeout: 30_000 }).toBe(false)
        await expect.poll(() => branchesNamed(env.workspaces.a, branch)).toBe('')
      } finally {
        await quitAndClose(app)
      }
    })
  }

  const REMOTE_CASE_IDS: Record<OtherAgentName, string> = {
    Codex: 'T-KEY-13',
    Antigravity: 'T-KEY-14'
  }

  for (const agent of OTHER_AGENTS_ON_THE_MACHINE) {
    test(`${REMOTE_CASE_IDS[agent.label]}: ⌘W on ${agent.label} sessions on another machine offers only Close tab only, as for Claude there`, async ({
      env
    }) => {
      test.setTimeout(180_000)
      agent.install(env)
      seedSettings(env, { hintsOff: true })
      const { app, page } = await launchWithRemote(env)
      try {
        await addRemoteWorkspace(page, env)
        await newSessionInWith(page, REMOTE_WS_NAME, agent.label)
        await agent.bound?.(page)
        const rows = wsRows(page, REMOTE_WS_NAME)
        await expect(rows.first()).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })
        await onlyTabCloseOnAnotherMachine(app, page, rows)
      } finally {
        await quitAndClose(app)
        killFakeRemote(env)
      }
    })
  }
})
