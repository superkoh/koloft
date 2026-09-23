import fs from 'fs'
import path from 'path'
import { test, expect, launchApp } from './helpers/app'
import type { E2EEnv } from './helpers/env'
import {
  closeMenu,
  encodeCwd,
  FAKE_SESSION_TITLE,
  gitInit,
  gitWorktreeAdd,
  menuItemTexts,
  openMenu,
  openWorktreeSession,
  readCalls,
  seedJsonl,
  snap,
  waitBooted,
  waitForCalls
} from './helpers/p1'

const GRACE_FOR_A_WRONG_RESCAN_MS = 3000

test.describe('multi-bucket aggregation and the watcher triggers (each case launches by hand so its fixtures exist before the startup rescan)', () => {
  test('T-AGG-06: a pre-seeded native-git worktree session is listed after startup, labelled by its bucket dir', async ({
    env
  }) => {
    gitInit(env.workspaces.a)
    const wt = gitWorktreeAdd(env.workspaces.a, 'wt1')
    seedJsonl(env, wt, { summary: 'WT preseed session', cwd: wt })

    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')

      const row = page.locator('.ws-tab', { hasText: 'WT preseed session' })
      await expect.poll(async () => row.isVisible(), { timeout: 20_000 }).toBe(true)
      await expect(row).toHaveClass(/\bcold\b/)
      await expect(row.locator('.ws-tab-sub')).toHaveText('wt1')
      await snap(page, 'T-AGG-06')
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('T-AGG-06: the same pre-seeded worktree session is aggregated but stays hidden when Koloft never drove it', async ({
    env
  }) => {
    gitInit(env.workspaces.a)
    const wt = gitWorktreeAdd(env.workspaces.a, 'wt1')
    seedJsonl(env, wt, { summary: 'WT preseed session', cwd: wt, owned: false })

    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await expect(page.locator('.ws-head .ws-name', { hasText: 'ws-a' })).toBeVisible({
        timeout: 20_000
      })
      await page.waitForTimeout(GRACE_FOR_A_WRONG_RESCAN_MS)
      await expect(page.locator('.ws-tab')).toHaveCount(0)
    } finally {
      await app.close().catch(() => {})
    }
  })

  // CC§2
  test('T-AGG-07: a root-slug `claude -w` session is labelled with its worktree name', async ({
    env
  }) => {
    test.setTimeout(120_000)
    gitInit(env.workspaces.a)

    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await waitBooted(page)
      const dlg = await openWorktreeSession(page, 'ws-a')
      await dlg.getByRole('textbox').click()
      await page.keyboard.type('feat1')
      await page.keyboard.press('Enter')
      await expect(dlg).toHaveCount(0)

      const row = page.locator('.ws-tab', { hasText: FAKE_SESSION_TITLE })
      await expect.poll(async () => row.isVisible(), { timeout: 30_000 }).toBe(true)
      await expect(row.locator('.ws-tab-sub')).toHaveText('feat1')
      await expect(row).not.toHaveClass(/\bcold\b/)

      const wtDir = path.join(env.workspaces.a, '.claude', 'worktrees', 'feat1')
      expect(fs.statSync(wtDir).isDirectory()).toBe(true)
      const [call] = await waitForCalls(env, 1)
      expect(call.cwd).toBe(env.workspaces.a)
      expect(call.effectiveCwd).toBe(fs.realpathSync(wtDir))

      const rootSlug = path.join(env.home, '.claude', 'projects', encodeCwd(env.workspaces.a))
      expect(fs.readdirSync(rootSlug)).toContain(`${call.sessionId}.jsonl`)
      const head = JSON.parse(
        fs.readFileSync(path.join(rootSlug, `${call.sessionId}.jsonl`), 'utf8').split('\n')[0]
      ) as { type: string; worktreeSession: { worktreeName: string; originalCwd: string } }
      expect(head.type).toBe('worktree-state')
      expect(head.worktreeSession.worktreeName).toBe('feat1')
      expect(head.worktreeSession.originalCwd).toBe(env.workspaces.a)
      const wtSlug = path.join(env.home, '.claude', 'projects', encodeCwd(fs.realpathSync(wtDir)))
      expect(fs.readdirSync(wtSlug)).toEqual([])
      await snap(page, 'T-AGG-07')
    } finally {
      await app.close().catch(() => {})
    }
  })

  // CC§2
  test('T-AGG-07: a seeded root-slug transcript with a worktree binding is labelled by it', async ({
    env
  }) => {
    gitInit(env.workspaces.a)
    const wt = gitWorktreeAdd(env.workspaces.a, 'wt2')
    seedJsonl(env, env.workspaces.a, {
      summary: 'Bound root-slug session',
      cwd: env.workspaces.a,
      worktreeState: { worktreeName: 'wt2', worktreePath: wt, originalCwd: env.workspaces.a }
    })

    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      const row = page.locator('.ws-tab', { hasText: 'Bound root-slug session' })
      await expect(row).toBeVisible({ timeout: 20_000 })
      await expect(row).toHaveClass(/\bcold\b/)
      await expect(row.locator('.ws-tab-sub')).toHaveText('wt2')
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('T-AGG-08: an externally created matching slug dir surfaces; an unowned one and a stranger do not', async ({
    env
  }) => {
    test.setTimeout(120_000)
    gitInit(env.workspaces.a)
    const wt = gitWorktreeAdd(env.workspaces.a, 'wt3')
    const wt4 = gitWorktreeAdd(env.workspaces.a, 'wt4')
    ensureProjectsRootSoItsWatcherArms(env)

    const ownedId = '11111111-0000-4000-8000-000000000001'
    const unpinnedCheckoutKeepingOwnershipAlive = path.join(env.home, 'unpinned-checkout')
    fs.mkdirSync(unpinnedCheckoutKeepingOwnershipAlive, { recursive: true })
    seedJsonl(env, unpinnedCheckoutKeepingOwnershipAlive, {
      id: ownedId,
      summary: 'Earlier wt3 transcript',
      cwd: unpinnedCheckoutKeepingOwnershipAlive
    })

    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await expect(page.locator('.ws-head .ws-name', { hasText: 'ws-a' })).toBeVisible({
        timeout: 20_000
      })
      await expect(page.locator('.ws-tab')).toHaveCount(0)

      seedJsonl(env, wt4, { summary: 'Foreign wt4 session', cwd: wt4, owned: false })
      seedJsonl(env, wt, { id: ownedId, summary: 'External wt3 session', cwd: wt, owned: false })
      const row = page.locator('.ws-tab', { hasText: 'External wt3 session' })
      await expect.poll(async () => row.isVisible(), { timeout: 15_000 }).toBe(true)
      await expect(row.locator('.ws-tab-sub')).toHaveText('wt3')
      await expect(page.locator('.ws-tab', { hasText: 'Foreign wt4 session' })).toHaveCount(0)

      const strangerDir = path.join(env.home, '.claude', 'projects', '-zebra-unrelated-repo')
      fs.mkdirSync(strangerDir, { recursive: true })
      fs.writeFileSync(
        path.join(strangerDir, 'aaaaaaaa-0000-4000-8000-000000000001.jsonl'),
        JSON.stringify({ type: 'summary', summary: 'Zebra stranger session' }) + '\n'
      )
      await page.waitForTimeout(GRACE_FOR_A_WRONG_RESCAN_MS)
      await expect(page.locator('.ws-tab', { hasText: 'Zebra stranger session' })).toHaveCount(0)
      await expect(page.locator('.ws-tab')).toHaveCount(1)
      await snap(page, 'T-AGG-08')
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('T-AGG-03: a summary-less, prompt-less session titles as a relative time', async ({
    env
  }) => {
    seedJsonl(env, env.workspaces.a, {
      bare: true,
      timestamp: Date.now() - 2 * 3600 * 1000
    })

    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      const title = page.locator('.ws-tab .ws-tab-title')
      await expect(title).toBeVisible({ timeout: 20_000 })
      expect((await title.textContent())?.trim()).toMatch(/^\d+[smhd] ago$/)
      await snap(page, 'T-AGG-03')
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('T-AGG-05: an invalid-cwd row stays resumable and routed (only Reveal is disabled), and launches nothing on its own', async ({
    env
  }) => {
    const deadCwd = path.join(env.workspaces.a, '.claude', 'worktrees', 'deleted-worktree')
    seedJsonl(env, deadCwd, { summary: 'Ghost session', cwd: deadCwd })

    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      const row = page.locator('.ws-tab', { hasText: 'Ghost session' })
      await expect(row).toBeVisible({ timeout: 20_000 })
      await expect(row).toHaveClass(/\bcold\b/)
      await expect(row).not.toHaveClass(/\bdisabled\b/)
      await expect(row).toHaveAttribute('title', /worktree deleted; click to rebuild and resume/)

      await row.click()
      await page.waitForTimeout(2000)
      expect(readCalls(env)).toHaveLength(0)

      const menu = await openMenu(page, row)
      const items = await menuItemTexts(page)
      expect(items).toEqual(['Resume↩', 'Reveal in Finder', 'Copy session ID', 'Remove from list'])
      await expect(menu.locator('.mi.disabled')).toHaveText('Reveal in Finder')
      await snap(page, 'T-AGG-05')
      await closeMenu(page)
    } finally {
      await app.close().catch(() => {})
    }
  })

  function ensureProjectsRootSoItsWatcherArms(env: E2EEnv): void {
    fs.mkdirSync(path.join(env.home, '.claude', 'projects'), { recursive: true })
  }

  test('seed helper writes into the bucket slug the aggregator reads, so the aggregate cases cannot go vacuously green', async ({
    env
  }) => {
    const id = seedJsonl(env, env.workspaces.a, { summary: 'Slug sanity session' })
    expect(
      fs.existsSync(
        path.join(env.home, '.claude', 'projects', encodeCwd(env.workspaces.a), `${id}.jsonl`)
      )
    ).toBe(true)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await expect(page.locator('.ws-tab', { hasText: 'Slug sanity session' })).toBeVisible({
        timeout: 20_000
      })
    } finally {
      await app.close().catch(() => {})
    }
  })
})
