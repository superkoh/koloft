import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import type { Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { EDIT, editReady, typeAtEnd } from './helpers/editPane'
import { addressValue, BROWSER, newWebTab, typeInAddressBar } from './helpers/browser'
import { hostResolverSwitch, startEchoServer } from './helpers/fixtureServer'
import { NO_USABLE_ACCOUNT } from '../../src/shared/accountUsage'
import {
  type E2EEnv,
  E2E_CLAUDE_ACCOUNT,
  installAgy,
  installCodex,
  installFakeGh,
  installMuse,
  seedNoClaudeAccountButStillSetUp,
  seedSettings,
  setGithubFixture,
  writeGitIdentity
} from './helpers/env'
import {
  addRemoteWorkspace,
  agyReady,
  boundRemoteAgy,
  breakConnection,
  healConnection,
  installCodexOnFakeRemote,
  installMuseOnMachine,
  installRemoteAgy,
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
  type AgentName,
  agentRow,
  agentShell,
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
  newSessionInWith,
  oneStillRunning,
  openMenu,
  openSessionTerminal,
  panelTerm,
  runIn,
  sendShortcut,
  snap,
  startSessionIn,
  transcriptFile,
  waitBooted,
  waitForCalls,
  wsRows
} from './helpers/p1'
import {
  FAILED_LOG,
  ONE_FAILING_OF_FIVE,
  WORKBENCH,
  artifactBody,
  browseRow,
  claudePrompts,
  commentOnFirstHunk,
  expectOnePromptFromTheChecks,
  expectOnePromptFromTheComment,
  sendFailingChecks,
  openInBrowse,
  rowMenu,
  showBrowse,
  wbActiveTab
} from './helpers/workbench'

const LAYOUT_SAVE_DEBOUNCE_SETTLE_MS = 3000
const A_CLI_STEP_FINISHES_WITHIN_MS = 60_000
const A_REFUSED_LOAD_SETTLES_MS = 3000
const PAGE_HOST_THAT_IS_NOT_THE_MAC = 'remote-page.test'
const TURN_LONGER_THAN_ONE_MIRROR_PULL = '/busy'

const heartbeatsStamping = (env: E2EEnv, bare: string): number =>
  sshCommands(env, 'end').filter((c) => c.includes('tmux -L koloft ls') && c.includes(`'${bare}'`))
    .length

async function untilTheMachineHasStamped(env: E2EEnv, bare: string): Promise<void> {
  const before = heartbeatsStamping(env, bare)
  await expect
    .poll(() => heartbeatsStamping(env, bare), { timeout: 30_000 })
    .toBeGreaterThanOrEqual(before + 2)
}

async function openRemoteSessionWorkbench(page: Page, env: E2EEnv): Promise<void> {
  await addRemoteWorkspace(page, env)
  await startSessionIn(page, REMOTE_WS_NAME, { remote: true })
  await wsRows(page, REMOTE_WS_NAME).first().click()
  await expect(auxIcon(page, 'Workbench')).toHaveCount(1)
}

const OTHER_AGENTS_ON_THE_MACHINE: {
  id: string
  label: AgentName
  install: (env: E2EEnv) => void
  bound?: (page: Page) => Promise<unknown>
}[] = [
  { id: 'E-RW-38', label: 'Codex', install: installCodexOnFakeRemote },
  {
    id: 'E-RW-39',
    label: 'Muse',
    install: (env: E2EEnv): void => {
      installMuse(env)
      installMuseOnMachine(env)
    }
  },
  {
    id: 'E-RW-40',
    label: 'Antigravity',
    install: (env: E2EEnv): void => {
      installAgy(env)
      installRemoteAgy(env)
    },
    bound: async (page: Page) => {
      await agyReady(page)
      await runIn(page, centerTerm(page), 'first words')
      return boundRemoteAgy(page)
    }
  }
]

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

  for (const agent of OTHER_AGENTS_ON_THE_MACHINE) {
    test(`${agent.id}: koloft open, typed in the Workbench shell of a ${agent.label} session on the machine, shows a file there in that session’s Workbench`, async ({
      env
    }) => {
      test.setTimeout(240_000)
      agent.install(env)
      seedSettings(env, { hintsOff: true })
      const { app, page } = await launchWithRemote(env)
      try {
        fs.writeFileSync(path.join(remoteDir(env), 'shown.md'), `# shown for ${agent.label}\n`)
        await addRemoteWorkspace(page, env)
        await newSessionInWith(page, REMOTE_WS_NAME, agent.label)
        await agent.bound?.(page)
        await openSessionTerminal(app, page)
        await runIn(page, panelTerm(page), 'koloft open shown.md')
        await expect(artifactBody(page)).toContainText(`shown for ${agent.label}`, {
          timeout: 60_000
        })
      } finally {
        await quitAndClose(app)
      }
    })
  }

  test('after ⇧⌘R on a Claude Code tab on the machine, koloft open typed in its Workbench shell still shows the file in that tab’s Workbench', async ({
    env
  }) => {
    test.setTimeout(300_000)
    seedSettings(env, { hintsOff: true })
    const { app, page } = await launchWithRemote(env)
    try {
      fs.writeFileSync(path.join(remoteDir(env), 'after-restart.md'), '# shown after restart\n')
      await addRemoteWorkspace(page, env)
      await startSessionIn(page, REMOTE_WS_NAME, { remote: true })
      await waitForCalls(env, 1)
      await openSessionTerminal(app, page)

      await sendShortcut(app, 'shortcut:restart-session')
      await waitForCalls(env, 2, 90_000)
      await expect(wsRows(page, REMOTE_WS_NAME)).toHaveClass(/\bst-waiting\b/, {
        timeout: 60_000
      })

      await runIn(page, panelTerm(page), 'koloft open after-restart.md')
      await expect(artifactBody(page)).toContainText('shown after restart', { timeout: 60_000 })
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

      const expand = page.locator('.wb-panel .cv-blk[data-path="tracked.txt"] .cv-exp:not(.cv-cmt)')
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

  test('E-RW-28: ✎ comment on a remote Changes hunk reaches claude on the machine through ssh and tmux as a paste with the note typed after it, unsent until the person presses Enter', async ({
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
      const row = wsRows(page, REMOTE_WS_NAME).first()
      await row.click()
      const tabId = await row.getAttribute('data-tab-id')
      await expect.poll(() => boundSessionId(page, tabId), { timeout: 60_000 }).toBeTruthy()
      const transcript = transcriptFile(
        machineHome(env),
        dir,
        (await boundSessionId(page, tabId)) ?? ''
      )
      await showBrowse(page)
      await page
        .locator(`${WORKBENCH.kindBar} .seg[aria-label="Files view"] button`)
        .filter({ hasText: 'Changes' })
        .click()
      await expect(page.locator('.wb-panel .cv-blk[data-path="tracked.txt"] .cv-cmt')).toBeVisible({
        timeout: 30_000
      })

      const note = 'E-RW-28 say why two'
      const head = await commentOnFirstHunk(page, 'tracked.txt', note)
      await expectOnePromptFromTheComment(() => claudePrompts(transcript), head, note)
    } finally {
      await quitAndClose(app)
    }
  })

  test('E-RW-29: the GitHub button on a remote session commits and pushes on the machine, while gh runs on this Mac and its failing checks reach claude on the machine as one unsent paste', async ({
    env
  }) => {
    test.setTimeout(300_000)
    installFakeGh(env, { checks: ONE_FAILING_OF_FIVE, failedLog: FAILED_LOG })
    setGithubFixture(env, {
      [remoteKey(env)]: { owner: 'acme', repo: 'widgets', branch: 'feature/login', pr: 265 }
    })
    const { app, page } = await launchWithRemote(env)
    try {
      const dir = remoteDir(env)
      const origin = path.join(machineHome(env), 'widgets-origin.git')
      writeGitIdentity(machineHome(env))
      fs.writeFileSync(path.join(dir, '.gitignore'), 'NOTES.md\n')
      gitInit(dir)
      execFileSync('git', ['init', '-q', '--bare', origin])
      execFileSync('git', ['remote', 'add', 'origin', origin], { cwd: dir })
      execFileSync('git', ['switch', '-q', '-c', 'feature/login'], { cwd: dir })

      await addRemoteWorkspace(page, env)
      await startSessionIn(page, REMOTE_WS_NAME, { remote: true })
      const row = wsRows(page, REMOTE_WS_NAME).first()
      await row.click()
      const tabId = await row.getAttribute('data-tab-id')
      await expect.poll(() => boundSessionId(page, tabId), { timeout: 60_000 }).toBeTruthy()
      const transcript = transcriptFile(
        machineHome(env),
        dir,
        (await boundSessionId(page, tabId)) ?? ''
      )
      await expect(page.locator('.wb-gh .ci')).toHaveClass(/\bfail\b/, { timeout: 30_000 })

      fs.writeFileSync(path.join(dir, 'rw29.txt'), 'new\n')
      await page.locator('.wb-gh').click({ button: 'right' })
      await page.locator('.wb-ghmenu .mi', { hasText: 'Commit…' }).click()
      const dialog = page.locator('.modal', { hasText: 'Commit changes' })
      await dialog.getByLabel('Commit message').fill('E-RW-29 commit on the machine')
      await dialog.getByLabel('Commit message').press('Enter')
      await expect(dialog).toHaveCount(0, { timeout: 60_000 })
      const git = (cwd: string, ...args: string[]): string =>
        execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
      expect(git(dir, 'log', '-1', '--format=%s')).toBe('E-RW-29 commit on the machine')
      expect(git(dir, 'show', '--name-only', '--format=', 'HEAD')).toContain('rw29.txt')

      await page.locator('.wb-gh').click({ button: 'right' })
      await page.locator('.wb-ghmenu .mi', { hasText: 'Push' }).click()
      await expect
        .poll(
          () => git(origin, 'for-each-ref', '--format=%(objectname)', 'refs/heads/feature/login'),
          { timeout: 60_000 }
        )
        .toBe(git(dir, 'rev-parse', 'HEAD'))

      await sendFailingChecks(page)
      await expectOnePromptFromTheChecks(() => claudePrompts(transcript))
    } finally {
      await quitAndClose(app)
    }
  })

  // ADR-0030 CODEX§16
  test('E-RW-30: with no Claude account, a remote workspace’s empty panel shuts "New Claude session" under a line that says why, while Codex, whose account is there, stays open in its agent list', async ({
    env
  }) => {
    test.setTimeout(120_000)
    installCodex(env)
    seedNoClaudeAccountButStillSetUp(env)
    const layoutFile = path.join(env.userData, 'layout.json')
    const layout = JSON.parse(fs.readFileSync(layoutFile, 'utf8')) as Record<string, unknown>
    fs.writeFileSync(
      layoutFile,
      JSON.stringify({ ...layout, workspaces: [{ path: remoteKey(env) }] })
    )
    const { app, page } = await launchWithRemote(env)
    try {
      const empty = page.locator('.w-empty')
      await expect(empty.locator('.big')).toHaveText(REMOTE_WS_NAME, { timeout: 20_000 })
      await expect(empty.getByRole('button', { name: /New Claude session/ })).toBeDisabled()
      await expect(empty.locator('.field-hint.bad')).toHaveText(
        /^No Claude account yet — add one in Settings ▸ Accounts\.$/
      )
      await empty.getByRole('button', { name: 'Pick an agent' }).click()
      await expect(agentRow(page, 'Codex')).not.toHaveAttribute('aria-disabled', 'true')
      await expect(agentRow(page, 'Codex')).not.toContainText(/Local only|Unavailable|No account/)
      await snap(page, 'E-RW-30')
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

  test("a file name typed in a remote tab's address bar opens the file on the machine in a file tab, a page as its source, and a path that climbs out of the session's folder searches instead", async ({
    env
  }) => {
    test.setTimeout(300_000)
    env.extraArgs.push(hostResolverSwitch(['duckduckgo.com']))
    const { app, page } = await launchWithRemote(env)
    try {
      const dir = remoteDir(env)
      fs.writeFileSync(path.join(dir, 'page.html'), '<h1>typed on the machine</h1>\n')
      fs.writeFileSync(path.join(path.dirname(dir), 'outside.html'), '<h1>outside</h1>\n')

      await openRemoteSessionWorkbench(page, env)
      await newWebTab(page)
      await typeInAddressBar(page, 'page.html')
      await expect(wbActiveTab(page)).toContainText('page.html', {
        timeout: 30_000
      })
      await expect(artifactBody(page).locator('.code-body')).toContainText('typed on the machine', {
        timeout: 30_000
      })

      await newWebTab(page)
      await typeInAddressBar(page, '../outside.html')
      await expect
        .poll(() => addressValue(page), { timeout: 30_000 })
        .toMatch(/duckduckgo\.com\/\?q=.*outside\.html/)
      await expect(page.locator(WORKBENCH.tab, { hasText: 'outside.html' })).toHaveCount(0)
    } finally {
      await quitAndClose(app)
    }
  })

  // CC§5
  test('E-RW-28: a remote turn that ends while its reported background work still runs shows breathing green with ↻ until the work drains', async ({
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
      const running = oneStillRunning(row)
      await expect(running).toBeVisible({ timeout: 60_000 })
      await expect(row).toHaveClass(/\bst-waiting\b/)
      await expect(row).toHaveClass(/\bst-bg-run\b/)
      await expect(running).toHaveCount(0, { timeout: 90_000 })
      await expect(row).toHaveClass(/\bst-waiting\b/)
      await expect(row).not.toHaveClass(/\bst-bg-run\b/)
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

  test('restarting a remote Claude Code session once no Claude account can be used says why, and starts no new claude on the machine', async ({
    env
  }) => {
    test.setTimeout(300_000)
    const { app, page } = await launchWithRemote(env)
    try {
      await addRemoteWorkspace(page, env)
      await startSessionIn(page, REMOTE_WS_NAME, { remote: true })
      const row = wsRows(page, REMOTE_WS_NAME).first()
      await expect(row).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })
      await row.click()
      const launches = (await waitForCalls(env, 1)).length
      await page.evaluate(
        (name) => window.api.accounts.toggle(name, 'apikey', false),
        E2E_CLAUDE_ACCOUNT
      )
      await sendShortcut(app, 'shortcut:restart-session')
      await expect(page.locator('.toast-msg')).toHaveText(NO_USABLE_ACCOUNT.claude, {
        timeout: 60_000
      })
      expect(await waitForCalls(env, launches)).toHaveLength(launches)
    } finally {
      await quitAndClose(app)
    }
  })

  test('E-RW-31: a file changed on the machine reloads by itself in the reading area, with no Reload pressed', async ({
    env
  }) => {
    test.setTimeout(300_000)
    const { app, page } = await launchWithRemote(env)
    try {
      const doc = path.join(remoteDir(env), 'doc.md')
      fs.writeFileSync(doc, '# Doc\n\nfirst line\n')
      await openRemoteSessionWorkbench(page, env)

      await openInBrowse(page, `${remoteKey(env)}/doc.md`)
      const body = page.locator(`${WORKBENCH.readingBody} .md-body`)
      await expect(body).toContainText('first line', { timeout: 30_000 })

      await untilTheMachineHasStamped(env, doc)
      fs.writeFileSync(doc, '# Doc\n\nsecond line, written on the machine\n')
      await expect(body).toContainText('second line, written on the machine', { timeout: 30_000 })
    } finally {
      await quitAndClose(app)
    }
  })

  test('E-RW-32: the editor of a remote file with unsaved edits shows "Changed on disk" as soon as the machine changes the file, before any save', async ({
    env
  }) => {
    test.setTimeout(300_000)
    const { app, page } = await launchWithRemote(env)
    try {
      const file = path.join(remoteDir(env), 'settings.env')
      fs.writeFileSync(file, 'KOLOFT_E2E_REMOTE_EDIT=1\n')
      await openRemoteSessionWorkbench(page, env)

      await showBrowse(page)
      const row = browseRow(page, `${remoteKey(env)}/settings.env`)
      await expect(row).toBeVisible({ timeout: 30_000 })
      await row.click({ button: 'right' })
      await rowMenu(page).getByText('Edit', { exact: true }).click()
      await editReady(page, 'KOLOFT_E2E_REMOTE_EDIT=1')
      await typeAtEnd(page, 'MINE=1')
      await expect(page.locator(EDIT.dirty)).toBeVisible()

      await untilTheMachineHasStamped(env, file)
      fs.writeFileSync(file, 'KOLOFT_E2E_REMOTE_EDIT=1\nTHEIRS=2\n')
      await expect(page.locator(EDIT.stale)).toContainText(EDIT.staleText, { timeout: 30_000 })
      expect(fs.readFileSync(file, 'utf8')).toBe('KOLOFT_E2E_REMOTE_EDIT=1\nTHEIRS=2\n')
    } finally {
      await quitAndClose(app)
    }
  })

  test('E-RW-33: a file made on the machine appears in Browse by itself, at the top and inside an open folder', async ({
    env
  }) => {
    test.setTimeout(300_000)
    const { app, page } = await launchWithRemote(env)
    try {
      const dir = remoteDir(env)
      const src = path.join(dir, 'src')
      fs.mkdirSync(src)
      fs.writeFileSync(path.join(src, 'a.ts'), 'export const a = 1\n')
      await openRemoteSessionWorkbench(page, env)

      await showBrowse(page)
      const srcRow = browseRow(page, `${remoteKey(env)}/src`)
      await expect(srcRow).toBeVisible({ timeout: 30_000 })
      await srcRow.click()
      await expect(browseRow(page, `${remoteKey(env)}/src/a.ts`)).toBeVisible({ timeout: 30_000 })

      await untilTheMachineHasStamped(env, src)
      await untilTheMachineHasStamped(env, dir)
      fs.writeFileSync(path.join(src, 'b.ts'), 'export const b = 2\n')
      fs.writeFileSync(path.join(dir, 'top.txt'), 'new at the top\n')
      await expect(browseRow(page, `${remoteKey(env)}/src/b.ts`)).toBeVisible({ timeout: 30_000 })
      await expect(browseRow(page, `${remoteKey(env)}/top.txt`)).toBeVisible({ timeout: 30_000 })
    } finally {
      await quitAndClose(app)
    }
  })

  // PLATFORM§57
  test("E-RW-34: Browse's Reload lists the remote tree again, catching a change no folder's time shows (a file .gitignore stops hiding)", async ({
    env
  }) => {
    test.setTimeout(300_000)
    const { app, page } = await launchWithRemote(env)
    try {
      const dir = remoteDir(env)
      fs.writeFileSync(path.join(dir, '.gitignore'), 'secret.txt\n')
      fs.writeFileSync(path.join(dir, 'secret.txt'), 'hidden at first\n')
      fs.writeFileSync(path.join(dir, 'tracked.txt'), 'one\n')
      gitInit(dir)
      gitCommitAll(dir)
      await openRemoteSessionWorkbench(page, env)

      await showBrowse(page)
      await expect(browseRow(page, `${remoteKey(env)}/tracked.txt`)).toBeVisible({
        timeout: 30_000
      })
      const secret = browseRow(page, `${remoteKey(env)}/secret.txt`)
      await expect(secret).toHaveCount(0)

      fs.writeFileSync(path.join(dir, '.gitignore'), '')
      await untilTheMachineHasStamped(env, dir)
      await expect(secret).toHaveCount(0)

      await page.locator(WORKBENCH.reload).click()
      await expect(secret).toBeVisible({ timeout: 30_000 })
    } finally {
      await quitAndClose(app)
    }
  })

  // PLATFORM§33
  test("E-RW-41: Koloft's playwright-cli, run by Claude Code on the machine, drives that tab's Workbench browser through the address Koloft writes there but never opens a file or a local server of the Mac, and switching browser control off takes the address away", async ({
    env
  }) => {
    test.setTimeout(300_000)
    const server = await startEchoServer()
    env.extraArgs.push(hostResolverSwitch([PAGE_HOST_THAT_IS_NOT_THE_MAC]))
    const { app, page } = await launchWithRemote(env)
    try {
      await addRemoteWorkspace(page, env)
      await startSessionIn(page, REMOTE_WS_NAME, { remote: true })
      const tabId = (await wsRows(page, REMOTE_WS_NAME).first().getAttribute('data-tab-id'))!
      const address = path.join(machineHome(env), '.koloft', 'tabs', `${tabId}.cdp`)
      await expect
        .poll(() => (fs.existsSync(address) ? fs.readFileSync(address, 'utf8') : ''), {
          timeout: 30_000
        })
        .toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/cdp\/[0-9a-f]{32}$/)

      const title = `remote-${Date.now().toString(36)}`
      const url = server
        .page('/remote', `<title>${title}</title><body>from the machine</body>`)
        .replace('127.0.0.1', PAGE_HOST_THAT_IS_NOT_THE_MAC)
      const onTheMac = server.page('/mac-only', '<title>mac-only-server</title>')
      const run = agentShell(page, tabId, A_CLI_STEP_FINISHES_WITHIN_MS)
      const unwrapped = async (command: string): Promise<string> =>
        (await run(command)).replace(/\n/g, '')
      expect(await unwrapped('command -v playwright-cli')).toMatch(
        /\.koloft\/m-[0-9a-f]+\/claude-bin\/playwright-cli/
      )
      expect(await unwrapped(`playwright-cli open ${url}`)).toContain(`Page Title: ${title}`)
      await expect(page.locator(BROWSER.drivenTab)).toHaveCount(1, { timeout: 30_000 })

      const macFile = path.join(env.home, 'only-on-the-mac.html')
      fs.writeFileSync(macFile, '<title>only-on-the-mac</title>')
      const lastStep = (text: string): string => text.split('sh exit=').at(-2) ?? ''
      const refused = 'cannot reach files or local servers of the Mac'
      expect(lastStep(await unwrapped(`playwright-cli goto file://${macFile}`))).toContain(refused)
      expect(lastStep(await unwrapped(`playwright-cli goto ${onTheMac}`))).toContain(refused)
      await run(`playwright-cli eval "() => { location.href = 'file://${macFile}' }"`)
      await run(
        `playwright-cli eval "() => { location.href = '${onTheMac.replace('127.0.0.1', 'localhost')}' }"`
      )
      expect(lastStep(await unwrapped('playwright-cli eval "() => location.href"'))).toContain(url)
      expect(
        lastStep(
          await unwrapped(
            `playwright-cli eval "() => fetch('${onTheMac}', { mode: 'no-cors' }).then(() => 'reached', () => 'blocked')"`
          )
        )
      ).toContain('blocked')
      await run(`playwright-cli eval "() => { window.open('${onTheMac}') }"`)
      expect(lastStep(await unwrapped(`playwright-cli tab-new file://${macFile}`))).toContain(
        refused
      )
      await page.locator(BROWSER.drivenTab).first().click()
      await run('playwright-cli close')
      await typeInAddressBar(page, `file://${macFile}`)
      await page.waitForTimeout(A_REFUSED_LOAD_SETTLES_MS)
      const titles = await app.evaluate(({ webContents }) =>
        Promise.all(
          webContents.getAllWebContents().map((w) => w.executeJavaScript('document.title'))
        )
      )
      expect(titles).not.toContain('only-on-the-mac')
      expect(titles).not.toContain('mac-only-server')

      await page.evaluate(() => window.api.settings.set({ browserControl: false }))
      await expect.poll(() => fs.existsSync(address), { timeout: 30_000 }).toBe(false)
    } finally {
      await quitAndClose(app)
      await server.close()
    }
  })
})
