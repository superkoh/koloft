import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from '../helpers/app'
import { openMenu, seedJsonl } from '../helpers/p1'
import {
  gitWorktreeAdd,
  launchSettled,
  pinWorkspaces,
  pressNewWorktreeSession,
  rowsWithSub,
  waitForSessionRow
} from '../helpers/blackbox'

/**
 * Black-box cases for the C8 worktree dialog and the ⇧⌘N entrance that reaches it
 *.
 * RED until the feature exists.
 *
 * Locator discipline: the dialogs, their buttons and their hints are NEW surfaces, so
 * they are found by the text the case itself names — never by a class this file made
 * up. `.modal` / `[role="dialog"]` is only the container every dialog Koloft already ships
 * lives in; the title text is what identifies which dialog it is. Setup and observation
 * use the harness's existing sidebar seams (`.ws-head`, `.ws-tab`, rowsWithSub).
 */

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The dialog carrying `title` — innermost match, so a nested container can't shadow it. */
function dialogTitled(page: Page, title: string): Locator {
  return page.locator('.modal, [role="dialog"]').filter({ hasText: title }).last()
}

const c8 = (page: Page, ws: string): Locator => dialogTitled(page, `New Worktree Session · ${ws}`)
const c10Worktree = (page: Page): Locator => dialogTitled(page, 'New Worktree Session in…')
const c10Main = (page: Page): Locator => dialogTitled(page, 'New Session in…')

/** C8's single name field. */
const field = (dlg: Locator): Locator => dlg.getByRole('textbox')

/** C8's morphing primary — the button that always opens with the worktree action it
 *  will perform (Create worktree "x" / Open worktree "x"), enabled or not: design D12
 *  reachability contract pins that the disabled state keeps its Create/Open label. */
const primary = (dlg: Locator): Locator =>
  dlg.getByRole('button', { name: /^(Create|Open) worktree/ })

/** The label the cases write with straight quotes; the app renders typographic ones. */
const reads = (verb: 'Create' | 'Open', name: string): RegExp =>
  new RegExp(`${verb} worktree [“"]${esc(name)}[”"]`)

/** The note every existing-worktree row carries (`branch worktree-<name>`) — the format
 *  is design D12 reachability contract, not a guess; one per row, and the lookahead keeps
 *  `new-session` from answering for `new-session-ux`. */
const wtNote = (dlg: Locator, name: string): Locator =>
  dlg.getByText(new RegExp(`branch worktree-${esc(name)}(?![A-Za-z0-9._-])`))

/** …and the row that note sits in (what a user clicks). */
const wtRow = (dlg: Locator, name: string): Locator => wtNote(dlg, name).locator('..')

/** Open C8 for `ws` through ⇧⌘N. §03A skips the C10 picker when a single row is
 *  visible; a build that still shows it takes one ⏎ on the preselection — either way
 *  the case under test starts at C8. */
async function openC8(app: ElectronApplication, page: Page, ws: string): Promise<Locator> {
  await pressNewWorktreeSession(app, page)
  await expect(c8(page, ws).or(c10Worktree(page)).first()).toBeVisible({ timeout: 20_000 })
  if (await c10Worktree(page).count()) await page.keyboard.press('Enter')
  const dlg = c8(page, ws)
  await expect(dlg).toBeVisible({ timeout: 20_000 })
  return dlg
}

/** Type into the name field the way a user does (the field is where hot starts). */
async function typeName(page: Page, dlg: Locator, name: string): Promise<void> {
  await field(dlg).click()
  await page.keyboard.type(name)
}

/** The cases' setup vocabulary for "last-touched = this workspace": start a main
 *  session from the workspace's own context menu — a direct launch (D7). */
async function startMainSession(page: Page, ws: string): Promise<void> {
  await openMenu(page, page.locator('.ws-head', { hasText: ws }))
  await page.locator('.menu .mi', { hasText: 'New session' }).click()
  await waitForSessionRow(page, ws, 'main')
}

// BB-M05 — ⇧⌘N opens the worktree-mode picker, then C8 for the confirmed workspace.
test('BB-M05: ⇧⌘N opens the worktree-mode picker, then C8 for the confirmed workspace', async ({
  env
}) => {
  test.setTimeout(180_000)
  // A = ws-alpha, B = ws-bravo (distinct basenames: sidebar rows match by substring)
  pinWorkspaces(env, [
    { name: 'ws-alpha', kind: 'git' },
    { name: 'ws-bravo', kind: 'git' }
  ])

  const { app, page } = await launchSettled(env)
  try {
    await startMainSession(page, 'ws-bravo') // last-touched = B

    await pressNewWorktreeSession(app, page)
    const picker = c10Worktree(page)
    await expect(picker).toBeVisible({ timeout: 20_000 })
    await expect(picker.getByRole('button', { name: 'Next' })).toBeVisible()

    await page.keyboard.press('Enter')
    // B was the preselection, so ⏎ is what names the dialog that replaces the picker
    const dlg = c8(page, 'ws-bravo')
    await expect(dlg).toBeVisible({ timeout: 20_000 })
    await expect(c10Worktree(page)).toHaveCount(0)
    await expect(field(dlg)).toHaveCount(1)
    // "field, no list" in the terms D12 reachability contract pins: list rows are role=option, and
    // an existing-worktree row always carries its `branch worktree-<name>` note
    await expect(dlg.getByRole('option')).toHaveCount(0)
    await expect(dlg.getByText(/branch worktree-/)).toHaveCount(0)
    await expect(field(dlg)).toHaveAttribute('placeholder', 'name a new worktree')
  } finally {
    await app.close().catch(() => {})
  }
})

// BB-M06 — typing a new name and ⏎ creates that worktree's session.
test("BB-M06: typing a new name and ⏎ creates that worktree's session", async ({ env }) => {
  test.setTimeout(180_000)
  pinWorkspaces(env, [{ name: 'repo-one', kind: 'git' }]) // no worktree named payment-retry

  const { app, page } = await launchSettled(env)
  try {
    const dlg = await openC8(app, page, 'repo-one')
    await typeName(page, dlg, 'payment-retry')
    await expect(primary(dlg)).toHaveText(reads('Create', 'payment-retry'))

    await page.keyboard.press('Enter')
    await expect(dlg).toHaveCount(0)
    await waitForSessionRow(page, 'repo-one', 'payment-retry')
  } finally {
    await app.close().catch(() => {})
  }
})

// BB-M07 — an exact existing name (case-insensitive) opens, never re-creates.
test('BB-M07: exact existing name (case-insensitive) opens, never re-creates', async ({ env }) => {
  test.setTimeout(240_000)
  const pinned = pinWorkspaces(env, [{ name: 'repo-one', kind: 'git' }])

  const { app, page } = await launchSettled(env)
  try {
    // `alpha` is created through the product itself (BB-M06's flow)
    const first = await openC8(app, page, 'repo-one')
    await typeName(page, first, 'alpha')
    await page.keyboard.press('Enter')
    await expect(first).toHaveCount(0)
    await waitForSessionRow(page, 'repo-one', 'alpha')
    // the pending row precedes fake-claude's actual `git worktree add` by ~2s; C8
    // snapshots its list at open (D4/A9), so wait for the worktree to exist ON DISK
    // (the filesystem is an external observable) before reopening
    const wtDir = join(pinned.paths['repo-one'], '.claude', 'worktrees', 'alpha')
    await expect.poll(() => existsSync(wtDir), { timeout: 30_000 }).toBe(true)
    const rows = rowsWithSub(page, 'repo-one', 'alpha')
    const before = await rows.count()

    const dlg = await openC8(app, page, 'repo-one')
    await typeName(page, dlg, 'Alpha')
    await expect(primary(dlg)).toHaveText(reads('Open', 'alpha'))

    await page.keyboard.press('Enter')
    await expect(dlg).toHaveCount(0)
    await expect(rows).toHaveCount(before + 1, { timeout: 60_000 })

    const reopened = await openC8(app, page, 'repo-one')
    await expect(wtNote(reopened, 'alpha')).toHaveCount(1)
  } finally {
    await app.close().catch(() => {})
  }
})

// BB-M08 — empty field + ↓ ⏎ opens the most recently active worktree (activity beats
// name order), and a worktree with no working-set session tails the list.
test('BB-M08: empty field + ↓ ⏎ opens the most recently active worktree', async ({ env }) => {
  test.setTimeout(180_000)
  const pinned = pinWorkspaces(env, [{ name: 'repo-one', kind: 'git' }])
  const repo = pinned.paths['repo-one']
  const alpha = gitWorktreeAdd(repo, 'alpha')
  const zeta = gitWorktreeAdd(repo, 'zeta')
  const tail = gitWorktreeAdd(repo, 'aaa-tail')
  const now = Date.now()
  // a `-w` session's transcript stays in the LAUNCH cwd's slug; the worktree-state
  // record is what binds it to a checkout
  seedJsonl(env, repo, {
    summary: 'alpha work',
    worktreeState: { worktreeName: 'alpha', worktreePath: alpha, originalCwd: repo },
    timestamp: now - 600_000,
    mtime: now - 600_000
  })
  seedJsonl(env, repo, {
    summary: 'zeta work',
    worktreeState: { worktreeName: 'zeta', worktreePath: zeta, originalCwd: repo },
    timestamp: now - 5_000,
    mtime: now - 5_000
  })
  // aaa-tail's only session is off the working set (never owned), so it carries no
  // activity at all — despite being the newest file and the first name alphabetically
  seedJsonl(env, repo, {
    summary: 'tail work',
    owned: false,
    worktreeState: { worktreeName: 'aaa-tail', worktreePath: tail, originalCwd: repo },
    timestamp: now - 1_000,
    mtime: now - 1_000
  })

  const { app, page } = await launchSettled(env)
  try {
    const dlg = await openC8(app, page, 'repo-one')
    await expect(field(dlg)).toHaveValue('')
    await expect(wtNote(dlg, 'zeta')).toHaveCount(1)
    await expect(wtNote(dlg, 'alpha')).toHaveCount(1)
    await expect(wtNote(dlg, 'aaa-tail')).toHaveCount(1)

    const listed = await dlg.innerText()
    expect(listed.indexOf('zeta')).toBeLessThan(listed.indexOf('alpha'))
    expect(listed.indexOf('alpha')).toBeLessThan(listed.indexOf('aaa-tail'))

    const rows = rowsWithSub(page, 'repo-one', 'zeta')
    const before = await rows.count()
    await field(dlg).click() // hot on the (empty) field, where ↓ starts from
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await expect(dlg).toHaveCount(0)
    await expect(rows).toHaveCount(before + 1, { timeout: 60_000 })
  } finally {
    await app.close().catch(() => {})
  }
})

// BB-M11 — revised: the sidebar ⑂ hover button is back (as a git head's ONLY
// hover button — BB-M10), so the case drives it again: C8 opens for exactly the
// workspace whose row was clicked, skipping C10. The fly-out's "New worktree session…"
// keeps the same contract and is exercised by the openWorktreeDialog helper elsewhere.
test('BB-M11: sidebar ⑂ opens C8 for exactly that workspace, skipping the picker', async ({
  env
}) => {
  test.setTimeout(180_000)
  pinWorkspaces(env, [
    { name: 'ws-alpha', kind: 'git' },
    { name: 'ws-bravo', kind: 'git' }
  ])

  const { app, page } = await launchSettled(env)
  try {
    await startMainSession(page, 'ws-bravo') // last-touched = B, so A can only come from the click

    const headA = page.locator('.ws-head', { hasText: 'ws-alpha' })
    await headA.hover()
    // D12: the ⑂'s accessible name STARTS with "New worktree session" (the design
    // appends the shortcut to it), so the name is matched from its start
    await headA.getByRole('button', { name: /^New worktree session/ }).click()

    await expect(c8(page, 'ws-alpha')).toBeVisible({ timeout: 20_000 })
    await expect(c10Worktree(page)).toHaveCount(0)
    await expect(c10Main(page)).toHaveCount(0)
  } finally {
    await app.close().catch(() => {})
  }
})

// BB-C07 — a prefix collision still creates, and the collision stays visible.
test('BB-C07: prefix collision still creates, and the collision stays visible', async ({ env }) => {
  test.setTimeout(240_000)
  const pinned = pinWorkspaces(env, [{ name: 'repo-one', kind: 'git' }])
  gitWorktreeAdd(pinned.paths['repo-one'], 'new-session-ux')

  const { app, page } = await launchSettled(env)
  try {
    const dlg = await openC8(app, page, 'repo-one')
    await typeName(page, dlg, 'new-session')

    // cases-file correction: the MATCHING row stays prominent — §04B dims
    // only NON-matching rows. The collision row must be visible at full strength;
    // dim-behavior on non-matching rows is BB-C34's subject.
    const collision = wtRow(dlg, 'new-session-ux')
    await expect(collision).toBeVisible()
    const opacity = await collision.evaluate((el) => parseFloat(getComputedStyle(el).opacity))
    expect(opacity).toBe(1)
    await expect(primary(dlg)).toHaveText(reads('Create', 'new-session'))

    await page.keyboard.press('Enter')
    await expect(dlg).toHaveCount(0)
    await waitForSessionRow(page, 'repo-one', 'new-session')
    // same disk race as BB-M07: the pending row precedes the actual `git worktree add`;
    // C8 snapshots at open, so wait for the checkout before re-snapshotting
    const createdDir = join(pinned.paths['repo-one'], '.claude', 'worktrees', 'new-session')
    await expect.poll(() => existsSync(createdDir), { timeout: 30_000 }).toBe(true)

    const reopened = await openC8(app, page, 'repo-one')
    await expect(wtNote(reopened, 'new-session')).toHaveCount(1)
    await expect(wtNote(reopened, 'new-session-ux')).toHaveCount(1)
  } finally {
    await app.close().catch(() => {})
  }
})

// BB-C08 — the reserved name `main` is refused.
test('BB-C08: reserved name `main` is refused', async ({ env }) => {
  test.setTimeout(180_000)
  pinWorkspaces(env, [{ name: 'repo-one', kind: 'git' }])

  const { app, page } = await launchSettled(env)
  try {
    const dlg = await openC8(app, page, 'repo-one')
    await typeName(page, dlg, 'Main') // any letter case

    await expect(
      dlg.getByText(/[“"]main[”"] is the main checkout — pick another name/i)
    ).toBeVisible()
    await expect(primary(dlg)).toBeDisabled()

    await page.keyboard.press('Enter')
    await page.waitForTimeout(2_000) // give a (wrong) launch every chance to show up
    await expect(dlg).toBeVisible()
    await expect(field(dlg)).toHaveValue('Main')
    await expect(page.locator('.ws-tab')).toHaveCount(0)
  } finally {
    await app.close().catch(() => {})
  }
})

// BB-C09 — illegal characters are refused with the hint.
test('BB-C09: illegal characters are refused with the hint', async ({ env }) => {
  test.setTimeout(180_000)
  pinWorkspaces(env, [{ name: 'repo-one', kind: 'git' }])

  const { app, page } = await launchSettled(env)
  try {
    const dlg = await openC8(app, page, 'repo-one')
    await typeName(page, dlg, 'bad name!')

    await expect(dlg.getByText('Only letters, digits, . _ -')).toBeVisible()
    await expect(primary(dlg)).toBeDisabled()

    await page.keyboard.press('Enter')
    await page.waitForTimeout(2_000)
    await expect(dlg).toBeVisible()
    await expect(page.locator('.ws-tab')).toHaveCount(0)
  } finally {
    await app.close().catch(() => {})
  }
})

// BB-C10 — a unicode homoglyph is refused, not silently normalized.
test('BB-C10: unicode homoglyph in the name is refused, not silently normalized', async ({
  env
}) => {
  test.setTimeout(180_000)
  pinWorkspaces(env, [{ name: 'repo-one', kind: 'git' }])

  const { app, page } = await launchSettled(env)
  try {
    const dlg = await openC8(app, page, 'repo-one')
    await typeName(page, dlg, 'mаin') // Cyrillic а — reads as `main`, is not

    await expect(dlg.getByText('Only letters, digits, . _ -')).toBeVisible()
    await expect(primary(dlg)).toBeDisabled()
  } finally {
    await app.close().catch(() => {})
  }
})

// BB-C11 — the name-length boundary: 64 accepted, 65 refused.
test('BB-C11: name-length boundary — 64 accepted, 65 refused', async ({ env }) => {
  test.setTimeout(180_000)
  pinWorkspaces(env, [{ name: 'repo-one', kind: 'git' }])
  const legal64 = 'koloft-' + 'a'.repeat(57) // exactly 64 legal characters

  const { app, page } = await launchSettled(env)
  try {
    const dlg = await openC8(app, page, 'repo-one')
    await typeName(page, dlg, legal64)

    await expect(primary(dlg)).toBeEnabled()
    await expect(primary(dlg)).toHaveText(reads('Create', legal64))

    await page.keyboard.type('a') // 65
    // the case names no wording for the over-length hint; the rule it breaks is the
    // one §04A spells out, so either that hint or a length-specific one satisfies it
    await expect(dlg.getByText(/Only letters, digits, \. _ -|64/).first()).toBeVisible()
    await expect(primary(dlg)).toBeDisabled()
  } finally {
    await app.close().catch(() => {})
  }
})

// BB-C12 — an empty field leaves ⏎ inert.
test('BB-C12: empty field — primary disabled, ⏎ inert', async ({ env }) => {
  test.setTimeout(180_000)
  pinWorkspaces(env, [{ name: 'repo-one', kind: 'git' }])

  const { app, page } = await launchSettled(env)
  try {
    const dlg = await openC8(app, page, 'repo-one')
    await field(dlg).click() // hot on the field, still empty
    await expect(field(dlg)).toHaveValue('')

    await page.keyboard.press('Enter')
    await page.waitForTimeout(2_000)
    await expect(dlg).toBeVisible()
    await expect(field(dlg)).toHaveValue('')
    await expect(page.locator('.ws-tab')).toHaveCount(0)
  } finally {
    await app.close().catch(() => {})
  }
})

// BB-C13 — the C8 Esc ladder: list → field → clear → close.
test('BB-C13: C8 Esc ladder — list → field → clear → close', async ({ env }) => {
  test.setTimeout(180_000)
  const pinned = pinWorkspaces(env, [{ name: 'repo-one', kind: 'git' }])
  gitWorktreeAdd(pinned.paths['repo-one'], 'xylo') // the one row `x` matches

  const { app, page } = await launchSettled(env)
  try {
    const dlg = await openC8(app, page, 'repo-one')
    // the case's Given: "C8 lists the worktree" — the list loads async, so establish
    // it before typing (under 4 parallel workers ArrowDown can otherwise outrun it)
    await expect(wtNote(dlg, 'xylo')).toBeVisible({ timeout: 15_000 })
    await typeName(page, dlg, 'x')
    await page.keyboard.press('ArrowDown')
    // hot sits on the row: the primary speaks for whatever hot points at (§04A)
    await expect(primary(dlg)).toHaveText(reads('Open', 'xylo'))

    await page.keyboard.press('Escape') // 1 — back to the field, text intact
    await expect(dlg).toBeVisible()
    await expect(field(dlg)).toHaveValue('x')
    await expect(primary(dlg)).toHaveText(reads('Create', 'x'))

    await page.keyboard.press('Escape') // 2 — the field clears, the dialog stays
    await expect(dlg).toBeVisible()
    await expect(field(dlg)).toHaveValue('')

    await page.keyboard.press('Escape') // 3 — the dialog closes
    await expect(dlg).toHaveCount(0)
    await page.waitForTimeout(2_000)
    await expect(page.locator('.ws-tab')).toHaveCount(0)
  } finally {
    await app.close().catch(() => {})
  }
})

// BB-C16 — an in-use worktree stays selectable and is only annotated.
test('BB-C16: in-use worktree stays selectable and is only annotated', async ({ env }) => {
  test.setTimeout(240_000)
  const pinned = pinWorkspaces(env, [{ name: 'repo-one', kind: 'git' }])
  gitWorktreeAdd(pinned.paths['repo-one'], 'busy')

  const { app, page } = await launchSettled(env)
  try {
    // a real session running inside the `busy` checkout — opened through C8 itself,
    // which is how a user reaches an existing worktree
    const opening = await openC8(app, page, 'repo-one')
    await typeName(page, opening, 'busy')
    await page.keyboard.press('Enter')
    await expect(opening).toHaveCount(0)
    await waitForSessionRow(page, 'repo-one', 'busy')
    const rows = rowsWithSub(page, 'repo-one', 'busy')
    const before = await rows.count()

    const dlg = await openC8(app, page, 'repo-one')
    const row = wtRow(dlg, 'busy')
    await expect(row).toContainText('in use')

    await row.click()
    await expect(dlg).toHaveCount(0)
    await expect(rows).toHaveCount(before + 1, { timeout: 60_000 })
  } finally {
    await app.close().catch(() => {})
  }
})

// BB-C34 — ↓ skips dimmed rows; ↑ from the first row restores the field's Create.
test("BB-C34: ↓ skips dimmed rows; ↑ from the first row restores the field's Create", async ({
  env
}) => {
  test.setTimeout(180_000)
  const pinned = pinWorkspaces(env, [{ name: 'repo-one', kind: 'git' }])
  gitWorktreeAdd(pinned.paths['repo-one'], 'apple')
  gitWorktreeAdd(pinned.paths['repo-one'], 'banana')

  const { app, page } = await launchSettled(env)
  try {
    const dlg = await openC8(app, page, 'repo-one')
    // establish the Given (both rows listed) before typing — the list loads async
    await expect(wtNote(dlg, 'apple')).toBeVisible({ timeout: 15_000 })
    await expect(wtNote(dlg, 'banana')).toBeVisible({ timeout: 15_000 })
    await typeName(page, dlg, 'ban') // `apple` dims, `banana` matches
    await expect(primary(dlg)).toHaveText(reads('Create', 'ban'))

    await page.keyboard.press('ArrowDown')
    await expect(primary(dlg)).toHaveText(reads('Open', 'banana'))

    await page.keyboard.press('ArrowUp')
    await expect(primary(dlg)).toHaveText(reads('Create', 'ban'))
  } finally {
    await app.close().catch(() => {})
  }
})

// BB-C35 — the C8 list is a snapshot: a worktree born after the dialog opened stays
// absent, and its name stays creatable.
test('BB-C35: the C8 list is a snapshot — an externally created worktree stays absent', async ({
  env
}) => {
  test.setTimeout(180_000)
  const pinned = pinWorkspaces(env, [{ name: 'repo-one', kind: 'git' }])
  // a pre-existing worktree whose row proves the snapshot has LANDED: the list loads
  // async after the dialog opens, and creating `ext` before the fetch ran would put
  // it legitimately inside the snapshot (the under-parallel-load flake this Given
  // closes — same establish-then-act rule as BB-C34's row waits)
  gitWorktreeAdd(pinned.paths['repo-one'], 'seed')

  const { app, page } = await launchSettled(env)
  try {
    const dlg = await openC8(app, page, 'repo-one')
    await expect(wtNote(dlg, 'seed')).toBeVisible({ timeout: 15_000 })
    // created outside Koloft, while the dialog stays open — AFTER the snapshot landed
    gitWorktreeAdd(pinned.paths['repo-one'], 'ext')

    await typeName(page, dlg, 'ext')
    await expect(wtNote(dlg, 'ext')).toHaveCount(0)
    await expect(primary(dlg)).toHaveText(reads('Create', 'ext'))
  } finally {
    await app.close().catch(() => {})
  }
})
