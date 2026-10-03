import type { Locator, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { seedSettings, setGithubFixture } from './helpers/env'
import { setupGitFixture } from './helpers/gitFixture'
import { gitInit, openGitPanel, snap } from './helpers/p1'
import {
  addRemoteWorkspace,
  installFakeRemote,
  killFakeRemote,
  launchWithRemote,
  REMOTE_WS_NAME,
  remoteDir,
  remoteKey
} from './helpers/remote'

const COUNTS_TIMEOUT = 30_000
const LONG_NAME = 'payments-gateway-service'
const NAME_KEEPS_PX = 44

const strip = (page: Page, ws: string): Locator =>
  page.locator('.ws-head', { hasText: ws }).locator(':scope > .ws-git')

async function launched(env: Parameters<typeof launchApp>[0]): Promise<{
  app: Awaited<ReturnType<typeof launchApp>>
  page: Page
}> {
  const app = await launchApp(env)
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
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
    const { app, page } = await launched(env)
    try {
      const counts = strip(page, 'repo').locator('.ws-gh > span')
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
    const { app, page } = await launched(env)
    try {
      const counts = strip(page, 'repo').locator('.ws-gh > span')
      await expect(counts).toHaveCount(1, { timeout: COUNTS_TIMEOUT })
      await expect(counts).toHaveAttribute('aria-label', '5 open pull requests')
      await expect(strip(page, 'repo')).toHaveAttribute('title', '')
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
    const { app, page } = await launched(env)
    try {
      await expect(strip(page, LONG_NAME).locator('.ws-gh > span')).toHaveCount(2, {
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
    const { app, page } = await launched(env)
    try {
      await expect(strip(page, LONG_NAME).locator('.ws-gh > span')).toHaveCount(2, {
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
    const { app, page } = await launched(env)
    try {
      await expect(strip(page, LONG_NAME).locator('.ws-gh > span')).toHaveCount(2, {
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
      const counts = strip(page, REMOTE_WS_NAME).locator('.ws-gh > span')
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
