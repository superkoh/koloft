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

/**
 * Black-box cases for the per-workspace direct-launch surfaces and the D3 pull gate
 *: BB-M10 · M12 · M13 · M14 · M15 · M16 ·
 * BB-C01 · C02 · C20 · C21 · C22 · C23 · C26.
 *
 * RED-FIRST: none of the surfaces these cases name exist yet — the three dialogs, the
 * sidebar ⑂, the welcome secondary, the zero-workspace toast and the File menu's second
 * item are all located by the user-visible text/label the case itself names, never by a
 * class that would have to be invented for an implementation that isn't written.
 * Existing surfaces (sidebar rows, context menu, the reused PullConfirm) keep the
 * harness's own selectors.
 */

/** A dialog is on screen only if its title is — the cases name the three new dialogs by
 *  their titles, and the app's own dialog family carries `.modal`. */
async function expectNoDialog(page: Page): Promise<void> {
  await expect(page.locator('.modal')).toHaveCount(0)
  // scope the title probes to the dialog family (sibling-file pattern): the context
  // menu item and the welcome secondary legitimately carry the same phrase as text
  const dialogs = page.locator('.modal, [role="dialog"]')
  await expect(dialogs.filter({ hasText: 'New Session in…' })).toHaveCount(0)
  await expect(dialogs.filter({ hasText: 'New Worktree Session' })).toHaveCount(0)
}

/** The C10 picker/gate title. */
const pickerTitle = (page: Page): Locator => page.getByText('New Session in…')

/** The morphing primary of the picker/gate (§03B: `Start` / `Pull & Start`). */
const pullAndStart = (page: Page): Locator => page.getByRole('button', { name: 'Pull & Start' })

/** The row an empty workspace carries where its session rows would be. */
function emptyDoor(page: Page, wsName: string): Locator {
  return wsGroup(page, wsName).locator('.ws-empty')
}

/** The welcome panel's two buttons, by their visible text. */
function welcomeButton(page: Page, label: string): Locator {
  return page.locator('.w-empty').getByRole('button', { name: label })
}

// BB-M10 — revised: the head's hover button is back, but as ONE button, not
// the old ＋/⑂ pair (retired because the two sat side by side and the wrong
// one got hit). A git workspace's single button is the worktree door; a plain
// folder's is the main-session door (BB-C05). The generic one-button count is
// deliberate: a second button creeping back in must fail this. (The freshness badge is
// also a head button, but these workspaces have no origin to be behind, so one is
// exact.)
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
    // Given: A's row is on screen and hovered
    const head = page.locator('.ws-head', { hasText: 'ws-alpha' })
    await expect(head).toBeVisible()
    await head.hover()

    // Then: one button, named as the worktree door — no plain "New session" beside it
    await expect(head.locator('button')).toHaveCount(1)
    await expect(head.getByRole('button', { name: /^New worktree session/ })).toHaveCount(1)
    await expect(head.getByRole('button', { name: 'New session' })).toHaveCount(0)
  } finally {
    await app.close().catch(() => {})
  }
})

// BB-M12 — the welcome panel's two buttons split the same way the row does: primary =
// direct launch, secondary = C8 for this workspace. The welcome state is reopened by
// relaunching the app: Koloft restores no tabs (persistence spec), so the panel is back.
test('BB-M12: welcome panel primary starts directly; secondary opens C8', async ({ env }) => {
  test.setTimeout(240_000)
  pinWorkspaces(env, [{ name: 'ws-alpha', kind: 'git' }])

  const first = await launchSettled(env)
  try {
    // Given: the welcome panel shows both buttons
    await expect(first.page.locator('.w-empty')).toBeVisible()
    await expect(welcomeButton(first.page, 'New session')).toBeVisible()
    await expect(welcomeButton(first.page, 'New worktree session…')).toBeVisible()

    // When: the primary is clicked
    await welcomeButton(first.page, 'New session').click()

    // Then: a session row with secondary line `main`, and no dialog was shown
    await first.page.waitForTimeout(1500)
    await expectNoDialog(first.page)
    await waitForSessionRow(first.page, 'ws-alpha', 'main')
  } finally {
    await first.app.close().catch(() => {})
  }

  // …and the secondary, from the welcome state again, opens C8 directly
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

// BB-M13 — the context menu's "New session" (no ellipsis, D12) is the per-workspace
// direct launch: it already knows which workspace it was opened on.
test('BB-M13: context menu "New session" is a direct launch', async ({ env }) => {
  test.setTimeout(120_000)
  pinWorkspaces(env, [
    { name: 'ws-alpha', kind: 'git' },
    { name: 'ws-bravo', kind: 'git' }
  ])

  const { app, page } = await launchSettled(env)
  try {
    // Given: A's context menu is open
    await openMenu(page, page.locator('.ws-head', { hasText: 'ws-alpha' }))

    // When: "New session" is clicked (never the worktree item beside it)
    await page
      .locator('.menu .mi')
      .filter({ hasText: /^\s*New session/ })
      .click()

    // Then: no dialog, and the session lands under A on the main checkout
    await page.waitForTimeout(1500)
    await expectNoDialog(page)
    await waitForSessionRow(page, 'ws-alpha', 'main')
  } finally {
    await app.close().catch(() => {})
  }
})

// BB-M14 — the one state where ⌘N does NOT skip its picker with a single workspace:
// the row is behind and a plain fast-forward is safe, so C10 becomes the D6a gate.
test('BB-M14: behind-and-pullable main — the picker becomes the Pull & Start gate', async ({
  env
}) => {
  test.setTimeout(120_000)
  const pinned = pinWorkspaces(env, [{ name: 'ws-repo', kind: 'cloned' }])
  pinned.git['ws-repo'].originAhead(3)

  const { app, page } = await launchSettled(env)
  try {
    // Given: the single pinned workspace is shown behind by 3, fast-forward possible
    await waitForBehindBadge(page, 'ws-repo', 3)

    // When: ⌘N is pressed
    await pressNewSession(app, page)

    // Then: the picker appears despite the single workspace, primary reads Pull & Start,
    // and nothing has started
    await expect(pickerTitle(page).first()).toBeVisible({ timeout: 15_000 })
    await expect(pullAndStart(page)).toBeVisible()
    await expect(page.locator('.ws-tab')).toHaveCount(0)
  } finally {
    await app.close().catch(() => {})
  }
})

// BB-M15 — the gate's ⏎ is one action with two steps in order: pull, then start.
test('BB-M15: Pull & Start pulls, then starts', async ({ env }) => {
  test.setTimeout(120_000)
  const pinned = pinWorkspaces(env, [{ name: 'ws-repo', kind: 'cloned' }])
  pinned.git['ws-repo'].originAhead(3)

  const { app, page } = await launchSettled(env)
  try {
    await waitForBehindBadge(page, 'ws-repo', 3)
    await pressNewSession(app, page)
    // Given: the gate — the "New Session in…" dialog the case's Surface names — is
    // showing `Pull & Start`
    await expect(pickerTitle(page).first()).toBeVisible({ timeout: 15_000 })
    await expect(pullAndStart(page)).toBeVisible()

    // When: ⏎ is pressed
    await page.keyboard.press('Enter')

    // Then: the behind badge clears and a main session row appears
    await expect(behindBadge(page, 'ws-repo')).toHaveCount(0, { timeout: 40_000 })
    await waitForSessionRow(page, 'ws-repo', 'main')
  } finally {
    await app.close().catch(() => {})
  }
})

// BB-M16 — the gate is a gate, not a nag: Esc leaves the workspace exactly as it was.
test('BB-M16: Esc on the gate starts nothing and pulls nothing', async ({ env }) => {
  test.setTimeout(120_000)
  const pinned = pinWorkspaces(env, [{ name: 'ws-repo', kind: 'cloned' }])
  pinned.git['ws-repo'].originAhead(3)

  const { app, page } = await launchSettled(env)
  try {
    await waitForBehindBadge(page, 'ws-repo', 3)
    await pressNewSession(app, page)
    // Given: the gate — the "New Session in…" dialog the case's Surface names — is
    // showing `Pull & Start`
    await expect(pickerTitle(page).first()).toBeVisible({ timeout: 15_000 })
    await expect(pullAndStart(page)).toBeVisible()

    // When: Esc is pressed
    await page.keyboard.press('Escape')

    // Then: the dialog closes, no session row appeared, the behind count still reads 3
    await expect(pickerTitle(page)).toHaveCount(0)
    await expect(pullAndStart(page)).toHaveCount(0)
    await page.waitForTimeout(2000) // give a (wrong) launch every chance to show up
    await expect(page.locator('.ws-tab')).toHaveCount(0)
    await expect(behindBadge(page, 'ws-repo')).toHaveText('3')
  } finally {
    await app.close().catch(() => {})
  }
})

// BB-C01 — with nothing pinned both keys have nothing to aim at, and the answer is a
// toast rather than today's silent no-op.
test('BB-C01: zero workspaces — both keys toast instead of silence', async ({ env }) => {
  test.setTimeout(120_000)
  pinWorkspaces(env, [])

  // Given: no workspace is pinned and the app has settled (launchSettled waits for the
  // empty-state render, i.e. past the cold-start guard window)
  const { app, page } = await launchSettled(env)
  try {
    const toast = page.getByText('No workspace yet — add one first')

    // When: ⌘N is pressed
    await pressNewSession(app, page)
    // Then: a toast, no dialog, no session
    await expect(toast.first()).toBeVisible({ timeout: 15_000 })
    await expectNoDialog(page)
    await expect(page.locator('.ws-tab')).toHaveCount(0)

    // …and then ⇧⌘N — waited out so the second toast is a second toast, not the first
    await expect(toast).toHaveCount(0, { timeout: 20_000 })
    await pressNewWorktreeSession(app, page)
    await expect(toast.first()).toBeVisible({ timeout: 15_000 })
    await expectNoDialog(page)
    await expect(page.locator('.ws-tab')).toHaveCount(0)
  } finally {
    await app.close().catch(() => {})
  }
})

// BB-C02 — a plain folder has no branch question to answer, so ⌘N runs in the folder
// itself: the old "not a git repository" confirm box dies with C7 (D10).
test('BB-C02: non-git workspace — ⌘N starts in the folder itself, no confirm box', async ({
  env
}) => {
  test.setTimeout(120_000)
  pinWorkspaces(env, [{ name: 'ws-plain', kind: 'plain' }])

  const { app, page } = await launchSettled(env)
  try {
    // Given: the single pinned workspace is not a git repository
    await expect(page.locator('.ws-head', { hasText: 'ws-plain' })).toBeVisible()

    // When: ⌘N is pressed
    await pressNewSession(app, page)

    // Then: no dialog, and a session row under it with secondary line `main`
    await page.waitForTimeout(1500)
    await expectNoDialog(page)
    await waitForSessionRow(page, 'ws-plain', 'main')
  } finally {
    await app.close().catch(() => {})
  }
})

// BB-C20 — D14: only "behind and safely fast-forwardable" morphs anything. A dirty
// tree is behind-but-not-pullable, so ⌘N stays a zero-rendering direct launch.
// The local change is seeded BEFORE launch so the app's first freshness sweep already
// measures the dirty tree — the case's own "then make a change" ordering would race
// the resident snapshot rather than test the D14 rule.
test('BB-C20: behind but NOT pullable — ⌘N launches instantly with zero rendering', async ({
  env
}) => {
  test.setTimeout(120_000)
  const pinned = pinWorkspaces(env, [{ name: 'ws-repo', kind: 'cloned' }])
  pinned.git['ws-repo'].originAhead(3)
  makeDirty(pinned.paths['ws-repo'])

  const { app, page } = await launchSettled(env)
  try {
    // Given: the single workspace is behind but not safely fast-forwardable
    await waitForBehindBadge(page, 'ws-repo', 3)

    // When: ⌘N is pressed
    await pressNewSession(app, page)

    // Then: no dialog, a main session row, and the behind badge is untouched
    await page.waitForTimeout(1500)
    await expectNoDialog(page)
    await waitForSessionRow(page, 'ws-repo', 'main')
    await expect(behindBadge(page, 'ws-repo')).toHaveText('3')
  } finally {
    await app.close().catch(() => {})
  }
})

// BB-C21 — D6a bars starting on the old base only while pulling is still possible: a
// pull that FAILS degrades the same gate to a plain Start on the current HEAD.
test('BB-C21: pull failure degrades the gate to Start on the current base', async ({ env }) => {
  test.setTimeout(150_000)
  const pinned = pinWorkspaces(env, [{ name: 'ws-repo', kind: 'cloned' }])
  pinned.git['ws-repo'].originAhead(3)

  const { app, page } = await launchSettled(env)
  try {
    await waitForBehindBadge(page, 'ws-repo', 3)
    // the origin goes away only once the app already measured behind-and-pullable
    pinned.git['ws-repo'].deleteOrigin()

    await pressNewSession(app, page)
    // Given: the gate — the "New Session in…" dialog the case's Surface names — shows
    // `Pull & Start`, but the pull will fail
    await expect(pickerTitle(page).first()).toBeVisible({ timeout: 15_000 })
    await expect(pullAndStart(page)).toBeVisible()

    // When: ⏎ is pressed
    await page.keyboard.press('Enter')

    // Then: a failure notice, and the primary is now plain `Start`
    await expect(page.getByText(/pull failed/i).first()).toBeVisible({ timeout: 60_000 })
    await expect(pullAndStart(page)).toHaveCount(0)
    const start = page.getByRole('button', { name: /^\s*Start\s*⏎?\s*$/ })
    await expect(start).toBeVisible()

    // …and the second ⏎ starts on the current base, behind badge intact
    await page.keyboard.press('Enter')
    await waitForSessionRow(page, 'ws-repo', 'main')
    await expect(behindBadge(page, 'ws-repo')).toHaveText('3')
  } finally {
    await app.close().catch(() => {})
  }
})

// BB-C22 — a fast-forward rewrites files under whatever agents are already working in
// the root checkout, so the gate's ⏎ stacks the existing pull confirmation on top.
// The session is started BEFORE origin moves, so seeding it cannot itself go through
// the gate — the gate is what the case is about.
test('BB-C22: pulling under a running root session asks first', async ({ env }) => {
  test.setTimeout(240_000)
  const pinned = pinWorkspaces(env, [{ name: 'ws-repo', kind: 'cloned' }])

  const { app, page } = await launchSettled(env)
  try {
    await startSessionIn(page, 'ws-repo')
    await waitForSessionRow(page, 'ws-repo', 'main')
    // only NOW does origin move, and a manual fetch is what discovers it (the startup
    // fetch already ran, against an origin that had not moved yet)
    pinned.git['ws-repo'].originAhead(3)
    await openMenu(page, page.locator('.ws-head', { hasText: 'ws-repo' }))
    await page.locator('.menu .mi', { hasText: 'Fetch origin' }).click()
    await waitForBehindBadge(page, 'ws-repo', 3)

    await pressNewSession(app, page)
    // Given: the gate — the "New Session in…" dialog the case's Surface names — shows
    // `Pull & Start` while a root session is running
    await expect(pickerTitle(page).first()).toBeVisible({ timeout: 15_000 })
    await expect(pullAndStart(page)).toBeVisible()

    // When: ⏎ is pressed and the confirmation is cancelled
    await page.keyboard.press('Enter')
    const confirm = page.locator('.modal').filter({ hasText: 'running in this checkout' })
    await expect(confirm).toBeVisible({ timeout: 20_000 })
    await confirm.getByRole('button', { name: 'Cancel' }).click()

    // Then: no pull happened and no new session row exists
    await expect(confirm).toHaveCount(0)
    await page.waitForTimeout(2000)
    await expect(behindBadge(page, 'ws-repo')).toHaveText('3')
    await expect(rowsWithSub(page, 'ws-repo', 'main')).toHaveCount(1)
  } finally {
    await app.close().catch(() => {})
  }
})

// BB-C23 — the per-workspace direct launches are one rule, not one each: both meet the
// same gate when the target is behind-and-pullable (D6a has no back door). Two surfaces
// — the sidebar ＋ retired with the head's hover buttons (BB-M10).
// With a single pin the gate's "single-workspace frame, no list" has no second row to
// be falsifiable against, so the gate is identified by its morphed primary.
test('BB-C23: the gate guards both per-workspace direct-launch surfaces', async ({ env }) => {
  test.setTimeout(180_000)
  const pinned = pinWorkspaces(env, [{ name: 'ws-repo', kind: 'cloned' }])
  pinned.git['ws-repo'].originAhead(3)

  const { app, page } = await launchSettled(env)
  try {
    // Given: the workspace is behind-and-pullable, zero sessions (welcome panel up)
    await waitForBehindBadge(page, 'ws-repo', 3)
    await expect(page.locator('.w-empty')).toBeVisible()
    const head = page.locator('.ws-head', { hasText: 'ws-repo' })

    // the gate is C10 in its single-workspace frame: it keeps the mode's title (D12)
    // and has no list rows at all
    const expectGate = async (): Promise<void> => {
      await expect(pullAndStart(page)).toBeVisible({ timeout: 15_000 })
      await expect(pickerTitle(page).first()).toBeVisible()
      await expect(page.getByRole('option')).toHaveCount(0)
    }

    // When ①: the context menu's "New session" — gate, then Esc
    await openMenu(page, head)
    await page
      .locator('.menu .mi')
      .filter({ hasText: /^\s*New session/ })
      .click()
    await expectGate()
    await page.keyboard.press('Escape')
    await expect(pullAndStart(page)).toHaveCount(0)

    // Then ①: the Esc'd surface started nothing and pulled nothing
    await page.waitForTimeout(2000)
    await expect(page.locator('.ws-tab')).toHaveCount(0)
    await expect(behindBadge(page, 'ws-repo')).toHaveText('3')

    // When ②: the welcome panel's primary — gate, then ⏎
    await welcomeButton(page, 'New session').click()
    await expectGate()
    await page.keyboard.press('Enter')

    // Then ②: the pull happened and the session started on the fresh base
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

/** Every application-menu item, tagged with its top-level menu's label. */
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

/** Modifier order in an accelerator is a free choice; the keys it binds are not. */
function normalizeAccelerator(accel: string): string {
  return accel
    .toLowerCase()
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
    .sort()
    .join('+')
}

// BB-C26 — the two global gestures are also menu items, and the menu is where their
// keys are discoverable (D12: both carry the ellipsis, both pass through C10).
test('BB-C26: File menu carries both items with their shortcuts', async ({ env }) => {
  test.setTimeout(120_000)
  pinWorkspaces(env, [{ name: 'ws-alpha', kind: 'git' }])

  // Given: the app is running
  const { app } = await launchSettled(env)
  try {
    const file = (await menuEntries(app)).filter((e) => e.top === 'File')

    const newSession = file.find((e) => e.label === 'New Session…')
    expect(newSession).toBeDefined()
    expect(normalizeAccelerator(newSession!.accelerator)).toBe(normalizeAccelerator('CmdOrCtrl+N'))

    const newWorktree = file.find((e) => e.label === 'New Worktree Session…')
    expect(newWorktree).toBeDefined()
    expect(normalizeAccelerator(newWorktree!.accelerator)).toBe(
      normalizeAccelerator('Shift+CmdOrCtrl+N')
    )
  } finally {
    await app.close().catch(() => {})
  }
})

// The sidebar's newest launch surface: a workspace with NO sessions carries a clickable
// row where its session rows would be, and it opens whatever the head's hover button
// opens (BB-M10's split — a repo → C8, a plain folder → direct launch). It replaced a
// sentence telling the user to hover, which at the sidebar's 200px minimum was wider
// than the list itself, so the case pins BOTH halves: the door, and a narrowest sidebar
// with nothing to scroll sideways.
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
    // Given: the sidebar is as narrow as the grip allows and both groups are empty
    const repoDoor = emptyDoor(page, 'ws-alpha')
    const plainDoor = emptyDoor(page, 'ws-plain')
    await expect(repoDoor).toBeVisible()

    // Then: nothing in the list overflows sideways
    const overflow = await page
      .locator('.ws-list')
      .evaluate((el) => el.scrollWidth - el.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)

    // …and each row names the door its own head button carries
    await expect(repoDoor).toHaveText('New worktree…')
    await expect(plainDoor).toHaveText('New session')

    // When: the plain folder's row is clicked — a direct launch, no dialog, and the row
    // gives way to the session it started
    await plainDoor.click()
    await page.waitForTimeout(1500)
    await expectNoDialog(page)
    await waitForSessionRow(page, 'ws-plain', 'main')
    await expect(plainDoor).toHaveCount(0)

    // When: the repo's row is clicked — C8, for that workspace
    await repoDoor.click()
    await expect(page.getByText('New Worktree Session · ws-alpha')).toBeVisible({
      timeout: 15_000
    })
  } finally {
    await app.close().catch(() => {})
  }
})
