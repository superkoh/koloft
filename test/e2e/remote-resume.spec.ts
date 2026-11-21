import fs from 'fs'
import http from 'http'
import type { AddressInfo } from 'net'
import path from 'path'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { addKeychainEntry, seededAccount, seedSettings, type E2EEnv } from './helpers/env'
import {
  installFakeRemote,
  killFakeRemote,
  REMOTE_HOST,
  REMOTE_WS_NAME,
  remoteDir,
  remoteKey,
  seedRemoteWorkspace,
  sshCommands
} from './helpers/remote'
import {
  readCalls,
  resumedId,
  seedJsonl,
  startSessionIn,
  waitBooted,
  waitForCalls,
  wsRows
} from './helpers/p1'
import { NO_USABLE_ACCOUNT } from '../../src/shared/accountUsage'

test.afterEach(({ env }) => killFakeRemote(env))

const NOTHING_LISTENS = 'http://127.0.0.1:1'

const oauthToken = (name: string): string => `sk-ant-oat01-fixture-${name}`

async function startWeekUseServer(
  env: E2EEnv,
  weekUseByAccount: Record<string, number>
): Promise<http.Server> {
  const weekUse = new Map(
    Object.entries(weekUseByAccount).map(([name, use]) => [oauthToken(name), use])
  )
  const probe = http.createServer((req, res) => {
    const token = String(req.headers['authorization'] ?? '').replace(/^Bearer /, '')
    const use = weekUse.get(token) ?? 0
    req.resume()
    req.on('end', () => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'anthropic-ratelimit-unified-5h-utilization': '0.1',
        'anthropic-ratelimit-unified-7d-utilization': String(use),
        'anthropic-ratelimit-unified-5h-status': 'allowed',
        'anthropic-ratelimit-unified-7d-status': use >= 1 ? 'rejected' : 'allowed'
      })
      res.end('{}')
    })
  })
  await new Promise<void>((ok) => probe.listen(0, '127.0.0.1', ok))
  env.launchEnv.KOLOFT_PROBE_BASE_URL = `http://127.0.0.1:${(probe.address() as AddressInfo).port}`
  for (const name of Object.keys(weekUseByAccount))
    addKeychainEntry(env, 'koloft-dev-claude-oauth', name, oauthToken(name))
  seedSettings(env, { accounts: Object.keys(weekUseByAccount).map((n) => seededAccount(n)) })
  return probe
}

test.describe('resuming a cold remote row from the mirror, never as a local path', () => {
  test('E-RW-09: clicking a cold remote row resumes it on the machine with no dialog', async ({
    env
  }) => {
    test.setTimeout(240_000)
    installFakeRemote(env)
    seedRemoteWorkspace(env)
    const seeded = seedJsonl(env, remoteDir(env), {
      root: path.join(env.userData, 'remote', REMOTE_HOST, 'projects'),
      cwd: remoteDir(env),
      summary: 'Yesterday on the build machine'
    })

    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await waitBooted(page)

      const row = wsRows(page, REMOTE_WS_NAME).first()
      await expect(row).toBeVisible({ timeout: 30_000 })
      await expect(row).toHaveClass(/\bcold\b/)
      await expect(row).toContainText('Yesterday on the build machine')

      await row.click()

      await expect(page.locator('.modal')).toHaveCount(0)
      const calls = await waitForCalls(env, 1, 90_000)
      const last = calls[calls.length - 1]
      expect(resumedId(last)).toBe(seeded)
      expect(last.cwd).toBe(remoteDir(env))
      expect(sshCommands(env).some((c) => /tabs\/[^"]+\.sh"?\s+start/.test(c))).toBe(true)
      await expect(page.locator('.modal')).toHaveCount(0)
      await expect(row).not.toHaveClass(/\bcold\b/, { timeout: 60_000 })
    } finally {
      await quitAndClose(app)
    }
  })

  test('a cold remote row resumes on the account the session last ran on while it has room, even when another account is lighter', async ({
    env
  }) => {
    test.setTimeout(240_000)
    const probe = await startWeekUseServer(env, { alpha: 0.1, bravo: 0.8 })
    installFakeRemote(env)
    seedRemoteWorkspace(env)
    const seeded = seedJsonl(env, remoteDir(env), {
      root: path.join(env.userData, 'remote', REMOTE_HOST, 'projects'),
      cwd: remoteDir(env),
      summary: 'Yesterday on the build machine'
    })
    fs.writeFileSync(
      path.join(env.userData, 'session-accounts.json'),
      JSON.stringify({ [`claude:${seeded}`]: 'bravo' })
    )

    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await waitBooted(page)
      const row = wsRows(page, REMOTE_WS_NAME).first()
      await expect(row).toHaveClass(/\bcold\b/, { timeout: 30_000 })
      await row.click()
      const calls = await waitForCalls(env, 1, 90_000)
      const last = calls[calls.length - 1]
      expect(resumedId(last)).toBe(seeded)
      expect(last.oauthToken).toBe(oauthToken('bravo'))
    } finally {
      await quitAndClose(app)
      await new Promise((ok) => probe.close(ok))
    }
  })

  test('after Koloft is reopened, the first remote Claude session started while no usage can be read runs on the machine in the account that had room when Koloft was last open, not the full one listed first', async ({
    env
  }) => {
    test.setTimeout(240_000)
    const probe = await startWeekUseServer(env, { alpha: 1, bravo: 0.1 })
    installFakeRemote(env)
    seedRemoteWorkspace(env)
    const lastOpen = await launchApp(env)
    try {
      const page = await lastOpen.firstWindow()
      await waitBooted(page)
      await expect
        .poll(
          async () =>
            (await page.evaluate(() => window.api.accounts.probe())).filter((a) => a.usage).length,
          { timeout: 30_000 }
        )
        .toBe(2)
    } finally {
      await quitAndClose(lastOpen)
      await new Promise((ok) => probe.close(ok))
    }

    env.launchEnv.KOLOFT_PROBE_BASE_URL = NOTHING_LISTENS
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await startSessionIn(page, REMOTE_WS_NAME, { remote: true })
      const [call] = await waitForCalls(env, 1, 90_000)
      expect(call.oauthToken).toBe(oauthToken('bravo'))
    } finally {
      await quitAndClose(app)
    }
  })

  test('a remote row resumed on a custom endpoint account that pins a model Claude Code does not know runs with the context capped at 200k on the machine', async ({
    env
  }) => {
    test.setTimeout(240_000)
    addKeychainEntry(env, 'koloft-dev-custom-endpoint', 'glm', 'custom-endpoint-fixture-token')
    seedSettings(env, {
      accounts: [
        {
          name: 'glm',
          kind: 'custom',
          enabled: true,
          fable: 'unknown',
          status: 'ok',
          addedAt: 1,
          baseUrl: 'https://custom-endpoint.invalid/api',
          model: 'glm-5.2'
        }
      ]
    })
    installFakeRemote(env)
    seedRemoteWorkspace(env)
    seedJsonl(env, remoteDir(env), {
      root: path.join(env.userData, 'remote', REMOTE_HOST, 'projects'),
      cwd: remoteDir(env),
      summary: 'Yesterday on the build machine'
    })

    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await waitBooted(page)
      const row = wsRows(page, REMOTE_WS_NAME).first()
      await expect(row).toHaveClass(/\bcold\b/, { timeout: 30_000 })
      await row.click()
      const calls = await waitForCalls(env, 1, 90_000)
      expect(calls[calls.length - 1].disable1mContext).toBe('1')
    } finally {
      await quitAndClose(app)
    }
  })

  function seedRemoteRowWithNoUsableAccount(env: E2EEnv): string {
    seedSettings(env, { accounts: [seededAccount('no-secret-in-the-keychain')] })
    installFakeRemote(env)
    seedRemoteWorkspace(env)
    return seedJsonl(env, remoteDir(env), {
      root: path.join(env.userData, 'remote', REMOTE_HOST, 'projects'),
      cwd: remoteDir(env),
      summary: 'Yesterday on the build machine'
    })
  }

  test('clicking a cold remote Claude row while no Koloft account can be used says why in the toast, not just "Resume failed", and starts nothing', async ({
    env
  }) => {
    test.setTimeout(240_000)
    seedRemoteRowWithNoUsableAccount(env)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await waitBooted(page)
      const row = wsRows(page, REMOTE_WS_NAME).first()
      await expect(row).toHaveClass(/\bcold\b/, { timeout: 30_000 })
      await row.click()
      await expect(page.locator('.toast-msg')).toContainText(NO_USABLE_ACCOUNT.claude, {
        timeout: 60_000
      })
      expect(readCalls(env)).toEqual([])
      await expect(row).toHaveClass(/\bcold\b/)
    } finally {
      await quitAndClose(app)
    }
  })

  test('reopening a remote Claude tab after a restart while no Koloft account can be used names the session and says why in the toast, not just "click it to try again", and starts nothing', async ({
    env
  }) => {
    test.setTimeout(240_000)
    const seeded = seedRemoteRowWithNoUsableAccount(env)
    fs.writeFileSync(
      path.join(env.userData, 'open-tabs.json'),
      JSON.stringify({
        tabs: [
          {
            sessionId: seeded,
            kind: 'claude',
            title: 'Yesterday on the build machine',
            cwd: remoteKey(env)
          }
        ],
        active: seeded
      })
    )
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await expect(page.locator('.toast-msg')).toContainText(
        `Could not start “Yesterday on the build machine” — ${NO_USABLE_ACCOUNT.claude}`,
        { timeout: 90_000 }
      )
      expect(readCalls(env)).toEqual([])
      await expect(wsRows(page, REMOTE_WS_NAME).first()).toHaveClass(/\bcold\b/)
    } finally {
      await quitAndClose(app)
    }
  })
})
