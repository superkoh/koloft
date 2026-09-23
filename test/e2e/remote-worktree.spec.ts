import fs from 'fs'
import path from 'path'
import type { Page } from '@playwright/test'
import { test, expect, quitAndClose } from './helpers/app'
import {
  addRemoteWorkspace,
  installFakeRemote,
  killFakeRemote,
  launchWithRemote,
  liveTmuxSessions,
  REMOTE_WS_NAME,
  remoteDir
} from './helpers/remote'
import {
  FAKE_SESSION_TITLE,
  gitInit,
  gitWorktreeAdd,
  menuItemTexts,
  openMenu,
  openWorktreeSession,
  resumedId,
  sendShortcut,
  waitForCalls,
  wsRows
} from './helpers/p1'

/**
 * Worktree sessions in a remote workspace. The machine's own git answer travels
 * back in the heartbeat, so a remote folder that is a checkout over there grows the
 * "New worktree session…" item and the C8 dialog; creating runs `claude … -w <name>` on
 * the machine, and opening an existing one runs claude in that worktree's directory over
 * there. "Fetch origin" stays local-only.
 *
 * A non-git remote folder showing no such item is E-RW-03's assertion, not repeated here.
 *
 * The machine is helpers/remote.ts + fixtures/fake-ssh.js; its folder is a real local
 * directory, so a real `git init` there is what the remote git probe reads.
 */

test.afterEach(({ env }) => killFakeRemote(env))

/** The fly-out's items, closing the menu again so a poll can re-open it. */
async function wsMenuTexts(page: Page): Promise<string[]> {
  await openMenu(page, page.locator('.ws-head', { hasText: REMOTE_WS_NAME }))
  const items = await menuItemTexts(page)
  await page.keyboard.press('Escape')
  await expect(page.locator('.menu')).toHaveCount(0)
  return items
}

// E-RW-14 — the machine says the folder is a git checkout, so the remote workspace gets
// the worktree entrance (and still no Fetch origin), and "create" really runs `claude -w`
// over there.
test('E-RW-14: a remote git folder offers New worktree session, and creating one runs `-w` on the machine', async ({
  env
}) => {
  test.setTimeout(300_000)
  installFakeRemote(env)
  gitInit(remoteDir(env))
  const { app, page } = await launchWithRemote(env)
  try {
    await addRemoteWorkspace(page, env)

    // the item appears only once a heartbeat has brought the machine's git answer back
    await expect
      .poll(async () => (await wsMenuTexts(page)).join(' | '), { timeout: 60_000 })
      .toContain('New worktree session')
    expect((await wsMenuTexts(page)).join(' | ')).not.toContain('Fetch origin')

    const dlg = await openWorktreeSession(page, REMOTE_WS_NAME)
    await dlg.getByRole('textbox').click()
    await page.keyboard.type('featr')
    await page.keyboard.press('Enter')
    await expect(dlg).toHaveCount(0)

    const row = wsRows(page, REMOTE_WS_NAME).filter({ hasText: FAKE_SESSION_TITLE })
    await expect(row).toHaveCount(1, { timeout: 120_000 })
    await expect(row.locator('.ws-tab-sub')).toHaveText('featr')

    const [call] = await waitForCalls(env, 1, 60_000)
    expect(call.cwd).toBe(remoteDir(env)) // the launch cwd is the machine's folder
    expect(call.argv.join(' ')).toContain('-w featr')

    // the checkout really exists on the machine, and its claude is held by tmux there
    const wtDir = path.join(remoteDir(env), '.claude', 'worktrees', 'featr')
    expect(fs.statSync(wtDir).isDirectory()).toBe(true)
    await expect.poll(() => liveTmuxSessions(env).length, { timeout: 30_000 }).toBe(1)
  } finally {
    await quitAndClose(app)
  }
})

// E-RW-15 — a worktree that already exists on the machine is listed by C8, and choosing
// it is a plain cd into that directory over there: no `-w` at all.
test('E-RW-15: C8 lists the machine’s existing worktree and opens it with no -w', async ({
  env
}) => {
  test.setTimeout(300_000)
  installFakeRemote(env)
  gitInit(remoteDir(env))
  const wtDir = gitWorktreeAdd(remoteDir(env), 'oldwt')
  const { app, page } = await launchWithRemote(env)
  try {
    await addRemoteWorkspace(page, env)
    await expect
      .poll(async () => (await wsMenuTexts(page)).join(' | '), { timeout: 60_000 })
      .toContain('New worktree session')

    const dlg = await openWorktreeSession(page, REMOTE_WS_NAME)
    const listRow = dlg.locator('.cb-row', { has: page.locator('.wt-name', { hasText: 'oldwt' }) })
    await expect(listRow).toHaveCount(1, { timeout: 20_000 })
    await listRow.click()
    await expect(dlg).toHaveCount(0)

    const row = wsRows(page, REMOTE_WS_NAME).filter({ hasText: FAKE_SESSION_TITLE })
    await expect(row).toHaveCount(1, { timeout: 120_000 })

    const [call] = await waitForCalls(env, 1, 60_000)
    expect(fs.realpathSync(call.cwd)).toBe(fs.realpathSync(wtDir))
    expect(call.argv).not.toContain('-w')
  } finally {
    await quitAndClose(app)
  }
})

// E-RW-17 — resuming a remote session that lives in one of the machine's worktrees. The
// row remembers where its transcript says it ran, so the resume `cd`s into the worktree
// over there; before this it landed in the workspace root and the session came back on
// the wrong checkout.
test('E-RW-17: a cold worktree row resumes in the worktree directory on the machine', async ({
  env
}) => {
  test.setTimeout(300_000)
  installFakeRemote(env)
  gitInit(remoteDir(env))
  const wtDir = gitWorktreeAdd(remoteDir(env), 'oldwt')
  const { app, page } = await launchWithRemote(env)
  try {
    await addRemoteWorkspace(page, env)
    await expect
      .poll(async () => (await wsMenuTexts(page)).join(' | '), { timeout: 60_000 })
      .toContain('New worktree session')

    const dlg = await openWorktreeSession(page, REMOTE_WS_NAME)
    const listRow = dlg.locator('.cb-row', { has: page.locator('.wt-name', { hasText: 'oldwt' }) })
    await expect(listRow).toHaveCount(1, { timeout: 20_000 })
    await listRow.click()
    await expect(dlg).toHaveCount(0)

    const row = wsRows(page, REMOTE_WS_NAME).filter({ hasText: FAKE_SESSION_TITLE })
    await expect(row).toHaveCount(1, { timeout: 120_000 })
    const [first] = await waitForCalls(env, 1, 60_000)

    // close the tab — the session ends over there and the row turns cold
    await page.locator('.ws-tab.active').first().click()
    await sendShortcut(app, 'shortcut:close-tab')
    const confirm = page.locator('.modal', { hasText: 'Close running session?' })
    if (await confirm.isVisible({ timeout: 4000 }).catch(() => false)) {
      await confirm
        .locator('.btn-primary, button', { hasText: /^Close$/ })
        .first()
        .click()
    }
    await expect(row).toHaveClass(/\bcold\b/, { timeout: 90_000 })

    await row.click()

    const calls = await waitForCalls(env, 2, 90_000)
    const resume = calls[calls.length - 1]
    expect(resumedId(resume)).toBe(first.sessionId)
    expect(resume.argv).not.toContain('-w')
    expect(fs.realpathSync(resume.cwd)).toBe(fs.realpathSync(wtDir))
  } finally {
    await quitAndClose(app)
  }
})
