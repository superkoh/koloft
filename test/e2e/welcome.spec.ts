import fs from 'fs'
import path from 'path'
import { test, expect, launchApp, runInTerminal } from './helpers/app'
import { seedSettings } from './helpers/env'
import {
  gitInit,
  killSession,
  pickerDialog,
  seedJsonl,
  sendShortcut,
  snap,
  startSessionIn,
  waitForCalls,
  worktreeDialog,
  wsRows
} from './helpers/p1'

// S4, the center island with nothing running (retired agent-centric design S4,
// logic.md §4/O2). Two states, one rule: the panel is what the center IS when no
// session tab exists — onboarding with nothing pinned, a launchpad otherwise.

// T-LIFE-13 ① — nothing pinned: the panel says so, and the titlebar's Add-workspace
// icon stays lit because it is the only way forward. gave the never-run install its
// own four-step welcome (T-OB-01 owns that copy now), so this case is the OTHER way into
// the same slot: a user who has seen the welcome and has no workspace left.
test('T-LIFE-13: with nothing pinned the center is the onboarding panel', async ({ env }) => {
  test.setTimeout(120_000)
  seedSettings(env, { onboardingSeen: true })
  // an EMPTY current-version document, not a legacy one: this case is about the panel a
  // first run lands on, so anything the migration would do in between is noise it must
  // not depend on (bumped the shape to v3 / `workbench.defaultOpen`; v4 keeps it)
  fs.writeFileSync(
    path.join(env.userData, 'layout.json'),
    JSON.stringify({ version: 4, workspaces: [], workbench: { defaultOpen: true }, sessions: {} })
  )

  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const panel = page.locator('.w-empty')
    await expect(panel).toBeVisible({ timeout: 20_000 })
    await expect(panel.locator('.big')).toHaveText('No workspace yet')
    await expect(panel).toContainText('Pick a folder to manage sessions in.')
    await expect(panel.locator('.btn-primary')).toHaveText('Choose Folder…')
    await expect(panel.locator('.quiet.key')).toHaveText('⇧⌘O')
    // no workspace, no session shortcut to advertise
    await expect(panel.locator('.recent-list')).toHaveCount(0)
    await expect(page.locator('.tb-ico[aria-label="Add workspace"]')).toHaveClass(/\bon\b/)
    await snap(page, 'T-LIFE-13a')
  } finally {
    await app.close().catch(() => {})
  }
})

// T-LIFE-13 ② — with a workspace pinned the same slot is the launchpad for the
// workspace ⌘N would target (O2): its name, its ＋, and ITS recents only. Starting a
// session replaces the panel with that session's terminal.
test('T-LIFE-13: with a workspace pinned the panel launches that workspace, then yields to it', async ({
  env
}) => {
  test.setTimeout(180_000)
  gitInit(env.workspaces.a)
  seedJsonl(env, env.workspaces.a, { summary: 'Recent A session' })
  seedJsonl(env, env.workspaces.b, { summary: 'Other B session' })

  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const panel = page.locator('.w-empty')
    await expect(panel).toBeVisible({ timeout: 20_000 })
    await expect(panel.locator('.big')).toHaveText('ws-a')
    await expect(panel.locator('.quiet').first()).toHaveText('No running session')
    await expect(panel.locator('.btn-primary')).toHaveText('＋ New session')

    // Recent belongs to the panel's workspace alone — ws-b's cold session is listed
    // in the sidebar but never here
    await expect(panel.locator('.recent-hd')).toHaveText('Recent')
    const recent = panel.locator('.recent-list .recent-row')
    await expect(recent).toHaveCount(1)
    await expect(recent.locator('.ws-tab-title')).toHaveText('Recent A session')
    await expect(page.locator('.ws-tab', { hasText: 'Other B session' })).toHaveCount(1)
    await snap(page, 'T-LIFE-13b')

    // the panel's second creation action is C8, aimed at the panel's own workspace
    // (D7) — checked before ＋, which takes the panel off screen for good
    await panel.locator('button', { hasText: 'New worktree session' }).click()
    const c8 = worktreeDialog(page)
    await expect(c8).toBeVisible({ timeout: 15_000 })
    await expect(c8.locator('.modal-header')).toContainText('ws-a')
    await page.keyboard.press('Escape')
    await expect(c8).toHaveCount(0)

    // ＋ is the per-workspace direct launch (§03B): the click IS the session, no
    // dialog in between — ws-a has no remote, so nothing is behind and no gate stands
    await panel.locator('.btn-primary').click()

    // a session exists now, so the center is that session — the panel is not a view
    // the user can be left staring at
    await expect(page.locator('.w-empty')).toHaveCount(0, { timeout: 20_000 })
    await expect(page.locator('.modal')).toHaveCount(0)
    await expect(page.locator('.term-wrap:visible')).toBeVisible()
    const [call] = await waitForCalls(env, 1)
    expect(call.cwd).toBe(env.workspaces.a)
  } finally {
    await app.close().catch(() => {})
  }
})

// T-LIFE-17 — and the way back. §4 gives the centre to the panel "when no session is
// running", but the only thing that ever released a finished session's surface was the
// user moving to ANOTHER tab — which the last session, by definition, does not leave
// behind. Cold rows are no substitute: a row is a list entry, not a tab, so a workspace
// full of them still has nowhere to move to. What decides it is HOW the session ended:
// a clean /exit left nothing to read (unlike the crash T-LIFE-03 freezes), so its
// surface goes and the panel comes back — with the cold rows still listed beside it.
test('T-LIFE-17: the last session exiting hands the centre back to the panel', async ({ env }) => {
  test.setTimeout(180_000)
  gitInit(env.workspaces.a)
  seedJsonl(env, env.workspaces.a, { summary: 'Recent A session' })

  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await startSessionIn(page, 'ws-a')
    await waitForCalls(env, 1)
    await expect(page.locator('.w-empty')).toHaveCount(0)

    // the cold row seeded above is still in the sidebar the whole time: what the panel
    // waits on is a running session, not an empty list
    await expect(page.locator('.ws-tab', { hasText: 'Recent A session' })).toHaveCount(1)

    await runInTerminal(page, '/exit')

    const panel = page.locator('.w-empty')
    await expect(panel).toBeVisible({ timeout: 30_000 })
    await expect(panel.locator('.quiet').first()).toHaveText('No running session')
    // the finished session's terminal is gone, not merely hidden behind the panel
    await expect(page.locator('.term-wrap')).toHaveCount(0)
    await expect(page.locator('.ws-tab', { hasText: 'Recent A session' })).toHaveCount(1)
    await snap(page, 'T-LIFE-17')
  } finally {
    await app.close().catch(() => {})
  }
})

// T-LIFE-12 — the O2 targeting mechanism, whole. The panel is not "the first
// workspace"; it is the last one the user was IN, for this run only (nothing about the
// selection is persisted, A10). Five observables, one fixture: two pinned workspaces
// with A as the array head, and the user's session in B.
test('T-LIFE-12: with nothing selected the panel targets the workspace last worked in, until a restart', async ({
  env
}) => {
  test.setTimeout(300_000)
  gitInit(env.workspaces.b)
  // a cold session in A as well: "Recent lists B's alone" has to mean something
  seedJsonl(env, env.workspaces.a, { summary: 'Cold A session' })

  const app1 = await launchApp(env)
  const page1 = await app1.firstWindow()
  await page1.waitForLoadState('domcontentloaded')
  try {
    await expect(page1.locator('.ws-head')).toHaveCount(2, { timeout: 20_000 })
    // the head of workspaces[] is where a fresh run starts
    await expect(page1.locator('.w-empty .big')).toHaveText('ws-a')

    // work in B, then lose the session the way that KEEPS its row (the lifecycle contract D1:
    // a graceful /exit would remove it from the list, and Recent lists cold rows —
    // so the fixture needs a hard kill, not an exit). The tab closes with its pty
    // (T-LIFE-05), so nothing is selected and the welcome panel is back on its own.
    await startSessionIn(page1, 'ws-b')
    const rowB = wsRows(page1, 'ws-b').first()
    await rowB.click()
    const [sessionB] = await waitForCalls(env, 1)
    killSession(sessionB.pid, env)
    await expect(rowB).toHaveClass(/\bcold\b/, { timeout: 40_000 })
    const panel = page1.locator('.w-empty')
    await expect(panel).toBeVisible({ timeout: 20_000 })

    // ① the panel followed the user to B
    await expect(panel.locator('.big')).toHaveText('ws-b')
    // ② Recent is B's cold sessions only — A's never leaks in
    const recent = panel.locator('.recent-list .recent-row')
    await expect(recent).toHaveCount(1)
    await expect(recent.locator('.ws-tab-title')).toHaveText('Fake session: project notes')
    await expect(panel).not.toContainText('Cold A session')
    // ③ RETIRED — the behaviour is gone, not relocated. It asserted that the sidebar
    //   Files island's root followed the user to ws-b, and it did so from exactly this
    //   state: nothing selected. The tree retired into the Workbench's pinned `files` tab
    //   (FR-44), and that panel is session-attached (FR-04) — with no session there is no
    //   panel, hence no root row to name. FR-45 spells the same rule out for the one key
    //   that reaches the surface: ⌘⇧F is a "No-op without an active session". So "the file
    //   browser tracks the selected WORKSPACE while nothing is selected" is a capability
    //   a later design dropped, and there is no successor to point at.
    //
    //   Deleted because it is gone, NOT because it was inconvenient: re-aiming it would
    //   mean starting a session in ws-b, which destroys this case's own Given. ①, ② and ④
    //   are untouched and still carry T-LIFE-12.
    await snap(page1, 'T-LIFE-12')

    // ④ ⌘N with no selection aims at the same workspace — with several pinned the
    // aim is C10's preselection (§03A), and ⏎ is still the second of the two keys
    await sendShortcut(app1, 'shortcut:new-session')
    const dlg = pickerDialog(page1)
    await expect(dlg).toBeVisible({ timeout: 15_000 })
    await expect(dlg.locator('.modal-header')).toContainText('New Session in…')
    await expect(dlg.locator('[role="option"][aria-selected="true"] .wsp-name')).toHaveText('ws-b')
    await page1.keyboard.press('Enter')
    const calls = await waitForCalls(env, 2)
    expect(calls[1].cwd).toBe(env.workspaces.b)
    expect(calls[1].argv).not.toContain('-w')
  } finally {
    await app1.close().catch(() => {})
  }

  // ⑤ the memory is per run: a relaunch has no history, so the panel falls back to
  // the array head
  const app2 = await launchApp(env)
  try {
    const page2 = await app2.firstWindow()
    await page2.waitForLoadState('domcontentloaded')
    await expect(page2.locator('.w-empty .big')).toHaveText('ws-a', { timeout: 20_000 })
  } finally {
    await app2.close().catch(() => {})
  }
})
