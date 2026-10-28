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
import { readCalls, resumedId, seedJsonl, waitBooted, waitForCalls, wsRows } from './helpers/p1'
import { NO_USABLE_ACCOUNT } from '../../src/shared/accountUsage'

test.afterEach(({ env }) => killFakeRemote(env))

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
    const tokens = { alpha: 'sk-ant-oat01-fixture-alpha', bravo: 'sk-ant-oat01-fixture-bravo' }
    const fiveHourUse: Record<string, number> = { [tokens.alpha]: 0.1, [tokens.bravo]: 0.8 }
    const probe = http.createServer((req, res) => {
      const token = String(req.headers['authorization'] ?? '').replace(/^Bearer /, '')
      req.resume()
      req.on('end', () => {
        res.writeHead(200, {
          'content-type': 'application/json',
          'anthropic-ratelimit-unified-5h-utilization': String(fiveHourUse[token] ?? 0),
          'anthropic-ratelimit-unified-7d-utilization': '0.2',
          'anthropic-ratelimit-unified-5h-status': 'allowed',
          'anthropic-ratelimit-unified-7d-status': 'allowed'
        })
        res.end('{}')
      })
    })
    await new Promise<void>((ok) => probe.listen(0, '127.0.0.1', ok))
    env.launchEnv.KOLOFT_PROBE_BASE_URL = `http://127.0.0.1:${(probe.address() as AddressInfo).port}`
    for (const [name, token] of Object.entries(tokens))
      addKeychainEntry(env, 'koloft-dev-claude-oauth', name, token)
    seedSettings(env, { accounts: [seededAccount('alpha'), seededAccount('bravo')] })
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
      expect(last.oauthToken).toBe(tokens.bravo)
    } finally {
      await quitAndClose(app)
      await new Promise((ok) => probe.close(ok))
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
