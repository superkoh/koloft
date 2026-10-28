import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import type { Locator, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import {
  E2E_MUSE_ACCOUNT,
  installCodex,
  installMuse,
  museCalls,
  seedSettings,
  trustInMuse,
  type E2EEnv,
  type MuseCall
} from './helpers/env'
import {
  agentRow,
  centerTerm,
  chooseBackend,
  gitCommitAll,
  gitInit,
  newSessionInWith,
  openMenu,
  openPicker,
  openWorktreeSession,
  processAlive,
  readCalls,
  restoreOffered,
  runIn,
  sendShortcut,
  staysOnTheFolderPageNotTheButler,
  waitBooted,
  wsRows
} from './helpers/p1'

test.setTimeout(120_000)

const SKIPS_PERMISSION_PROMPTS_AS_SHIPPED = ['--permission-profile', ':unrestricted']

function museRows(page: Page): Locator {
  return wsRows(page, 'ws-a').filter({
    hasNot: page.getByRole('img', { name: 'Claude', exact: true })
  })
}

async function startMuse(page: Page, env: E2EEnv): Promise<MuseCall> {
  const before = museCalls(env).length
  await newSessionInWith(page, 'ws-a', 'Muse')
  await expect.poll(() => museCalls(env).length).toBe(before + 1)
  await expect(museRows(page).and(page.locator('.active'))).toHaveClass(/st-waiting/)
  return museCalls(env)[before]
}

const ROWS_FOLLOW_A_LISTING_MS = 2_000
const SAMPLE_EVERY_MS = 100

async function textsAcrossAWindow(locator: Locator, ms: number): Promise<string[]> {
  const seen: string[] = []
  for (const end = Date.now() + ms; Date.now() < end;) {
    seen.push(await locator.innerText())
    await new Promise((resolve) => setTimeout(resolve, SAMPLE_EVERY_MS))
  }
  return seen
}

function museListings(env: E2EEnv): number {
  const file = path.join(env.home, 'fake-muse-listings.jsonl')
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0
}

test.describe('Muse Code sessions through the real method chooser, status signal, live registry and muse serve, with only the CLI faked', () => {
  test("a Muse session starts from the workspace menu, waits on Muse's trust question in its terminal, and its light follows its status from working to waiting, the finished turn leaving a red dot and the bell's count though its tab is on screen", async ({
    env
  }) => {
    installMuse(env)
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await newSessionInWith(page, 'ws-a', 'Muse')
      await expect(page.locator('.term-wrap:visible')).toContainText('Do you trust this workspace?')
      expect(museCalls(env)).toHaveLength(0)
      await runIn(page, centerTerm(page), '')
      await expect.poll(() => museCalls(env).length).toBe(1)
      const call = museCalls(env)[0]
      expect(call.argv).toEqual(SKIPS_PERMISSION_PROMPTS_AS_SHIPPED)
      expect(fs.existsSync(path.join(call.pathHead, 'open'))).toBe(true)
      expect(call.configHome).toBe(path.join(env.userData, 'muse-homes', E2E_MUSE_ACCOUNT))
      expect(call.credentials).toBe('file')
      const row = museRows(page)
      await expect(row).toHaveClass(/st-waiting/)
      fs.writeFileSync(path.join(env.home, 'fake-muse-delay'), '1500')
      await runIn(page, centerTerm(page), 'hello muse')
      await expect(row).toHaveClass(/st-working/)
      await expect(row).toHaveClass(/st-waiting/)
      await expect(row).toContainText('hello muse')
      await expect(row.locator('.ws-tab-unread')).toHaveCount(1)
      await expect(page.locator('.aux-ico.waiting-bell .ws-unread-count')).toHaveText('1')
    } finally {
      await quitAndClose(app)
    }
  })

  // MUSE§10
  test("answering 2 Quit to Muse's trust question before any session opened puts you back on the folder page, and never opens the butler", async ({
    env
  }) => {
    installMuse(env)
    seedSettings(env, { hintsOff: true, assist: { on: true, backend: 'claude' } })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await newSessionInWith(page, 'ws-a', 'Muse')
      await expect(page.locator('.term-wrap:visible')).toContainText('Do you trust this workspace?')
      await runIn(page, centerTerm(page), '2')
      await expect(museRows(page)).toHaveCount(0, { timeout: 30_000 })
      await staysOnTheFolderPageNotTheButler(page, env, 'ws-a')
      expect(museCalls(env)).toHaveLength(0)
    } finally {
      await quitAndClose(app)
    }
  })

  // MUSE§13
  test("a Muse account signed in with Meta shows its 5h and 7d quota in the usage panel, read from /usage in a muse that keeps no session log, so no session appears anywhere; a Muse tab then started on it prints that account and quota above Muse's screen, as a Claude tab does", async ({
    env
  }) => {
    installMuse(env)
    trustInMuse(env, env.workspaces.a)
    seedSettings(env, { hintsOff: true })
    fs.writeFileSync(
      path.join(env.userData, 'muse-homes', E2E_MUSE_ACCOUNT, 'muse', 'auth.json'),
      JSON.stringify({ schema_version: 1, providers: { meta: { access_token: 'fake' } } })
    )
    fs.writeFileSync(
      path.join(env.home, 'fake-muse-quota.json'),
      JSON.stringify({ current: 40, weekly: 7 })
    )
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await page.evaluate(() => window.api.accounts.probe())
      await page.locator('.tbu').click()
      const pop = page.locator('.tbu-pop')
      await expect(pop.locator('.tbu-pop-head', { hasText: /^Muse$/ })).toBeVisible()
      const row = pop.locator('.tbu-row', { hasText: E2E_MUSE_ACCOUNT })
      await expect(row.locator('.acct-meter[data-win="5h"] .m-pct')).toHaveText('40%')
      await expect(row.locator('.acct-meter[data-win="7d"] .m-pct')).toHaveText('7%')
      expect(museCalls(env)).toEqual([])
      expect(await page.evaluate(() => window.api.sessions.list())).toEqual([])
      await page.keyboard.press('Escape')
      await startMuse(page, env)
      await expect(page.locator('.term-wrap:visible .xterm')).toContainText(
        `koloft: → ${E2E_MUSE_ACCOUNT} · 5h 40% · 7d 7%`
      )
    } finally {
      await quitAndClose(app)
    }
  })

  // MUSE§13
  test('a muse login that fails closes its sign-in tab and brings Settings ▸ Accounts back with muse’s error under “Sign-in did not complete.” and no row for the new account', async ({
    env
  }) => {
    installMuse(env)
    seedSettings(env, { hintsOff: true })
    fs.writeFileSync(path.join(env.home, 'fake-muse-login-fails'), '')
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await sendShortcut(app, 'shortcut:open-settings')
      await page.getByRole('tab', { name: 'Accounts', exact: true }).click()
      await page.getByRole('button', { name: 'Sign in to Muse' }).click()
      await page.getByPlaceholder('Name this account (e.g. work)').fill('work')
      await page.locator('.acct-add').getByRole('button', { name: 'Sign in', exact: true }).click()

      const dialog = page.locator('.acct-add')
      await expect(dialog.locator('.acct-login-state.bad')).toContainText(
        'Sign-in did not complete.',
        { timeout: 20_000 }
      )
      await expect(dialog.locator('.acct-login-tail')).toHaveText(
        'Error: the device code expired before it was approved'
      )
      await expect(page.locator('.term-island > .wb-bar')).toHaveCount(0)
      await expect(page.locator('.acct-name', { hasText: /^work$/ })).toHaveCount(0)
      await expect(page.locator('.acct-name', { hasText: /^e2e-muse$/ })).toBeVisible()
    } finally {
      await quitAndClose(app)
    }
  })

  test('/clear keeps the tab and moves it to a new session; the cleared one leaves the list for Restore session, which resumes it with muse resume', async ({
    env
  }) => {
    installMuse(env)
    trustInMuse(env, env.workspaces.a)
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      const first = await startMuse(page, env)
      await runIn(page, centerTerm(page), 'first topic')
      await expect(museRows(page).filter({ hasText: 'first topic' })).toHaveClass(/st-waiting/)
      await runIn(page, centerTerm(page), '/clear')
      await expect.poll(() => museCalls(env).length).toBe(2)
      const second = museCalls(env)[1]
      expect(second.pid).toBe(first.pid)
      expect(second.sessionId).not.toBe(first.sessionId)
      await runIn(page, centerTerm(page), 'second topic')
      await expect(museRows(page).filter({ hasText: 'second topic' })).toHaveClass(/st-waiting/)
      await expect(museRows(page)).toHaveCount(1)
      await openMenu(page, page.locator('.ws-head', { hasText: 'ws-a' }))
      await page.locator('.menu .mi', { hasText: 'Restore session' }).click()
      const history = page.getByRole('dialog', { name: 'Restore session · ws-a', exact: true })
      await history.getByRole('button').filter({ hasText: 'first topic' }).click()
      await expect.poll(() => museCalls(env).length).toBe(3)
      expect(museCalls(env)[2].argv).toEqual([
        ...SKIPS_PERMISSION_PROMPTS_AS_SHIPPED,
        'resume',
        first.sessionId
      ])
      expect(museCalls(env)[2].sessionId).toBe(first.sessionId)
    } finally {
      await quitAndClose(app)
    }
  })

  for (const ends of ['quits', 'crashes'] as const)
    test(`a Muse tab still open when Koloft ${ends} comes back running the same session after a restart`, async ({
      env
    }) => {
      installMuse(env)
      trustInMuse(env, env.workspaces.a)
      seedSettings(env, { hintsOff: true })
      let app = await launchApp(env)
      try {
        let page = await app.firstWindow()
        await waitBooted(page)
        const first = await startMuse(page, env)
        if (ends === 'quits') await quitAndClose(app)
        else {
          process.kill(app.process().pid!, 'SIGKILL')
          await app.close().catch(() => {})
        }
        await expect.poll(() => processAlive(first.pid)).toBe(false)

        app = await launchApp(env)
        page = await app.firstWindow()
        await waitBooted(page)
        await expect.poll(() => museCalls(env).length, { timeout: 30_000 }).toBe(2)
        expect(museCalls(env)[1].argv).toEqual([
          ...SKIPS_PERMISSION_PROMPTS_AS_SHIPPED,
          'resume',
          first.sessionId
        ])
        await expect(museRows(page)).toHaveCount(1)
        await expect(museRows(page)).toHaveClass(/st-(waiting|idle)/, { timeout: 30_000 })
      } finally {
        await quitAndClose(app)
      }
    })

  test('with Claude, Codex and Muse, ⇧⏎ in the ⌘N picker opens the numbered agent list on the first other agent; ↓↑ and Esc stay inside the list, and its digit starts that agent in the picked workspace', async ({
    env
  }) => {
    installCodex(env)
    installMuse(env)
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      const dlg = await openPicker(app, page)
      await expect(dlg.getByRole('button', { name: 'Pick an agent' })).toBeVisible()
      await expect(dlg.getByText('⏎ Claude · ⇧⏎ other agent')).toBeVisible()
      const hotWs = dlg.locator('.cb-row.hot .wsp-name')
      const picked = await hotWs.innerText()
      trustInMuse(
        env,
        Object.values(env.workspaces).find((ws) => path.basename(ws) === picked)!
      )

      await page.keyboard.press('Shift+Enter')
      const list = page.getByRole('listbox', { name: 'Agents' })
      await expect(list.getByRole('option')).toHaveText(['1Claudedefault', '2Codex', '3Muse'])
      await expect(agentRow(page, 'Codex')).toHaveAttribute('aria-selected', 'true')
      await page.keyboard.press('ArrowDown')
      await expect(agentRow(page, 'Muse')).toHaveAttribute('aria-selected', 'true')
      await expect(hotWs).toHaveText(picked)
      await page.keyboard.press('Escape')
      await expect(list).toHaveCount(0)
      await expect(dlg).toBeVisible()

      await page.keyboard.press('Shift+Enter')
      await expect(list).toBeVisible()
      await page.keyboard.press('3')
      await expect.poll(() => museCalls(env).length).toBe(1)
      await expect(dlg).toHaveCount(0)
      expect(path.basename(museCalls(env)[0].cwd)).toBe(picked)
      expect(readCalls(env)).toHaveLength(0)
    } finally {
      await quitAndClose(app)
    }
  })

  test('a Muse worktree session runs in its own worktree folder, trusted for that run because its workspace is', async ({
    env
  }) => {
    installMuse(env)
    trustInMuse(env, env.workspaces.a)
    seedSettings(env, { hintsOff: true })
    gitInit(env.workspaces.a)
    gitCommitAll(env.workspaces.a)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      const dialog = await openWorktreeSession(page, 'ws-a')
      await dialog.locator('input').fill('muse-tree')
      await chooseBackend(page, 'Muse')
      await expect.poll(() => museCalls(env).length).toBe(1)
      const call = museCalls(env)[0]
      expect(call.argv).toEqual([...SKIPS_PERMISSION_PROMPTS_AS_SHIPPED, '--trust-workspace'])
      expect(fs.realpathSync(call.cwd)).not.toBe(fs.realpathSync(env.workspaces.a))
      expect(path.basename(call.cwd)).toBe('muse-tree')
      await expect(museRows(page).and(page.locator('.active'))).toHaveClass(/st-waiting/)
    } finally {
      await quitAndClose(app)
    }
  })

  test('a Muse session whose .claude/worktrees folder was deleted and whose worktree Koloft has no record of is rebuilt there from its branch on a click, for the same session', async ({
    env
  }) => {
    installMuse(env)
    trustInMuse(env, env.workspaces.a)
    seedSettings(env, { hintsOff: true })
    gitInit(env.workspaces.a)
    let app = await launchApp(env)
    let first: MuseCall
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      const dialog = await openWorktreeSession(page, 'ws-a')
      await dialog.locator('input').fill('muse-lost')
      await chooseBackend(page, 'Muse')
      await expect.poll(() => museCalls(env).length).toBe(1)
      first = museCalls(env)[0]
      await expect(museRows(page).and(page.locator('.active'))).toHaveClass(/st-waiting/)
      fs.writeFileSync(path.join(first.cwd, 'kept.txt'), 'committed on the branch')
      gitCommitAll(first.cwd)
      await sendShortcut(app, 'shortcut:close-tab')
      await expect(museRows(page)).toHaveClass(/cold/)
    } finally {
      await quitAndClose(app)
    }
    const storeFile = path.join(env.userData, 'muse-sessions.json')
    const store = JSON.parse(fs.readFileSync(storeFile, 'utf8'))
    store.resources = {}
    for (const member of Object.values<{ worktreeResourceId?: string }>(store.members))
      delete member.worktreeResourceId
    fs.writeFileSync(storeFile, JSON.stringify(store))
    fs.rmSync(first.cwd, { recursive: true, force: true })

    app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await museRows(page).click()
      await expect.poll(() => museCalls(env).length).toBe(2)
      await expect(museRows(page)).toHaveClass(/st-waiting|st-idle/)
      expect(museCalls(env)[1]).toMatchObject({ cwd: first.cwd, sessionId: first.sessionId })
      expect(fs.readFileSync(path.join(first.cwd, 'kept.txt'), 'utf8')).toBe(
        'committed on the branch'
      )
    } finally {
      await quitAndClose(app)
    }
  })

  // MUSE§9
  test("a subagent and a command left running in the background show breathing green with ↻ only while Muse's hooks and session log say they run, and a rename in Muse retitles the row", async ({
    env
  }) => {
    installMuse(env)
    trustInMuse(env, env.workspaces.a)
    seedSettings(env, { hintsOff: true })
    fs.writeFileSync(path.join(env.home, 'fake-muse-subagent-ms'), '4000')
    fs.writeFileSync(path.join(env.home, 'fake-muse-bg-ms'), '4000')
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await startMuse(page, env)
      const row = museRows(page)
      await runIn(page, centerTerm(page), '/subagent')
      await expect(row).toHaveClass(/\bst-bg-run\b/)
      await expect(row).not.toHaveClass(/\bst-bg-run\b/, { timeout: 15_000 })
      await runIn(page, centerTerm(page), '/bg')
      await expect(row).toHaveClass(/\bst-bg-run\b/)
      await expect(row).toHaveClass(/st-waiting/)
      await expect(row).not.toHaveClass(/\bst-bg-run\b/, { timeout: 15_000 })
      await runIn(page, centerTerm(page), '/rename Docs cleanup')
      await expect(row).toContainText('docs cleanup')
    } finally {
      await quitAndClose(app)
    }
  })

  // MUSE§2 MUSE§5
  test('a name given in Muse with /rename survives a Koloft restart, and a /fork copy is listed in the same workspace although Muse gives it no folder', async ({
    env
  }) => {
    installMuse(env)
    trustInMuse(env, env.workspaces.a)
    seedSettings(env, { hintsOff: true })
    let app = await launchApp(env)
    try {
      let page = await app.firstWindow()
      await waitBooted(page)
      await startMuse(page, env)
      await runIn(page, centerTerm(page), 'first topic')
      await expect(museRows(page).filter({ hasText: 'first topic' })).toHaveClass(/st-waiting/)
      await runIn(page, centerTerm(page), '/rename Docs cleanup')
      await expect(museRows(page)).toContainText('docs cleanup')
      await runIn(page, centerTerm(page), '/fork')
      await expect(page.locator('.term-wrap:visible')).toContainText('Fork created')
      await quitAndClose(app)

      app = await launchApp(env)
      page = await app.firstWindow()
      await waitBooted(page)
      await expect.poll(() => museCalls(env).length, { timeout: 30_000 }).toBe(2)
      await expect(museRows(page).filter({ hasText: 'docs cleanup' })).toHaveClass(
        /st-(waiting|idle)/,
        { timeout: 30_000 }
      )
      await openMenu(page, page.locator('.ws-head', { hasText: 'ws-a' }))
      await page.locator('.menu .mi', { hasText: 'Restore session' }).click()
      const history = page.getByRole('dialog', { name: 'Restore session · ws-a', exact: true })
      await expect(history.getByRole('button').filter({ hasText: 'first topic' })).toHaveCount(1)
    } finally {
      await quitAndClose(app)
    }
  })

  // MUSE§2
  test('closing the tab ends muse; its row stays in the list, cold, under the name given with /rename rather than the first message, and clicking it brings the same session back', async ({
    env
  }) => {
    installMuse(env)
    trustInMuse(env, env.workspaces.a)
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      const first = await startMuse(page, env)
      await runIn(page, centerTerm(page), 'keep me')
      await expect(museRows(page)).toContainText('keep me')
      await expect(museRows(page)).toHaveClass(/st-waiting/)
      await runIn(page, centerTerm(page), '/rename Docs cleanup')
      await expect(museRows(page)).toContainText('docs cleanup')
      const listedBefore = museListings(env)
      await sendShortcut(app, 'shortcut:close-tab')
      await expect.poll(() => processAlive(first.pid)).toBe(false)
      await expect(museRows(page)).toHaveClass(/cold/)
      await expect.poll(() => museListings(env)).toBeGreaterThan(listedBefore)
      const titles = await textsAcrossAWindow(museRows(page), ROWS_FOLLOW_A_LISTING_MS)
      expect(titles.filter((t) => !t.includes('docs cleanup'))).toEqual([])
      await museRows(page).click()
      await expect.poll(() => museCalls(env).length).toBe(2)
      expect(museCalls(env)[1].sessionId).toBe(first.sessionId)
    } finally {
      await quitAndClose(app)
    }
  })

  // MUSE§2
  test('/exit typed inside Muse leaves the list for Restore session under the name given with /rename, and the session brought back from there keeps that name', async ({
    env
  }) => {
    installMuse(env)
    trustInMuse(env, env.workspaces.a)
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      const first = await startMuse(page, env)
      await runIn(page, centerTerm(page), 'keep me')
      await expect(museRows(page)).toContainText('keep me')
      await expect(museRows(page)).toHaveClass(/st-waiting/)
      await runIn(page, centerTerm(page), '/rename Docs cleanup')
      await expect(museRows(page)).toContainText('docs cleanup')
      await runIn(page, centerTerm(page), '/exit')
      await expect.poll(() => processAlive(first.pid)).toBe(false)
      await expect(museRows(page)).toHaveCount(0)

      await openMenu(page, page.locator('.ws-head', { hasText: 'ws-a' }))
      await page.locator('.menu .mi', { hasText: 'Restore session' }).click()
      const history = page.getByRole('dialog', { name: 'Restore session · ws-a', exact: true })
      const row = history.getByRole('button').filter({ hasText: 'docs cleanup' })
      await expect(row).toHaveCount(1)
      await row.click()
      await expect.poll(() => museCalls(env).length).toBe(2)
      expect(museCalls(env)[1].sessionId).toBe(first.sessionId)
      await expect(museRows(page)).toContainText('docs cleanup')
    } finally {
      await quitAndClose(app)
    }
  })

  // MUSE§4
  test('a cold row whose session another live muse process still holds is not resumed: the notice names the muse process and no muse starts', async ({
    env
  }) => {
    installMuse(env)
    trustInMuse(env, env.workspaces.a)
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    const other = spawn('sleep', ['600'], { stdio: 'ignore' })
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      const first = await startMuse(page, env)
      await runIn(page, centerTerm(page), 'keep me')
      await expect(museRows(page)).toHaveClass(/st-waiting/)
      await sendShortcut(app, 'shortcut:close-tab')
      await expect.poll(() => processAlive(first.pid)).toBe(false)
      await expect(museRows(page)).toHaveClass(/cold/)

      const registry = path.join(env.home, '.local', 'share', 'muse', 'runtime', 'muse', 'sessions')
      fs.mkdirSync(registry, { recursive: true })
      fs.writeFileSync(
        path.join(registry, `${first.sessionId}.json`),
        JSON.stringify({
          schema_version: 1,
          session_id: first.sessionId,
          process_generation_hint: `pid=${other.pid}`
        })
      )
      await museRows(page).click()
      await expect(
        page.locator('.toast', { hasText: /still running in another muse process/ })
      ).toBeVisible({ timeout: 10_000 })
      await expect(museRows(page)).toHaveClass(/cold/)
      expect(museCalls(env)).toHaveLength(1)
    } finally {
      other.kill()
      await quitAndClose(app)
    }
  })

  test('a scheduled job set to run in Muse starts Muse in its own worktree with its task, model and thinking level, on the permission of my other sessions — with Skip permission prompts on, never asking — trusted for that run', async ({
    env
  }) => {
    const TASK = '/daily-report now'
    installMuse(env)
    gitInit(env.workspaces.a)
    trustInMuse(env, env.workspaces.a)
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await openMenu(page, page.locator('.ws-head', { hasText: 'ws-a' }))
      await page.locator('.menu .mi', { hasText: 'Scheduled jobs' }).click()
      const dlg = page.locator('.modal.cronjobs')
      await dlg.locator('button.mini', { hasText: 'New job' }).click()
      await dlg.locator('.chip', { hasText: /^Muse$/ }).click()
      await dlg.locator('input[aria-label="Name"]').fill('Nightly report')
      await dlg.locator('[aria-label="What to run"]').fill(TASK)
      await dlg.locator('.chip', { hasText: 'Other…' }).click()
      await dlg.locator('input[aria-label="Model name"]').fill('muse-large')
      await dlg.locator('.chip', { hasText: /^High$/ }).click()
      await expect(dlg.locator('.chip.on', { hasText: 'Same as my other sessions' })).toHaveCount(1)
      await dlg.locator('.modal-foot .btn-primary').click()
      await dlg.locator('.job-row button.mini', { hasText: 'Run now' }).click()

      await expect.poll(() => museCalls(env).length, { timeout: 30_000 }).toBe(1)
      expect(museCalls(env)[0].argv).toEqual([
        '--model',
        'muse-large',
        '--reasoning-effort',
        'high',
        '--permission-profile',
        ':unrestricted',
        '--trust-workspace',
        TASK
      ])
      expect(museCalls(env)[0].cwd).not.toBe(env.workspaces.a)
      expect(museCalls(env)[0].credentials).toBe('file')
      await expect
        .poll(
          () => page.evaluate(async () => (await window.api.cron.list()).live.map((l) => l.state)),
          { timeout: 30_000 }
        )
        .toEqual([expect.stringMatching(/^(running|done)$/)])
    } finally {
      await quitAndClose(app)
    }
  })

  test('a Muse job set to "Close it" closes for good once Muse finishes the turn: tab, row and worktree', async ({
    env
  }) => {
    installMuse(env)
    gitInit(env.workspaces.a)
    trustInMuse(env, env.workspaces.a)
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await openMenu(page, page.locator('.ws-head', { hasText: 'ws-a' }))
      await page.locator('.menu .mi', { hasText: 'Scheduled jobs' }).click()
      const dlg = page.locator('.modal.cronjobs')
      await dlg.locator('button.mini', { hasText: 'New job' }).click()
      await dlg.locator('.chip', { hasText: /^Muse$/ }).click()
      await dlg.locator('input[aria-label="Name"]').fill('Nightly report')
      await dlg.locator('[aria-label="What to run"]').fill('/daily-report now')
      await dlg.locator('.chip', { hasText: 'Close it' }).click()
      await dlg.locator('.modal-foot .btn-primary').click()
      await dlg.locator('.job-row button.mini', { hasText: 'Run now' }).click()

      await expect.poll(() => museCalls(env).length, { timeout: 30_000 }).toBe(1)
      await expect(dlg.locator('.hist-row').first()).toContainText('Done — closed itself', {
        timeout: 30_000
      })
      const tree = museCalls(env)[0].cwd
      await expect(page.locator('.terminals .term-wrap')).toHaveCount(0, { timeout: 30_000 })
      await expect(wsRows(page, 'ws-a')).toHaveCount(0, { timeout: 30_000 })
      await expect.poll(() => fs.existsSync(tree), { timeout: 30_000 }).toBe(false)
    } finally {
      await quitAndClose(app)
    }
  })

  // MUSE§5
  test('a Muse session started in a plain terminal while Koloft is open turns Restore session on for its folder with nothing else done, and deleting its folder there turns it off again', async ({
    env
  }) => {
    installMuse(env)
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      expect(await restoreOffered(page, 'ws-a')).toBe(false)
      const sessions = path.join(env.home, '.local', 'share', 'muse', 'sessions')
      const id = '01a17db8-7cda-7722-8212-7f60790ea9c8'
      const listed = path.join(sessions, 'fake', `${id}.json`)
      const at = new Date()
      const p2 = (n: number): string => String(n).padStart(2, '0')
      const folder = path.join(
        sessions,
        String(at.getFullYear()),
        p2(at.getMonth() + 1),
        p2(at.getDate()),
        id
      )
      fs.mkdirSync(path.dirname(listed), { recursive: true })
      fs.writeFileSync(
        listed,
        JSON.stringify({
          id,
          cwd: fs.realpathSync(env.workspaces.a),
          title: 'started in a plain terminal',
          createdAt: at.toISOString(),
          updatedAt: at.toISOString(),
          items: []
        })
      )
      fs.mkdirSync(folder, { recursive: true })
      fs.writeFileSync(path.join(folder, 'session.jsonl'), '{}\n')
      await expect.poll(() => restoreOffered(page, 'ws-a'), { timeout: 20_000 }).toBe(true)
      fs.unlinkSync(listed)
      fs.rmSync(folder, { recursive: true })
      await expect.poll(() => restoreOffered(page, 'ws-a'), { timeout: 20_000 }).toBe(false)
    } finally {
      await quitAndClose(app)
    }
  })
})
