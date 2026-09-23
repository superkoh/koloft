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

// v1 → v4 layout migration, end to end. Only the
// `env` fixture is used: each test overwrites the seeded layout.json with a v1
// document BEFORE its own launch, then asserts what the real first boot made of it.
//
// bumped the target version: the v1 branch lands directly on the current shape (`workbench`), never
// on the intermediate v2 (`aux`) shape — migrateLayout has one output document, so a v1
// upgrade skips the former vocabulary entirely rather than passing through it.

function writeV1Layout(env: E2EEnv, tabs: unknown[], activeIndex = 1): void {
  fs.writeFileSync(
    path.join(env.userData, 'layout.json'),
    JSON.stringify({ version: 1, tabs, activeIndex })
  )
}

// T-MIG-07 — the full chain over all four v1 tab shapes: a worktree-cwd claude tab
// and a subdir-cwd claude tab merge into ONE workspace at the canonical repo root; a
// shell tab and a dead-directory claude tab vanish without residue (A11); historic
// sessions re-appear as cold rows aggregated from Claude's own storage — including
// the worktree bucket's — and the file on disk is rewritten as v2.
test('T-MIG-07: v1 layout (worktree+subdir+shell+dead tabs) boots into the v4 workspace tree', async ({
  env
}) => {
  test.setTimeout(120_000)
  // the repo the two claude tabs drifted around in
  const repo = path.join(env.home, 'repo')
  fs.mkdirSync(path.join(repo, 'sub'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'sub', 'file.txt'), 'x\n')
  gitInit(repo)
  const wt = gitWorktreeAdd(repo, 'wtm')
  // a dead directory a v1 claude tab still points at
  const gone = path.join(env.home, 'gone')
  fs.mkdirSync(gone)
  fs.rmSync(gone, { recursive: true })

  // historic sessions in Claude's storage: one in the main-checkout bucket, one in
  // the worktree bucket — both must surface as cold rows after the upgrade. A v1
  // document has no `sessions` map to pre-seed: their ownership has to come out of
  // the migration itself, from the very tabs that drove them.
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

    // exactly ONE workspace: the canonical repo root (worktree + subdir merged);
    // the shell tab's dir and the dead dir pinned nothing
    await expect(page.locator('.ws-head .ws-name')).toHaveText(['repo'], { timeout: 20_000 })

    // both historic sessions reappear as cold rows, the worktree one attributed by
    // its bucket dir (second line = worktree name)
    const mainRow = page.locator('.ws-tab', { hasText: 'Migrated main session' })
    const wtRow = page.locator('.ws-tab', { hasText: 'Migrated worktree session' })
    await expect(mainRow).toBeVisible({ timeout: 20_000 })
    await expect(wtRow).toBeVisible()
    await expect(mainRow).toHaveClass(/\bcold\b/)
    await expect(wtRow).toHaveClass(/\bcold\b/)
    await expect(mainRow.locator('.ws-tab-sub')).toHaveText('main')
    await expect(wtRow.locator('.ws-tab-sub')).toHaveText('wtm')

    // nothing runs, nothing is selected — the v1 tabs are gone without legacy residue
    await expect(page.locator('.ws-tab')).toHaveCount(2)
    await expect(page.locator('.ws-tab.active')).toHaveCount(0)
    await expect(page.locator('.center')).toContainText('No running session')

    // the file itself is now v4: canonical root only, no tabs, defaults in place
    const layout = layoutOnDisk(env)
    expect(layout.version).toBe(4)
    expect(layout.workspaces).toEqual([{ path: repo }])
    expect(layout).not.toHaveProperty('tabs')
    expect(layout).not.toHaveProperty('activeSessionId')
    // the Workbench's global default replaces `aux.defaultMode`, and the former key
    // is not written alongside it — a document carrying both would be read by the v2
    // guard first on the next boot and re-migrate every session entry. v4 ships that
    // default COLLAPSED.
    expect(layout.workbench).toEqual({ defaultOpen: false })
    expect(layout).not.toHaveProperty('aux')
    // ownership migrated with the tabs; `dead-beef` had no transcript left, so the
    // first rescan's §6 GC dropped it
    expect(Object.keys(layout.sessions as Record<string, unknown>).sort()).toEqual(
      [mainId, wtId].sort()
    )

    await snap(page, 'T-MIG-07')
  } finally {
    await app.close().catch(() => {})
  }
})

// Decided (overturning the D1 full backfill) — an upgrade boot adopts NOTHING by
// itself: the only ownership the migration carries over is what the v1 tab ledger
// names (T-MIG-07 above). A jsonl no v1 tab pointed at — an external terminal run,
// `claude -p` residue, ancient history — must stay invisible AND must not be seeded
// into `sessions`, on this boot or any later rescan.
test('upgrade boot leaves unowned jsonl invisible and unadopted', async ({ env }) => {
  const histId = seedJsonl(env, env.workspaces.a, { summary: 'External session', owned: false })

  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')

    // the workspace itself has rendered — absence of the row is a verdict, not a race
    await expect(page.locator('.ws-head .ws-name').first()).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('.ws-tab', { hasText: 'External session' })).toHaveCount(0)

    const after = layoutOnDisk(env)
    expect((after.sessions as Record<string, unknown>)[histId]).toBeUndefined()
  } finally {
    await app.close().catch(() => {})
  }
})

// T-MIG-04 (e2e half) — migration writes workspaces[] alphabetically; every LATER
// add appends to the tail, even when the new name sorts first. (The alphabetical
// write itself is unit-covered; this pins the live append + render order.)
test('T-MIG-04: migrated workspaces are alphabetical, a later add appends to the tail', async ({
  env
}) => {
  const mike = path.join(env.home, 'mike')
  const zeta = path.join(env.home, 'zeta')
  const alpha = path.join(env.home, 'alpha')
  for (const d of [mike, zeta, alpha]) fs.mkdirSync(d)

  // v1 order deliberately reversed — migration must sort, not preserve
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

    // 'alpha' sorts before both, yet must land LAST (append semantics, §6)
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
