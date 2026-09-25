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

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function dialogTitled(page: Page, title: string): Locator {
  return page.locator('.modal, [role="dialog"]').filter({ hasText: title }).last()
}

const c8 = (page: Page, ws: string): Locator => dialogTitled(page, `New Worktree Session · ${ws}`)
const c10Worktree = (page: Page): Locator => dialogTitled(page, 'New Worktree Session in…')
const c10Main = (page: Page): Locator => dialogTitled(page, 'New Session in…')

const field = (dlg: Locator): Locator => dlg.getByRole('textbox')

const primary = (dlg: Locator): Locator =>
  dlg.getByRole('button', { name: /^(Create|Open) worktree/ })

const reads = (verb: 'Create' | 'Open', name: string): RegExp =>
  new RegExp(`${verb} worktree [“"]${esc(name)}[”"]`)

const wtNote = (dlg: Locator, name: string): Locator =>
  dlg.getByText(new RegExp(`branch worktree-${esc(name)}(?![A-Za-z0-9._-])`))

const wtRow = (dlg: Locator, name: string): Locator => wtNote(dlg, name).locator('..')

async function openC8(app: ElectronApplication, page: Page, ws: string): Promise<Locator> {
  await pressNewWorktreeSession(app, page)
  await expect(c8(page, ws).or(c10Worktree(page)).first()).toBeVisible({ timeout: 20_000 })
  if (await c10Worktree(page).count()) await page.keyboard.press('Enter')
  const dlg = c8(page, ws)
  await expect(dlg).toBeVisible({ timeout: 20_000 })
  return dlg
}

async function typeName(page: Page, dlg: Locator, name: string): Promise<void> {
  await field(dlg).click()
  await page.keyboard.type(name)
}

async function waitForCheckoutOnDiskBeforeReopeningC8(repo: string, name: string): Promise<void> {
  const wtDir = join(repo, '.claude', 'worktrees', name)
  await expect.poll(() => existsSync(wtDir), { timeout: 30_000 }).toBe(true)
}

async function waitForAsyncWorktreeListToLand(dlg: Locator, name: string): Promise<void> {
  await expect(wtNote(dlg, name)).toBeVisible({ timeout: 15_000 })
}

const GRACE_FOR_A_WRONG_LAUNCH_MS = 2_000
const CYRILLIC_A_HOMOGLYPH_OF_MAIN = 'mаin'

async function startMainSession(page: Page, ws: string): Promise<void> {
  await openMenu(page, page.locator('.ws-head', { hasText: ws }))
  await page.locator('.menu .mi', { hasText: 'New session' }).click()
  await waitForSessionRow(page, ws, 'main')
}

test.describe('C8 New Worktree Session dialog and the ⇧⌘N entrance that reaches it', () => {
  test('BB-M05: ⇧⌘N opens the worktree-mode picker, then C8 for the confirmed workspace', async ({
    env
  }) => {
    test.setTimeout(180_000)
    pinWorkspaces(env, [
      { name: 'ws-alpha', kind: 'git' },
      { name: 'ws-bravo', kind: 'git' }
    ])

    const { app, page } = await launchSettled(env)
    try {
      await startMainSession(page, 'ws-bravo')

      await pressNewWorktreeSession(app, page)
      const picker = c10Worktree(page)
      await expect(picker).toBeVisible({ timeout: 20_000 })
      await expect(picker.getByRole('button', { name: 'Next' })).toBeVisible()

      await page.keyboard.press('Enter')
      const dlg = c8(page, 'ws-bravo')
      await expect(dlg).toBeVisible({ timeout: 20_000 })
      await expect(c10Worktree(page)).toHaveCount(0)
      await expect(field(dlg)).toHaveCount(1)
      await expect(dlg.getByRole('option')).toHaveCount(0)
      await expect(dlg.getByText(/branch worktree-/)).toHaveCount(0)
      await expect(field(dlg)).toHaveAttribute('placeholder', 'name a new worktree')
    } finally {
      await app.close().catch(() => {})
    }
  })

  test("BB-M06: typing a new name and ⏎ creates that worktree's session", async ({ env }) => {
    test.setTimeout(180_000)
    pinWorkspaces(env, [{ name: 'repo-one', kind: 'git' }])

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

  test('BB-M07: exact existing name (case-insensitive) opens, never re-creates', async ({
    env
  }) => {
    test.setTimeout(240_000)
    const pinned = pinWorkspaces(env, [{ name: 'repo-one', kind: 'git' }])

    const { app, page } = await launchSettled(env)
    try {
      const first = await openC8(app, page, 'repo-one')
      await typeName(page, first, 'alpha')
      await page.keyboard.press('Enter')
      await expect(first).toHaveCount(0)
      await waitForSessionRow(page, 'repo-one', 'alpha')
      await waitForCheckoutOnDiskBeforeReopeningC8(pinned.paths['repo-one'], 'alpha')
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

  test('BB-M08: empty field + ↓ ⏎ opens the most recently active worktree; one with no working-set session tails the list', async ({
    env
  }) => {
    test.setTimeout(180_000)
    const pinned = pinWorkspaces(env, [{ name: 'repo-one', kind: 'git' }])
    const repo = pinned.paths['repo-one']
    const alpha = gitWorktreeAdd(repo, 'alpha')
    const zeta = gitWorktreeAdd(repo, 'zeta')
    const tail = gitWorktreeAdd(repo, 'aaa-tail')
    const now = Date.now()
    // CC§2
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
      await field(dlg).click()
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('Enter')
      await expect(dlg).toHaveCount(0)
      await expect(rows).toHaveCount(before + 1, { timeout: 60_000 })
    } finally {
      await app.close().catch(() => {})
    }
  })

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
      await startMainSession(page, 'ws-bravo')

      const headA = page.locator('.ws-head', { hasText: 'ws-alpha' })
      await headA.hover()
      await headA.getByRole('button', { name: /^New worktree session/ }).click()

      await expect(c8(page, 'ws-alpha')).toBeVisible({ timeout: 20_000 })
      await expect(c10Worktree(page)).toHaveCount(0)
      await expect(c10Main(page)).toHaveCount(0)
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-C07: prefix collision still creates, and the matching collision row stays at full strength', async ({
    env
  }) => {
    test.setTimeout(240_000)
    const pinned = pinWorkspaces(env, [{ name: 'repo-one', kind: 'git' }])
    gitWorktreeAdd(pinned.paths['repo-one'], 'new-session-ux')

    const { app, page } = await launchSettled(env)
    try {
      const dlg = await openC8(app, page, 'repo-one')
      await typeName(page, dlg, 'new-session')

      const collision = wtRow(dlg, 'new-session-ux')
      await expect(collision).toBeVisible()
      const opacity = await collision.evaluate((el) => parseFloat(getComputedStyle(el).opacity))
      expect(opacity).toBe(1)
      await expect(primary(dlg)).toHaveText(reads('Create', 'new-session'))

      await page.keyboard.press('Enter')
      await expect(dlg).toHaveCount(0)
      await waitForSessionRow(page, 'repo-one', 'new-session')
      await waitForCheckoutOnDiskBeforeReopeningC8(pinned.paths['repo-one'], 'new-session')

      const reopened = await openC8(app, page, 'repo-one')
      await expect(wtNote(reopened, 'new-session')).toHaveCount(1)
      await expect(wtNote(reopened, 'new-session-ux')).toHaveCount(1)
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-C08: reserved name `main` is refused', async ({ env }) => {
    test.setTimeout(180_000)
    pinWorkspaces(env, [{ name: 'repo-one', kind: 'git' }])

    const { app, page } = await launchSettled(env)
    try {
      const dlg = await openC8(app, page, 'repo-one')
      await typeName(page, dlg, 'Main')

      await expect(
        dlg.getByText(/[“"]main[”"] is the main checkout — pick another name/i)
      ).toBeVisible()
      await expect(primary(dlg)).toBeDisabled()

      await page.keyboard.press('Enter')
      await page.waitForTimeout(GRACE_FOR_A_WRONG_LAUNCH_MS)
      await expect(dlg).toBeVisible()
      await expect(field(dlg)).toHaveValue('Main')
      await expect(page.locator('.ws-tab')).toHaveCount(0)
    } finally {
      await app.close().catch(() => {})
    }
  })

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
      await page.waitForTimeout(GRACE_FOR_A_WRONG_LAUNCH_MS)
      await expect(dlg).toBeVisible()
      await expect(page.locator('.ws-tab')).toHaveCount(0)
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-C10: unicode homoglyph in the name is refused, not silently normalized', async ({
    env
  }) => {
    test.setTimeout(180_000)
    pinWorkspaces(env, [{ name: 'repo-one', kind: 'git' }])

    const { app, page } = await launchSettled(env)
    try {
      const dlg = await openC8(app, page, 'repo-one')
      await typeName(page, dlg, CYRILLIC_A_HOMOGLYPH_OF_MAIN)

      await expect(dlg.getByText('Only letters, digits, . _ -')).toBeVisible()
      await expect(primary(dlg)).toBeDisabled()
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-C11: name-length boundary — 64 accepted, 65 refused', async ({ env }) => {
    test.setTimeout(180_000)
    pinWorkspaces(env, [{ name: 'repo-one', kind: 'git' }])
    const legal64 = 'koloft-' + 'a'.repeat(57)

    const { app, page } = await launchSettled(env)
    try {
      const dlg = await openC8(app, page, 'repo-one')
      await typeName(page, dlg, legal64)

      await expect(primary(dlg)).toBeEnabled()
      await expect(primary(dlg)).toHaveText(reads('Create', legal64))

      await page.keyboard.type('a')
      await expect(dlg.getByText(/Only letters, digits, \. _ -|64/).first()).toBeVisible()
      await expect(primary(dlg)).toBeDisabled()
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-C12: empty field — primary disabled, ⏎ inert', async ({ env }) => {
    test.setTimeout(180_000)
    pinWorkspaces(env, [{ name: 'repo-one', kind: 'git' }])

    const { app, page } = await launchSettled(env)
    try {
      const dlg = await openC8(app, page, 'repo-one')
      await field(dlg).click()
      await expect(field(dlg)).toHaveValue('')

      await page.keyboard.press('Enter')
      await page.waitForTimeout(GRACE_FOR_A_WRONG_LAUNCH_MS)
      await expect(dlg).toBeVisible()
      await expect(field(dlg)).toHaveValue('')
      await expect(page.locator('.ws-tab')).toHaveCount(0)
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-C13: C8 Esc ladder — list → field → clear → close', async ({ env }) => {
    test.setTimeout(180_000)
    const pinned = pinWorkspaces(env, [{ name: 'repo-one', kind: 'git' }])
    gitWorktreeAdd(pinned.paths['repo-one'], 'xylo')

    const { app, page } = await launchSettled(env)
    try {
      const dlg = await openC8(app, page, 'repo-one')
      await waitForAsyncWorktreeListToLand(dlg, 'xylo')
      await typeName(page, dlg, 'x')
      await page.keyboard.press('ArrowDown')
      await expect(primary(dlg)).toHaveText(reads('Open', 'xylo'))

      await page.keyboard.press('Escape')
      await expect(dlg).toBeVisible()
      await expect(field(dlg)).toHaveValue('x')
      await expect(primary(dlg)).toHaveText(reads('Create', 'x'))

      await page.keyboard.press('Escape')
      await expect(dlg).toBeVisible()
      await expect(field(dlg)).toHaveValue('')

      await page.keyboard.press('Escape')
      await expect(dlg).toHaveCount(0)
      await page.waitForTimeout(GRACE_FOR_A_WRONG_LAUNCH_MS)
      await expect(page.locator('.ws-tab')).toHaveCount(0)
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-C16: in-use worktree stays selectable and is only annotated', async ({ env }) => {
    test.setTimeout(240_000)
    const pinned = pinWorkspaces(env, [{ name: 'repo-one', kind: 'git' }])
    gitWorktreeAdd(pinned.paths['repo-one'], 'busy')

    const { app, page } = await launchSettled(env)
    try {
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

  test('BB-C71: a worktree named main is in use only while a session runs in it, not in the repo root', async ({
    env
  }) => {
    test.setTimeout(240_000)
    const pinned = pinWorkspaces(env, [{ name: 'repo-one', kind: 'git' }])
    gitWorktreeAdd(pinned.paths['repo-one'], 'main')

    const { app, page } = await launchSettled(env)
    try {
      await startMainSession(page, 'repo-one')
      const running = rowsWithSub(page, 'repo-one', 'main').and(
        page.locator('.ws-tab:not(.cold):not(.st-pending)')
      )
      await expect(running).toHaveCount(1, { timeout: 60_000 })

      const dlg = await openC8(app, page, 'repo-one')
      await waitForAsyncWorktreeListToLand(dlg, 'main')
      await expect(wtRow(dlg, 'main')).not.toContainText('in use')

      await wtRow(dlg, 'main').click()
      await expect(dlg).toHaveCount(0)
      await expect(running).toHaveCount(2, { timeout: 60_000 })

      const again = await openC8(app, page, 'repo-one')
      await expect(wtRow(again, 'main')).toContainText('in use')
    } finally {
      await app.close().catch(() => {})
    }
  })

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
      await waitForAsyncWorktreeListToLand(dlg, 'apple')
      await waitForAsyncWorktreeListToLand(dlg, 'banana')
      await typeName(page, dlg, 'ban')
      await expect(primary(dlg)).toHaveText(reads('Create', 'ban'))

      await page.keyboard.press('ArrowDown')
      await expect(primary(dlg)).toHaveText(reads('Open', 'banana'))

      await page.keyboard.press('ArrowUp')
      await expect(primary(dlg)).toHaveText(reads('Create', 'ban'))
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-C35: the C8 list is a snapshot — an externally created worktree stays absent and its name stays creatable', async ({
    env
  }) => {
    test.setTimeout(180_000)
    const pinned = pinWorkspaces(env, [{ name: 'repo-one', kind: 'git' }])
    gitWorktreeAdd(pinned.paths['repo-one'], 'seed')

    const { app, page } = await launchSettled(env)
    try {
      const dlg = await openC8(app, page, 'repo-one')
      await waitForAsyncWorktreeListToLand(dlg, 'seed')
      gitWorktreeAdd(pinned.paths['repo-one'], 'ext')

      await typeName(page, dlg, 'ext')
      await expect(wtNote(dlg, 'ext')).toHaveCount(0)
      await expect(primary(dlg)).toHaveText(reads('Create', 'ext'))
    } finally {
      await app.close().catch(() => {})
    }
  })
})
