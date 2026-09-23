import path from 'path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, launchApp } from './helpers/app'
import { setGithubFixture } from './helpers/env'
import type { E2EEnv } from './helpers/env'
import { hostResolverSwitch } from './helpers/fixtureServer'
import {
  centerTerm,
  gitInit,
  runIn,
  sendShortcut,
  snap,
  startSessionIn,
  waitBooted
} from './helpers/p1'
import { newWebTab, openBrowser } from './helpers/browser'
import { WORKBENCH, waitPanelAttached, wbTabs } from './helpers/workbench'

const REPO = { owner: 'acme', repo: 'widgets', branch: 'feature/login', pr: 265 }
const REPO_URL = 'https://github.com/acme/widgets'
const PR_URL = `${REPO_URL}/pull/265`
const PULLS_URL = `${REPO_URL}/pulls`

const NOT_A_GITHUB_WORKSPACE = 'ws-b'

const ghButton = (page: Page): ReturnType<Page['locator']> => page.locator('.wb-gh')

async function startWithGithub(
  env: E2EEnv,
  ws = 'ws-a',
  extra: Record<string, { owner: string; repo: string; branch?: string; pr?: number }> = {}
): Promise<{ app: ElectronApplication; page: Page }> {
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

test.describe('Workbench · GitHub button (read-only; github.com is pinned to loopback, so the oracle is the tab address)', () => {
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

  test('G5: right-click offers the read-only set, and each item opens its page', async ({
    env
  }) => {
    test.setTimeout(240_000)
    const { app: a, page } = await startWithGithub(env)
    try {
      await expect(ghButton(page)).toBeVisible({ timeout: 30_000 })
      await ghButton(page).click({ button: 'right' })

      const menu = page.locator('.wb-ghmenu')
      await expect(menu).toBeVisible()
      expect(await menu.locator('.mi').allInnerTexts()).toEqual([
        'Open repository',
        'Open pull requests',
        'Open pull request #265',
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
})
