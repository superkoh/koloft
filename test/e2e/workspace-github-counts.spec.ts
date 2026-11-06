import fs from 'fs'
import path from 'path'
import type { Locator, Page } from '@playwright/test'
import { test, expect, quitAndClose } from './helpers/app'
import { launchSettled } from './helpers/blackbox'
import { installCodex, seedSettings, setGithubFixture } from './helpers/env'
import { hostResolverSwitch } from './helpers/fixtureServer'
import { runGit, setupGitFixture } from './helpers/gitFixture'
import { gitInit, gitMark, openGitPanel, snap, startSessionIn, wsRows } from './helpers/p1'
import { WELCOME_PAGE, wbActiveTab, wbTabs, workbenchPanel } from './helpers/workbench'
import {
  addRemoteWorkspace,
  installFakeRemote,
  killFakeRemote,
  launchWithRemote,
  REMOTE_WS_NAME,
  remoteDir,
  remoteKey
} from './helpers/remote'
import { NAME_KEEPS_PX } from '../../src/renderer/src/wsHeadFit'
import { SIDEBAR_MIN } from '../../src/shared/types'

const COUNTS_TIMEOUT = 30_000
const LONG_NAME = 'payments-gateway-service'
const ONE_COUNT_FITS_AT_SIDEBAR_MIN = { issues: 12345, prs: 4321 }
const ISSUES_URL = 'https://github.com/acme/repo/issues'
const PULLS_URL = 'https://github.com/acme/repo/pulls'

function listRows(panel: Locator): Locator {
  return panel.locator('.tbu-act', { hasText: / open (issues|pull requests)$/ })
}

function tabTargets(page: Page): Promise<(string | null)[]> {
  return wbTabs(page).evaluateAll((els) => els.map((e) => e.getAttribute('title')))
}

function headFit(
  page: Page,
  ws: string
): Promise<{
  shown: string[]
  clipped: number
  spill: number
  nameWidth: number
  nameNeeds: number
}> {
  return page.locator('.ws-head', { hasText: ws }).evaluate((head) => {
    const box = head.getBoundingClientRect()
    const limit = box.right - parseFloat(getComputedStyle(head).paddingRight)
    const counts = [...head.querySelectorAll<HTMLElement>('.ws-gh > button')]
    const shown = counts.filter((c) => c.checkVisibility())
    const name = head.querySelector<HTMLElement>('.ws-name')!
    return {
      shown: shown.map((c) => c.getAttribute('aria-label') ?? ''),
      clipped: shown.filter((c) => c.getBoundingClientRect().right > limit + 0.5).length,
      spill: Math.max(...[...head.children].map((c) => c.getBoundingClientRect().right)) - limit,
      nameWidth: name.clientWidth,
      nameNeeds: name.scrollWidth
    }
  })
}

test.describe('Workspace GitHub counts · open issues and pull requests after the git mark, and the git panel', () => {
  test('T-GH-01: a GitHub workspace shows its open issue and PR counts, and the git panel lists them under the branch state', async ({
    env
  }) => {
    const fx = setupGitFixture(env)
    setGithubFixture(env, { [fx.clone]: { owner: 'acme', repo: 'repo', issues: 12, prs: 3 } })
    const { app, page } = await launchSettled(env)
    try {
      const counts = gitMark(page, 'repo').locator('.ws-gh > button')
      await expect(counts).toHaveCount(2, { timeout: COUNTS_TIMEOUT })
      await expect(counts.nth(0)).toHaveAttribute('aria-label', '12 open issues')
      await expect(counts.nth(0)).toHaveText('12')
      await expect(counts.nth(1)).toHaveAttribute('aria-label', '3 open pull requests')
      await expect(counts.nth(1)).toHaveText('3')

      const panel = await openGitPanel(page, 'repo')
      await expect(panel.locator('.tbu-pop-head').first()).toContainText('main · origin/main')
      await expect(panel.locator('.tbu-pop-head').last()).toHaveText('GitHub · acme/repo')
      await expect(listRows(panel)).toHaveText(['12 open issues', '3 open pull requests'])
      await expect(listRows(panel).first()).toBeEnabled()
      await expect(panel.locator('.tbu-act', { hasText: 'Fetch now' })).toBeEnabled()
      await snap(page, 'T-GH-01-panel')
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('T-GH-02: a zero count draws nothing, and a workspace off GitHub keeps its plain git mark', async ({
    env
  }) => {
    const fx = setupGitFixture(env)
    setGithubFixture(env, { [fx.clone]: { owner: 'acme', repo: 'repo', issues: 0, prs: 5 } })
    const { app, page } = await launchSettled(env)
    try {
      const counts = gitMark(page, 'repo').locator('.ws-gh > button')
      await expect(counts).toHaveCount(1, { timeout: COUNTS_TIMEOUT })
      await expect(counts).toHaveAttribute('aria-label', '5 open pull requests')
      await expect(gitMark(page, 'repo')).toHaveAttribute('title', '')
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('T-GH-03: in the narrowest sidebar a count is hidden whole, the PR before the issue, and the name keeps its few letters', async ({
    env
  }) => {
    const fx = setupGitFixture(env, LONG_NAME)
    setGithubFixture(env, {
      [fx.clone]: { owner: 'acme', repo: LONG_NAME, ...ONE_COUNT_FITS_AT_SIDEBAR_MIN }
    })
    seedSettings(env, { sidebarWidth: SIDEBAR_MIN })
    const { app, page } = await launchSettled(env)
    try {
      await expect(gitMark(page, LONG_NAME).locator('.ws-gh > button')).toHaveCount(2, {
        timeout: COUNTS_TIMEOUT
      })
      await expect(page.locator('.side')).toHaveJSProperty('offsetWidth', SIDEBAR_MIN)
      await expect
        .poll(async () => (await headFit(page, LONG_NAME)).shown)
        .toEqual(['12345 open issues'])
      const fit = await headFit(page, LONG_NAME)
      expect(fit.clipped).toBe(0)
      expect(fit.spill).toBeLessThanOrEqual(0.5)
      expect(fit.nameWidth).toBeGreaterThanOrEqual(Math.min(NAME_KEEPS_PX, fit.nameNeeds))
      await snap(page, 'T-GH-03-narrow')
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('T-GH-04: a wide sidebar shows both counts beside the long name', async ({ env }) => {
    const fx = setupGitFixture(env, LONG_NAME)
    setGithubFixture(env, { [fx.clone]: { owner: 'acme', repo: LONG_NAME, issues: 128, prs: 37 } })
    seedSettings(env, { sidebarWidth: 420 })
    const { app, page } = await launchSettled(env)
    try {
      await expect(gitMark(page, LONG_NAME).locator('.ws-gh > button')).toHaveCount(2, {
        timeout: COUNTS_TIMEOUT
      })
      await expect
        .poll(async () => (await headFit(page, LONG_NAME)).shown)
        .toEqual(['128 open issues', '37 open pull requests'])
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('T-GH-05: hovering a workspace whose name is cut scrolls the name, and leaving stops it', async ({
    env
  }) => {
    const fx = setupGitFixture(env, LONG_NAME)
    setGithubFixture(env, { [fx.clone]: { owner: 'acme', repo: LONG_NAME, issues: 128, prs: 37 } })
    seedSettings(env, { sidebarWidth: SIDEBAR_MIN })
    const { app, page } = await launchSettled(env)
    try {
      await expect(gitMark(page, LONG_NAME).locator('.ws-gh > button')).toHaveCount(2, {
        timeout: COUNTS_TIMEOUT
      })
      const name = page.locator('.ws-head', { hasText: LONG_NAME }).locator('.ws-name')
      const running = (): Promise<number> =>
        name.evaluate((n) => n.querySelector('i')!.getAnimations().length)
      expect(await running()).toBe(0)
      await name.hover()
      await expect.poll(running).toBe(1)
      await expect(name).toHaveClass(/\bmq\b/)
      await page.mouse.move(600, 400)
      await expect.poll(running).toBe(0)
      await expect(name).not.toHaveClass(/\bmq\b/)
    } finally {
      await app.close().catch(() => {})
    }
  })
})

test.describe('Workspace GitHub counts · the counts open their lists in the workspace’s own Workbench (github.com is pinned to loopback, so the oracle is the tab address)', () => {
  test('T-GH-08: from a Codex session, "12 open issues" in the git panel moves to the workspace’s welcome page and opens the list in its Workbench while the session runs on; the sidebar’s PR number opens the other list beside it, a second click reuses the tab, and a restart keeps both', async ({
    env
  }) => {
    test.setTimeout(240_000)
    installCodex(env)
    const fx = setupGitFixture(env)
    setGithubFixture(env, { [fx.clone]: { owner: 'acme', repo: 'repo', issues: 12, prs: 3 } })
    env.extraArgs.push(hostResolverSwitch(['github.com']))
    const first = await launchSettled(env)
    let app = first.app
    try {
      const page = first.page
      await startSessionIn(page, 'repo', { method: 'Codex' })
      const session = wsRows(page, 'repo').first()
      await expect(page.locator(WELCOME_PAGE)).toHaveCount(0)

      await listRows(await openGitPanel(page, 'repo'))
        .first()
        .click()
      await expect(page.locator(`${WELCOME_PAGE} .big`)).toHaveText('repo')
      await expect(page.locator(`${WELCOME_PAGE} .quiet`)).toHaveText(/^1 session running/)
      await expect(session).not.toHaveClass(/\bcold\b/)
      await expect(workbenchPanel(page)).toBeVisible({ timeout: 20_000 })
      await expect.poll(() => tabTargets(page)).toContain(ISSUES_URL)

      await gitMark(page, 'repo').locator('.ws-gh > button').nth(1).click()
      await expect.poll(() => tabTargets(page)).toContain(PULLS_URL)
      await expect(wbTabs(page)).toHaveCount(3)
      await page.mouse.move(1, 1)
      await listRows(await openGitPanel(page, 'repo'))
        .first()
        .click()
      await expect(wbActiveTab(page)).toHaveAttribute('title', ISSUES_URL)
      await expect(wbTabs(page)).toHaveCount(3)
      await snap(page, 'T-GH-08-workspace-workbench')

      await quitAndClose(app)
      const second = await launchSettled(env)
      app = second.app
      await second.page.locator('.ws-head', { hasText: 'repo' }).click()
      await expect(workbenchPanel(second.page)).toBeVisible({ timeout: 20_000 })
      await expect(wbTabs(second.page)).toHaveCount(3)
      await expect
        .poll(() => tabTargets(second.page))
        .toEqual(expect.arrayContaining([ISSUES_URL, PULLS_URL]))
    } finally {
      await quitAndClose(app)
    }
  })
})

test.describe('Workspace GitHub counts · the real gh path, no fixture', () => {
  test('T-GH-07: an app started with launchd’s short PATH still finds gh through the login shell and asks it for this repo’s counts', async ({
    env
  }) => {
    const fx = setupGitFixture(env)
    const github = 'git@github.com:acme/repo.git'
    runGit(fx.clone, 'remote', 'set-url', 'origin', github)
    runGit(fx.clone, 'config', `url.file://${fx.origin}.insteadOf`, github)

    const ghDir = path.join(env.home, 'login-shell-only-bin')
    const ghLog = path.join(env.home, 'gh-calls.txt')
    fs.mkdirSync(ghDir)
    fs.writeFileSync(
      path.join(ghDir, 'gh'),
      `#!/bin/sh\necho "$*" >> ${JSON.stringify(ghLog)}\n` +
        `printf '%s' '{"data":{"repository":{"issues":{"totalCount":7},"pullRequests":{"totalCount":2}}}}'\n`,
      { mode: 0o755 }
    )
    fs.writeFileSync(path.join(env.home, '.zprofile'), `export PATH="${ghDir}:$PATH"\n`)
    // PLATFORM§1
    env.launchEnv.PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
    env.launchEnv.SHELL = '/bin/zsh'
    delete env.launchEnv.ZDOTDIR

    const { app, page } = await launchSettled(env)
    try {
      const counts = gitMark(page, 'repo').locator('.ws-gh > button')
      await expect(counts).toHaveCount(2, { timeout: COUNTS_TIMEOUT })
      await expect(counts.nth(0)).toHaveAttribute('aria-label', '7 open issues')
      await expect(counts.nth(1)).toHaveAttribute('aria-label', '2 open pull requests')
      const call = fs.readFileSync(ghLog, 'utf8')
      expect(call).toContain('api graphql')
      expect(call).toContain('owner=acme')
      expect(call).toContain('name=repo')
    } finally {
      await app.close().catch(() => {})
    }
  })
})

test.describe('Workspace GitHub counts · a remote workspace', () => {
  test.afterEach(({ env }) => killFakeRemote(env))

  test('T-GH-06: a remote GitHub workspace shows its counts, its git panel holds only the GitHub part — no pull or fetch over SSH — and a count there opens its list in the remote workspace’s own Workbench', async ({
    env
  }) => {
    test.setTimeout(180_000)
    installFakeRemote(env)
    gitInit(remoteDir(env))
    setGithubFixture(env, { [remoteKey(env)]: { owner: 'acme', repo: 'proj', issues: 0, prs: 4 } })
    env.extraArgs.push(hostResolverSwitch(['github.com']))
    const { app, page } = await launchWithRemote(env)
    try {
      await addRemoteWorkspace(page, env)
      const counts = gitMark(page, REMOTE_WS_NAME).locator('.ws-gh > button')
      await expect(counts).toHaveCount(1, { timeout: 60_000 })
      await expect(counts).toHaveAttribute('aria-label', '4 open pull requests')

      const panel = await openGitPanel(page, REMOTE_WS_NAME)
      await expect(panel.locator('.tbu-pop-head')).toHaveText('GitHub · acme/proj')
      await expect(panel.locator('.tbu-act')).toHaveText(['0 open issues', '4 open pull requests'])
      await snap(page, 'T-GH-06-remote-panel')

      await listRows(panel).last().click()
      await expect(panel).toHaveCount(0)
      await expect(page.locator(`${WELCOME_PAGE} .big`)).toHaveText(REMOTE_WS_NAME)
      await expect(workbenchPanel(page)).toBeVisible({ timeout: 20_000 })
      await expect.poll(() => tabTargets(page)).toContain('https://github.com/acme/proj/pulls')
    } finally {
      await quitAndClose(app)
    }
  })
})
