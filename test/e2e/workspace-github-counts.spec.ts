import fs from 'fs'
import path from 'path'
import type { Page } from '@playwright/test'
import { test, expect, quitAndClose } from './helpers/app'
import { launchSettled } from './helpers/blackbox'
import { seedSettings, setGithubFixture } from './helpers/env'
import { runGit, setupGitFixture } from './helpers/gitFixture'
import { gitInit, gitMark, openGitPanel, snap } from './helpers/p1'
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

const COUNTS_TIMEOUT = 30_000
const LONG_NAME = 'payments-gateway-service'

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
    const counts = [...head.querySelectorAll<HTMLElement>('.ws-gh > span')]
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
      const counts = gitMark(page, 'repo').locator('.ws-gh > span')
      await expect(counts).toHaveCount(2, { timeout: COUNTS_TIMEOUT })
      await expect(counts.nth(0)).toHaveAttribute('aria-label', '12 open issues')
      await expect(counts.nth(0)).toHaveText('12')
      await expect(counts.nth(1)).toHaveAttribute('aria-label', '3 open pull requests')
      await expect(counts.nth(1)).toHaveText('3')

      const panel = await openGitPanel(page, 'repo')
      await expect(panel.locator('.tbu-pop-head').first()).toContainText('main · origin/main')
      await expect(panel.locator('.tbu-pop-head').last()).toHaveText('GitHub · acme/repo')
      await expect(panel.locator('.fx-counts').last()).toHaveText(
        '12 open issues3 open pull requests'
      )
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
      const counts = gitMark(page, 'repo').locator('.ws-gh > span')
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
    setGithubFixture(env, { [fx.clone]: { owner: 'acme', repo: LONG_NAME, issues: 128, prs: 37 } })
    seedSettings(env, { sidebarWidth: 200 })
    const { app, page } = await launchSettled(env)
    try {
      await expect(gitMark(page, LONG_NAME).locator('.ws-gh > span')).toHaveCount(2, {
        timeout: COUNTS_TIMEOUT
      })
      const fit = await headFit(page, LONG_NAME)
      expect(fit.shown).not.toEqual(['128 open issues', '37 open pull requests'])
      expect(fit.shown).not.toEqual(['37 open pull requests'])
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
      await expect(gitMark(page, LONG_NAME).locator('.ws-gh > span')).toHaveCount(2, {
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
    seedSettings(env, { sidebarWidth: 200 })
    const { app, page } = await launchSettled(env)
    try {
      await expect(gitMark(page, LONG_NAME).locator('.ws-gh > span')).toHaveCount(2, {
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
      const counts = gitMark(page, 'repo').locator('.ws-gh > span')
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

  test('T-GH-06: a remote GitHub workspace shows its counts, and its git panel holds only the GitHub part — no pull or fetch over SSH', async ({
    env
  }) => {
    test.setTimeout(180_000)
    installFakeRemote(env)
    gitInit(remoteDir(env))
    setGithubFixture(env, { [remoteKey(env)]: { owner: 'acme', repo: 'proj', issues: 0, prs: 4 } })
    const { app, page } = await launchWithRemote(env)
    try {
      await addRemoteWorkspace(page, env)
      const counts = gitMark(page, REMOTE_WS_NAME).locator('.ws-gh > span')
      await expect(counts).toHaveCount(1, { timeout: 60_000 })
      await expect(counts).toHaveAttribute('aria-label', '4 open pull requests')

      const panel = await openGitPanel(page, REMOTE_WS_NAME)
      await expect(panel.locator('.tbu-pop-head')).toHaveText('GitHub · acme/proj')
      await expect(panel.locator('.fx-counts')).toHaveText('0 open issues4 open pull requests')
      await expect(panel.locator('.tbu-act')).toHaveCount(0)
      await snap(page, 'T-GH-06-remote-panel')
    } finally {
      await quitAndClose(app)
    }
  })
})
