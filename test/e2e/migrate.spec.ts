import fs from 'fs'
import path from 'path'
import { test, expect, launchApp } from './helpers/app'
import type { E2EEnv } from './helpers/env'
import {
  addWorkspace,
  gitInit,
  gitWorktreeAdd,
  layoutOnDisk,
  seedJsonl,
  snap,
  workspaceNames
} from './helpers/p1'

test.describe('v1 → v4 layout migration end to end: a v1 layout.json written before the real first boot', () => {
  function writeV1Layout(env: E2EEnv, tabs: unknown[], activeIndex = 1): void {
    fs.writeFileSync(
      path.join(env.userData, 'layout.json'),
      JSON.stringify({ version: 1, tabs, activeIndex })
    )
  }

  test('T-MIG-07: v1 layout (worktree+subdir+shell+dead tabs) boots straight into the v4 workspace tree, never via the v2 `aux` shape', async ({
    env
  }) => {
    test.setTimeout(120_000)
    const repo = path.join(env.home, 'repo')
    fs.mkdirSync(path.join(repo, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(repo, 'sub', 'file.txt'), 'x\n')
    gitInit(repo)
    const wt = gitWorktreeAdd(repo, 'wtm')
    const gone = path.join(env.home, 'gone')
    fs.mkdirSync(gone)
    fs.rmSync(gone, { recursive: true })

    const mainId = seedJsonl(env, repo, { summary: 'Migrated main session', owned: false })
    const wtId = seedJsonl(env, wt, { summary: 'Migrated worktree session', cwd: wt, owned: false })

    writeV1Layout(env, [
      { kind: 'claude', cwd: wt, sessionId: wtId, title: 'old worktree tab' },
      { kind: 'claude', cwd: path.join(repo, 'sub'), sessionId: mainId, title: 'old subdir tab' },
      { kind: 'shell', cwd: env.workspaces.b, title: 'free terminal' },
      { kind: 'claude', cwd: gone, sessionId: 'dead-beef', title: 'dead dir tab' }
    ])

    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')

      await expect(page.locator('.ws-head .ws-name')).toHaveText(['repo'], { timeout: 20_000 })

      const mainRow = page.locator('.ws-tab', { hasText: 'Migrated main session' })
      const wtRow = page.locator('.ws-tab', { hasText: 'Migrated worktree session' })
      await expect(mainRow).toBeVisible({ timeout: 20_000 })
      await expect(wtRow).toBeVisible()
      await expect(mainRow).toHaveClass(/\bcold\b/)
      await expect(wtRow).toHaveClass(/\bcold\b/)
      await expect(mainRow.locator('.ws-tab-sub')).toHaveText('main')
      await expect(wtRow.locator('.ws-tab-sub')).toHaveText('wtm')

      await expect(page.locator('.ws-tab')).toHaveCount(2)
      await expect(page.locator('.ws-tab.active')).toHaveCount(0)
      await expect(page.locator('.center')).toContainText('No running session')

      const layout = layoutOnDisk(env)
      expect(layout.version).toBe(6)
      expect(layout.workspaces).toEqual([{ path: repo }])
      expect(layout).not.toHaveProperty('tabs')
      expect(layout).not.toHaveProperty('activeSessionId')
      expect(layout.workbench).toEqual({ defaultOpen: false })
      expect(layout).not.toHaveProperty('aux')
      expect([...(layout.members ?? [])].sort()).toEqual([mainId, wtId].sort())
      expect(Object.keys(layout.panels ?? {}).sort()).toEqual([mainId, wtId].sort())

      await snap(page, 'T-MIG-07')
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('an upgrade boot adopts nothing by itself: a jsonl no v1 tab pointed at stays invisible and unadopted', async ({
    env
  }) => {
    const histId = seedJsonl(env, env.workspaces.a, { summary: 'External session', owned: false })
    fs.writeFileSync(
      path.join(env.userData, 'layout.json'),
      JSON.stringify({
        version: 4,
        workspaces: [{ path: env.workspaces.a }, { path: env.workspaces.b }],
        workbench: { defaultOpen: true },
        sessions: {}
      })
    )

    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')

      await expect(page.locator('.ws-head .ws-name').first()).toBeVisible({ timeout: 20_000 })
      await expect(page.locator('.ws-tab', { hasText: 'External session' })).toHaveCount(0)

      const after = layoutOnDisk(env)
      expect(after.members).not.toContain(histId)
      expect((after.panels as Record<string, unknown>)[histId]).toBeUndefined()
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('T-MIG-04 (e2e half): migrated workspaces are alphabetical, a later add appends to the tail even when it sorts first', async ({
    env
  }) => {
    const mike = path.join(env.home, 'mike')
    const zeta = path.join(env.home, 'zeta')
    const alpha = path.join(env.home, 'alpha')
    for (const d of [mike, zeta, alpha]) fs.mkdirSync(d)

    writeV1Layout(env, [
      { kind: 'claude', cwd: zeta },
      { kind: 'claude', cwd: mike }
    ])

    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')

      await expect(page.locator('.ws-head .ws-name')).toHaveText(['mike', 'zeta'], {
        timeout: 20_000
      })
      expect((layoutOnDisk(env).workspaces as { path: string }[]).map((w) => w.path)).toEqual([
        mike,
        zeta
      ])

      const res = await addWorkspace(page, alpha)
      expect(res).toEqual({ code: 'added', path: alpha })
      await expect(page.locator('.ws-head .ws-name')).toHaveText(['mike', 'zeta', 'alpha'])
      expect((layoutOnDisk(env).workspaces as { path: string }[]).map((w) => w.path)).toEqual([
        mike,
        zeta,
        alpha
      ])

      expect(await workspaceNames(page)).toEqual(['mike', 'zeta', 'alpha'])
      await snap(page, 'T-MIG-04')
    } finally {
      await app.close().catch(() => {})
    }
  })
})
