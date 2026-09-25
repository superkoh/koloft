import fs from 'fs'
import path from 'path'
import type { Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import {
  addRemoteWorkspace,
  killFakeRemote,
  launchWithRemote,
  REMOTE_WS_NAME,
  remoteKey,
  sshCommands
} from './helpers/remote'
import { seedSettings } from './helpers/env'
import {
  clickAppMenuItem,
  encodeCwd,
  focusOwner,
  notesArea,
  notesIsland,
  notesOnDisk,
  notesPath,
  openMenu,
  processAlive,
  sendShortcut,
  settingsOnDisk,
  snap,
  startSessionIn,
  waitBooted,
  waitForCalls,
  wsRows
} from './helpers/p1'
import { layoutState } from './helpers/workbench'

const head = (page: Page, wsName: string) => page.locator('.ws-head', { hasText: wsName })

function notesBorder(page: Page): Promise<{ border: string; accent: string }> {
  return page.evaluate(() => {
    const flat = (c: string): string => c.replace(/\s+/g, '')
    const el = document.querySelector('.island.isl-notes') as HTMLElement | null
    const probe = document.createElement('div')
    probe.style.borderTopColor = 'var(--accent-line)'
    probe.style.display = 'none'
    document.body.appendChild(probe)
    const accent = flat(getComputedStyle(probe).borderTopColor)
    probe.remove()
    return { border: el ? flat(getComputedStyle(el).borderTopColor) : '', accent }
  })
}

async function focusNotes(page: Page, app: Parameters<typeof sendShortcut>[0]): Promise<void> {
  await sendShortcut(app, 'shortcut:focus-notes')
  await expect(notesArea(page)).toBeFocused()
}

const SESSION_LIST_MIN_HEIGHT_PX = 160
const DOCK_GUTTER_PX = 10
const SHORTER_THAN_AUTOSAVE_DEBOUNCE_MS = 400

test.describe('Workspace note: an island under the sessions list, always holding the current workspace’s note and saving itself as it is typed', () => {
  test('N01: the note island sits under the sessions island and names the current workspace', async ({
    page
  }) => {
    test.setTimeout(120_000)
    await waitBooted(page)

    await expect(notesIsland(page)).toBeVisible({ timeout: 20_000 })
    await expect(notesIsland(page).locator('.wb-title')).toHaveText('Notes · ws-a')

    const order = await page.evaluate(() =>
      [...(document.querySelector('.dock-left')?.children ?? [])].map((el) => el.className)
    )
    expect(order).toEqual(['island flat isl-sessions', 'gutter-h', 'island isl-notes'])
    await snap(page, 'N01')
  })

  test('N02: picking a session in another workspace moves the note to that workspace', async ({
    page
  }) => {
    test.setTimeout(300_000)
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    await expect(notesIsland(page).locator('.wb-title')).toHaveText('Notes · ws-a')

    await startSessionIn(page, 'ws-b')
    await expect(notesIsland(page).locator('.wb-title')).toHaveText('Notes · ws-b')

    await wsRows(page, 'ws-a').first().click()
    await expect(notesIsland(page).locator('.wb-title')).toHaveText('Notes · ws-a')
    await snap(page, 'N02')
  })

  test('N04: ⌥⌘N puts the caret in the note and lights the island, and again takes it out', async ({
    app,
    page
  }) => {
    test.setTimeout(120_000)
    await waitBooted(page)
    await expect(notesIsland(page)).toBeVisible({ timeout: 20_000 })

    const dark = await notesBorder(page)
    expect(dark.border).not.toBe(dark.accent)

    await focusNotes(page, app)
    const lit = await notesBorder(page)
    expect(lit.border).toBe(lit.accent)

    await sendShortcut(app, 'shortcut:focus-notes')
    await expect(notesArea(page)).not.toBeFocused()
    await snap(page, 'N04')
  })

  test('N05: Esc hands the caret back to the centre without folding the island', async ({
    app,
    page
  }) => {
    test.setTimeout(120_000)
    await waitBooted(page)
    await expect(notesIsland(page)).toBeVisible({ timeout: 20_000 })
    await focusNotes(page, app)

    await page.keyboard.press('Escape')
    await expect(notesArea(page)).not.toBeFocused()
    expect(await focusOwner(page)).toBe('welcome')
    await expect(notesArea(page)).toBeVisible()
    await snap(page, 'N05')
  })

  test('N06: typing in the note reaches the file on disk by itself', async ({ app, page, env }) => {
    test.setTimeout(120_000)
    await waitBooted(page)
    await expect(notesIsland(page)).toBeVisible({ timeout: 20_000 })
    await focusNotes(page, app)

    const sawSaving = page.waitForFunction(
      () => !!document.querySelector('.isl-notes .ed-saving'),
      null,
      { polling: 'raf', timeout: 20_000 }
    )
    await page.keyboard.type('hello koloft')
    await sawSaving
    await expect
      .poll(() => notesOnDisk(env, env.workspaces.a), { timeout: 5_000 })
      .toBe('hello koloft')
    await expect(notesIsland(page).locator('.ed-saved')).toContainText('Saved')
    await expect(notesIsland(page).locator('.ed-saving')).toHaveCount(0)
    await snap(page, 'N06')
  })

  test('N21: Tab in the note writes two spaces, which reach the file, and the caret stays put', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(120_000)
    await waitBooted(page)
    await expect(notesIsland(page)).toBeVisible({ timeout: 20_000 })
    await focusNotes(page, app)

    await page.keyboard.press('Tab')

    await expect.poll(() => notesOnDisk(env, env.workspaces.a), { timeout: 5_000 }).toBe('  ')
    await expect(notesArea(page)).toBeFocused()
    await expect(notesArea(page)).toHaveValue('  ')
    await snap(page, 'N21')
  })

  test('N19: removing a workspace keeps its note file', async ({ app, page, env }) => {
    test.setTimeout(180_000)
    await waitBooted(page)
    await expect(notesIsland(page)).toBeVisible({ timeout: 20_000 })

    await head(page, 'ws-b').locator('.ws-name').click()
    await expect(notesIsland(page).locator('.wb-title')).toHaveText('Notes · ws-b')
    await focusNotes(page, app)
    await page.keyboard.type('keep me')
    await expect.poll(() => notesOnDisk(env, env.workspaces.b), { timeout: 5_000 }).toBe('keep me')

    await openMenu(page, head(page, 'ws-b'))
    await page.locator('.menu .mi.danger', { hasText: 'Remove workspace' }).click()

    await expect(head(page, 'ws-b')).toHaveCount(0, { timeout: 20_000 })
    await expect(notesIsland(page).locator('.wb-title')).toHaveText('Notes · ws-a')
    expect(notesOnDisk(env, env.workspaces.b)).toBe('keep me')
    await snap(page, 'N19')
  })

  test('N07: closing the app right after typing — before the autosave has landed — writes the note instead of asking about it', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(120_000)
    await waitBooted(page)
    await expect(notesIsland(page)).toBeVisible({ timeout: 20_000 })
    await focusNotes(page, app)

    await page.keyboard.type('quit fast')
    expect(
      notesOnDisk(env, env.workspaces.a),
      'the autosave landed before the quit, so this run proves nothing'
    ).not.toBe('quit fast')

    const exited = app.waitForEvent('close', { timeout: 60_000 })
    await app.evaluate(({ app: electronApp }) => electronApp.quit())
    await exited

    expect(notesOnDisk(env, env.workspaces.a)).toBe('quit fast')
  })

  test('N09: each workspace keeps its own note, and switching back brings it straight back', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    await waitBooted(page)
    await expect(notesIsland(page)).toBeVisible({ timeout: 20_000 })

    await focusNotes(page, app)
    await page.keyboard.type('alpha')

    await head(page, 'ws-b').locator('.ws-name').click()
    await expect(notesIsland(page).locator('.wb-title')).toHaveText('Notes · ws-b')
    await expect(notesArea(page)).toHaveValue('')
    await focusNotes(page, app)
    await page.keyboard.type('beta')

    await expect.poll(() => notesOnDisk(env, env.workspaces.a), { timeout: 5_000 }).toBe('alpha')
    await expect.poll(() => notesOnDisk(env, env.workspaces.b), { timeout: 5_000 }).toBe('beta')

    await head(page, 'ws-a').locator('.ws-name').click()
    await expect(notesIsland(page).locator('.wb-title')).toHaveText('Notes · ws-a')
    await expect(notesArea(page)).toHaveValue('alpha')
    await snap(page, 'N09')
  })

  test('N10: the fold button leaves only the head band, and the choice is written down', async ({
    page,
    env
  }) => {
    test.setTimeout(120_000)
    await waitBooted(page)
    await expect(notesArea(page)).toBeVisible({ timeout: 20_000 })

    await notesArea(page).click()
    await notesIsland(page).locator('.icobtn[aria-label="Fold"]').click()
    await expect(notesArea(page)).toHaveCount(0)
    await expect(notesIsland(page).locator('.wb-bar')).toBeVisible()
    await expect(page.locator('.gutter-h.idle')).toHaveCount(1)
    expect(await notesIsland(page).evaluate((el) => el.matches(':focus-within'))).toBe(false)
    expect(await focusOwner(page)).toBe('welcome')
    await expect.poll(() => settingsOnDisk(env).notesFolded, { timeout: 5_000 }).toBe(true)

    await notesIsland(page).locator('.icobtn[aria-label="Unfold"]').click()
    await expect(page.locator('.gutter-h.idle')).toHaveCount(0)
    await expect(notesArea(page)).toBeVisible()
    await expect.poll(() => settingsOnDisk(env).notesFolded, { timeout: 5_000 }).toBe(false)
    await snap(page, 'N10')
  })

  test('N16: Copy path copies the note file’s path', async ({ page, env }) => {
    test.setTimeout(120_000)
    await waitBooted(page)
    await expect(notesIsland(page)).toBeVisible({ timeout: 20_000 })

    await page.evaluate(() => {
      const g = window as unknown as { __copied?: string }
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: (t: string) => {
            g.__copied = t
            return Promise.resolve()
          }
        }
      })
    })
    await notesIsland(page).locator('.icobtn[aria-label="Copy path"]').click()

    const copied = await page.evaluate(() => (window as unknown as { __copied?: string }).__copied)
    expect(copied).toBe(path.join(env.userData, 'notes', encodeCwd(env.workspaces.a), 'notes.md'))
    await expect(page.locator('.toast-msg')).toHaveText('Copied path')
    await snap(page, 'N16')
  })

  test('N18: with nothing pinned there is no note island at all', async ({ env }) => {
    test.setTimeout(120_000)
    fs.writeFileSync(
      path.join(env.userData, 'layout.json'),
      JSON.stringify({ version: 4, workspaces: [], workbench: { defaultOpen: true }, sessions: {} })
    )
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await expect(page.locator('.w-empty')).toBeVisible({ timeout: 20_000 })
      await expect(notesIsland(page)).toHaveCount(0)
      await expect(page.locator('.gutter-h')).toHaveCount(0)
      await snap(page, 'N18')
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('N22: a note height remembered from a bigger window never squeezes the session list away', async ({
    env
  }) => {
    test.setTimeout(120_000)
    seedSettings(env, { notesHeight: 5000 })

    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await expect(notesIsland(page)).toBeVisible({ timeout: 20_000 })

      const box = await page.evaluate(() => {
        const h = (sel: string): number =>
          document.querySelector(sel)?.getBoundingClientRect().height ?? 0
        return {
          dock: h('.dock-left'),
          sessions: h('.island.isl-sessions'),
          notes: h('.island.isl-notes')
        }
      })
      expect(box.sessions).toBeGreaterThanOrEqual(SESSION_LIST_MIN_HEIGHT_PX)
      expect(box.notes).toBeLessThanOrEqual(
        box.dock - (SESSION_LIST_MIN_HEIGHT_PX + DOCK_GUTTER_PX)
      )
      expect(settingsOnDisk(env).notesHeight).toBe(5000)
      await snap(page, 'N22')
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('N23: ⌘S in the note writes the file at once, ahead of the autosave', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(120_000)
    await waitBooted(page)
    await expect(notesIsland(page)).toBeVisible({ timeout: 20_000 })
    await focusNotes(page, app)

    await page.keyboard.type('saved by key')
    await sendShortcut(app, 'shortcut:save')
    await expect
      .poll(() => notesOnDisk(env, env.workspaces.a), {
        timeout: SHORTER_THAN_AUTOSAVE_DEBOUNCE_MS,
        intervals: [20]
      })
      .toBe('saved by key')
    await expect(notesIsland(page).locator('.ed-saved')).toContainText('Saved')
    await snap(page, 'N23')
  })

  test('N24: unfolding the note shows what changed on disk while it was folded', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(120_000)
    await waitBooted(page)
    await expect(notesIsland(page)).toBeVisible({ timeout: 20_000 })
    await focusNotes(page, app)

    await page.keyboard.type('first')
    await expect.poll(() => notesOnDisk(env, env.workspaces.a), { timeout: 5_000 }).toBe('first')
    await expect(notesIsland(page).locator('.ed-saved')).toContainText('Saved')

    await notesIsland(page).locator('.icobtn[aria-label="Fold"]').click()
    await expect(notesArea(page)).toHaveCount(0)

    fs.writeFileSync(notesPath(env, env.workspaces.a), 'from outside')

    await notesIsland(page).locator('.icobtn[aria-label="Unfold"]').click()
    await expect(notesArea(page)).toHaveValue('from outside')
    await expect(notesIsland(page).locator('.ed-stale')).toHaveCount(0)
    await snap(page, 'N24')
  })

  test('N25: coming back from another workspace shows the note as the file now stands', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    await waitBooted(page)
    await expect(notesIsland(page)).toBeVisible({ timeout: 20_000 })
    await focusNotes(page, app)

    await page.keyboard.type('mine')
    await expect.poll(() => notesOnDisk(env, env.workspaces.a), { timeout: 5_000 }).toBe('mine')

    await head(page, 'ws-b').locator('.ws-name').click()
    await expect(notesIsland(page).locator('.wb-title')).toHaveText('Notes · ws-b')

    fs.writeFileSync(notesPath(env, env.workspaces.a), 'changed elsewhere')

    await head(page, 'ws-a').locator('.ws-name').click()
    await expect(notesIsland(page).locator('.wb-title')).toHaveText('Notes · ws-a')
    await expect(notesArea(page)).toHaveValue('changed elsewhere')
    await expect(notesIsland(page).locator('.ed-stale')).toHaveCount(0)
    await snap(page, 'N25')
  })

  test('N26: ⌘Z after a Tab takes the two spaces back', async ({ app, page }) => {
    test.setTimeout(120_000)
    await waitBooted(page)
    await expect(notesIsland(page)).toBeVisible({ timeout: 20_000 })
    await focusNotes(page, app)

    await page.keyboard.type('abc')
    await page.keyboard.press('Tab')
    await expect(notesArea(page)).toHaveValue('abc  ')

    await page.keyboard.press('Meta+z')
    await expect(notesArea(page)).not.toHaveValue(/ {2}$/)
    await snap(page, 'N26')
  })

  test('N27: ⌘W while typing in the note leaves the session alone', async ({ app, page, env }) => {
    test.setTimeout(240_000)
    await startSessionIn(page, 'ws-a')
    const [session] = await waitForCalls(env, 1)
    const row = wsRows(page, 'ws-a').first()
    await focusNotes(page, app)

    await sendShortcut(app, 'shortcut:close-tab')

    await page.keyboard.type('still here')
    await expect(notesArea(page)).toHaveValue('still here')
    await expect
      .poll(() => notesOnDisk(env, env.workspaces.a), { timeout: 5_000 })
      .toBe('still here')

    expect(processAlive(session.pid)).toBe(true)
    await expect(page.locator('.modal-backdrop')).toHaveCount(0)
    await expect(row).not.toHaveClass(/\bcold\b/)
    await snap(page, 'N27')
  })

  test('N28: Esc in the note comes out of full-width Workbench and lands on the session', async ({
    app,
    page
  }) => {
    test.setTimeout(240_000)
    await startSessionIn(page, 'ws-a')
    await expect.poll(() => layoutState(page), { timeout: 30_000 }).toBe('T2')

    await clickAppMenuItem(app, page, 'toggle-focus-mode')
    await expect.poll(() => layoutState(page), { timeout: 20_000 }).toBe('T3')
    // PLATFORM§5
    await expect.poll(() => focusOwner(page), { timeout: 20_000 }).toBe('panel')

    await focusNotes(page, app)
    await page.keyboard.press('Escape')

    await expect.poll(() => layoutState(page), { timeout: 20_000 }).toBe('T2')
    await expect(notesArea(page)).not.toBeFocused()
    await expect.poll(() => focusOwner(page), { timeout: 20_000 }).toBe('tui')
    await snap(page, 'N28')
  })

  test('N29: ⌥⌘N after clicking Fold unfolds the note and puts the caret in it', async ({
    app,
    page
  }) => {
    test.setTimeout(120_000)
    await waitBooted(page)
    await expect(notesIsland(page)).toBeVisible({ timeout: 20_000 })

    await notesIsland(page).locator('.icobtn[aria-label="Fold"]').click()
    await expect(notesArea(page)).toHaveCount(0)

    await sendShortcut(app, 'shortcut:focus-notes')

    await expect(notesArea(page)).toBeVisible({ timeout: 20_000 })
    await expect(notesArea(page)).toBeFocused()
    await snap(page, 'N29')
  })

  test('E-RW-10: a remote workspace’s note saves locally and sends nothing over ssh', async ({
    env
  }) => {
    test.setTimeout(240_000)
    const { app, page } = await launchWithRemote(env)
    try {
      await addRemoteWorkspace(page, env)
      await page.locator('.ws-head', { hasText: REMOTE_WS_NAME }).click()
      await expect(notesIsland(page)).toContainText(REMOTE_WS_NAME, { timeout: 20_000 })

      await focusNotes(page, app)
      await page.keyboard.type('build machine todo')

      await expect
        .poll(() => notesOnDisk(env, remoteKey(env)), { timeout: 20_000 })
        .toBe('build machine todo')
      expect(notesPath(env, remoteKey(env)).startsWith(env.userData)).toBe(true)

      for (const cmd of sshCommands(env)) {
        expect(cmd).not.toContain('notes')
        expect(cmd).not.toContain('build machine todo')
      }
    } finally {
      await quitAndClose(app)
      killFakeRemote(env)
    }
  })
})
