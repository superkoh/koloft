import fs from 'fs'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { test, expect } from '../helpers/app'
import type { E2EEnv } from '../helpers/env'
import {
  behindBadge,
  launchSettled,
  pinWorkspaces,
  pressNewSession,
  pressNewWorktreeSession,
  rowsWithSub,
  waitForBehindBadge,
  waitForSessionRow
} from '../helpers/blackbox'
import { startSessionIn, wsRows } from '../helpers/p1'

const PICKER = 'New Session in…'
const GRACE_FOR_A_WRONG_DIALOG_OR_LAUNCH_MS = 2000
const HOLD_NEW_SESSION_PENDING_MS = '3000'
const WORKTREE_PICKER = 'New Worktree Session in…'

const anyDialog = (page: Page): Locator => page.locator('[role="dialog"], .modal')

const dialogTitled = (page: Page, title: string): Locator =>
  page.locator('[role="dialog"], .modal').filter({ hasText: title })

const pickerRows = (dlg: Locator): Locator => dlg.getByRole('option')

const selectedRow = (dlg: Locator): Locator => dlg.locator('[aria-selected="true"]')

const primary = (dlg: Locator, label: RegExp): Locator => dlg.getByRole('button', { name: label })

const SAMPLE_ROW_AND_BADGE_EVERY_MS = 25

async function expectRowAndBadgeSampledTogetherSoAStartBeforePullCannotHide(
  page: Page,
  rows: Locator,
  badge: Locator
): Promise<void> {
  const deadline = Date.now() + 90_000
  let prev = { rows: 0, badge: 0 }
  let sawRow = false
  while (Date.now() < deadline) {
    const rowCount = await rows.count()
    const badgeCount = await badge.count()
    if (rowCount > 0) {
      expect(
        badgeCount,
        `the session row appeared while the behind badge was still up (rows=${rowCount}, badge=${badgeCount}) — the start did not wait for the pull`
      ).toBe(0)
      expect(
        prev.rows === 0 || prev.badge === 0,
        `an earlier sample already showed a session row with the badge still up (rows=${prev.rows}, badge=${prev.badge})`
      ).toBe(true)
      sawRow = true
      break
    }
    prev = { rows: rowCount, badge: badgeCount }
    await page.waitForTimeout(SAMPLE_ROW_AND_BADGE_EVERY_MS)
  }
  expect(sawRow, 'no main session row appeared under ws-bravo within 90s').toBe(true)
}

async function openPicker(app: ElectronApplication, page: Page): Promise<Locator> {
  await pressNewSession(app, page)
  const dlg = dialogTitled(page, PICKER)
  await expect(dlg).toBeVisible({ timeout: 15_000 })
  return dlg
}

async function touchWorkspace(page: Page, wsName: string): Promise<void> {
  await startSessionIn(page, wsName)
  const rows = wsRows(page, wsName)
  await expect(rows).toHaveCount(1, { timeout: 60_000 })
  await expect(page.locator('.ws-tab.st-pending')).toHaveCount(0, { timeout: 60_000 })
  await rows.first().click()
  await expect(rows.first()).toHaveClass(/\bactive\b/, { timeout: 15_000 })
}

test.describe('C10 workspace picker: the ⌘N / ⇧⌘N list dialog, its preselection chain, digit/arrow keys and per-row morph', () => {
  test('BB-M01: ⌘N with several workspaces opens the picker, last-touched preselected', async ({
    env
  }) => {
    test.setTimeout(240_000)
    const pinned = pinWorkspaces(env, [
      { name: 'ws-alpha', kind: 'git' },
      { name: 'ws-bravo', kind: 'git' }
    ])
    const { app, page } = await launchSettled(env)
    try {
      await touchWorkspace(page, 'ws-bravo')
      const before = await page.locator('.ws-tab').count()

      const dlg = await openPicker(app, page)

      const rows = pickerRows(dlg)
      await expect(rows).toHaveCount(2)
      await expect(rows.nth(0)).toContainText('1')
      await expect(rows.nth(0)).toContainText('ws-alpha')
      await expect(rows.nth(1)).toContainText('2')
      await expect(rows.nth(1)).toContainText('ws-bravo')
      await expect(selectedRow(dlg)).toHaveCount(1)
      await expect(selectedRow(dlg)).toContainText('ws-bravo')
      expect(await page.locator('.ws-tab').count()).toBe(before)
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-M02: ⏎ in the picker starts a main session in the preselected workspace', async ({
    env
  }) => {
    test.setTimeout(240_000)
    const pinned = pinWorkspaces(env, [
      { name: 'ws-alpha', kind: 'git' },
      { name: 'ws-bravo', kind: 'git' }
    ])
    const { app, page } = await launchSettled(env)
    try {
      await touchWorkspace(page, 'ws-bravo')
      const beforeB = await wsRows(page, 'ws-bravo').count()

      const dlg = await openPicker(app, page)
      await expect(selectedRow(dlg)).toContainText('ws-bravo')
      fs.writeFileSync(env.claudeDelayFile, HOLD_NEW_SESSION_PENDING_MS)

      await page.keyboard.press('Enter')
      await expect(dialogTitled(page, PICKER)).toHaveCount(0)

      const fresh = page.locator('.ws-tab.st-pending')
      await expect(fresh).toHaveCount(1, { timeout: 30_000 })
      await expect(fresh.locator('.ws-tab-sub')).toHaveText('main')
      await expect(wsRows(page, 'ws-bravo')).toHaveCount(beforeB + 1, { timeout: 30_000 })
      await expect(wsRows(page, 'ws-bravo').and(page.locator('.ws-tab.st-pending'))).toHaveCount(1)
      await expect(fresh).toHaveClass(/\bactive\b/)
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-M03: a digit picks and starts in one press', async ({ env }) => {
    test.setTimeout(240_000)
    const pinned = pinWorkspaces(env, [
      { name: 'ws-alpha', kind: 'git' },
      { name: 'ws-bravo', kind: 'git' }
    ])
    const { app, page } = await launchSettled(env)
    try {
      await touchWorkspace(page, 'ws-bravo')

      const dlg = await openPicker(app, page)
      await expect(selectedRow(dlg)).toContainText('ws-bravo')

      await page.keyboard.press('1')
      await expect(dialogTitled(page, PICKER)).toHaveCount(0)
      await waitForSessionRow(page, 'ws-alpha', 'main')
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-M04: single up-to-date workspace — ⌘N launches with no dialog at all', async ({
    env
  }) => {
    test.setTimeout(180_000)
    pinWorkspaces(env, [{ name: 'ws-alpha', kind: 'git' }])
    const { app, page } = await launchSettled(env)
    try {
      await pressNewSession(app, page)

      await page.waitForTimeout(GRACE_FOR_A_WRONG_DIALOG_OR_LAUNCH_MS)
      await expect(anyDialog(page)).toHaveCount(0)
      await waitForSessionRow(page, 'ws-alpha', 'main')
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-C14: C10 Esc closes without launching', async ({ env }) => {
    test.setTimeout(180_000)
    pinWorkspaces(env, [
      { name: 'ws-alpha', kind: 'git' },
      { name: 'ws-bravo', kind: 'git' }
    ])
    const { app, page } = await launchSettled(env)
    try {
      await openPicker(app, page)

      await page.keyboard.press('Escape')
      await expect(dialogTitled(page, PICKER)).toHaveCount(0)
      await page.waitForTimeout(GRACE_FOR_A_WRONG_DIALOG_OR_LAUNCH_MS)
      await expect(page.locator('.ws-tab')).toHaveCount(0)
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-C15: missing workspace is not a picker row (two others stay, so the picker cannot skip)', async ({
    env
  }) => {
    test.setTimeout(180_000)
    pinWorkspaces(env, [
      { name: 'ws-alpha', kind: 'git' },
      { name: 'ws-bravo', kind: 'git' },
      { name: 'ws-cedar', kind: 'missing' }
    ])
    const { app, page } = await launchSettled(env)
    try {
      await expect(page.locator('.ws-head.missing')).toHaveCount(1, { timeout: 30_000 })

      const dlg = await openPicker(app, page)
      const rows = pickerRows(dlg)
      await expect(rows).toHaveCount(2)
      await expect(rows.nth(0)).toContainText('1')
      await expect(rows.nth(0)).toContainText('ws-alpha')
      await expect(rows.nth(1)).toContainText('2')
      await expect(rows.nth(1)).toContainText('ws-bravo')
      await expect(rows.filter({ hasText: 'ws-cedar' })).toHaveCount(0)

      await page.keyboard.press('3')
      await page.waitForTimeout(GRACE_FOR_A_WRONG_DIALOG_OR_LAUNCH_MS)
      await expect(dlg).toBeVisible()
      await expect(page.locator('.ws-tab')).toHaveCount(0)
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-C17: one press, one session — twice', async ({ env }) => {
    test.setTimeout(300_000)
    const pinned = pinWorkspaces(env, [
      { name: 'ws-alpha', kind: 'git' },
      { name: 'ws-bravo', kind: 'git' }
    ])
    const { app, page } = await launchSettled(env)
    try {
      await touchWorkspace(page, 'ws-bravo')
      const before = await page.locator('.ws-tab').count()
      const beforeB = await wsRows(page, 'ws-bravo').count()

      for (let i = 1; i <= 2; i++) {
        const dlg = await openPicker(app, page)
        await page.keyboard.press('Enter')
        await expect(dlg).toHaveCount(0)
        await expect(wsRows(page, 'ws-bravo')).toHaveCount(beforeB + i, { timeout: 60_000 })
      }

      await expect(page.locator('.ws-tab')).toHaveCount(before + 2)
      await expect(rowsWithSub(page, 'ws-bravo', 'main')).toHaveCount(beforeB + 2)
      await expect(wsRows(page, 'ws-alpha')).toHaveCount(0)
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-C24: picker contains no text input and letters are inert', async ({ env }) => {
    test.setTimeout(180_000)
    pinWorkspaces(env, [
      { name: 'ws-alpha', kind: 'git' },
      { name: 'ws-bravo', kind: 'git' }
    ])
    const { app, page } = await launchSettled(env)
    try {
      const dlg = await openPicker(app, page)
      const rows = pickerRows(dlg)
      await expect(rows).toHaveCount(2)

      await page.keyboard.press('a')
      await page.keyboard.press('b')
      await page.keyboard.press('c')

      await expect(dlg.getByRole('textbox')).toHaveCount(0)
      await expect(dlg.locator('input, textarea')).toHaveCount(0)
      await expect(rows).toHaveCount(2)
      await expect(selectedRow(dlg)).toContainText('ws-alpha')

      await page.keyboard.press('1')
      await expect(dialogTitled(page, PICKER)).toHaveCount(0)
      await waitForSessionRow(page, 'ws-alpha', 'main')
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-C29: ⌘N picker lists non-git workspaces as normal, startable rows', async ({ env }) => {
    test.setTimeout(180_000)
    pinWorkspaces(env, [
      { name: 'ws-alpha', kind: 'git' },
      { name: 'ws-notes', kind: 'plain' }
    ])
    const { app, page } = await launchSettled(env)
    try {
      const dlg = await openPicker(app, page)
      const rows = pickerRows(dlg)
      await expect(rows).toHaveCount(2)
      const xRow = rows.filter({ hasText: 'ws-notes' })
      await expect(xRow).toHaveCount(1)
      await expect(xRow).toContainText('no git')

      await page.keyboard.press('2')
      await expect(dialogTitled(page, PICKER)).toHaveCount(0)
      await waitForSessionRow(page, 'ws-notes', 'main')
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-C31: the morph follows the arrow-selected row, and ⏎ launches that row', async ({
    env
  }) => {
    test.setTimeout(240_000)
    const pinned = pinWorkspaces(env, [
      { name: 'ws-alpha', kind: 'git' },
      { name: 'ws-bravo', kind: 'cloned' }
    ])
    pinned.git['ws-bravo'].originAhead(3)
    const { app, page } = await launchSettled(env)
    try {
      await waitForBehindBadge(page, 'ws-bravo', 3)

      const dlg = await openPicker(app, page)
      await expect(selectedRow(dlg)).toContainText('ws-alpha')
      await expect(primary(dlg, /Start/)).toBeVisible()
      await expect(primary(dlg, /Pull & Start/)).toHaveCount(0)

      await page.keyboard.press('ArrowDown')
      await expect(selectedRow(dlg)).toContainText('ws-bravo')
      await expect(primary(dlg, /Pull & Start/)).toBeVisible()
      await expect(pickerRows(dlg).filter({ hasText: 'ws-bravo' })).toContainText(/behind/i)

      await page.keyboard.press('ArrowUp')
      await expect(selectedRow(dlg)).toContainText('ws-alpha')
      await expect(primary(dlg, /Pull & Start/)).toHaveCount(0)
      await expect(primary(dlg, /Start/)).toBeVisible()

      await page.keyboard.press('ArrowDown')
      await expect(selectedRow(dlg)).toContainText('ws-bravo')
      await page.keyboard.press('Enter')
      await expect(dialogTitled(page, PICKER)).toHaveCount(0)

      await expect(behindBadge(page, 'ws-bravo')).toHaveCount(0, { timeout: 60_000 })
      await waitForSessionRow(page, 'ws-bravo', 'main')
      await expect(wsRows(page, 'ws-alpha')).toHaveCount(0)
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-C36: preselect falls back to the first pinned workspace when nothing was ever touched', async ({
    env
  }) => {
    test.setTimeout(180_000)
    pinWorkspaces(env, [
      { name: 'ws-alpha', kind: 'git' },
      { name: 'ws-bravo', kind: 'git' }
    ])
    const { app, page } = await launchSettled(env)
    try {
      const dlg = await openPicker(app, page)
      const rows = pickerRows(dlg)
      await expect(rows.nth(0)).toContainText('1')
      await expect(rows.nth(0)).toContainText('ws-alpha')
      await expect(rows.nth(0)).toHaveAttribute('aria-selected', 'true')
      await expect(selectedRow(dlg)).toHaveCount(1)
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-C37: a digit landing on a behind-and-pullable row confirms its morph — pull, then start', async ({
    env
  }) => {
    test.setTimeout(240_000)
    const pinned = pinWorkspaces(env, [
      { name: 'ws-alpha', kind: 'git' },
      { name: 'ws-bravo', kind: 'cloned' }
    ])
    pinned.git['ws-bravo'].originAhead(3)
    const { app, page } = await launchSettled(env)
    try {
      await waitForBehindBadge(page, 'ws-bravo', 3)

      const dlg = await openPicker(app, page)
      await expect(selectedRow(dlg)).toContainText('ws-alpha')

      await page.keyboard.press('2')
      await expect(dialogTitled(page, PICKER)).toHaveCount(0)

      await expectRowAndBadgeSampledTogetherSoAStartBeforePullCannotHide(
        page,
        rowsWithSub(page, 'ws-bravo', 'main'),
        behindBadge(page, 'ws-bravo')
      )
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-C38: ⇧⌘N preselect skips a hidden last-touched workspace', async ({ env }) => {
    test.setTimeout(240_000)
    const pinned = pinWorkspaces(env, [
      { name: 'ws-alpha', kind: 'git' },
      { name: 'ws-bravo', kind: 'git' },
      { name: 'ws-notes', kind: 'plain' }
    ])
    const { app, page } = await launchSettled(env)
    try {
      await touchWorkspace(page, 'ws-notes')

      await pressNewWorktreeSession(app, page)
      const dlg = dialogTitled(page, WORKTREE_PICKER)
      await expect(dlg).toBeVisible({ timeout: 15_000 })

      const rows = pickerRows(dlg)
      await expect(rows).toHaveCount(2)
      await expect(rows.nth(0)).toContainText('ws-alpha')
      await expect(rows.nth(1)).toContainText('ws-bravo')
      await expect(rows.filter({ hasText: 'ws-notes' })).toHaveCount(0)
      await expect(selectedRow(dlg)).toHaveCount(1)
      await expect(selectedRow(dlg)).toContainText('ws-alpha')
      await expect(page.getByText(/no git repository among your workspaces/)).toHaveCount(0)
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-C39: every pinned workspace missing — ⌘N toasts instead of showing an empty picker', async ({
    env
  }) => {
    test.setTimeout(180_000)
    pinWorkspaces(env, [{ name: 'ws-gone', kind: 'missing' }])
    const { app, page } = await launchSettled(env)
    try {
      await expect(page.locator('.ws-head.missing')).toHaveCount(1, { timeout: 30_000 })

      await pressNewSession(app, page)

      await expect(page.getByText(/No workspace yet — add one first/).first()).toBeVisible({
        timeout: 15_000
      })
      await expect(anyDialog(page)).toHaveCount(0)
      await expect(page.locator('.ws-tab')).toHaveCount(0)
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-C40: a failed pull dis-arms only the row it failed for, not the whole dialog', async ({
    env
  }) => {
    test.setTimeout(240_000)
    const pinned = pinWorkspaces(env, [
      { name: 'ws-alpha', kind: 'cloned' },
      { name: 'ws-bravo', kind: 'cloned' }
    ])
    pinned.git['ws-alpha'].originAhead(2)
    pinned.git['ws-bravo'].originAhead(3)
    const { app, page } = await launchSettled(env)
    try {
      await waitForBehindBadge(page, 'ws-alpha', 2)
      await waitForBehindBadge(page, 'ws-bravo', 3)
      pinned.git['ws-bravo'].deleteOrigin()

      const dlg = await openPicker(app, page)
      await expect(selectedRow(dlg)).toContainText('ws-alpha')
      await page.keyboard.press('ArrowDown')
      await expect(selectedRow(dlg)).toContainText('ws-bravo')
      await expect(primary(dlg, /Pull & Start/)).toBeVisible()

      await page.keyboard.press('Enter')
      await expect(dlg.getByText(/pull failed/i)).toBeVisible({ timeout: 30_000 })
      await expect(primary(dlg, /Pull & Start/)).toHaveCount(0)

      await page.keyboard.press('ArrowUp')
      await expect(selectedRow(dlg)).toContainText('ws-alpha')
      await expect(primary(dlg, /Pull & Start/)).toBeVisible()
      await expect(dlg.getByText(/pull failed/i)).toHaveCount(0)

      await page.keyboard.press('Enter')
      await expect(behindBadge(page, 'ws-alpha')).toHaveCount(0, { timeout: 60_000 })
      await waitForSessionRow(page, 'ws-alpha', 'main')
    } finally {
      await app.close().catch(() => {})
    }
  })
})
