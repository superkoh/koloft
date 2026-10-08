import fs from 'fs'
import path from 'path'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import {
  addRemoteWorkspace,
  breakConnection,
  healConnection,
  killFakeRemote,
  launchWithRemote,
  machineHome,
  mirrorProjectDir,
  REMOTE_HOST,
  REMOTE_WS_NAME,
  remoteDir,
  remoteKey,
  remoteStatuslineOut,
  sshCalls,
  sshCommands,
  liveTmuxSessions
} from './helpers/remote'
import {
  auxIcon,
  boundSessionId,
  centerTerm,
  continuedInOf,
  encodeCwd,
  FAKE_SESSION_TITLE,
  gitCommitAll,
  gitInit,
  layoutOnDisk,
  menuItemTexts,
  openMenu,
  openSessionTerminal,
  panelTerm,
  runIn,
  sendShortcut,
  startSessionIn,
  transcriptFile,
  waitBooted,
  waitForCalls,
  wsRows
} from './helpers/p1'
import { WORKBENCH, browseRow, openInBrowse, showBrowse } from './helpers/workbench'

const LAYOUT_SAVE_DEBOUNCE_SETTLE_MS = 3000
const TURN_LONGER_THAN_ONE_MIRROR_PULL = '/busy'

test.afterEach(({ env }) => killFakeRemote(env))

test.describe('remote workspaces: a workspace on another machine over ssh, with no Koloft installed there', () => {
  test('E-RW-00: ⊞ ▸ Remote directory validates, then pins an ssh:// workspace', async ({
    env
  }) => {
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

      await where.fill('/home/koh/api')
      await dlg.locator('.btn-primary', { hasText: 'Add' }).click()
      await expect(dlg).toBeVisible()
      await expect(dlg.locator('.rws-err')).toBeVisible()

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

      const head = page.locator('.ws-head', { hasText: REMOTE_WS_NAME })
      await expect(head).toBeVisible({ timeout: 20_000 })
      await expect(head.locator('.ws-remote')).toHaveText(REMOTE_HOST)
      await expect(wsRows(page, REMOTE_WS_NAME)).toHaveCount(0)
    } finally {
      await quitAndClose(app)
    }
  })

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

      const cmds = sshCommands(env)
      expect(cmds.some((c) => c.includes('test -d "$HOME/.koloft/m-'))).toBe(true)
      expect(cmds.some((c) => c.includes('tar xf -'))).toBe(true)
      expect(cmds.some((c) => /tabs\/[^"]+\.sh"?\s+start/.test(c))).toBe(true)

      const [first] = await waitForCalls(env, 1)
      expect(first.cwd).toBe(remoteDir(env))
      await expect
        .poll(
          () =>
            fs.existsSync(mirrorProjectDir(env))
              ? fs.readdirSync(mirrorProjectDir(env)).filter((f) => f.endsWith('.jsonl'))
              : [],
          { timeout: 60_000 }
        )
        .toContain(`${first.sessionId}.jsonl`)

      await expect(
        page
          .locator('.ws', { has: page.locator('.ws-head', { hasText: REMOTE_WS_NAME }) })
          .locator('.ws-conn.on')
      ).toBeVisible({ timeout: 30_000 })

      await expect.poll(() => remoteStatuslineOut(env), { timeout: 60_000 }).toBeTruthy()

      await runIn(page, centerTerm(page), TURN_LONGER_THAN_ONE_MIRROR_PULL)
      await expect(rows.first()).toHaveClass(/\bst-working\b/, { timeout: 60_000 })
      await expect(rows.first()).toHaveClass(/\bst-waiting\b/, { timeout: 90_000 })

      const localProjects = path.join(env.home, '.claude', 'projects')
      expect(fs.existsSync(path.join(localProjects, encodeCwd(remoteDir(env))))).toBe(false)
      const localJsonl = fs.existsSync(localProjects)
        ? fs
            .readdirSync(localProjects, { recursive: true, encoding: 'utf8' })
            .filter((f) => f.endsWith('.jsonl'))
        : []
      expect(localJsonl.some((f) => f.includes(first.sessionId))).toBe(false)

      await startSessionIn(page, REMOTE_WS_NAME, { remote: true })
      await expect(page.locator('.modal')).toHaveCount(0)
      await expect(rows).toHaveCount(2)
      await expect.poll(() => liveTmuxSessions(env).length, { timeout: 30_000 }).toBe(2)
    } finally {
      await quitAndClose(app)
    }
  })

  test('E-RW-02: a remote session has a Workbench on the machine — Files lists its folder, Changes shows its edits, and a terminal opens there that refuses an interactive claude', async ({
    env
  }) => {
    test.setTimeout(300_000)
    const { app, page } = await launchWithRemote(env)
    try {
      const dir = remoteDir(env)
      fs.writeFileSync(path.join(dir, '.gitignore'), 'NOTES.md\n')
      fs.writeFileSync(path.join(dir, 'tracked.txt'), 'one\n')
      gitInit(dir)
      gitCommitAll(dir)
      fs.writeFileSync(path.join(dir, 'tracked.txt'), 'one\ntwo\n')

      await addRemoteWorkspace(page, env)
      await startSessionIn(page, REMOTE_WS_NAME, { remote: true })
      await wsRows(page, REMOTE_WS_NAME).first().click()
      await expect(auxIcon(page, 'Workbench')).toHaveCount(1)

      await showBrowse(page)
      await expect(browseRow(page, `${remoteKey(env)}/tracked.txt`)).toBeVisible({
        timeout: 30_000
      })

      await page
        .locator(`${WORKBENCH.kindBar} .seg[aria-label="Files view"] button`)
        .filter({ hasText: 'Changes' })
        .click()
      await expect(page.locator('.wb-panel .cv-row[data-path="tracked.txt"]')).toBeVisible({
        timeout: 30_000
      })

      await openSessionTerminal(app, page)
      await expect
        .poll(
          () =>
            sshCalls(env).some(
              (c) => c.argv.includes('-t') && (c.argv[c.argv.length - 1] ?? '').includes('util.sh')
            ),
          { timeout: 60_000 }
        )
        .toBe(true)
      await runIn(
        page,
        panelTerm(page),
        `[ "$HOME" = '${machineHome(env)}' ] && [ "$PWD" = '${dir}' ] && [ "$KOLOFT_UTIL" = 1 ] && echo RW02_ON_$((6 * 7))`
      )
      await expect(panelTerm(page)).toContainText('RW02_ON_42', { timeout: 60_000 })
      await runIn(page, panelTerm(page), 'claude')
      await expect(panelTerm(page)).toContainText('not an agent surface', { timeout: 25_000 })
    } finally {
      await quitAndClose(app)
    }
  })

  test('E-RW-24: an ssh drop keeps the remote Changes list and offers Retry, never "This directory no longer exists."', async ({
    env
  }) => {
    test.setTimeout(300_000)
    const { app, page } = await launchWithRemote(env)
    try {
      const dir = remoteDir(env)
      fs.writeFileSync(path.join(dir, '.gitignore'), 'NOTES.md\n')
      fs.writeFileSync(path.join(dir, 'tracked.txt'), 'one\n')
      gitInit(dir)
      gitCommitAll(dir)
      fs.writeFileSync(path.join(dir, 'tracked.txt'), 'one\ntwo\n')

      await addRemoteWorkspace(page, env)
      await startSessionIn(page, REMOTE_WS_NAME, { remote: true })
      await wsRows(page, REMOTE_WS_NAME).first().click()
      await expect(auxIcon(page, 'Workbench')).toHaveCount(1)
      await showBrowse(page)
      await page
        .locator(`${WORKBENCH.kindBar} .seg[aria-label="Files view"] button`)
        .filter({ hasText: 'Changes' })
        .click()
      const row = page.locator('.wb-panel .cv-row[data-path="tracked.txt"]')
      await expect(row).toBeVisible({ timeout: 30_000 })

      breakConnection(env)
      await page.locator('.wb-bar .icobtn[aria-label="Reload"]').click()

      const banner = page.locator('.wb-panel .cv-banner-err')
      await expect(banner).toBeVisible({ timeout: 30_000 })
      await expect(row).toBeVisible()
      await expect(page.getByText('This directory no longer exists.')).toHaveCount(0)

      healConnection(env)
      await banner.getByRole('button', { name: /retry/i }).click()
      await expect(banner).toHaveCount(0, { timeout: 30_000 })
      await expect(row).toBeVisible()
    } finally {
      await quitAndClose(app)
    }
  })

  test('E-RW-23: remote Changes keeps an expanded diff open while the session works, and only Reload folds it back', async ({
    env
  }) => {
    test.setTimeout(300_000)
    const { app, page } = await launchWithRemote(env)
    try {
      const dir = remoteDir(env)
      fs.writeFileSync(path.join(dir, 'tracked.txt'), 'one\n')
      gitInit(dir)
      gitCommitAll(dir)
      fs.writeFileSync(path.join(dir, 'tracked.txt'), 'one\ntwo\n')

      await addRemoteWorkspace(page, env)
      await startSessionIn(page, REMOTE_WS_NAME, { remote: true })
      await wsRows(page, REMOTE_WS_NAME).first().click()
      await expect(auxIcon(page, 'Workbench')).toHaveCount(1)
      await showBrowse(page)
      await page
        .locator(`${WORKBENCH.kindBar} .seg[aria-label="Files view"] button`)
        .filter({ hasText: 'Changes' })
        .click()

      const expand = page.locator('.wb-panel .cv-blk[data-path="tracked.txt"] .cv-exp')
      await expect(expand).toBeVisible({ timeout: 30_000 })
      await expand.click()
      await expect(expand).toHaveAttribute('aria-pressed', 'true')

      fs.writeFileSync(path.join(dir, 'extra.txt'), 'new\n')
      await runIn(page, centerTerm(page), TURN_LONGER_THAN_ONE_MIRROR_PULL)
      await expect(page.locator('.wb-panel .cv-row[data-path="extra.txt"]')).toBeVisible({
        timeout: 90_000
      })
      await expect(expand).toHaveAttribute('aria-pressed', 'true')

      await page.locator('.wb-bar .icobtn[aria-label="Reload"]').click()
      await expect(expand).toHaveAttribute('aria-pressed', 'false', { timeout: 20_000 })
    } finally {
      await quitAndClose(app)
    }
  })

  test('E-RW-03: remote menus drop the local-only items, keep Scheduled jobs, and Copy path gives machine:/path', async ({
    env
  }) => {
    test.setTimeout(240_000)
    const { app, page } = await launchWithRemote(env)
    try {
      await addRemoteWorkspace(page, env)
      await startSessionIn(page, REMOTE_WS_NAME, { remote: true })

      await openMenu(page, page.locator('.ws-head', { hasText: REMOTE_WS_NAME }))
      const wsItems = await menuItemTexts(page)
      expect(wsItems.join(' | ')).toContain('Scheduled jobs')
      expect(wsItems.join(' | ')).not.toContain('Fetch origin')
      expect(wsItems.join(' | ')).not.toContain('New worktree session')
      expect(wsItems.some((t) => t.startsWith('New session'))).toBe(true)
      expect(wsItems.some((t) => t.startsWith('Restore session'))).toBe(true)
      await page.keyboard.press('Escape')

      await expect(
        page
          .locator('.ws', { has: page.locator('.ws-head', { hasText: REMOTE_WS_NAME }) })
          .locator('[aria-label="Scheduled jobs"]')
      ).toHaveCount(0)

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

      const copied = await page.evaluate(
        () => (window as unknown as { __copied?: string }).__copied
      )
      expect(copied).toBe(`${REMOTE_HOST}:${remoteDir(env)}`)
    } finally {
      await quitAndClose(app)
    }
  })

  // CC§2
  test('E-RW-18: a workspace pinned through a symlink lights up from the mirror under the path the machine resolved', async ({
    env
  }) => {
    test.setTimeout(300_000)
    const real = remoteDir(env)
    const link = path.join(path.dirname(real), 'proj-link')
    const linkKey = `ssh://${REMOTE_HOST}${link}`

    const { app, page } = await launchWithRemote(env)
    try {
      fs.symlinkSync(real, link)
      expect(await page.evaluate((p) => window.api.workspace.add(p), linkKey)).toEqual({
        code: 'added',
        path: linkKey
      })
      await startSessionIn(page, 'proj-link', { remote: true })

      const rows = wsRows(page, 'proj-link')
      await expect(rows).toHaveCount(1)
      await expect(rows.first()).toContainText(FAKE_SESSION_TITLE, { timeout: 60_000 })

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
      await page.waitForTimeout(LAYOUT_SAVE_DEBOUNCE_SETTLE_MS)
    } finally {
      await quitAndClose(app)
    }

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

  test('E-RW-22: in a remote markdown file, a relative link and a path:line both open the file on the machine', async ({
    env
  }) => {
    test.setTimeout(300_000)
    const { app, page } = await launchWithRemote(env)
    try {
      const dir = remoteDir(env)
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
      fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 1\n')
      fs.writeFileSync(path.join(dir, 'src', 'b.ts'), 'export const b = 2\n')
      fs.writeFileSync(
        path.join(dir, 'doc.md'),
        '# Doc\n\n[open a](src/a.ts)\n\nSee src/b.ts:1 here.\n'
      )

      await addRemoteWorkspace(page, env)
      await startSessionIn(page, REMOTE_WS_NAME, { remote: true })
      await wsRows(page, REMOTE_WS_NAME).first().click()

      const doc = `${remoteKey(env)}/doc.md`
      const title = page.locator(WORKBENCH.readingTitle)
      const body = page.locator(`${WORKBENCH.readingBody} .md-body`)

      await openInBrowse(page, doc)
      await body.locator('a', { hasText: 'open a' }).click({ timeout: 30_000 })
      await expect(title).toContainText('a.ts', { timeout: 30_000 })

      await showBrowse(page)
      await browseRow(page, doc).click()
      await body.locator('a.md-fileref', { hasText: 'src/b.ts:1' }).click({ timeout: 30_000 })
      await expect(title).toContainText('b.ts', { timeout: 30_000 })
    } finally {
      await quitAndClose(app)
    }
  })

  test('E-RW-25: a page on the machine opens as source in the reading area, from a Browse row and from a markdown link', async ({
    env
  }) => {
    test.setTimeout(300_000)
    const { app, page } = await launchWithRemote(env)
    try {
      const dir = remoteDir(env)
      fs.writeFileSync(path.join(dir, 'page.html'), '<h1>on the machine</h1>\n')
      fs.writeFileSync(path.join(dir, 'doc.md'), '# Doc\n\n[the page](page.html)\n')

      await addRemoteWorkspace(page, env)
      await startSessionIn(page, REMOTE_WS_NAME, { remote: true })
      await wsRows(page, REMOTE_WS_NAME).first().click()

      const title = page.locator(WORKBENCH.readingTitle)
      const source = page.locator(`${WORKBENCH.readingBody} .code-body`)

      await openInBrowse(page, `${remoteKey(env)}/page.html`)
      await expect(title).toContainText('page.html', { timeout: 30_000 })
      await expect(source).toContainText('on the machine', { timeout: 30_000 })

      await showBrowse(page)
      await browseRow(page, `${remoteKey(env)}/doc.md`).click()
      await expect(title).toContainText('doc.md', { timeout: 30_000 })
      await page
        .locator(`${WORKBENCH.readingBody} .md-body a`, { hasText: 'the page' })
        .click({ timeout: 30_000 })
      await expect(title).toContainText('page.html', { timeout: 30_000 })
      await expect(source).toContainText('on the machine', { timeout: 30_000 })
    } finally {
      await quitAndClose(app)
    }
  })

  // CC§5
  test('E-RW-28: a remote turn that ends while its reported background work still runs shows green with ↻ until the work drains', async ({
    env
  }) => {
    test.setTimeout(300_000)
    const { app, page } = await launchWithRemote(env)
    try {
      expect(await addRemoteWorkspace(page, env)).toEqual({ code: 'added', path: remoteKey(env) })
      await startSessionIn(page, REMOTE_WS_NAME, { remote: true })
      const row = wsRows(page, REMOTE_WS_NAME).first()
      await expect(row).toHaveClass(/\bst-waiting\b/, { timeout: 90_000 })
      fs.writeFileSync(path.join(machineHome(env), 'fake-claude-bg-ms'), '20000')
      await runIn(page, centerTerm(page), '/bg-reported')
      const running = row.locator('.ws-tab-parked.bg-run', { hasText: /^↻ 1$/ })
      await expect(running).toBeVisible({ timeout: 60_000 })
      await expect(row).toHaveClass(/\bst-waiting\b/)
      await expect(running).toHaveCount(0, { timeout: 90_000 })
      await expect(row).toHaveClass(/\bst-waiting\b/)
    } finally {
      await quitAndClose(app)
    }
  })

  test('E-RW-27: when Claude Code moves a remote conversation to a new session id (a phantom start, then continued-in), the tab follows it: one live row, bound to the new id, and ⌘W still ends its tmux session on the machine', async ({
    env
  }) => {
    test.setTimeout(300_000)
    const { app, page } = await launchWithRemote(env)
    try {
      await addRemoteWorkspace(page, env)
      await startSessionIn(page, REMOTE_WS_NAME, { remote: true })
      const rows = wsRows(page, REMOTE_WS_NAME)
      const tabId = await rows.first().getAttribute('data-tab-id')
      const boundOf = (): Promise<string | undefined> => boundSessionId(page, tabId)
      await expect.poll(boundOf, { timeout: 60_000 }).toBeTruthy()
      const before = await boundOf()
      const beforeTranscript = transcriptFile(machineHome(env), remoteDir(env), before ?? '')

      await runIn(page, centerTerm(page), '/move-to-background')
      const continuedIn = (): string | undefined => continuedInOf(beforeTranscript)
      await expect.poll(continuedIn, { timeout: 30_000 }).toBeTruthy()
      await expect.poll(boundOf, { timeout: 60_000 }).toBe(continuedIn())
      await expect
        .poll(() => layoutOnDisk(env).members, { timeout: 30_000 })
        .toEqual([continuedIn()])
      await expect(rows).toHaveCount(1)
      await expect(rows.first()).not.toHaveClass(/\bcold\b/)

      await expect.poll(() => liveTmuxSessions(env), { timeout: 30_000 }).toHaveLength(1)
      await expect(rows.first()).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })
      await rows.first().click()
      await sendShortcut(app, 'shortcut:close-tab')
      await expect.poll(() => liveTmuxSessions(env), { timeout: 30_000 }).toEqual([])
    } finally {
      await quitAndClose(app)
    }
  })
})
