import fs from 'fs'
import path from 'path'
import { test, expect, launchApp } from './helpers/app'
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

// Multi-bucket aggregation + the watcher trigger set.
// Every test launches manually so Claude-storage / git fixtures exist BEFORE the
// startup rescan where the case demands it.

// T-AGG-06 — behavioral: a worktree created with native git before launch, its slug
// bucket pre-seeded in Claude's storage → the session row is there after startup
// (trigger a), attributed to the worktree by bucket dir.
test('T-AGG-06: a pre-seeded native-git worktree session is listed after startup', async ({
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
    // worktree attribution comes from the bucket dir (never gitBranch)
    await expect(row.locator('.ws-tab-sub')).toHaveText('wt1')
    await snap(page, 'T-AGG-06')
  } finally {
    await app.close().catch(() => {})
  }
})

// T-AGG-06 (negative) — the same fixture minus the ownership entry: an external
// `claude` run in that worktree is aggregated all the same, and then filtered out
// (— the sidebar lists only sessions Koloft drove).
test('T-AGG-06: the same pre-seeded worktree session stays hidden when Koloft never drove it', async ({
  env
}) => {
  gitInit(env.workspaces.a)
  const wt = gitWorktreeAdd(env.workspaces.a, 'wt1')
  seedJsonl(env, wt, { summary: 'WT preseed session', cwd: wt, owned: false })

  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    // the workspace itself renders — without this the count below is vacuous
    await expect(page.locator('.ws-head .ws-name', { hasText: 'ws-a' })).toBeVisible({
      timeout: 20_000
    })
    await page.waitForTimeout(3000) // give the startup rescan every chance to land
    await expect(page.locator('.ws-tab')).toHaveCount(0)
  } finally {
    await app.close().catch(() => {})
  }
})

// T-AGG-07 (the lifecycle contract D11) — `claude -w <new>` makes the fake create a REAL
// worktree, and — the shape the real 2.1.227 has (§6/E2) — keeps its transcript in the
// REPO-ROOT slug with a `worktree-state` head record. Bucket dir alone would therefore
// label this row "main"; the binding is what makes it read as the worktree it actually
// runs in. Trigger (b) still applies: the SessionStart cwd is outside every known
// bucket, so a rescan has to land within the poll budget either way.
test('T-AGG-07: a root-slug `claude -w` session is labelled with its worktree name', async ({
  env
}) => {
  test.setTimeout(120_000)
  gitInit(env.workspaces.a)

  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    // C8 is the product's `claude -w`: name a worktree that does not exist and ⏎
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

    // the worktree really exists on disk, in CC's namespace, and the session runs there
    const wtDir = path.join(env.workspaces.a, '.claude', 'worktrees', 'feat1')
    expect(fs.statSync(wtDir).isDirectory()).toBe(true)
    const [call] = await waitForCalls(env, 1)
    expect(call.cwd).toBe(env.workspaces.a) // launch cwd stays the repo root
    expect(call.effectiveCwd).toBe(fs.realpathSync(wtDir))

    // the label above came from the binding, not from the bucket: the transcript is in
    // the ROOT slug, and the worktree's own slug dir exists but holds nothing
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

// T-AGG-07 (cold half, the lifecycle contract D11) — the same rule with no live session in
// sight: a transcript in the REPO-ROOT slug that carries a worktree binding is
// labelled by the binding. Slug location and binding are independent axes (§1✎) —
// this is the shape that used to read as "main".
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

// T-AGG-08 — trigger (c): a slug dir appearing under ~/.claude/projects that
// prefix-matches a pinned workspace pulls a rescan and the row in; a slug Koloft never
// drove, and a non-matching slug, are never included.
test('T-AGG-08: an externally created matching slug dir surfaces; a stranger does not', async ({
  env
}) => {
  test.setTimeout(120_000)
  gitInit(env.workspaces.a)
  const wt = gitWorktreeAdd(env.workspaces.a, 'wt3') // bucket known from startup, no jsonl yet
  const wt4 = gitWorktreeAdd(env.workspaces.a, 'wt4')
  // the projects root must exist for its fs.watch to arm at startup (on a real
  // machine ~/.claude/projects always does; a fresh e2e home starts without it)
  fs.mkdirSync(path.join(env.home, '.claude', 'projects'), { recursive: true })

  // Koloft drove the wt3 session once, from a checkout that is not pinned any more, so
  // the layout carries its ownership entry — and an older transcript keeps that entry
  // alive past the §6 GC (which drops a `sessions` key the moment NO jsonl anywhere in
  // Claude's storage carries its id) while putting no row on screen: an unpinned
  // directory's slug is nobody's bucket.
  const ownedId = '11111111-0000-4000-8000-000000000001'
  const unpinned = path.join(env.home, 'unpinned-checkout')
  fs.mkdirSync(unpinned, { recursive: true })
  seedJsonl(env, unpinned, { id: ownedId, summary: 'Earlier wt3 transcript', cwd: unpinned })

  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.locator('.ws-head .ws-name', { hasText: 'ws-a' })).toBeVisible({
      timeout: 20_000
    })
    await expect(page.locator('.ws-tab')).toHaveCount(0)

    // two external `claude` runs drop new slug dirs + jsonl while Koloft is running: one
    // in the session Koloft owns, one it never drove. The owned row showing up is proof a
    // rescan ran over BOTH drops — so the other one's absence is the ownership filter,
    // not a rescan that never happened.
    seedJsonl(env, wt4, { summary: 'Foreign wt4 session', cwd: wt4, owned: false })
    seedJsonl(env, wt, { id: ownedId, summary: 'External wt3 session', cwd: wt, owned: false })
    const row = page.locator('.ws-tab', { hasText: 'External wt3 session' })
    await expect.poll(async () => row.isVisible(), { timeout: 15_000 }).toBe(true)
    await expect(row.locator('.ws-tab-sub')).toHaveText('wt3')
    await expect(page.locator('.ws-tab', { hasText: 'Foreign wt4 session' })).toHaveCount(0)

    // a stranger slug (no pinned-workspace prefix) must never be aggregated
    const strangerDir = path.join(env.home, '.claude', 'projects', '-zebra-unrelated-repo')
    fs.mkdirSync(strangerDir, { recursive: true })
    fs.writeFileSync(
      path.join(strangerDir, 'aaaaaaaa-0000-4000-8000-000000000001.jsonl'),
      JSON.stringify({ type: 'summary', summary: 'Zebra stranger session' }) + '\n'
    )
    await page.waitForTimeout(3000) // give a (wrong) rescan every chance to land
    await expect(page.locator('.ws-tab', { hasText: 'Zebra stranger session' })).toHaveCount(0)
    await expect(page.locator('.ws-tab')).toHaveCount(1)
    await snap(page, 'T-AGG-08')
  } finally {
    await app.close().catch(() => {})
  }
})

// T-AGG-03 (e2e smoke) — the title chain's third state: no summary, no genuine user
// prompt → the row titles as a relative time, asserted by format only (unit tests pin
// the exact values with an injected clock).
test('T-AGG-03: a summary-less, prompt-less session titles as a relative time', async ({ env }) => {
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

// T-AGG-05 (e2e half, the lifecycle contract D6) — a session whose recorded cwd is gone is no
// longer a dead row: it is the resume tree's rebuild ENTRANCE, so it stays clickable
// and keeps Resume in its menu (pre-gating it here is exactly what would close D6
// off). Reveal is the one item that genuinely has nothing to act on. What must never
// happen is a silent launch elsewhere — a cwd nothing can rebuild spawns nothing.
//
// the row's folder — the one Reveal opens and the one its greying is decided by — is
// the folder this session's transcript belongs to, so the fixture puts the transcript in
// the bucket of a worktree that is not there. ws-a is no repo, so there is still nothing to
// rebuild from and the click must still launch nothing.
test('T-AGG-05: an invalid-cwd row stays resumable and routed, and launches nothing on its own', async ({
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

    // the folder is SHAPED like a worktree, but ws-a is no repo, so the tree has nothing
    // to rebuild from — and a session must never be quietly resumed somewhere it did not live
    await row.click()
    await page.waitForTimeout(2000)
    expect(readCalls(env)).toHaveLength(0)

    const menu = await openMenu(page, row)
    const items = await menuItemTexts(page)
    // Resume present (D6 routes it), Remove from list present (D4 renamed the item,
    // the channel underneath is unchanged) — a worktree the agent deleted is exactly
    // the row the user needs both a way back INTO and a way OFF the list for
    expect(items).toEqual(['Resume↩', 'Reveal in Finder', 'Copy session ID', 'Remove from list'])
    await expect(menu.locator('.mi.disabled')).toHaveText('Reveal in Finder')
    await snap(page, 'T-AGG-05')
    await closeMenu(page)
  } finally {
    await app.close().catch(() => {})
  }
})

// sanity guard for the seed helper itself: the slug it writes is the one the
// aggregator resolves for the bucket (a drifted encoding would silently no-op
// several tests above into vacuous greens)
test('seed helper writes into the bucket slug the aggregator reads', async ({ env }) => {
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
