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

// Workspace management. All adds go
// through the workspace:add IPC — never the native folder picker (§0).

// T-WS-01 — a linked worktree of ANY repo is refused: pin the repo root instead.
test('T-WS-01: adding a linked worktree is rejected and pins nothing', async ({ page, env }) => {
  const repo = path.join(env.home, 'repoW')
  fs.mkdirSync(repo)
  gitInit(repo)
  const wt = gitWorktreeAdd(repo, 'wtw')

  await expect(page.locator('.ws-head')).toHaveCount(2, { timeout: 20_000 })
  const res = await addWorkspace(page, wt)
  expect(res).toEqual({ code: 'rejected-worktree' })

  await page.waitForTimeout(500)
  await expect(page.locator('.ws-head')).toHaveCount(2) // nothing appeared
  expect((layoutOnDisk(env).workspaces as { path: string }[]).map((w) => w.path)).toEqual([
    env.workspaces.a,
    env.workspaces.b
  ])
  await snap(page, 'T-WS-01')
})

// T-WS-02 — a repo subdir normalizes to the repo root; re-adding (root or subdir)
// is idempotent.
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

  // idempotent, both through the root and through the subdir again
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

// T-WS-03 — removing a workspace with running sessions confirms via a DOM modal
// naming N, then closes the ptys gracefully; the sessions stay in Claude's storage
// and re-adding the folder brings them back resumable.
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

  // the confirmation is a DOM .modal (never a native dialog) and it names N
  const modal = page.locator('.modal')
  await expect(modal).toBeVisible()
  await expect(modal).toContainText('1 running session')
  await snap(page, 'T-WS-03')
  await modal.locator('.btn-primary', { hasText: 'Close & remove' }).click()

  // the pin is gone and the pty was closed gracefully
  await expect(page.locator('.ws-head .ws-name', { hasText: 'ws-a' })).toHaveCount(0, {
    timeout: 20_000
  })
  await expect.poll(() => processAlive(first.pid), { timeout: 30_000 }).toBe(false)
  expect((layoutOnDisk(env).workspaces as { path: string }[]).map((w) => w.path)).toEqual([
    env.workspaces.b
  ])

  // Claude's storage was never touched: re-adding lists the session cold, resumable
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

// T-WS-04 — a workspace whose directory is deleted at runtime: the head grays with
// the tooltip, its menu shrinks to Remove workspace only, and aggregation degrades
// to the single root bucket without losing the rows (or crashing).
test('T-WS-04: a deleted workspace dir grays out, menu shrinks to Remove, rows survive', async ({
  env
}) => {
  test.setTimeout(120_000)
  // a cold session recorded in ws-b's bucket before launch — listed from startup
  seedJsonl(env, env.workspaces.b, { summary: 'Doomed dir session' })

  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const row = page.locator('.ws-tab', { hasText: 'Doomed dir session' })
    await expect(row).toBeVisible({ timeout: 20_000 })
    await expect(row).toHaveAttribute('title', /click to resume$/)

    fs.rmSync(env.workspaces.b, { recursive: true, force: true })
    // the missing flag is computed on rescan — adding another workspace forces one
    const wsD = path.join(env.home, 'ws-d')
    fs.mkdirSync(wsD)
    expect(await addWorkspace(page, wsD)).toEqual({ code: 'added', path: wsD })

    const head = page.locator('.ws-head', { hasText: 'ws-b' })
    await expect(head).toHaveClass(/\bmissing\b/, { timeout: 20_000 })
    await expect(head).toHaveAttribute('title', 'folder deleted')

    // single-bucket degradation: the cold row is still listed and still ACTIONABLE —
    // the lifecycle contract D6 retired the invalidCwd gray-out, because a vanished cwd is the
    // resume tree's rebuild branch, not a dead row. Only the tooltip changes.
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

// T-WS-06 — git-ness surfaces once, as the branch mark after the head's name: a repo
// wears it, a plain folder wears nothing (it is what takes the worktree entrances off
// the row, D10). A folder that no longer exists reports "deleted" and wears nothing
// either, whatever it used to be.
test('T-WS-06: only an intact git workspace wears the branch mark', async ({ env }) => {
  test.setTimeout(120_000)
  gitInit(env.workspaces.a) // ws-b stays a plain directory

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

    // a deleted repo is not "a git workspace" any more — the missing state wins
    fs.rmSync(env.workspaces.a, { recursive: true, force: true })
    const wsE = path.join(env.home, 'ws-e')
    fs.mkdirSync(wsE)
    expect(await addWorkspace(page, wsE)).toEqual({ code: 'added', path: wsE }) // forces a rescan
    await expect(headA).toHaveClass(/\bmissing\b/, { timeout: 20_000 })
    await expect(headA.locator('.ws-git')).toHaveCount(0)
  } finally {
    await app.close().catch(() => {})
  }
})

// T-WS-05 — adds append to the tail regardless of name order, and a restart keeps
// the array order exactly.
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
  // 'aa-early' sorts first alphabetically but must render (and persist) last
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
