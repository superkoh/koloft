import fs from 'fs'
import path from 'path'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import {
  addRemoteWorkspace,
  killFakeRemote,
  launchWithRemote,
  mirrorProjectDir,
  REMOTE_HOST,
  REMOTE_WS_NAME,
  remoteDir,
  remoteKey,
  remoteStatuslineOut,
  sshCommands,
  liveTmuxSessions
} from './helpers/remote'
import {
  auxIcon,
  centerTerm,
  clickAppMenuItem,
  encodeCwd,
  FAKE_SESSION_TITLE,
  layoutOnDisk,
  menuItemTexts,
  openMenu,
  runIn,
  sendShortcut,
  startSessionIn,
  waitBooted,
  waitForCalls,
  wsRows
} from './helpers/p1'

/**
 * Remote workspaces: a workspace that lives on another machine, reached over ssh,
 * with no Koloft installed there. Cases E-RW-00..03 of the former case file
 * §3.2 (retired when the
 * feature shipped) — adding one, starting a session in it, and the two things a remote
 * session deliberately does NOT have: a Workbench, and the local-only menu items.
 *
 * The other machine is helpers/remote.ts + fixtures/fake-ssh.js. Nothing in the product
 * is stubbed: the app spawns real `ssh`/`rsync` by name, types its real launch line into
 * a real pty, and a real fake-claude runs "over there" under the machine's own home.
 */

test.afterEach(({ env }) => killFakeRemote(env))

// E-RW-00 — the entrance. ⊞ grew a two-item menu; the remote half raises a dialog that
// refuses an empty machine and a relative path, and on success writes the `ssh://` key
// into the layout verbatim.
test('E-RW-00: ⊞ ▸ Remote directory validates, then pins an ssh:// workspace', async ({ env }) => {
  test.setTimeout(180_000)
  const { app, page } = await launchWithRemote(env)
  try {
    await page.locator('.tb-ico[aria-label="Add workspace"]').click()
    await expect(page.locator('.menu')).toBeVisible()
    expect((await menuItemTexts(page)).join(' ')).toContain('Local folder')
    await page.locator('.menu .mi', { hasText: 'Remote directory' }).click()

    const dlg = page.locator('.modal.remotews')
    await expect(dlg).toBeVisible({ timeout: 20_000 })
    const machine = dlg.locator('input[placeholder="user@host or an ssh config name"]')
    const where = dlg.locator('input[placeholder="/home/me/project"]')

    // an empty machine name gets nowhere, and says why
    await where.fill('/home/koh/api')
    await dlg.locator('.btn-primary', { hasText: 'Add' }).click()
    await expect(dlg).toBeVisible()
    await expect(dlg.locator('.rws-err')).toBeVisible()

    // …nor does a path that is not absolute on the machine
    await machine.fill(REMOTE_HOST)
    await where.fill('relative/path')
    await dlg.locator('.btn-primary', { hasText: 'Add' }).click()
    await expect(dlg).toBeVisible()
    await expect(dlg.locator('.rws-err')).toBeVisible()

    await where.fill(remoteDir(env))
    await dlg.locator('.btn-primary', { hasText: 'Add' }).click()
    await expect(dlg).toHaveCount(0, { timeout: 20_000 })

    const paths = (layoutOnDisk(env).workspaces as { path: string }[]).map((w) => w.path)
    expect(paths).toContain(remoteKey(env))

    // it lands in the sidebar named by its last segment, wearing the machine badge…
    const head = page.locator('.ws-head', { hasText: REMOTE_WS_NAME })
    await expect(head).toBeVisible({ timeout: 20_000 })
    await expect(head.locator('.ws-remote')).toHaveText(REMOTE_HOST)
    // …and holds no sessions yet
    await expect(wsRows(page, REMOTE_WS_NAME)).toHaveCount(0)
  } finally {
    await quitAndClose(app)
  }
})

// E-RW-01 — the main flow. One line typed into the tab's shell pushes the packages,
// enters tmux and starts claude on the machine; the mirror brings its transcript and its
// hook reports back, so the row titles and lights itself exactly as a local one does.
// Nothing of it may appear in the LOCAL Claude storage, and a second session in the same
// directory must not raise the "another session is working here" dialog.
test('E-RW-01: a remote session starts, lights up from the mirror, and touches nothing local', async ({
  env
}) => {
  test.setTimeout(300_000)
  const { app, page } = await launchWithRemote(env)
  try {
    expect(await addRemoteWorkspace(page, env)).toEqual({ code: 'added', path: remoteKey(env) })
    await startSessionIn(page, REMOTE_WS_NAME, { remote: true })

    const rows = wsRows(page, REMOTE_WS_NAME)
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText(FAKE_SESSION_TITLE)

    // the line really went through ssh, in the documented order
    const cmds = sshCommands(env)
    expect(cmds.some((c) => c.includes('test -d "$HOME/.koloft/m-'))).toBe(true)
    expect(cmds.some((c) => c.includes('tar xf -'))).toBe(true)
    expect(cmds.some((c) => /tabs\/[^"]+\.sh"?\s+start/.test(c))).toBe(true)

    const [first] = await waitForCalls(env, 1)
    // claude was launched ON the machine, in the machine's own directory
    expect(first.cwd).toBe(remoteDir(env))
    // …and its transcript came back through the mirror, not from local storage
    await expect
      .poll(
        () =>
          fs.existsSync(mirrorProjectDir(env))
            ? fs.readdirSync(mirrorProjectDir(env)).filter((f) => f.endsWith('.jsonl'))
            : [],
        { timeout: 60_000 }
      )
      .toContain(`${first.sessionId}.jsonl`)

    // the connection dot is lit: the heartbeat is answering
    await expect(
      page
        .locator('.ws', { has: page.locator('.ws-head', { hasText: REMOTE_WS_NAME }) })
        .locator('.ws-conn.on')
    ).toBeVisible({ timeout: 30_000 })

    // the statusline really rendered over there: run.sh, the node ensure.sh found, and
    // the pushed bundle all worked (the machine package is the only way any of it got
    // to the other side)
    await expect.poll(() => remoteStatuslineOut(env), { timeout: 60_000 }).toBeTruthy()

    // The run-state walk, driven only by hook files rsync brought back. `/busy` rather
    // than a short turn on purpose: a remote row's status arrives one mirror pull behind,
    // so a turn shorter than the pull interval has both its hooks land in the same batch
    // and the row goes straight to waiting, never showing the working half at all.
    await runIn(page, centerTerm(page), '/busy')
    await expect(rows.first()).toHaveClass(/\bst-working\b/, { timeout: 60_000 })
    await expect(rows.first()).toHaveClass(/\bst-waiting\b/, { timeout: 90_000 })

    // NOTHING of this session is in the local Claude storage
    const localProjects = path.join(env.home, '.claude', 'projects')
    expect(fs.existsSync(path.join(localProjects, encodeCwd(remoteDir(env))))).toBe(false)
    const localJsonl = fs.existsSync(localProjects)
      ? fs
          .readdirSync(localProjects, { recursive: true, encoding: 'utf8' })
          .filter((f) => f.endsWith('.jsonl'))
      : []
    expect(localJsonl.some((f) => f.includes(first.sessionId))).toBe(false)

    // a SECOND session in the same directory: no "another session is working here"
    await startSessionIn(page, REMOTE_WS_NAME, { remote: true })
    await expect(page.locator('.modal')).toHaveCount(0)
    await expect(rows).toHaveCount(2)
    await expect.poll(() => liveTmuxSessions(env).length, { timeout: 30_000 }).toBe(2)
  } finally {
    await quitAndClose(app)
  }
})

// E-RW-02 — a remote session has no Workbench, and every route to one is shut: the
// titlebar icon is not painted, the menu item is disabled, and the shortcut IPC does
// nothing at all.
test('E-RW-02: a remote session has no Workbench — no icon, dead shortcut, disabled menu item', async ({
  env
}) => {
  test.setTimeout(240_000)
  const { app, page } = await launchWithRemote(env)
  try {
    await addRemoteWorkspace(page, env)
    await startSessionIn(page, REMOTE_WS_NAME, { remote: true })
    await wsRows(page, REMOTE_WS_NAME).first().click()

    await expect(auxIcon(page, 'Workbench')).toHaveCount(0)

    await sendShortcut(app, 'shortcut:toggle-browser')
    await page.waitForTimeout(1500)
    await expect(page.locator('.wb-col')).toHaveCount(0)

    // The two View items that really are gated on a panel being possible (`toggle-browser`
    // is not one of them — it is always enabled and no-ops in the renderer, which is what
    // the shortcut half above already pins).
    // polled: the renderer REPORTS availability from an effect, so main's flags trail the
    // selection by a frame or two
    await expect
      .poll(
        () =>
          app.evaluate(({ Menu }) => ({
            focus: Menu.getApplicationMenu()?.getMenuItemById('toggle-focus-mode')?.enabled,
            terminal: Menu.getApplicationMenu()?.getMenuItemById('new-terminal-tab')?.enabled
          })),
        { timeout: 20_000 }
      )
      .toEqual({ focus: false, terminal: false })
    await clickAppMenuItem(app, page, 'toggle-browser')
    await page.waitForTimeout(1500)
    await expect(page.locator('.wb-col')).toHaveCount(0)
  } finally {
    await quitAndClose(app)
  }
})

// E-RW-03 — the menus. Everything that needs a local disk or a local git checkout is
// gone from a remote workspace's menu and a remote row's; Copy path hands over the
// `machine:/path` form someone can paste into their own terminal.
test('E-RW-03: remote menus drop the local-only items and Copy path gives machine:/path', async ({
  env
}) => {
  test.setTimeout(240_000)
  const { app, page } = await launchWithRemote(env)
  try {
    await addRemoteWorkspace(page, env)
    await startSessionIn(page, REMOTE_WS_NAME, { remote: true })

    await openMenu(page, page.locator('.ws-head', { hasText: REMOTE_WS_NAME }))
    const wsItems = await menuItemTexts(page)
    expect(wsItems.join(' | ')).not.toContain('Scheduled jobs')
    expect(wsItems.join(' | ')).not.toContain('Fetch origin')
    expect(wsItems.join(' | ')).not.toContain('New worktree session')
    expect(wsItems.some((t) => t.startsWith('New session'))).toBe(true)
    expect(wsItems.some((t) => t.startsWith('Restore session'))).toBe(true)
    await page.keyboard.press('Escape')

    // the two cron entrances outside the menu are gone as well
    await expect(
      page
        .locator('.ws', { has: page.locator('.ws-head', { hasText: REMOTE_WS_NAME }) })
        .locator('[aria-label="Scheduled jobs"]')
    ).toHaveCount(0)

    // the real clipboard here is the DEVELOPER's clipboard (workspace-notes N16 makes
    // the same call), so writeText is stubbed rather than read back
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

    await openMenu(page, wsRows(page, REMOTE_WS_NAME).first())
    const rowItems = await menuItemTexts(page)
    expect(rowItems.join(' | ')).not.toContain('Reveal in Finder')
    expect(rowItems.some((t) => t.startsWith('Copy path'))).toBe(true)
    await page.locator('.menu .mi', { hasText: 'Copy path' }).click()

    const copied = await page.evaluate(() => (window as unknown as { __copied?: string }).__copied)
    expect(copied).toBe(`${REMOTE_HOST}:${remoteDir(env)}`)
  } finally {
    await quitAndClose(app)
  }
})

// the folder on the machine is reached through a symlink. Claude Code slugs a
// transcript by the PHYSICAL directory (contract §2), so every path Koloft builds out of
// the typed key — the mirror's filter, the sidebar's bucket, the launch cwd — has to be
// the one the machine resolved, or the workspace stays empty forever.
test('E-RW-18: a workspace pinned through a symlink still lights up from the mirror', async ({
  env
}) => {
  test.setTimeout(300_000)
  const real = remoteDir(env)
  const link = path.join(path.dirname(real), 'proj-link')
  const linkKey = `ssh://${REMOTE_HOST}${link}`

  // the machine's directories are built by launchWithRemote, so the link goes up after it
  const { app, page } = await launchWithRemote(env)
  try {
    fs.symlinkSync(real, link)
    expect(await page.evaluate((p) => window.api.workspace.add(p), linkKey)).toEqual({
      code: 'added',
      path: linkKey
    })
    // started at once, before the first heartbeat could answer: the pending row has only
    // the typed path to go by and must survive the buckets moving to the resolved one
    await startSessionIn(page, 'proj-link', { remote: true })

    // the row titles itself, which only happens once the mirror brought the transcript
    const rows = wsRows(page, 'proj-link')
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText(FAKE_SESSION_TITLE, { timeout: 60_000 })

    // claude ran in the directory the machine resolved, and its transcript is mirrored
    // under that slug — the typed path's slug is never created on either side
    const [first] = await waitForCalls(env, 1)
    expect(first.cwd).toBe(real)
    const mirror = path.join(env.userData, 'remote', REMOTE_HOST, 'projects')
    await expect
      .poll(
        () =>
          fs.existsSync(path.join(mirror, encodeCwd(real)))
            ? fs.readdirSync(path.join(mirror, encodeCwd(real)))
            : [],
        { timeout: 60_000 }
      )
      .toContain(`${first.sessionId}.jsonl`)
    expect(fs.existsSync(path.join(mirror, encodeCwd(link)))).toBe(false)
    await page.waitForTimeout(3000) // let the debounced layout save land
  } finally {
    await quitAndClose(app)
  }

  // …and after a restart, when the row can only come from the mirror's buckets and no
  // live tab is left to carry it, the workspace still lists its session
  const app2 = await launchApp(env)
  try {
    const page2 = await app2.firstWindow()
    await page2.waitForLoadState('domcontentloaded')
    await waitBooted(page2)
    await expect(wsRows(page2, 'proj-link').first()).toContainText(FAKE_SESSION_TITLE, {
      timeout: 60_000
    })
  } finally {
    await quitAndClose(app2)
  }
})
