import fs from 'fs'
import path from 'path'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { E2E_MUSE_ACCOUNT, installMuse, seedSettings, type E2EEnv } from './helpers/env'
import {
  addRemoteWorkspace,
  dropTmuxPassthrough,
  installFakeRemote,
  installMuseOnMachine,
  killFakeRemote,
  liveTmuxSessions,
  machineHome,
  machineMuseCalls,
  remoteDir,
  remoteKey,
  REMOTE_WS_NAME,
  sshCommands,
  type MachineMuseCall
} from './helpers/remote'
import {
  centerTerm,
  gitCommitAll,
  gitInit,
  newSessionInWith,
  openMenu,
  runIn,
  sendShortcut,
  waitBooted,
  wsRows
} from './helpers/p1'

test.setTimeout(240_000)
test.afterEach(({ env }) => killFakeRemote(env))

const ON_THE_MACHINE_WITHIN_MS = 60_000
const A_TURN_LONGER_THAN_ONE_MIRROR_PULL_MS = '5000'
const KEY_THROUGH_A_LINE_MODE_TMUX = 'y\r'
const SKIPS_PERMISSION_PROMPTS_AS_SEEDED = ['--permission-profile', ':unrestricted']

function machineFile(env: E2EEnv, name: string, text: string): void {
  fs.writeFileSync(path.join(machineHome(env), name), text)
}

async function launchWithMuseThere(env: E2EEnv): Promise<{ app: ElectronApplication; page: Page }> {
  installMuse(env)
  installFakeRemote(env)
  installMuseOnMachine(env)
  seedSettings(env, { hintsOff: true })
  const app = await launchApp(env)
  const page = await app.firstWindow()
  await waitBooted(page)
  return { app, page }
}

function remoteRows(page: Page): Locator {
  return wsRows(page, REMOTE_WS_NAME)
}

async function startRemoteMuse(page: Page, env: E2EEnv): Promise<MachineMuseCall> {
  const before = machineMuseCalls(env).length
  await newSessionInWith(page, REMOTE_WS_NAME, 'Muse')
  await expect
    .poll(() => machineMuseCalls(env).length, { timeout: ON_THE_MACHINE_WITHIN_MS })
    .toBe(before + 1)
  const call = machineMuseCalls(env)[before]
  await expect
    .poll(() => liveTmuxSessions(env), { timeout: ON_THE_MACHINE_WITHIN_MS })
    .toContain(`k-${call.sessionId}`)
  return call
}

async function closeActiveTab(app: ElectronApplication, page: Page): Promise<void> {
  await page.locator('.ws-tab.active').first().click()
  await sendShortcut(app, 'shortcut:close-tab')
  const confirm = page.locator('.modal', { hasText: 'Close running session?' })
  if (await confirm.isVisible({ timeout: 4000 }).catch(() => false))
    await confirm
      .locator('button', { hasText: /^Close$/ })
      .first()
      .click()
}

test.describe('Muse Code in a remote workspace, through fake ssh and fake tmux with the real wrapper and hooks on the machine', () => {
  test('E-RM-01: a Muse session starts on the machine with the account Koloft picked, carried there, and its light follows working to waiting through the tmux passthrough', async ({
    env
  }) => {
    const { app, page } = await launchWithMuseThere(env)
    try {
      expect(await addRemoteWorkspace(page, env)).toEqual({ code: 'added', path: remoteKey(env) })
      const call = await startRemoteMuse(page, env)
      const account = path.join(machineHome(env), '.koloft', 'muse-homes', E2E_MUSE_ACCOUNT)
      expect(call).toMatchObject({
        argv: SKIPS_PERMISSION_PROMPTS_AS_SEEDED,
        cwd: remoteDir(env),
        configHome: account,
        credentials: 'file'
      })
      expect(fs.statSync(path.join(account, 'muse', 'auth.json')).mode & 0o777).toBe(0o600)
      const row = remoteRows(page)
      await expect(row).toHaveClass(/\bst-waiting\b/, { timeout: ON_THE_MACHINE_WITHIN_MS })
      machineFile(env, 'fake-muse-delay', '1500')
      await runIn(page, centerTerm(page), 'hello muse')
      await expect(row).toHaveClass(/\bst-working\b/)
      await expect(row).toHaveClass(/\bst-waiting\b/)
      await expect(row).toContainText('hello muse')
    } finally {
      await quitAndClose(app)
    }
  })

  test('E-RM-02: when tmux drops the passthrough, the light still follows working to waiting from the mirror the wrapper writes on the machine', async ({
    env
  }) => {
    const { app, page } = await launchWithMuseThere(env)
    try {
      dropTmuxPassthrough(env)
      await addRemoteWorkspace(page, env)
      await startRemoteMuse(page, env)
      const row = remoteRows(page)
      await expect(row).toHaveClass(/\bst-waiting\b/, { timeout: ON_THE_MACHINE_WITHIN_MS })
      machineFile(env, 'fake-muse-delay', A_TURN_LONGER_THAN_ONE_MIRROR_PULL_MS)
      await runIn(page, centerTerm(page), 'slow turn')
      await expect(row).toHaveClass(/\bst-working\b/, { timeout: 30_000 })
      await expect(row).toHaveClass(/\bst-waiting\b/, { timeout: 30_000 })
    } finally {
      await quitAndClose(app)
    }
  })

  test('E-RM-03: /clear keeps the tab and follows the new session on the machine, and closing the tab ends that tmux session there; the row stays cold and brings the session back with muse resume', async ({
    env
  }) => {
    const { app, page } = await launchWithMuseThere(env)
    try {
      await addRemoteWorkspace(page, env)
      const first = await startRemoteMuse(page, env)
      await expect(remoteRows(page)).toHaveClass(/\bst-waiting\b/, {
        timeout: ON_THE_MACHINE_WITHIN_MS
      })
      await runIn(page, centerTerm(page), 'keep me')
      await expect(remoteRows(page)).toContainText('keep me')
      await runIn(page, centerTerm(page), '/clear')
      await expect.poll(() => machineMuseCalls(env).length).toBe(2)
      const cleared = machineMuseCalls(env)[1]
      expect(cleared.pid).toBe(first.pid)
      await expect
        .poll(() => liveTmuxSessions(env), { timeout: 30_000 })
        .toEqual([`k-${cleared.sessionId}`])
      await runIn(page, centerTerm(page), 'second')
      await expect(remoteRows(page).filter({ hasText: 'second' })).toHaveCount(1)

      await closeActiveTab(app, page)
      await expect.poll(() => liveTmuxSessions(env), { timeout: 30_000 }).toEqual([])
      const cold = remoteRows(page).filter({ hasText: 'second' })
      await expect(cold).toHaveClass(/cold/, { timeout: 30_000 })
      await cold.click()
      await expect
        .poll(() => machineMuseCalls(env).length, { timeout: ON_THE_MACHINE_WITHIN_MS })
        .toBe(3)
      expect(machineMuseCalls(env)[2].argv.slice(-2)).toEqual(['resume', cleared.sessionId])
    } finally {
      await quitAndClose(app)
    }
  })

  test('E-RM-04: after Koloft restarts, the open Muse tab attaches to the same session still running on the machine, starts no second muse, and lights up again', async ({
    env
  }) => {
    let { app, page } = await launchWithMuseThere(env)
    let call: MachineMuseCall
    try {
      await addRemoteWorkspace(page, env)
      call = await startRemoteMuse(page, env)
      await runIn(page, centerTerm(page), 'before restart')
      await expect(remoteRows(page)).toContainText('before restart')
    } finally {
      await quitAndClose(app)
    }
    expect(liveTmuxSessions(env)).toEqual([`k-${call.sessionId}`])
    app = await launchApp(env)
    page = await app.firstWindow()
    try {
      await waitBooted(page)
      await expect
        .poll(() => sshCommands(env).filter((c) => /tabs\/[^"]+\.sh"?\s+attach/.test(c)).length, {
          timeout: ON_THE_MACHINE_WITHIN_MS
        })
        .toBeGreaterThan(0)
      await expect(remoteRows(page)).toHaveClass(/\bst-waiting\b/, {
        timeout: ON_THE_MACHINE_WITHIN_MS
      })
      expect(machineMuseCalls(env)).toHaveLength(1)
      machineFile(env, 'fake-muse-delay', '1500')
      await remoteRows(page).click()
      await runIn(page, centerTerm(page), 'after restart')
      await expect(remoteRows(page)).toHaveClass(/\bst-working\b/)
      await expect(remoteRows(page)).toHaveClass(/\bst-waiting\b/)
    } finally {
      await quitAndClose(app)
    }
  })

  test('E-RM-07: an approval Muse asks for on the machine turns the row amber, and a key pressed in the tab reaches Muse through ssh, tmux and the wrapper', async ({
    env
  }) => {
    const { app, page } = await launchWithMuseThere(env)
    try {
      await addRemoteWorkspace(page, env)
      const call = await startRemoteMuse(page, env)
      const row = remoteRows(page)
      await expect(row).toHaveClass(/\bst-waiting\b/, { timeout: ON_THE_MACHINE_WITHIN_MS })
      await runIn(page, centerTerm(page), '/approve')
      await expect(row).toHaveClass(/\bst-approval\b/)
      const tabId = await row.getAttribute('data-tab-id')
      await page.evaluate(
        ([id, key]) => window.api.terminal.write(id!, key!),
        [tabId, KEY_THROUGH_A_LINE_MODE_TMUX]
      )
      await expect(row).toHaveClass(/\bst-waiting\b/)
      const saved = path.join(
        machineHome(env),
        '.local',
        'share',
        'muse',
        'sessions',
        'fake',
        `${call.sessionId}.json`
      )
      await expect.poll(() => fs.readFileSync(saved, 'utf8')).toContain('Ran: ls -la')
    } finally {
      await quitAndClose(app)
    }
  })

  test('E-RM-05: a scheduled Muse job on a remote workspace runs muse on the machine in its own worktree made there by git, trusted for that run', async ({
    env
  }) => {
    const TASK = 'nightly check'
    installFakeRemote(env)
    fs.writeFileSync(path.join(remoteDir(env), 'README.md'), '# proj\n')
    gitInit(remoteDir(env))
    gitCommitAll(remoteDir(env))
    const { app, page } = await launchWithMuseThere(env)
    try {
      await addRemoteWorkspace(page, env)
      await openMenu(page, page.locator('.ws-head', { hasText: REMOTE_WS_NAME }))
      await page.locator('.menu .mi', { hasText: 'Scheduled jobs' }).click()
      const dlg = page.locator('.modal.cronjobs')
      await dlg.locator('button.mini', { hasText: 'New job' }).click()
      await dlg.locator('.chip', { hasText: /^Muse$/ }).click()
      await dlg.locator('input[aria-label="Name"]').fill('Nightly')
      await dlg.locator('[aria-label="What to run"]').fill(TASK)
      await dlg.locator('.modal-foot .btn-primary').click()
      await dlg.locator('.job-row button.mini', { hasText: 'Run now' }).click()
      await expect
        .poll(() => machineMuseCalls(env).length, { timeout: ON_THE_MACHINE_WITHIN_MS })
        .toBe(1)
      const call = machineMuseCalls(env)[0]
      expect(call.argv).toEqual(['--trust-workspace', ...SKIPS_PERMISSION_PROMPTS_AS_SEEDED, TASK])
      expect(call.cwd.startsWith(path.join(remoteDir(env), '.claude', 'worktrees') + '/')).toBe(
        true
      )
      expect(fs.existsSync(path.join(call.cwd, '.git'))).toBe(true)
    } finally {
      await quitAndClose(app)
    }
  })

  test('E-RM-06: with no Muse account, the remote workspace offers Muse under the same account line a local one shows, not "Local only"', async ({
    env
  }) => {
    installFakeRemote(env)
    installMuseOnMachine(env)
    const layoutFile = path.join(env.userData, 'layout.json')
    const layout = JSON.parse(fs.readFileSync(layoutFile, 'utf8')) as Record<string, unknown>
    fs.writeFileSync(
      layoutFile,
      JSON.stringify({ ...layout, workspaces: [{ path: remoteKey(env) }] })
    )
    installMuse(env)
    const settings = path.join(env.userData, 'settings.json')
    const current = JSON.parse(fs.readFileSync(settings, 'utf8')) as {
      accounts?: { kind: string }[]
    }
    fs.writeFileSync(
      settings,
      JSON.stringify({
        ...current,
        accounts: (current.accounts ?? []).filter((a) => a.kind !== 'muse-home')
      })
    )
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      const empty = page.locator('.w-empty')
      await expect(empty.locator('.big')).toHaveText(REMOTE_WS_NAME, { timeout: 20_000 })
      const muse = empty.getByRole('button', { name: /New Muse session/ })
      await expect(muse).toBeDisabled()
      await expect(empty).not.toContainText('Local only')
      await expect(empty.locator('.field-hint.bad')).toContainText('No Muse account yet')
    } finally {
      await quitAndClose(app)
    }
  })
})
