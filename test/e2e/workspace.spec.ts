import fs from 'fs'
import path from 'path'
import { test, expect, launchApp } from './helpers/app'
import {
  addWorkspace,
  closeMenu,
  FAKE_SESSION_TITLE,
  gitInit,
  gitWorktreeAdd,
  layoutOnDisk,
  menuItemTexts,
  openMenu,
  processAlive,
  resumedId,
  seedJsonl,
  snap,
  startSessionIn,
  waitBooted,
  waitForCalls,
  workspaceNames
} from './helpers/p1'

test.describe('Workspace management: every add goes through the workspace:add IPC, never the native folder picker', () => {
  test('T-WS-01: adding a linked worktree is rejected and pins nothing', async ({ page, env }) => {
    const repo = path.join(env.home, 'repoW')
    fs.mkdirSync(repo)
    gitInit(repo)
    const wt = gitWorktreeAdd(repo, 'wtw')

    await expect(page.locator('.ws-head')).toHaveCount(2, { timeout: 20_000 })
    const res = await addWorkspace(page, wt)
    expect(res).toEqual({ code: 'rejected-worktree' })

    await page.waitForTimeout(500)
    await expect(page.locator('.ws-head')).toHaveCount(2)
    expect((layoutOnDisk(env).workspaces as { path: string }[]).map((w) => w.path)).toEqual([
      env.workspaces.a,
      env.workspaces.b
    ])
    await snap(page, 'T-WS-01')
  })

  test('T-WS-02: a subdir add normalizes to the repo root, idempotently', async ({ page, env }) => {
    const repo = path.join(env.home, 'repo2')
    fs.mkdirSync(path.join(repo, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(repo, 'sub', 'f.txt'), 'x\n')
    gitInit(repo)

    await expect(page.locator('.ws-head')).toHaveCount(2, { timeout: 20_000 })
    expect(await addWorkspace(page, path.join(repo, 'sub'))).toEqual({
      code: 'added',
      path: repo
    })
    await expect(page.locator('.ws-head .ws-name', { hasText: 'repo2' })).toBeVisible()
    await expect(page.locator('.ws-head')).toHaveCount(3)

    expect(await addWorkspace(page, repo)).toEqual({ code: 'exists', path: repo })
    expect(await addWorkspace(page, path.join(repo, 'sub'))).toEqual({
      code: 'exists',
      path: repo
    })
    await expect(page.locator('.ws-head')).toHaveCount(3)
    const paths = (layoutOnDisk(env).workspaces as { path: string }[]).map((w) => w.path)
    expect(paths.filter((p) => p === repo)).toHaveLength(1)
    await snap(page, 'T-WS-02')
  })

  test('T-WS-03: remove confirms with N in a DOM modal, closes ptys, sessions survive re-add', async ({
    page,
    env
  }) => {
    test.setTimeout(180_000)
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    await expect(page.locator('.ws-tab-title', { hasText: FAKE_SESSION_TITLE })).toBeVisible({
      timeout: 40_000
    })
    const [first] = await waitForCalls(env, 1)

    await openMenu(page, page.locator('.ws-head', { hasText: 'ws-a' }))
    await page.locator('.menu .mi.danger', { hasText: 'Remove workspace' }).click()

    const modal = page.locator('.modal')
    await expect(modal).toBeVisible()
    await expect(modal).toContainText('1 running session')
    await snap(page, 'T-WS-03')
    await modal.locator('.btn-primary', { hasText: 'Close & remove' }).click()

    await expect(page.locator('.ws-head .ws-name', { hasText: 'ws-a' })).toHaveCount(0, {
      timeout: 20_000
    })
    await expect.poll(() => processAlive(first.pid), { timeout: 30_000 }).toBe(false)
    expect((layoutOnDisk(env).workspaces as { path: string }[]).map((w) => w.path)).toEqual([
      env.workspaces.b
    ])

    expect(await addWorkspace(page, env.workspaces.a)).toEqual({
      code: 'added',
      path: env.workspaces.a
    })
    const row = page.locator('.ws-tab', { hasText: 'Fake session: project notes' })
    await expect(row).toBeVisible({ timeout: 20_000 })
    await expect(row).toHaveClass(/\bcold\b/)
    await row.click()
    const calls = await waitForCalls(env, 2)
    expect(resumedId(calls[1])).toBe(first.sessionId)
  })

  test('T-WS-04: a deleted workspace dir grays out, menu shrinks to Remove, rows survive', async ({
    env
  }) => {
    test.setTimeout(120_000)
    seedJsonl(env, env.workspaces.b, { summary: 'Doomed dir session' })

    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      const row = page.locator('.ws-tab', { hasText: 'Doomed dir session' })
      await expect(row).toBeVisible({ timeout: 20_000 })
      await expect(row).toHaveAttribute('title', /click to resume$/)

      fs.rmSync(env.workspaces.b, { recursive: true, force: true })
      const wsD = path.join(env.home, 'ws-d')
      fs.mkdirSync(wsD)
      expect(await addWorkspace(page, wsD)).toEqual({ code: 'added', path: wsD })

      const head = page.locator('.ws-head', { hasText: 'ws-b' })
      await expect(head).toHaveClass(/\bmissing\b/, { timeout: 20_000 })
      await expect(head).toHaveAttribute('title', 'folder deleted')

      await expect(row).toBeVisible()
      await expect(row).not.toHaveClass(/\bdisabled\b/)
      await expect(row).toHaveAttribute('title', /worktree deleted; click to rebuild and resume$/)

      await openMenu(page, head)
      expect(await menuItemTexts(page)).toEqual(['Remove workspace'])
      await snap(page, 'T-WS-04')
      await closeMenu(page)
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('T-WS-06: only an intact git workspace wears the branch mark', async ({ env }) => {
    test.setTimeout(120_000)
    gitInit(env.workspaces.a)

    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      const headA = page.locator('.ws-head', { hasText: 'ws-a' })
      const headB = page.locator('.ws-head', { hasText: 'ws-b' })
      await expect(headA).toBeVisible({ timeout: 20_000 })
      await expect(headA.locator('.ws-git')).toHaveCount(1)
      await expect(headB.locator('.ws-git')).toHaveCount(0)
      await snap(page, 'T-WS-06')

      fs.rmSync(env.workspaces.a, { recursive: true, force: true })
      const wsE = path.join(env.home, 'ws-e')
      fs.mkdirSync(wsE)
      expect(await addWorkspace(page, wsE)).toEqual({ code: 'added', path: wsE })
      await expect(headA).toHaveClass(/\bmissing\b/, { timeout: 20_000 })
      await expect(headA.locator('.ws-git')).toHaveCount(0)
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('T-WS-05: a new workspace appends to the tail and the order survives a restart', async ({
    env
  }) => {
    test.setTimeout(120_000)
    const early = path.join(env.home, 'aa-early')
    fs.mkdirSync(early)

    const app1 = await launchApp(env)
    const page1 = await app1.firstWindow()
    await page1.waitForLoadState('domcontentloaded')
    await expect(page1.locator('.ws-head')).toHaveCount(2, { timeout: 20_000 })
    expect(await addWorkspace(page1, early)).toEqual({ code: 'added', path: early })
    await expect(page1.locator('.ws-head .ws-name')).toHaveText(['ws-a', 'ws-b', 'aa-early'])
    await page1.waitForTimeout(500)
    await app1.close()

    const app2 = await launchApp(env)
    try {
      const page2 = await app2.firstWindow()
      await page2.waitForLoadState('domcontentloaded')
      await expect(page2.locator('.ws-head .ws-name')).toHaveText(['ws-a', 'ws-b', 'aa-early'], {
        timeout: 20_000
      })
      expect(await workspaceNames(page2)).toEqual(['ws-a', 'ws-b', 'aa-early'])
      expect((layoutOnDisk(env).workspaces as { path: string }[]).map((w) => w.path)).toEqual([
        env.workspaces.a,
        env.workspaces.b,
        early
      ])
      await snap(page2, 'T-WS-05')
    } finally {
      await app2.close().catch(() => {})
    }
  })
})
