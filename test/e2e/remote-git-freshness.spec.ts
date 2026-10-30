import fs from 'fs'
import path from 'path'
import type { Locator, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { runGit } from './helpers/gitFixture'
import {
  addRemoteWorkspace,
  breakConnection,
  healConnection,
  installFakeRemote,
  killFakeRemote,
  launchWithRemote,
  machineHome,
  REMOTE_HOST,
  REMOTE_WS_NAME,
  remoteDir,
  seedRemoteWorkspace,
  sshCommands
} from './helpers/remote'
import { dialogPrimary, openGitPanel, openWorktreeSession, snap, waitBooted } from './helpers/p1'
import type { E2EEnv } from './helpers/env'

const FIRST_HEARTBEAT_AND_FETCH_MS = 60_000
const RECONNECT_AFTER_BACKED_OFF_HEARTBEATS_MS = 90_000
const SEVERAL_FAILED_HEARTBEATS_MS = 8_000
const DIALOG_SETTLE_MS = 3_000

test.afterEach(({ env }) => killFakeRemote(env))

function machineCheckoutBehindOrigin(env: E2EEnv, behind: number): { author: string } {
  const home = machineHome(env)
  const origin = path.join(home, 'origin.git')
  const author = path.join(home, 'author')
  fs.mkdirSync(origin, { recursive: true })
  fs.mkdirSync(author, { recursive: true })
  runGit(home, 'init', '--bare', '-q', origin)
  runGit(author, 'init', '-q')
  fs.writeFileSync(path.join(author, 'README.md'), '# on the machine\n')
  runGit(author, 'add', '-A')
  runGit(author, 'commit', '-q', '-m', 'init')
  runGit(author, 'remote', 'add', 'origin', `file://${origin}`)
  runGit(author, 'push', '-q', '-u', 'origin', 'main')
  runGit(home, 'clone', '-q', `file://${origin}`, remoteDir(env))
  for (let i = 1; i <= behind; i++) {
    fs.writeFileSync(path.join(author, `upstream-${i}.txt`), `${i}\n`)
    runGit(author, 'add', '-A')
    runGit(author, 'commit', '-q', '-m', `upstream ${i}`)
  }
  if (behind > 0) runGit(author, 'push', '-q', 'origin', 'main')
  return { author }
}

function publishOnOrigin(author: string, name: string): void {
  fs.writeFileSync(path.join(author, `${name}.txt`), `${name}\n`)
  runGit(author, 'add', '-A')
  runGit(author, 'commit', '-q', '-m', name)
  runGit(author, 'push', '-q', 'origin', 'main')
}

function fetchesSent(env: E2EEnv): string[] {
  return sshCommands(env).filter((c) => c.includes('fetch --quiet --no-auto-maintenance'))
}

function remoteHead(page: Page): Locator {
  return page.locator('.ws-head', { hasText: REMOTE_WS_NAME })
}

test.describe('a remote workspace knows how far it is behind origin, asked on the machine itself', () => {
  test('E-RW-35: a remote checkout 2 commits behind shows the amber badge, and Pull fast-forwards it on the machine', async ({
    env
  }) => {
    test.setTimeout(240_000)
    installFakeRemote(env)
    const { author } = machineCheckoutBehindOrigin(env, 2)
    const { app, page } = await launchWithRemote(env)
    try {
      await addRemoteWorkspace(page, env)

      const badge = remoteHead(page).locator('.ws-behind')
      await expect(badge).toHaveText('2', { timeout: FIRST_HEARTBEAT_AND_FETCH_MS })
      await expect(badge).not.toHaveClass(/\binfo\b/)
      const fetch = fetchesSent(env)[0]
      expect(fetch).toContain(remoteDir(env))
      expect(fetch).toContain('BatchMode=yes')

      await badge.click()
      const pop = page.locator('.tbu-pop.fx')
      await expect(pop.locator('.fx-counts')).toContainText('↓ 2 behind')
      await expect(pop.locator('.fx-note')).toContainText('Working tree clean')
      await expect(pop.locator('.tbu-act', { hasText: 'Fetch now' })).toBeEnabled()
      const pull = pop.locator('.tbu-act.pull')
      await expect(pull).toBeEnabled()
      await snap(page, 'E-RW-35-popover')

      await pull.click()
      await expect(page.locator('.toast')).toHaveText(
        new RegExp(`^${REMOTE_WS_NAME} · main: fast-forwarded 2 commits`),
        { timeout: 60_000 }
      )
      await expect(badge).toHaveCount(0)
      expect(runGit(remoteDir(env), 'rev-parse', 'HEAD')).toBe(runGit(author, 'rev-parse', 'HEAD'))
    } finally {
      await quitAndClose(app)
    }
  })

  test('E-RW-36: when the machine cannot reach origin, the git panel names the machine in its alarm', async ({
    env
  }) => {
    test.setTimeout(240_000)
    installFakeRemote(env)
    machineCheckoutBehindOrigin(env, 0)
    runGit(
      remoteDir(env),
      'remote',
      'set-url',
      'origin',
      `file://${path.join(machineHome(env), 'gone.git')}`
    )
    const { app, page } = await launchWithRemote(env)
    try {
      await addRemoteWorkspace(page, env)
      await expect.poll(() => fetchesSent(env).length, { timeout: 60_000 }).toBeGreaterThan(0)

      const panel = await openGitPanel(page, REMOTE_WS_NAME)
      await expect(panel.locator('.fx-note')).toHaveText(
        `can't reach origin from ${REMOTE_HOST} — check its network or credentials.`
      )
      await snap(page, 'E-RW-36')
    } finally {
      await quitAndClose(app)
    }
  })

  test('E-RW-37: a machine that connects late gets its badge on connect, and while it is away Fetch now and Pull are off', async ({
    env
  }) => {
    test.setTimeout(300_000)
    installFakeRemote(env)
    machineCheckoutBehindOrigin(env, 2)
    seedRemoteWorkspace(env)
    breakConnection(env)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await waitBooted(page)
      await expect(remoteHead(page)).toBeVisible({ timeout: 30_000 })
      await page.waitForTimeout(SEVERAL_FAILED_HEARTBEATS_MS)
      expect(fetchesSent(env)).toEqual([])
      await expect(remoteHead(page).locator('.ws-behind')).toHaveCount(0)

      healConnection(env)
      const badge = remoteHead(page).locator('.ws-behind')
      await expect(badge).toHaveText('2', { timeout: RECONNECT_AFTER_BACKED_OFF_HEARTBEATS_MS })

      breakConnection(env)
      await expect(remoteHead(page).locator('.ws-conn')).not.toHaveClass(/\bon\b/, {
        timeout: 60_000
      })
      await badge.click()
      const pop = page.locator('.tbu-pop.fx')
      await expect(pop.locator('.fx-counts')).toContainText('↓ 2 behind')
      await expect(pop.locator('.tbu-act.pull')).toBeDisabled()
      await expect(pop.locator('.tbu-act', { hasText: 'Fetch now' })).toBeDisabled()
      await snap(page, 'E-RW-37-away')
    } finally {
      await quitAndClose(app)
    }
  })

  test('E-RW-38: C8 fetches on the machine when it opens, so a commit pushed since the last sweep turns Create into Pull & Start; while the machine is away it fetches nothing and shows the last result', async ({
    env
  }) => {
    test.setTimeout(300_000)
    installFakeRemote(env)
    const { author } = machineCheckoutBehindOrigin(env, 2)
    const { app, page } = await launchWithRemote(env)
    try {
      await addRemoteWorkspace(page, env)
      const badge = remoteHead(page).locator('.ws-behind')
      await expect(badge).toHaveText('2', { timeout: FIRST_HEARTBEAT_AND_FETCH_MS })

      publishOnOrigin(author, 'after-sweep')
      const beforeOpen = fetchesSent(env).length
      const dlg = await openWorktreeSession(page, REMOTE_WS_NAME)
      const line = dlg.locator('.fresh-line.stale')
      await expect(line).toContainText('main is 3 commits behind origin/main', {
        timeout: 30_000
      })
      await expect(line).toContainText('Pull & Start will fast-forward first.')
      await expect(dialogPrimary(dlg)).toContainText('Pull & Start')
      await page.waitForTimeout(DIALOG_SETTLE_MS)
      expect(fetchesSent(env).length).toBe(beforeOpen + 1)
      await snap(page, 'E-RW-38-fetched-on-open')
      await page.keyboard.press('Escape')
      await expect(dlg).toHaveCount(0)

      breakConnection(env)
      await expect(remoteHead(page).locator('.ws-conn')).not.toHaveClass(/\bon\b/, {
        timeout: 60_000
      })
      publishOnOrigin(author, 'while-away')
      const beforeAway = fetchesSent(env).length
      const away = await openWorktreeSession(page, REMOTE_WS_NAME)
      await expect(away.locator('.fresh-line.stale')).toContainText(
        'main is 3 commits behind origin/main'
      )
      await page.waitForTimeout(DIALOG_SETTLE_MS)
      await expect(away.getByText('Checking origin…')).toHaveCount(0)
      expect(fetchesSent(env).length).toBe(beforeAway)
      await snap(page, 'E-RW-38-away')
    } finally {
      await quitAndClose(app)
    }
  })
})
