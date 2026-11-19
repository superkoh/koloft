import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { launchSettled } from './helpers/blackbox'
import {
  type AgentName,
  agyConversationOnceFirstTurnEnded,
  centerTerm,
  gitInit,
  newSessionInWith,
  openWorktreeSession,
  runIn,
  snap,
  startSessionIn,
  waitBooted,
  waitStartupTurnOver
} from './helpers/p1'
import {
  OTHER_AGENTS_ON_THE_MACHINE,
  REMOTE_WS_NAME,
  addRemoteWorkspace,
  agyReady,
  killFakeRemote,
  launchWithRemote,
  machineHome,
  remoteDir
} from './helpers/remote'
import { installAgentFor, writeGitIdentity, type E2EEnv } from './helpers/env'
import { showBrowse, waitPanelAttached } from './helpers/workbench'

const gitButton = (page: Page): Locator => page.locator('.wb-git')
const gitMenuItem = (page: Page, name: string): Locator =>
  page.locator('.wb-gitmenu .mi', { hasText: name })
const commitDialog = (page: Page): Locator => page.locator('.modal', { hasText: 'Commit changes' })
const toast = (page: Page): Locator => page.locator('.toast-msg')

function gitOut(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
}

function repoOn(dir: string, home: string, branch: string): void {
  writeGitIdentity(home)
  fs.writeFileSync(path.join(dir, '.gitignore'), 'NOTES.md\n')
  gitInit(dir)
  gitOut(dir, 'switch', '-q', '-c', branch)
}

function commitEverything(dir: string): void {
  gitOut(dir, 'add', '-A')
  gitOut(
    dir,
    '-c',
    'user.email=e2e@koloft.test',
    '-c',
    'user.name=koloft-e2e',
    'commit',
    '-qm',
    'base'
  )
}

function addOrigin(dir: string, home: string): string {
  const origin = path.join(home, 'origin.git')
  gitOut(home, 'init', '-q', '--bare', origin)
  gitOut(dir, 'remote', 'add', 'origin', origin)
  return origin
}

async function commitThroughTheMenu(page: Page, dir: string, file: string): Promise<void> {
  fs.writeFileSync(path.join(dir, file), 'new\n')
  await gitButton(page).click()
  await expect(gitMenuItem(page, 'Commit…')).not.toHaveClass(/\bdisabled\b/, { timeout: 30_000 })
  await gitMenuItem(page, 'Commit…').click()
  await commitDialog(page).getByLabel('Commit message').fill(`add ${file}`)
  await commitDialog(page).getByLabel('Commit message').press('Enter')
  await expect(commitDialog(page)).toHaveCount(0, { timeout: 60_000 })
  await expect(toast(page)).toHaveText('Committed.')
  expect(gitOut(dir, 'log', '-1', '--format=%s')).toBe(`add ${file}`)
  expect(gitOut(dir, 'show', '--name-only', '--format=', 'HEAD')).toContain(file)
}

async function pushThroughTheMenu(
  page: Page,
  dir: string,
  origin: string,
  branch: string
): Promise<void> {
  await gitButton(page).click()
  await gitMenuItem(page, 'Push').click()
  await expect(toast(page)).toHaveText('Pushed.', { timeout: 60_000 })
  expect(gitOut(origin, 'rev-parse', `refs/heads/${branch}`)).toBe(gitOut(dir, 'rev-parse', 'HEAD'))
}

function holdPushesUntil(origin: string, go: string): void {
  const hook = path.join(origin, 'hooks', 'pre-receive')
  fs.writeFileSync(hook, `#!/bin/sh\nwhile [ ! -f '${go}' ]; do sleep 0.1; done\ncat >/dev/null\n`)
  fs.chmodSync(hook, 0o755)
}

test.describe('Workbench · Commit… and Push for any git repository: a branch button in the tab strip, there with GitHub or without it', () => {
  test('GE1: a session in a repository that is not on GitHub gets the branch button; Commit… commits every change, Push sends the branch to origin and reads Pushing… meanwhile', async ({
    env
  }) => {
    test.setTimeout(240_000)
    const dir = env.workspaces.a
    repoOn(dir, env.home, 'feature/login')
    const origin = addOrigin(dir, env.home)
    const go = path.join(env.home, 'go-push')
    holdPushesUntil(origin, go)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await startSessionIn(page, 'ws-a')
      await waitPanelAttached(page)
      await expect(gitButton(page)).toHaveText('feature/login', { timeout: 30_000 })
      await expect(gitButton(page)).toHaveAttribute(
        'aria-label',
        'Commit or push feature/login · click for more'
      )
      await expect(page.locator('.wb-gh')).toHaveCount(0)

      await commitThroughTheMenu(page, dir, 'GE1-new.txt')

      await gitButton(page).click()
      await expect(gitMenuItem(page, 'Push')).toHaveAttribute(
        'title',
        'Push feature/login to the same branch on origin and track it'
      )
      await gitMenuItem(page, 'Push').click()
      await expect(gitButton(page)).toHaveText('Pushing…')
      await gitButton(page).click()
      await expect(gitMenuItem(page, 'Pushing…')).toHaveClass(/\bdisabled\b/)
      await snap(page, 'GE1-pushing')
      await page.keyboard.press('Escape')
      fs.writeFileSync(go, '')
      await expect(toast(page)).toHaveText('Pushed.', { timeout: 60_000 })
      await expect(gitButton(page)).toHaveText('feature/login')
      expect(gitOut(origin, 'rev-parse', 'refs/heads/feature/login')).toBe(
        gitOut(dir, 'rev-parse', 'HEAD')
      )
      expect(gitOut(dir, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('origin/feature/login')
    } finally {
      await quitAndClose(app)
    }
  })

  test("GE2: a workspace's own Workbench, with no session, gets the button too; Commit… is greyed while there is nothing to commit and Push while there is no origin, each saying why", async ({
    env
  }) => {
    test.setTimeout(180_000)
    const dir = env.workspaces.a
    repoOn(dir, env.home, 'main-line')
    commitEverything(dir)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await showBrowse(page, true)
      await expect(gitButton(page)).toHaveText('main-line', { timeout: 30_000 })

      await gitButton(page).click()
      await expect(gitMenuItem(page, 'Commit…')).toHaveClass(/\bdisabled\b/, { timeout: 30_000 })
      await expect(gitMenuItem(page, 'Commit…')).toHaveAttribute('title', 'Nothing to commit')
      await expect(gitMenuItem(page, 'Push')).toHaveClass(/\bdisabled\b/)
      await expect(gitMenuItem(page, 'Push')).toHaveAttribute(
        'title',
        'No remote named origin to push to'
      )
      await snap(page, 'GE2-nothing-no-origin')
      await page.keyboard.press('Escape')

      await commitThroughTheMenu(page, dir, 'GE2-new.txt')
    } finally {
      await quitAndClose(app)
    }
  })

  test('GE3: the button follows the checkout as git moves it from outside Koloft: a detached HEAD reads so and cannot push, a new branch shows at once', async ({
    env
  }) => {
    test.setTimeout(180_000)
    const dir = env.workspaces.a
    repoOn(dir, env.home, 'feature/login')
    addOrigin(dir, env.home)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await startSessionIn(page, 'ws-a')
      await waitPanelAttached(page)
      await expect(gitButton(page)).toHaveText('feature/login', { timeout: 30_000 })

      gitOut(dir, 'checkout', '-q', '--detach')
      await expect(gitButton(page)).toHaveText('detached HEAD', { timeout: 30_000 })
      await gitButton(page).click()
      await expect(gitMenuItem(page, 'Push')).toHaveClass(/\bdisabled\b/)
      await expect(gitMenuItem(page, 'Push')).toHaveAttribute('title', 'Not on a branch')
      await page.keyboard.press('Escape')

      gitOut(dir, 'switch', '-q', '-c', 'fix/typo')
      await expect(gitButton(page)).toHaveText('fix/typo', { timeout: 30_000 })
    } finally {
      await quitAndClose(app)
    }
  })

  test('GE4: a worktree session commits and pushes its own worktree-<name> branch, leaving the main checkout as it was', async ({
    env
  }) => {
    test.setTimeout(240_000)
    const dir = env.workspaces.a
    repoOn(dir, env.home, 'main-line')
    const origin = addOrigin(dir, env.home)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      const dlg = await openWorktreeSession(page, 'ws-a')
      await dlg.getByRole('textbox').click()
      await page.keyboard.type('ge4')
      await page.keyboard.press('Enter')
      await expect(dlg).toHaveCount(0)
      await waitPanelAttached(page)
      await expect(gitButton(page)).toHaveText('worktree-ge4', { timeout: 30_000 })

      const tree = path.join(dir, '.claude', 'worktrees', 'ge4')
      const mainHead = gitOut(dir, 'rev-parse', 'HEAD')
      await commitThroughTheMenu(page, tree, 'GE4-new.txt')
      await pushThroughTheMenu(page, tree, origin, 'worktree-ge4')
      expect(gitOut(dir, 'rev-parse', 'HEAD')).toBe(mainHead)
    } finally {
      await quitAndClose(app)
    }
  })

  test('GE5: a folder that is not a git repository gets no branch button', async ({ env }) => {
    test.setTimeout(120_000)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await startSessionIn(page, 'ws-b')
      await waitPanelAttached(page)
      await showBrowse(page)
      await expect(page.locator('.wb-panel .ft-root')).toBeVisible({ timeout: 30_000 })
      await expect(gitButton(page)).toHaveCount(0)
    } finally {
      await quitAndClose(app)
    }
  })
})

interface OpenTab {
  app: ElectronApplication
  page: Page
  dir: string
  origin: string
}

const BRANCH = 'feature/login'

async function openLocal(env: E2EEnv, agent: AgentName): Promise<OpenTab> {
  const dir = env.workspaces.a
  repoOn(dir, env.home, BRANCH)
  const origin = addOrigin(dir, env.home)
  installAgentFor(env, agent, dir)
  const { app, page } = await launchSettled(env)
  await newSessionInWith(page, 'ws-a', agent)
  if (agent === 'Antigravity') {
    await agyReady(page)
    await runIn(page, centerTerm(page), 'first words')
    await agyConversationOnceFirstTurnEnded(page)
  }
  return { app, page, dir, origin }
}

async function openRemote(env: E2EEnv, start: (page: Page) => Promise<unknown>): Promise<OpenTab> {
  const { app, page } = await launchWithRemote(env)
  const dir = remoteDir(env)
  fs.mkdirSync(dir, { recursive: true })
  repoOn(dir, machineHome(env), BRANCH)
  const origin = addOrigin(dir, machineHome(env))
  await addRemoteWorkspace(page, env)
  await start(page)
  return { app, page, dir, origin }
}

const OTHER_TABS: { kind: string; open: (env: E2EEnv) => Promise<OpenTab> }[] = [
  ...OTHER_AGENTS_ON_THE_MACHINE.map(({ label }) => ({
    kind: `a local ${label}`,
    open: (env: E2EEnv) => openLocal(env, label)
  })),
  {
    kind: 'a remote (ssh) Claude Code',
    open: (env) =>
      openRemote(env, async (page) => {
        await startSessionIn(page, REMOTE_WS_NAME, { remote: true })
        await waitStartupTurnOver(page, REMOTE_WS_NAME)
      })
  },
  ...OTHER_AGENTS_ON_THE_MACHINE.map((agent) => ({
    kind: `a remote (ssh) ${agent.label}`,
    open: (env: E2EEnv) => {
      agent.install(env)
      return openRemote(env, async (page) => {
        await newSessionInWith(page, REMOTE_WS_NAME, agent.label)
        await agent.bound?.(page)
      })
    }
  }))
]

test.describe('Workbench · the branch button commits and pushes in every other kind of session tab, on the machine the checkout is on', () => {
  test.afterEach(({ env }) => killFakeRemote(env))

  for (const tab of OTHER_TABS)
    test(`GE6: in ${tab.kind} tab, the branch button commits and pushes the checkout`, async ({
      env
    }) => {
      test.setTimeout(300_000)
      const { app, page, dir, origin } = await tab.open(env)
      try {
        await expect(gitButton(page)).toHaveText(BRANCH, { timeout: 60_000 })
        await commitThroughTheMenu(page, dir, 'GE6-new.txt')
        await pushThroughTheMenu(page, dir, origin, BRANCH)
      } finally {
        await quitAndClose(app)
      }
    })
})
