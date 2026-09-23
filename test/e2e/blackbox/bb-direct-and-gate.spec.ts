import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { test, expect } from '../helpers/app'
import { seedSettings } from '../helpers/env'
import { openMenu, startSessionIn, wsGroup } from '../helpers/p1'
import {
  behindBadge,
  launchSettled,
  makeDirty,
  pinWorkspaces,
  pressNewSession,
  pressNewWorktreeSession,
  rowsWithSub,
  waitForBehindBadge,
  waitForSessionRow
} from '../helpers/blackbox'

async function expectNoDialog(page: Page): Promise<void> {
  await expect(page.locator('.modal')).toHaveCount(0)
  const dialogs = page.locator('.modal, [role="dialog"]')
  await expect(dialogs.filter({ hasText: 'New Session in…' })).toHaveCount(0)
  await expect(dialogs.filter({ hasText: 'New Worktree Session' })).toHaveCount(0)
}

const GRACE_FOR_A_WRONG_DIALOG_MS = 1500
const GRACE_FOR_A_WRONG_DIALOG_OR_LAUNCH_MS = 2000

const pickerTitle = (page: Page): Locator => page.getByText('New Session in…')

const pullAndStart = (page: Page): Locator => page.getByRole('button', { name: 'Pull & Start' })

function emptyDoor(page: Page, wsName: string): Locator {
  return wsGroup(page, wsName).locator('.ws-empty')
}

function welcomeButton(page: Page, label: string): Locator {
  return page.locator('.w-empty').getByRole('button', { name: label })
}

test.describe('Per-workspace direct-launch surfaces and the Pull & Start gate', () => {
  test('BB-M10: a git head carries exactly one hover button, and it is the worktree door', async ({
    env
  }) => {
    test.setTimeout(120_000)
    pinWorkspaces(env, [
      { name: 'ws-alpha', kind: 'git' },
      { name: 'ws-bravo', kind: 'git' }
    ])

    const { app, page } = await launchSettled(env)
    try {
      const head = page.locator('.ws-head', { hasText: 'ws-alpha' })
      await expect(head).toBeVisible()
      await head.hover()

      await expect(head.locator('button')).toHaveCount(1)
      await expect(head.getByRole('button', { name: /^New worktree session/ })).toHaveCount(1)
      await expect(head.getByRole('button', { name: 'New session' })).toHaveCount(0)
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-M12: welcome panel primary starts directly; secondary opens C8', async ({ env }) => {
    test.setTimeout(240_000)
    pinWorkspaces(env, [{ name: 'ws-alpha', kind: 'git' }])

    const first = await launchSettled(env)
    try {
      await expect(first.page.locator('.w-empty')).toBeVisible()
      await expect(welcomeButton(first.page, 'New session')).toBeVisible()
      await expect(welcomeButton(first.page, 'New worktree session…')).toBeVisible()

      await welcomeButton(first.page, 'New session').click()

      await first.page.waitForTimeout(GRACE_FOR_A_WRONG_DIALOG_MS)
      await expectNoDialog(first.page)
      await waitForSessionRow(first.page, 'ws-alpha', 'main')
    } finally {
      await first.app.close().catch(() => {})
    }

    const second = await launchSettled(env)
    try {
      await expect(second.page.locator('.w-empty')).toBeVisible({ timeout: 20_000 })
      await welcomeButton(second.page, 'New worktree session…').click()
      await expect(second.page.getByText('New Worktree Session · ws-alpha')).toBeVisible({
        timeout: 15_000
      })
    } finally {
      await second.app.close().catch(() => {})
    }
  })

  test('BB-M13: context menu "New session" is a direct launch', async ({ env }) => {
    test.setTimeout(120_000)
    pinWorkspaces(env, [
      { name: 'ws-alpha', kind: 'git' },
      { name: 'ws-bravo', kind: 'git' }
    ])

    const { app, page } = await launchSettled(env)
    try {
      await openMenu(page, page.locator('.ws-head', { hasText: 'ws-alpha' }))

      await page
        .locator('.menu .mi')
        .filter({ hasText: /^\s*New session/ })
        .click()

      await page.waitForTimeout(GRACE_FOR_A_WRONG_DIALOG_MS)
      await expectNoDialog(page)
      await waitForSessionRow(page, 'ws-alpha', 'main')
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-M14: behind-and-pullable main — the picker becomes the Pull & Start gate', async ({
    env
  }) => {
    test.setTimeout(120_000)
    const pinned = pinWorkspaces(env, [{ name: 'ws-repo', kind: 'cloned' }])
    pinned.git['ws-repo'].originAhead(3)

    const { app, page } = await launchSettled(env)
    try {
      await waitForBehindBadge(page, 'ws-repo', 3)

      await pressNewSession(app, page)

      await expect(pickerTitle(page).first()).toBeVisible({ timeout: 15_000 })
      await expect(pullAndStart(page)).toBeVisible()
      await expect(page.locator('.ws-tab')).toHaveCount(0)
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-M15: Pull & Start pulls, then starts', async ({ env }) => {
    test.setTimeout(120_000)
    const pinned = pinWorkspaces(env, [{ name: 'ws-repo', kind: 'cloned' }])
    pinned.git['ws-repo'].originAhead(3)

    const { app, page } = await launchSettled(env)
    try {
      await waitForBehindBadge(page, 'ws-repo', 3)
      await pressNewSession(app, page)
      await expect(pickerTitle(page).first()).toBeVisible({ timeout: 15_000 })
      await expect(pullAndStart(page)).toBeVisible()

      await page.keyboard.press('Enter')

      await expect(behindBadge(page, 'ws-repo')).toHaveCount(0, { timeout: 40_000 })
      await waitForSessionRow(page, 'ws-repo', 'main')
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-M16: Esc on the gate starts nothing and pulls nothing', async ({ env }) => {
    test.setTimeout(120_000)
    const pinned = pinWorkspaces(env, [{ name: 'ws-repo', kind: 'cloned' }])
    pinned.git['ws-repo'].originAhead(3)

    const { app, page } = await launchSettled(env)
    try {
      await waitForBehindBadge(page, 'ws-repo', 3)
      await pressNewSession(app, page)
      await expect(pickerTitle(page).first()).toBeVisible({ timeout: 15_000 })
      await expect(pullAndStart(page)).toBeVisible()

      await page.keyboard.press('Escape')

      await expect(pickerTitle(page)).toHaveCount(0)
      await expect(pullAndStart(page)).toHaveCount(0)
      await page.waitForTimeout(GRACE_FOR_A_WRONG_DIALOG_OR_LAUNCH_MS)
      await expect(page.locator('.ws-tab')).toHaveCount(0)
      await expect(behindBadge(page, 'ws-repo')).toHaveText('3')
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-C01: zero workspaces — both keys toast instead of silence', async ({ env }) => {
    test.setTimeout(120_000)
    pinWorkspaces(env, [])

    const { app, page } = await launchSettled(env)
    try {
      const toast = page.getByText('No workspace yet — add one first')

      await pressNewSession(app, page)
      await expect(toast.first()).toBeVisible({ timeout: 15_000 })
      await expectNoDialog(page)
      await expect(page.locator('.ws-tab')).toHaveCount(0)

      await expect(toast).toHaveCount(0, { timeout: 20_000 })
      await pressNewWorktreeSession(app, page)
      await expect(toast.first()).toBeVisible({ timeout: 15_000 })
      await expectNoDialog(page)
      await expect(page.locator('.ws-tab')).toHaveCount(0)
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('⌘N / ⇧⌘N pressed before the first workspace:rows push lands are a silent no-op: no toast and no dialog, since "nothing pinned" is not yet known', async ({
    env
  }) => {
    test.setTimeout(120_000)
    pinWorkspaces(env, [])
    const { app, page } = await launchSettled(env)
    try {
      await app.evaluate(({ ipcMain, BrowserWindow }) => {
        ipcMain.removeHandler('workspace:rows')
        ipcMain.handle('workspace:rows', () => new Promise(() => {}))
        const wc = BrowserWindow.getAllWindows()[0].webContents
        const send = wc.send.bind(wc)
        wc.send = (channel: string, ...args: unknown[]): void => {
          if (channel !== 'workspace:rows') send(channel, ...args)
        }
      })
      await page.reload()
      await page.waitForLoadState('domcontentloaded')
      const rowsReady = (): Promise<boolean> =>
        page.evaluate(
          () => (window as unknown as { __koloftRowsReady?: boolean }).__koloftRowsReady === true
        )

      await pressNewSession(app, page)
      await pressNewWorktreeSession(app, page)
      await page.waitForTimeout(GRACE_FOR_A_WRONG_DIALOG_MS)

      expect(await rowsReady()).toBe(false)
      await expect(page.getByText('No workspace yet — add one first')).toHaveCount(0)
      await expectNoDialog(page)
      await expect(page.locator('.ws-tab')).toHaveCount(0)
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-C02: non-git workspace — ⌘N starts in the folder itself, no confirm box', async ({
    env
  }) => {
    test.setTimeout(120_000)
    pinWorkspaces(env, [{ name: 'ws-plain', kind: 'plain' }])

    const { app, page } = await launchSettled(env)
    try {
      await expect(page.locator('.ws-head', { hasText: 'ws-plain' })).toBeVisible()

      await pressNewSession(app, page)

      await page.waitForTimeout(GRACE_FOR_A_WRONG_DIALOG_MS)
      await expectNoDialog(page)
      await waitForSessionRow(page, 'ws-plain', 'main')
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-C20: behind but NOT pullable (tree dirtied before launch) — ⌘N launches instantly with zero rendering', async ({
    env
  }) => {
    test.setTimeout(120_000)
    const pinned = pinWorkspaces(env, [{ name: 'ws-repo', kind: 'cloned' }])
    pinned.git['ws-repo'].originAhead(3)
    makeDirty(pinned.paths['ws-repo'])

    const { app, page } = await launchSettled(env)
    try {
      await waitForBehindBadge(page, 'ws-repo', 3)

      await pressNewSession(app, page)

      await page.waitForTimeout(GRACE_FOR_A_WRONG_DIALOG_MS)
      await expectNoDialog(page)
      await waitForSessionRow(page, 'ws-repo', 'main')
      await expect(behindBadge(page, 'ws-repo')).toHaveText('3')
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-C21: pull failure degrades the gate to Start on the current base', async ({ env }) => {
    test.setTimeout(150_000)
    const pinned = pinWorkspaces(env, [{ name: 'ws-repo', kind: 'cloned' }])
    pinned.git['ws-repo'].originAhead(3)

    const { app, page } = await launchSettled(env)
    try {
      await waitForBehindBadge(page, 'ws-repo', 3)
      pinned.git['ws-repo'].deleteOrigin()

      await pressNewSession(app, page)
      await expect(pickerTitle(page).first()).toBeVisible({ timeout: 15_000 })
      await expect(pullAndStart(page)).toBeVisible()

      await page.keyboard.press('Enter')

      await expect(page.getByText(/pull failed/i).first()).toBeVisible({ timeout: 60_000 })
      await expect(pullAndStart(page)).toHaveCount(0)
      const start = page.getByRole('button', { name: /^\s*Start\s*⏎?\s*$/ })
      await expect(start).toBeVisible()

      await page.keyboard.press('Enter')
      await waitForSessionRow(page, 'ws-repo', 'main')
      await expect(behindBadge(page, 'ws-repo')).toHaveText('3')
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-C22: pulling under a running root session (started before origin moved) asks first', async ({
    env
  }) => {
    test.setTimeout(240_000)
    const pinned = pinWorkspaces(env, [{ name: 'ws-repo', kind: 'cloned' }])

    const { app, page } = await launchSettled(env)
    try {
      await startSessionIn(page, 'ws-repo')
      await waitForSessionRow(page, 'ws-repo', 'main')
      pinned.git['ws-repo'].originAhead(3)
      await openMenu(page, page.locator('.ws-head', { hasText: 'ws-repo' }))
      await page.locator('.menu .mi', { hasText: 'Fetch origin' }).click()
      await waitForBehindBadge(page, 'ws-repo', 3)

      await pressNewSession(app, page)
      await expect(pickerTitle(page).first()).toBeVisible({ timeout: 15_000 })
      await expect(pullAndStart(page)).toBeVisible()

      await page.keyboard.press('Enter')
      const confirm = page.locator('.modal').filter({ hasText: 'running in this checkout' })
      await expect(confirm).toBeVisible({ timeout: 20_000 })
      await confirm.getByRole('button', { name: 'Cancel' }).click()

      await expect(confirm).toHaveCount(0)
      await page.waitForTimeout(GRACE_FOR_A_WRONG_DIALOG_OR_LAUNCH_MS)
      await expect(behindBadge(page, 'ws-repo')).toHaveText('3')
      await expect(rowsWithSub(page, 'ws-repo', 'main')).toHaveCount(1)
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-C23: the gate guards both per-workspace direct-launch surfaces (single pin: identified by its morphed primary)', async ({
    env
  }) => {
    test.setTimeout(180_000)
    const pinned = pinWorkspaces(env, [{ name: 'ws-repo', kind: 'cloned' }])
    pinned.git['ws-repo'].originAhead(3)

    const { app, page } = await launchSettled(env)
    try {
      await waitForBehindBadge(page, 'ws-repo', 3)
      await expect(page.locator('.w-empty')).toBeVisible()
      const head = page.locator('.ws-head', { hasText: 'ws-repo' })

      const expectGate = async (): Promise<void> => {
        await expect(pullAndStart(page)).toBeVisible({ timeout: 15_000 })
        await expect(pickerTitle(page).first()).toBeVisible()
        await expect(page.getByRole('option')).toHaveCount(0)
      }

      await openMenu(page, head)
      await page
        .locator('.menu .mi')
        .filter({ hasText: /^\s*New session/ })
        .click()
      await expectGate()
      await page.keyboard.press('Escape')
      await expect(pullAndStart(page)).toHaveCount(0)

      await page.waitForTimeout(GRACE_FOR_A_WRONG_DIALOG_OR_LAUNCH_MS)
      await expect(page.locator('.ws-tab')).toHaveCount(0)
      await expect(behindBadge(page, 'ws-repo')).toHaveText('3')

      await welcomeButton(page, 'New session').click()
      await expectGate()
      await page.keyboard.press('Enter')

      await expect(behindBadge(page, 'ws-repo')).toHaveCount(0, { timeout: 40_000 })
      await waitForSessionRow(page, 'ws-repo', 'main')
    } finally {
      await app.close().catch(() => {})
    }
  })

  interface MenuEntry {
    top: string
    label: string
    accelerator: string
  }

  async function menuEntries(app: ElectronApplication): Promise<MenuEntry[]> {
    return app.evaluate(({ Menu }) => {
      const out: { top: string; label: string; accelerator: string }[] = []
      const menu = Menu.getApplicationMenu()
      if (!menu) return out
      for (const top of menu.items) {
        for (const item of top.submenu?.items ?? []) {
          out.push({
            top: top.label ?? '',
            label: item.label ?? '',
            accelerator: String(item.accelerator ?? '')
          })
        }
      }
      return out
    })
  }

  function normalizeAccelerator(accel: string): string {
    return accel
      .toLowerCase()
      .split('+')
      .map((part) => part.trim())
      .filter(Boolean)
      .sort()
      .join('+')
  }

  test('BB-C26: File menu carries both items with their shortcuts', async ({ env }) => {
    test.setTimeout(120_000)
    pinWorkspaces(env, [{ name: 'ws-alpha', kind: 'git' }])

    const { app } = await launchSettled(env)
    try {
      const file = (await menuEntries(app)).filter((e) => e.top === 'File')

      const newSession = file.find((e) => e.label === 'New Session…')
      expect(newSession).toBeDefined()
      expect(normalizeAccelerator(newSession!.accelerator)).toBe(
        normalizeAccelerator('CmdOrCtrl+N')
      )

      const newWorktree = file.find((e) => e.label === 'New Worktree Session…')
      expect(newWorktree).toBeDefined()
      expect(normalizeAccelerator(newWorktree!.accelerator)).toBe(
        normalizeAccelerator('Shift+CmdOrCtrl+N')
      )
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('an empty workspace carries the head button door as a row that fits the narrowest sidebar', async ({
    env
  }) => {
    test.setTimeout(180_000)
    seedSettings(env, { sidebarWidth: 200 })
    pinWorkspaces(env, [
      { name: 'ws-alpha', kind: 'git' },
      { name: 'ws-plain', kind: 'plain' }
    ])

    const { app, page } = await launchSettled(env)
    try {
      const repoDoor = emptyDoor(page, 'ws-alpha')
      const plainDoor = emptyDoor(page, 'ws-plain')
      await expect(repoDoor).toBeVisible()

      const overflow = await page
        .locator('.ws-list')
        .evaluate((el) => el.scrollWidth - el.clientWidth)
      expect(overflow).toBeLessThanOrEqual(0)

      await expect(repoDoor).toHaveText('New worktree…')
      await expect(plainDoor).toHaveText('New session')

      await plainDoor.click()
      await page.waitForTimeout(GRACE_FOR_A_WRONG_DIALOG_MS)
      await expectNoDialog(page)
      await waitForSessionRow(page, 'ws-plain', 'main')
      await expect(plainDoor).toHaveCount(0)

      await repoDoor.click()
      await expect(page.getByText('New Worktree Session · ws-alpha')).toBeVisible({
        timeout: 15_000
      })
    } finally {
      await app.close().catch(() => {})
    }
  })
})
