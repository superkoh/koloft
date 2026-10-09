import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, launchApp } from './helpers/app'
import {
  GH_SIGNED_OUT,
  HAVE_REAL_GH,
  NEEDS_REAL_GH,
  installFakeGh,
  installRealGhThatOnlyReads,
  setGithubFixture,
  writeGitIdentity,
  type FakeGhCheck
} from './helpers/env'
import type { E2EEnv } from './helpers/env'
import { hostResolverSwitch } from './helpers/fixtureServer'
import {
  boundSessionId,
  centerTerm,
  gitInit,
  runIn,
  sendShortcut,
  snap,
  startSessionIn,
  transcriptFile,
  waitBooted,
  wsRows
} from './helpers/p1'
import { newWebTab, openBrowser } from './helpers/browser'
import {
  FAILED_LOG,
  ONE_FAILING_OF_FIVE,
  PR_3_CHECKS_LINE,
  PR_3_FAILING_CHECK_PASTE_HEAD,
  PR_3_FIRST_ERROR_LINE,
  PR_3_NPM_ERROR,
  PR_3_OF_KOLOFT,
  WORKBENCH,
  claudePrompts,
  expectOnePromptFromTheChecks,
  sendFailingChecks,
  waitPanelAttached,
  wbTabs
} from './helpers/workbench'

const REPO = { owner: 'acme', repo: 'widgets', branch: 'feature/login', pr: 265 }
const REPO_URL = 'https://github.com/acme/widgets'
const PR_URL = `${REPO_URL}/pull/265`
const PULLS_URL = `${REPO_URL}/pulls`

const NOT_A_GITHUB_WORKSPACE = 'ws-b'

const ONE_PASSING: FakeGhCheck[] = [
  { name: 'check', bucket: 'pass', link: `${REPO_URL}/actions/runs/1/job/2`, workflow: 'CI' }
]

const ghButton = (page: Page): ReturnType<Page['locator']> => page.locator('.wb-gh')
const ghMenuItems = (page: Page): Promise<string[]> =>
  page.locator('.wb-ghmenu .mi').allInnerTexts()

function gitOut(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
}

function repoWithOrigin(env: E2EEnv, branch: string): string {
  const dir = env.workspaces.a
  const origin = path.join(env.home, 'widgets-origin.git')
  writeGitIdentity(env.home)
  fs.writeFileSync(path.join(dir, '.gitignore'), 'NOTES.md\n')
  gitInit(dir)
  gitOut(env.home, 'init', '-q', '--bare', origin)
  gitOut(dir, 'remote', 'add', 'origin', origin)
  gitOut(dir, 'switch', '-q', '-c', branch)
  return origin
}

async function startWithGithub(
  env: E2EEnv,
  ws = 'ws-a',
  extra: Record<string, { owner: string; repo: string; branch?: string; pr?: number | null }> = {},
  gh: Parameters<typeof installFakeGh>[1] = { checks: ONE_PASSING }
): Promise<{ app: ElectronApplication; page: Page }> {
  installFakeGh(env, gh)
  setGithubFixture(env, { [env.workspaces.a]: REPO, ...extra })
  env.extraArgs.push(hostResolverSwitch(['github.com']))
  const app = await launchApp(env)
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await waitBooted(page)
  await startSessionIn(page, ws)
  await waitPanelAttached(page)
  await openBrowser(page)
  return { app, page }
}

function tabTargets(page: Page): Promise<(string | null)[]> {
  return wbTabs(page).evaluateAll((els) => els.map((e) => e.getAttribute('title')))
}

test.describe('Workbench · GitHub button (github.com is pinned to loopback, so the oracle is the tab address; gh is a fake on PATH)', () => {
  test('G1: a workspace that is not a GitHub project gets no button', async ({ env }) => {
    test.setTimeout(240_000)
    const started = await startWithGithub(env, NOT_A_GITHUB_WORKSPACE)
    try {
      await expect(wbTabs(started.page).first()).toBeVisible({ timeout: 20_000 })
      await expect(ghButton(started.page)).toHaveCount(0)
    } finally {
      await started.app.close().catch(() => {})
    }
  })

  test('G2: a GitHub project gets a button between Files and the divider', async ({ env }) => {
    test.setTimeout(240_000)
    const { app: a, page } = await startWithGithub(env)
    try {
      const gh = ghButton(page)
      await expect(gh).toBeVisible({ timeout: 30_000 })
      await expect(gh).toHaveText('#265')
      await expect(gh).toHaveAttribute('aria-label', /Open pull request #265/)

      const order = await page
        .locator(`${WORKBENCH.tabStrip} .wb-pin > *`)
        .evaluateAll((els) => els.map((e) => e.className.split(/\s+/)[0]))
      expect(order[0]).toBe('wb-tab')
      expect(order[1]).toBe('wb-gh')
      await snap(page, 'G2-github-button')
    } finally {
      await a.close().catch(() => {})
    }
  })

  test('G3/G4: clicking opens the pull request once in an ordinary web tab, and returns to that same tab after that', async ({
    env
  }) => {
    test.setTimeout(240_000)
    const { app: a, page } = await startWithGithub(env)
    try {
      await expect(ghButton(page)).toBeVisible({ timeout: 30_000 })
      await expect(wbTabs(page)).toHaveCount(1)

      await ghButton(page).click()
      await expect(wbTabs(page)).toHaveCount(2, { timeout: 20_000 })
      await expect.poll(() => tabTargets(page)).toContain(PR_URL)
      await expect(wbTabs(page).nth(1)).toHaveClass(/\bon\b/)

      await ghButton(page).click()
      await expect(wbTabs(page)).toHaveCount(2)
      await expect(wbTabs(page).nth(1)).toHaveClass(/\bon\b/)
    } finally {
      await a.close().catch(() => {})
    }
  })

  test('G5: right-click offers the open items, the checks line and the git steps, and each open item opens its page', async ({
    env
  }) => {
    test.setTimeout(240_000)
    const { app: a, page } = await startWithGithub(env)
    try {
      await expect(ghButton(page)).toBeVisible({ timeout: 30_000 })
      await expect(ghButton(page).locator('.ci')).toHaveClass(/\bpass\b/, { timeout: 30_000 })
      await ghButton(page).click({ button: 'right' })

      const menu = page.locator('.wb-ghmenu')
      await expect(menu).toBeVisible()
      expect(await ghMenuItems(page)).toEqual([
        'Open repository',
        'Open pull requests',
        'Open pull request #265',
        'Checks · 1 passed of 1',
        'Commit…',
        'Push',
        'Check again'
      ])

      await menu.locator('.mi', { hasText: 'Open pull requests' }).click()
      await expect(wbTabs(page)).toHaveCount(2, { timeout: 20_000 })
      await expect.poll(() => tabTargets(page)).toContain(PULLS_URL)

      await ghButton(page).click({ button: 'right' })
      await page.locator('.wb-ghmenu .mi', { hasText: 'Open repository' }).click()
      await expect(wbTabs(page)).toHaveCount(3, { timeout: 20_000 })
      await expect.poll(() => tabTargets(page)).toContain(REPO_URL)
    } finally {
      await a.close().catch(() => {})
    }
  })

  test('G6: the button stays at the left edge when the strip scrolls, and tab drop indexes stay model positions', async ({
    env
  }) => {
    test.setTimeout(240_000)
    const { app: a, page } = await startWithGithub(env)
    try {
      await expect(ghButton(page)).toBeVisible({ timeout: 30_000 })
      for (let i = 0; i < 8; i++) await newWebTab(page)
      await expect(wbTabs(page)).toHaveCount(9, { timeout: 20_000 })

      expect(
        await wbTabs(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-drop-index')))
      ).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8'])

      const strip = page.locator(WORKBENCH.tabStrip)
      await expect
        .poll(() => strip.evaluate((el) => el.scrollWidth - el.clientWidth))
        .toBeGreaterThan(0)
      await strip.evaluate((el) => {
        el.scrollLeft = el.scrollWidth
      })

      const [stripBox, ghBox, filesBox] = await Promise.all([
        strip.boundingBox(),
        ghButton(page).boundingBox(),
        wbTabs(page).first().boundingBox()
      ])
      expect(ghBox).not.toBeNull()
      expect(ghBox!.x).toBeGreaterThanOrEqual(stripBox!.x)
      expect(ghBox!.x).toBeLessThan(stripBox!.x + 160)
      expect(filesBox!.x).toBeGreaterThanOrEqual(stripBox!.x)
    } finally {
      await a.close().catch(() => {})
    }
  })

  test('G7: the button is not a tab — ⌘W cannot close it, it cannot be dragged, and it is never counted', async ({
    env
  }) => {
    test.setTimeout(240_000)
    const { app: a, page } = await startWithGithub(env)
    try {
      await expect(ghButton(page)).toBeVisible({ timeout: 30_000 })
      await expect(wbTabs(page)).toHaveCount(1)

      await ghButton(page).click()
      await expect(wbTabs(page)).toHaveCount(2, { timeout: 20_000 })

      await ghButton(page).focus()
      await sendShortcut(a, 'shortcut:close-tab')
      await expect(wbTabs(page)).toHaveCount(1, { timeout: 20_000 })
      await expect(ghButton(page)).toBeVisible()
      await expect(ghButton(page)).not.toHaveAttribute('draggable', 'true')
    } finally {
      await a.close().catch(() => {})
    }
  })

  test('G8: the button follows the session into another worktree', async ({ env }) => {
    test.setTimeout(300_000)
    gitInit(env.workspaces.a)
    const wtDir = path.join(env.workspaces.a, '.claude', 'worktrees', 'wt271')
    const { app, page } = await startWithGithub(env, 'ws-a', {
      [wtDir]: { owner: 'acme', repo: 'widgets', branch: 'wt271', pr: 412 }
    })
    try {
      await expect(ghButton(page)).toHaveText('#265', { timeout: 30_000 })

      await runIn(page, centerTerm(page), '/enter-worktree wt271')
      await expect(ghButton(page)).toHaveText('#412', { timeout: 60_000 })
      await ghButton(page).click()
      await expect
        .poll(() => tabTargets(page), { timeout: 20_000 })
        .toContain('https://github.com/acme/widgets/pull/412')

      await runIn(page, centerTerm(page), '/exit-worktree')
      await expect(ghButton(page)).toHaveText('#265', { timeout: 60_000 })
    } finally {
      await app.close().catch(() => {})
    }
  })

  test("G9: a failing check turns the dot red, the menu counts it, and Send failing checks puts its name, link and log excerpt into the session's input box, unsent", async ({
    env
  }) => {
    test.setTimeout(240_000)
    const { app, page } = await startWithGithub(
      env,
      'ws-a',
      {},
      {
        checks: ONE_FAILING_OF_FIVE,
        failedLog: FAILED_LOG
      }
    )
    try {
      await expect(ghButton(page).locator('.ci')).toHaveClass(/\bfail\b/, { timeout: 30_000 })
      await expect(ghButton(page)).toHaveAttribute('aria-label', /checks failing/)
      await ghButton(page).click({ button: 'right' })
      await expect(page.locator('.wb-ghmenu .mi.head')).toHaveText('Checks · 1 failing of 5')
      await snap(page, 'G9-failing-checks-menu')
      await page.keyboard.press('Escape')

      const tabId = await wsRows(page, 'ws-a').first().getAttribute('data-tab-id')
      const sessionId = (await boundSessionId(page, tabId)) ?? ''
      const transcript = transcriptFile(env.home, env.workspaces.a, sessionId)
      await sendFailingChecks(page)
      await expectOnePromptFromTheChecks(() => claudePrompts(transcript))
      expect(fs.readFileSync(path.join(env.home, 'fake-gh-calls.txt'), 'utf8')).toContain(
        'run view --job 110263090912 --repo acme/widgets --log-failed'
      )
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('G10: with gh signed out the menu says to run gh auth login, draws no dot and offers nothing to send', async ({
    env
  }) => {
    test.setTimeout(240_000)
    const { app, page } = await startWithGithub(env, 'ws-a', {}, { exitCode: GH_SIGNED_OUT })
    try {
      await expect(ghButton(page)).toBeVisible({ timeout: 30_000 })
      await ghButton(page).click({ button: 'right' })
      await expect(page.locator('.wb-ghmenu .mi.head')).toHaveText('Checks · run gh auth login', {
        timeout: 30_000
      })
      expect(await ghMenuItems(page)).not.toContain('Send failing checks')
      await expect(ghButton(page).locator('.ci')).toHaveCount(0)
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('G11: Commit… commits every change, new files included, under the typed message, and Push sends the branch to origin', async ({
    env
  }) => {
    test.setTimeout(240_000)
    const origin = repoWithOrigin(env, 'feature/login')
    const dir = env.workspaces.a
    const { app, page } = await startWithGithub(env)
    try {
      fs.writeFileSync(path.join(dir, 'G11-new.txt'), 'new\n')
      await expect(ghButton(page)).toBeVisible({ timeout: 30_000 })
      await ghButton(page).click({ button: 'right' })
      await page.locator('.wb-ghmenu .mi', { hasText: 'Commit…' }).click()

      const dialog = page.locator('.modal', { hasText: 'Commit changes' })
      await expect(dialog).toBeVisible()
      await expect(dialog.locator('.field-hint')).toContainText('feature/login')
      await dialog.getByLabel('Commit message').fill('G11 add the new file')
      await dialog.locator('.btn-primary', { hasText: 'Commit' }).click()
      await expect(dialog).toHaveCount(0, { timeout: 30_000 })
      expect(gitOut(dir, 'log', '-1', '--format=%s')).toBe('G11 add the new file')
      expect(gitOut(dir, 'show', '--name-only', '--format=', 'HEAD')).toContain('G11-new.txt')

      await ghButton(page).click({ button: 'right' })
      await page.locator('.wb-ghmenu .mi', { hasText: 'Push' }).click()
      await expect
        .poll(
          () =>
            gitOut(origin, 'for-each-ref', '--format=%(objectname)', 'refs/heads/feature/login'),
          {
            timeout: 30_000
          }
        )
        .toBe(gitOut(dir, 'rev-parse', 'HEAD'))
    } finally {
      await app.close().catch(() => {})
    }
  })

  test("G12: on a branch with no pull request, Open pull request… pushes the branch, then opens GitHub's compare page in a web tab", async ({
    env
  }) => {
    test.setTimeout(240_000)
    const origin = repoWithOrigin(env, 'feature/login')
    const { app, page } = await startWithGithub(env, 'ws-a', {
      [env.workspaces.a]: { ...REPO, pr: null }
    })
    try {
      await expect(ghButton(page)).toBeVisible({ timeout: 30_000 })
      await ghButton(page).click({ button: 'right' })
      expect(await ghMenuItems(page)).toEqual([
        'Open repository',
        'Open pull requests',
        'Commit…',
        'Push',
        'Open pull request…',
        'Check again'
      ])
      await page.locator('.wb-ghmenu .mi', { hasText: 'Open pull request…' }).click()
      await expect
        .poll(() => tabTargets(page), { timeout: 30_000 })
        .toContain(`${REPO_URL}/compare/feature/login?expand=1`)
      expect(gitOut(origin, 'rev-parse', 'refs/heads/feature/login')).toBe(
        gitOut(env.workspaces.a, 'rev-parse', 'HEAD')
      )
    } finally {
      await app.close().catch(() => {})
    }
  })
})

test.describe('Workbench · GitHub button against the REAL gh and GitHub: opt-in; the pull request number comes from the fixture because PR #3’s branch is gone from GitHub', () => {
  test('G13: the real gh reads superkoh/koloft PR #3 as one failing check of two, and Send failing checks pastes its name, job link and the npm ERESOLVE excerpt up to the first ##[error] line, with the runner’s line prefixes, byte-order mark and colours stripped', async ({
    env
  }) => {
    test.skip(!HAVE_REAL_GH, NEEDS_REAL_GH)
    test.setTimeout(240_000)
    installRealGhThatOnlyReads(env)
    setGithubFixture(env, { [env.workspaces.a]: PR_3_OF_KOLOFT })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await waitBooted(page)
      await startSessionIn(page, 'ws-a')
      await waitPanelAttached(page)
      await expect(ghButton(page).locator('.ci')).toHaveClass(/\bfail\b/, { timeout: 60_000 })
      await expect(ghButton(page)).toHaveAttribute('aria-label', /checks failing/)
      await ghButton(page).click({ button: 'right' })
      await expect(page.locator('.wb-ghmenu .mi.head')).toHaveText(PR_3_CHECKS_LINE)
      expect(await ghMenuItems(page)).toContain('Send failing checks')
      await page.keyboard.press('Escape')

      const tabId = await wsRows(page, 'ws-a').first().getAttribute('data-tab-id')
      const sessionId = (await boundSessionId(page, tabId)) ?? ''
      const transcript = transcriptFile(env.home, env.workspaces.a, sessionId)
      await sendFailingChecks(page)
      const prompt = await expectOnePromptFromTheChecks(
        () => claudePrompts(transcript),
        PR_3_FAILING_CHECK_PASTE_HEAD
      )
      await test.info().attach('the-pasted-checks', { body: prompt })
      expect(prompt).toContain(`\n${PR_3_NPM_ERROR}\n`)
      expect(prompt).toContain(`\n${PR_3_FIRST_ERROR_LINE}\n\n`)
      expect(prompt).not.toMatch(/\t\d{4}-\d\d-\d\dT|\x1b\[|﻿/)
    } finally {
      await app.close().catch(() => {})
    }
  })
})
