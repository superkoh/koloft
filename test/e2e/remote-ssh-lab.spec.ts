import { execFileSync } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import type { E2EEnv } from './helpers/env'
import { defaultControlDir } from '../../src/main/remote/ssh'
import {
  addWorkspace,
  centerTerm,
  FAKE_SESSION_TITLE,
  openMenu,
  runIn,
  startSessionIn,
  waitBooted,
  wsGroup,
  wsRows
} from './helpers/p1'
import {
  dockerAvailable,
  installLabSsh,
  LAB_PASSWORD,
  loginsAccepted,
  remoteKeyFor,
  startSshLab,
  stopSshLab,
  type LabAlias,
  type SshLab
} from './helpers/docker'

const BACKGROUND_CONNECT_MS = 45_000
const TEN_SYNC_ROUNDS_WITH_TABS_OPEN_MS = 20_000
const LOGINS_OF_THE_FIRST_FULL_ROUND_SETTLE_MS = 5000
const README = (user: string): string => `# Lab project\n\nkoloft-ssh-lab marker for ${user}.\n`

test.describe.configure({ timeout: 420_000 })
test.beforeAll(() =>
  test.skip(!dockerAvailable(), 'needs a running Docker (for example `colima start`)')
)

async function withLab(
  env: E2EEnv,
  body: (ctx: { app: ElectronApplication; page: Page; lab: SshLab }) => Promise<void>,
  beforeLaunch?: (lab: SshLab) => void
): Promise<void> {
  const lab = await startSshLab(env)
  let app: ElectronApplication | null = null
  try {
    installLabSsh(env, lab)
    beforeLaunch?.(lab)
    app = await launchApp(env)
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await waitBooted(page)
    await body({ app, page, lab })
  } finally {
    if (app) await quitAndClose(app)
    stopSshLab(lab, defaultControlDir())
  }
}

async function addMachine(page: Page, alias: LabAlias, user: string): Promise<void> {
  expect((await addWorkspace(page, remoteKeyFor(alias, user))).code).toBe('added')
}

function dot(page: Page, alias: LabAlias): Locator {
  return wsGroup(page, alias).locator('.ws-conn')
}

function readme(page: Page, alias: LabAlias, user: string): Promise<string> {
  return page.evaluate(
    (p) => window.api.preview.readText(p) as Promise<string>,
    `${remoteKeyFor(alias, user)}/README.md`
  )
}

async function listed(page: Page, alias: LabAlias, user: string): Promise<string[]> {
  const entries = await page.evaluate(
    (p) => window.api.fs.listDir(p) as Promise<{ name: string }[]>,
    remoteKeyFor(alias, user)
  )
  return entries.map((e) => e.name)
}

async function connectsListsAndReads(page: Page, alias: LabAlias, user: string): Promise<void> {
  await expect(dot(page, alias)).toHaveClass(/\bon\b/, { timeout: BACKGROUND_CONNECT_MS })
  expect(await listed(page, alias, user)).toContain('README.md')
  expect(await readme(page, alias, user)).toBe(README(user))
}

async function newSessionAnsweringAtTheTab(
  page: Page,
  alias: LabAlias,
  prompt: string,
  answer: string
): Promise<void> {
  const rows = wsRows(page, alias)
  await openMenu(page, page.locator('.ws-head', { hasText: alias }))
  await page.locator('.menu .mi', { hasText: 'New session' }).click()
  await expect(rows).toHaveCount(1, { timeout: 30_000 })
  await expect(centerTerm(page)).toContainText(prompt, { timeout: 60_000 })
  await runIn(page, centerTerm(page), answer)
  await expect(rows.filter({ hasText: FAKE_SESSION_TITLE })).toHaveCount(1, { timeout: 90_000 })
}

test.describe('remote workspaces against real sshd machines behind a company jump host (Docker)', () => {
  test('E-SSH-01: with a key, through the jump host: connects before any session, lists and reads files, and a session starts and shows up', async ({
    env
  }) => {
    await withLab(env, async ({ page }) => {
      await addMachine(page, 'kt-key', 'kuser')
      await connectsListsAndReads(page, 'kt-key', 'kuser')
      await startSessionIn(page, 'kt-key', { remote: true })
      await expect(dot(page, 'kt-key')).toHaveClass(/\bon\b/)
    })
  })

  test('E-SSH-02: a password login says so on the dot, and once the password is typed in the session tab, files and sessions work', async ({
    env
  }) => {
    await withLab(env, async ({ page }) => {
      await addMachine(page, 'kt-pw', 'puser')
      await expect(dot(page, 'kt-pw')).toHaveAttribute('title', /Permission denied.*sign in/, {
        timeout: BACKGROUND_CONNECT_MS
      })
      await newSessionAnsweringAtTheTab(page, 'kt-pw', 'password:', LAB_PASSWORD)
      await connectsListsAndReads(page, 'kt-pw', 'puser')
    })
  })

  test('E-SSH-03: first contact with a machine says so on the dot; the session tab asks to trust its key, and after yes everything works', async ({
    env
  }) => {
    await withLab(env, async ({ page }) => {
      await addMachine(page, 'kt-newhost', 'kuser')
      await expect(dot(page, 'kt-newhost')).toHaveAttribute(
        'title',
        /Host key verification failed.*sign in/,
        { timeout: BACKGROUND_CONNECT_MS }
      )
      await newSessionAnsweringAtTheTab(page, 'kt-newhost', 'continue connecting', 'yes')
      await connectsListsAndReads(page, 'kt-newhost', 'kuser')
    })
  })

  // PLATFORM§37
  test('E-SSH-04: a machine whose login shell is tcsh, and one whose is fish: files list and read, and sessions start and show up', async ({
    env
  }) => {
    await withLab(env, async ({ page }) => {
      await addMachine(page, 'kt-tcsh', 'tuser')
      await addMachine(page, 'kt-fish', 'fuser')
      await connectsListsAndReads(page, 'kt-tcsh', 'tuser')
      await connectsListsAndReads(page, 'kt-fish', 'fuser')
      await startSessionIn(page, 'kt-tcsh', { remote: true })
      await startSessionIn(page, 'kt-fish', { remote: true })
    })
  })

  // PLATFORM§33
  test('E-SSH-05: a ~/.ssh/config that sets RemoteCommand and RequestTTY force: commands still run, files come back byte for byte, and a session starts', async ({
    env
  }) => {
    await withLab(env, async ({ page }) => {
      await addMachine(page, 'kt-remotecmd', 'kuser')
      await connectsListsAndReads(page, 'kt-remotecmd', 'kuser')
      await startSessionIn(page, 'kt-remotecmd', { remote: true })
    })
  })

  // PLATFORM§1
  test('E-SSH-06: a ProxyCommand tool and an ssh agent that only the login shell sets up: both machines connect before any session', async ({
    env
  }) => {
    const agentSocket = `/tmp/kl-agent-${crypto.randomBytes(4).toString('hex')}.sock`
    const started = execFileSync('/usr/bin/ssh-agent', ['-s', '-a', agentSocket], {
      encoding: 'utf8'
    })
    const agentPid = Number(/SSH_AGENT_PID=(\d+)/.exec(started)?.[1])
    try {
      await withLab(
        env,
        async ({ page }) => {
          await addMachine(page, 'kt-proxycmd', 'kuser')
          await addMachine(page, 'kt-agent', 'kuser')
          await connectsListsAndReads(page, 'kt-proxycmd', 'kuser')
          await connectsListsAndReads(page, 'kt-agent', 'kuser')
        },
        (lab) => {
          delete env.launchEnv.SSH_AUTH_SOCK
          execFileSync('/usr/bin/ssh-add', ['-q', lab.key], {
            env: { ...process.env, SSH_AUTH_SOCK: agentSocket },
            stdio: 'ignore'
          })
          fs.writeFileSync(
            path.join(env.home, '.zprofile'),
            `export PATH="$PATH:${lab.hopDir}"\nexport SSH_AUTH_SOCK=${agentSocket}\n`
          )
        }
      )
    } finally {
      if (agentPid) process.kill(agentPid)
      fs.rmSync(agentSocket, { force: true })
    }
  })

  // PLATFORM§33
  test('E-SSH-07: more tabs than the machine lets one connection hold: background work moves to a connection of its own instead of logging in again every round', async ({
    env
  }) => {
    await withLab(env, async ({ page, lab }) => {
      await addMachine(page, 'kt-few', 'muser')
      await startSessionIn(page, 'kt-few', { remote: true })
      await startSessionIn(page, 'kt-few', { remote: true })
      await connectsListsAndReads(page, 'kt-few', 'muser')

      await page.waitForTimeout(LOGINS_OF_THE_FIRST_FULL_ROUND_SETTLE_MS)
      const before = loginsAccepted(lab, 'muser')
      await page.waitForTimeout(TEN_SYNC_ROUNDS_WITH_TABS_OPEN_MS)
      expect(loginsAccepted(lab, 'muser') - before).toBeLessThanOrEqual(1)
      await expect(dot(page, 'kt-few')).toHaveClass(/\bon\b/)
      expect(await readme(page, 'kt-few', 'muser')).toBe(README('muser'))
    })
  })

  // PLATFORM§34
  test('E-SSH-08: a machine whose shell prints a greeting at login: the dot says so instead of never syncing in silence', async ({
    env
  }) => {
    await withLab(env, async ({ page }) => {
      await addMachine(page, 'kt-noisy', 'nuser')
      await expect(dot(page, 'kt-noisy')).toHaveAttribute('title', /prints text when it starts/, {
        timeout: BACKGROUND_CONNECT_MS
      })
    })
  })
})
