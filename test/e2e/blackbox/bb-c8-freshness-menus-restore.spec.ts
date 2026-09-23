import type { Locator, Page } from '@playwright/test'
import { test, expect } from '../helpers/app'
import {
  BADGE_TIMEOUT,
  behindBadge,
  gitWorktreeAdd,
  launchSettled,
  pinWorkspaces,
  pressNewSession,
  pressNewWorktreeSession,
  rowsWithSub,
  waitForBehindBadge,
  waitForSessionRow
} from '../helpers/blackbox'
import type { E2EEnv } from '../helpers/env'
import { fetchedAtMs } from '../helpers/gitFixture'
import {
  closeMenu,
  FAKE_SESSION_TITLE,
  killSession,
  menuItemTexts,
  openMenu,
  resumedId,
  startSessionIn,
  waitForCalls,
  wsRows
} from '../helpers/p1'

/**
 * Black-box cases of the original case list (retired after
 * the feature merged) — the C8 worktree dialog's freshness half, the exposure surfaces
 * (hover buttons, context menus, welcome panel) and the C9 restore dialog: BB-M09,
 * BB-C03, BB-C04, BB-C05, BB-C06, BB-C18, BB-C19, BB-C25, BB-C27, BB-C28, BB-C30,
 * BB-C32, BB-C33.
 *
 * RED by construction: none of the three dialogs exist yet. Every NEW surface is
 * therefore located by the text the case itself names (dialog titles, button labels,
 * toast wording) — never by a class this file invented. Existing surfaces used for
 * setup and observation (sidebar rows, fly-out menus, badges, the welcome panel) go
 * through the harness's own helpers.
 */

/** The smallest element carrying BOTH the dialog's visible title and a piece of its
 *  body — the only way to scope "inside the dialog" for a dialog that has no markup
 *  yet (the sidebar renders the same workspace names outside it). */
function dialogBody(page: Page, title: string, body: string | RegExp): Locator {
  return page.locator('div').filter({ hasText: title }).filter({ hasText: body }).last()
}

/** One picker row inside a dialog, in the terms the D12 accessibility contract pins: rows are
 *  `role="option"`, named by the workspace they offer. */
function rowNamed(scope: Locator, name: string): Locator {
  return scope.getByRole('option', {
    name: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  })
}

/** `<n>` then the workspace name, with whatever separator the row draws between them. */
function numbered(n: number, name: string): RegExp {
  return new RegExp(`^\\s*${n}[^A-Za-z0-9]*${name}`)
}

/** The per-workspace entrance (D7): the head's fly-out item — its ⑂ hover button
 *  retired (misclick hazard, BB-M10), the menu is the door now. */
async function openWorktreeDialog(page: Page, wsName: string): Promise<void> {
  await openMenu(page, page.locator('.ws-head', { hasText: wsName }))
  await page.locator('.menu .mi', { hasText: 'New worktree session' }).click()
  await expect(page.getByText(`New Worktree Session · ${wsName}`, { exact: true })).toBeVisible({
    timeout: 15_000
  })
}

/** A real session, started in `dir` and then taken off the list through its ROW MENU's
 *  "Remove from list" — the "absent from the sidebar but present in history"
 *  precondition the restore cases are given. The session is ended non-gracefully on
 *  purpose: a `/exit` drops the row outright (T-LIFE-04) and the cases name the menu,
 *  not that auto-drop, so the row has to survive its process to be removed by hand. */
async function seedEndedSession(env: E2EEnv, page: Page, wsName: string): Promise<void> {
  await startSessionIn(page, wsName)
  const row = page.locator('.ws-tab', { hasText: FAKE_SESSION_TITLE })
  await expect(row).toHaveCount(1, { timeout: 40_000 })

  const calls = await waitForCalls(env, 1)
  killSession(calls[calls.length - 1].pid, env)
  await expect(row).toHaveClass(/\bcold\b/, { timeout: 40_000 })

  await openMenu(page, row)
  await page.locator('.menu .mi', { hasText: 'Remove from list' }).click()
  await expect(row).toHaveCount(0, { timeout: 20_000 })
}

test('BB-M09: Restore session… brings a removed session back', async ({ env }) => {
  test.setTimeout(240_000)
  const pinned = pinWorkspaces(env, [{ name: 'ws-restore', kind: 'git' }])

  const { app, page } = await launchSettled(env)
  try {
    await seedEndedSession(env, page, 'ws-restore')
    // the identity the restore must preserve: the seeded session's own id, read from
    // the launcher's call record (the claude CLI invocation is an external contract)
    const seededCalls = await waitForCalls(env, 1)
    const originalId = seededCalls[seededCalls.length - 1].sessionId

    await openMenu(page, page.locator('.ws-head', { hasText: 'ws-restore' }))
    await page.locator('.menu .mi', { hasText: 'Restore session' }).click()

    const title = page.getByText('Restore session · ws-restore', { exact: true })
    await expect(title).toBeVisible({ timeout: 15_000 })
    const entry = page.getByRole('button', { name: FAKE_SESSION_TITLE })
    await expect(entry).toHaveCount(1)
    await expect(entry).toContainText('main')
    // the case asks for a relative time, not for one wording of it
    await expect(entry).toContainText(/(\d+\s*[smhd]\s*ago|just now|moments? ago|now)/i)

    await entry.click()
    await expect(title).toHaveCount(0)
    await expect(wsRows(page, 'ws-restore').filter({ hasText: FAKE_SESSION_TITLE })).toHaveCount(
      1,
      { timeout: 60_000 }
    )
    // …and it is the SAME session, not a lookalike: the relaunch carries --resume
    // with the original id (review find #7 — the former T-NEW-10's surviving oracle)
    const after = await waitForCalls(env, seededCalls.length + 1)
    expect(resumedId(after[after.length - 1])).toBe(originalId)
  } finally {
    await app.close().catch(() => {})
  }
})

test('BB-C03: ⇧⌘N picker hides non-git rows and renumbers digits', async ({ env }) => {
  test.setTimeout(120_000)
  pinWorkspaces(env, [
    { name: 'plain-x', kind: 'plain' },
    { name: 'git-a', kind: 'git' },
    { name: 'git-b', kind: 'git' }
  ])

  const { app, page } = await launchSettled(env)
  try {
    await pressNewWorktreeSession(app, page)

    await expect(page.getByText('New Worktree Session in…', { exact: true })).toBeVisible({
      timeout: 15_000
    })
    const dlg = dialogBody(page, 'New Worktree Session in…', 'git-a')
    await expect(dlg.getByText('plain-x')).toHaveCount(0)
    await expect(rowNamed(dlg, 'git-a')).toHaveText(numbered(1, 'git-a'))
    await expect(rowNamed(dlg, 'git-b')).toHaveText(numbered(2, 'git-b'))

    await page.keyboard.press('1')
    await expect(page.getByText('New Worktree Session · git-a', { exact: true })).toBeVisible({
      timeout: 15_000
    })
  } finally {
    await app.close().catch(() => {})
  }
})

test('BB-C04: no git workspace anywhere — ⇧⌘N toasts', async ({ env }) => {
  test.setTimeout(120_000)
  pinWorkspaces(env, [
    { name: 'plain-one', kind: 'plain' },
    { name: 'plain-two', kind: 'plain' }
  ])

  const { app, page } = await launchSettled(env)
  try {
    await pressNewWorktreeSession(app, page)

    await expect(page.getByText(/no git repository among your workspaces/i)).toBeVisible({
      timeout: 15_000
    })
    await expect(page.getByText(/New Worktree Session/)).toHaveCount(0)
  } finally {
    await app.close().catch(() => {})
  }
})

// [PRE-IMPL: green — existing behavior] absence assertions pass pre-implementation by design
test('BB-C05: non-git workspace exposes no worktree entrances', async ({ env }) => {
  test.setTimeout(120_000)
  pinWorkspaces(env, [{ name: 'plain-solo', kind: 'plain' }])

  const { app, page } = await launchSettled(env)
  try {
    const head = page.locator('.ws-head', { hasText: 'plain-solo' })
    await head.hover()
    const panel = page.locator('.w-empty')
    await expect(panel).toBeVisible()

    // revised: a plain head's single hover button is the main-session
    // door (＋), never the worktree one (BB-M10 pins the git side) — the other
    // worktree entrances to deny are the menu item (BB-C06's plain-menu set) and the
    // welcome panel's secondary, probed here
    await expect(head.locator('button')).toHaveCount(1)
    await expect(head.getByRole('button', { name: 'New session' })).toHaveCount(1)
    await expect(head.getByRole('button', { name: /New worktree session/ })).toHaveCount(0)
    await expect(panel.getByText(/New worktree session/i)).toHaveCount(0)
  } finally {
    await app.close().catch(() => {})
  }
})

test('BB-C06: context menu exact item sets for git / non-git / missing workspaces', async ({
  env
}) => {
  test.setTimeout(120_000)
  pinWorkspaces(env, [
    { name: 'git-menu', kind: 'git' },
    { name: 'plain-menu', kind: 'plain' },
    { name: 'gone-menu', kind: 'missing' }
  ])

  const { app, page } = await launchSettled(env)
  try {
    await openMenu(page, page.locator('.ws-head', { hasText: 'git-menu' }))
    const gitItems = await menuItemTexts(page)
    expect(gitItems).toHaveLength(6)
    expect(gitItems[0]).toMatch(/^New session\s*⌘N$/)
    expect(gitItems[1]).toMatch(/^New worktree session…\s*⇧⌘N$/)
    expect(gitItems[2]).toMatch(/^Restore session…$/)
    expect(gitItems[3]).toMatch(/^Fetch origin$/)
    expect(gitItems[4]).toMatch(/^Scheduled jobs…$/)
    expect(gitItems[5]).toMatch(/^Remove workspace$/)
    await closeMenu(page)

    await openMenu(page, page.locator('.ws-head', { hasText: 'plain-menu' }))
    const plainItems = await menuItemTexts(page)
    expect(plainItems).toHaveLength(4)
    expect(plainItems[0]).toMatch(/^New session\s*⌘N$/)
    expect(plainItems[1]).toMatch(/^Restore session…$/)
    // a plain folder gets the scheduled-jobs door too — a run just works in
    // the folder itself, so the item is not behind the git gate
    expect(plainItems[2]).toMatch(/^Scheduled jobs…$/)
    expect(plainItems[3]).toMatch(/^Remove workspace$/)
    await closeMenu(page)

    await openMenu(page, page.locator('.ws-head', { hasText: 'gone-menu' }))
    expect(await menuItemTexts(page)).toEqual(['Remove workspace'])
    await closeMenu(page)
  } finally {
    await app.close().catch(() => {})
  }
})

test('BB-C18: ⇧⌘N with exactly one visible git workspace skips the picker unconditionally', async ({
  env
}) => {
  test.setTimeout(120_000)
  const pinned = pinWorkspaces(env, [
    { name: 'plain-side', kind: 'plain' },
    { name: 'repo-b', kind: 'cloned' }
  ])
  pinned.git['repo-b'].originAhead(3)

  const { app, page } = await launchSettled(env)
  try {
    await waitForBehindBadge(page, 'repo-b', 3)

    await pressNewWorktreeSession(app, page)

    await expect(page.getByText('New Worktree Session · repo-b', { exact: true })).toBeVisible({
      timeout: 15_000
    })
    await expect(page.getByText('New Worktree Session in…')).toHaveCount(0)
    await expect(page.getByText(/3 commits behind origin\/main/)).toBeVisible({ timeout: 30_000 })
  } finally {
    await app.close().catch(() => {})
  }
})

test('BB-C19: stale base morphs C8 create button to Pull & Create', async ({ env }) => {
  test.setTimeout(180_000)
  const pinned = pinWorkspaces(env, [
    { name: 'plain-side', kind: 'plain' },
    { name: 'repo-b', kind: 'cloned' }
  ])
  pinned.git['repo-b'].originAhead(3)

  const { app, page } = await launchSettled(env)
  try {
    await waitForBehindBadge(page, 'repo-b', 3)
    await pressNewWorktreeSession(app, page)
    await expect(page.getByText('New Worktree Session · repo-b', { exact: true })).toBeVisible({
      timeout: 15_000
    })
    await page.keyboard.type('feat-x')

    await expect(page.getByRole('button', { name: /Pull & Create worktree/ })).toHaveText(
      /Pull & Create worktree\s*[“"]feat-x[”"]/
    )

    await page.keyboard.press('Enter')
    await expect(behindBadge(page, 'repo-b')).toHaveCount(0, { timeout: BADGE_TIMEOUT })
    await waitForSessionRow(page, 'repo-b', 'feat-x')
  } finally {
    await app.close().catch(() => {})
  }
})

test('BB-C25: ten pinned workspaces — row 10 has no digit', async ({ env }) => {
  test.setTimeout(180_000)
  const names = [
    'alpha',
    'bravo',
    'charlie',
    'delta',
    'echo',
    'foxtrot',
    'golf',
    'hotel',
    'india',
    'juliet'
  ]
  pinWorkspaces(
    env,
    names.map((name) => ({ name, kind: 'git' as const }))
  )

  const { app, page } = await launchSettled(env)
  try {
    await pressNewSession(app, page)
    await expect(page.getByText('New Session in…', { exact: true })).toBeVisible({
      timeout: 15_000
    })
    const dlg = dialogBody(page, 'New Session in…', 'juliet')

    for (let i = 0; i < 9; i++) {
      await expect(rowNamed(dlg, names[i])).toHaveText(numbered(i + 1, names[i]))
    }
    await expect(rowNamed(dlg, 'juliet')).toHaveText(/^\s*juliet/)

    // "↓↑ still reach row 10", read where a black box can see it: the arrows walk down
    // to row 10, up off it and back onto it, and the selection lands there (D12: the hot
    // row carries aria-selected="true"). The case's Then asks for no launch.
    for (let i = 0; i < 9; i++) await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('ArrowDown')
    await expect(dlg.locator('[aria-selected="true"]')).toHaveCount(1)
    await expect(rowNamed(dlg, 'juliet')).toHaveAttribute('aria-selected', 'true')
  } finally {
    await app.close().catch(() => {})
  }
})

test('BB-C27: Restore session… is disabled when history is empty', async ({ env }) => {
  test.setTimeout(120_000)
  pinWorkspaces(env, [{ name: 'git-fresh', kind: 'git' }])

  const { app, page } = await launchSettled(env)
  try {
    await openMenu(page, page.locator('.ws-head', { hasText: 'git-fresh' }))

    const item = page.locator('.menu .mi', { hasText: 'Restore session' })
    await expect(item).toHaveCount(1)
    // greyed out through the menu's own disabled affordance (D12; `.menu .mi.disabled`
    // is what every other greyed item in this menu family already uses)
    await expect(page.locator('.menu .mi.disabled', { hasText: 'Restore session' })).toHaveCount(1)
    // …and read behaviorally as well: activating it opens nothing. force: a correctly
    // disabled item carries pointer-events:none, which a plain click would wait on forever
    await item.click({ force: true })
    await page.waitForTimeout(2000)
    await expect(page.getByText(/^Restore session · /)).toHaveCount(0)
  } finally {
    await app.close().catch(() => {})
  }
})

test('BB-C28: restore works on a non-git workspace', async ({ env }) => {
  test.setTimeout(240_000)
  const pinned = pinWorkspaces(env, [{ name: 'plain-hist', kind: 'plain' }])

  const { app, page } = await launchSettled(env)
  try {
    await seedEndedSession(env, page, 'plain-hist')

    await openMenu(page, page.locator('.ws-head', { hasText: 'plain-hist' }))
    await page.locator('.menu .mi', { hasText: 'Restore session' }).click()
    await expect(page.getByText('Restore session · plain-hist', { exact: true })).toBeVisible({
      timeout: 15_000
    })
    await page.getByRole('button', { name: FAKE_SESSION_TITLE }).click()

    await expect(wsRows(page, 'plain-hist').filter({ hasText: FAKE_SESSION_TITLE })).toHaveCount(
      1,
      { timeout: 60_000 }
    )
  } finally {
    await app.close().catch(() => {})
  }
})

test('BB-C30: opening C8 is itself a fetch trigger', async ({ env }) => {
  test.setTimeout(180_000)
  const pinned = pinWorkspaces(env, [{ name: 'repo-fetch', kind: 'cloned' }])
  const fx = pinned.git['repo-fetch']

  const { app, page } = await launchSettled(env)
  try {
    // origin only moves once the startup sweep has been and gone, so the app genuinely
    // does not know yet — and the next sweep of its own is 5 minutes out
    await expect.poll(() => fetchedAtMs(fx), { timeout: BADGE_TIMEOUT }).toBeGreaterThan(0)
    fx.originAhead(3)
    await expect(behindBadge(page, 'repo-fetch')).toHaveCount(0)

    await openWorktreeDialog(page, 'repo-fetch')

    await expect(page.getByText(/3 commits behind origin\/main/)).toBeVisible({
      timeout: BADGE_TIMEOUT
    })
    await waitForBehindBadge(page, 'repo-fetch', 3)
  } finally {
    await app.close().catch(() => {})
  }
})

test('BB-C32: exact-name open state shows no freshness apparatus and pulls nothing', async ({
  env
}) => {
  test.setTimeout(180_000)
  const pinned = pinWorkspaces(env, [{ name: 'repo-w', kind: 'cloned' }])
  gitWorktreeAdd(pinned.paths['repo-w'], 'w')
  pinned.git['repo-w'].originAhead(3)

  const { app, page } = await launchSettled(env)
  try {
    await waitForBehindBadge(page, 'repo-w', 3)
    await openWorktreeDialog(page, 'repo-w')
    await page.keyboard.type('w')

    await expect(page.getByRole('button', { name: /Open worktree/ })).toHaveText(
      /^\s*Open worktree\s*[“"]w[”"]/
    )
    await expect(page.getByText(/behind origin\/main/)).toHaveCount(0)
    await expect(page.getByText(/is up to date/)).toHaveCount(0)

    await page.keyboard.press('Enter')
    await waitForSessionRow(page, 'repo-w', 'w')
    await expect(behindBadge(page, 'repo-w')).toHaveText('3')
  } finally {
    await app.close().catch(() => {})
  }
})

test('BB-C33: C8-side pull under a running root session asks first', async ({ env }) => {
  test.setTimeout(240_000)
  const pinned = pinWorkspaces(env, [{ name: 'repo-run', kind: 'cloned' }])

  const { app, page } = await launchSettled(env)
  try {
    // the root session is started BEFORE origin moves: seeding it must not itself go
    // through a gate, which is the surface under test
    await startSessionIn(page, 'repo-run')
    await waitForSessionRow(page, 'repo-run', 'main')
    // only NOW does origin move, and a manual fetch is what discovers it (the startup
    // fetch already ran, against an origin that had not moved yet)
    pinned.git['repo-run'].originAhead(3)
    await openMenu(page, page.locator('.ws-head', { hasText: 'repo-run' }))
    await page.locator('.menu .mi', { hasText: 'Fetch origin' }).click()
    await waitForBehindBadge(page, 'repo-run', 3)

    await openWorktreeDialog(page, 'repo-run')
    await page.keyboard.type('x')
    await expect(page.getByRole('button', { name: /Pull & Create worktree/ })).toHaveText(
      /Pull & Create worktree\s*[“"]x[”"]/
    )

    await page.keyboard.press('Enter')
    const confirm = page
      .locator('div')
      .filter({ hasText: /running in this checkout/ })
      .filter({ has: page.getByRole('button', { name: 'Pull anyway' }) })
      .last()
    await expect(confirm).toBeVisible({ timeout: 15_000 })
    await confirm.getByRole('button', { name: 'Cancel' }).click()

    await expect(behindBadge(page, 'repo-run')).toHaveText('3')
    await expect(rowsWithSub(page, 'repo-run', 'x')).toHaveCount(0)
  } finally {
    await app.close().catch(() => {})
  }
})
