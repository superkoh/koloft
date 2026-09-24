import fs from 'fs'
import path from 'path'
import http from 'http'
import type { AddressInfo } from 'net'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { test, expect, launchApp } from './helpers/app'
import { seedSettings, type E2EEnv } from './helpers/env'
import { centerTerm, runIn, startSessionIn, waitBooted } from './helpers/p1'

const TOKENS: Record<string, string> = {
  alpha: 'sk-ant-oat01-fixture-alpha',
  bravo: 'sk-ant-oat01-fixture-bravo',
  charlie: 'sk-ant-oat01-fixture-charlie',
  'api-main': 'sk-ant-api03-fixture-api'
}

const UNPACKAGED_BUILD_OAUTH_SVC_SPELLED_OUT_NOT_IMPORTED = 'koloft-dev-claude-oauth'
const UNPACKAGED_BUILD_APIKEY_SVC_SPELLED_OUT_NOT_IMPORTED = 'koloft-dev-anthropic-api'
const UNPACKAGED_BUILD_CUSTOM_SVC_SPELLED_OUT_NOT_IMPORTED = 'koloft-dev-custom-endpoint'

const LET_THE_FIRST_SESSION_EXIT_MS = 800
const COLD_STATUSLINE_RENDER_MS = 40_000
const ROOM_FOR_A_WRONG_REFETCH_MS = 1_000

function seedKeychain(env: E2EEnv): void {
  fs.writeFileSync(
    env.keychainFile,
    JSON.stringify({
      [UNPACKAGED_BUILD_OAUTH_SVC_SPELLED_OUT_NOT_IMPORTED]: {
        alpha: TOKENS.alpha,
        bravo: TOKENS.bravo,
        charlie: TOKENS.charlie
      },
      [UNPACKAGED_BUILD_APIKEY_SVC_SPELLED_OUT_NOT_IMPORTED]: { 'api-main': TOKENS['api-main'] }
    })
  )
}

function acct(name: string, kind: 'oauth' | 'apikey' = 'oauth'): Record<string, unknown> {
  return { name, kind, enabled: true, fable: 'unknown', status: 'ok', addedAt: 1 }
}

function seedPool(env: E2EEnv, extra: Record<string, unknown> = {}): void {
  seedKeychain(env)
  seedSettings(env, {
    multiAccount: true,
    accounts: [acct('alpha'), acct('bravo'), acct('charlie'), acct('api-main', 'apikey')],
    ...extra
  })
}

interface BucketScript {
  u5?: number
  u7?: number
  uoi?: number
  s5?: string
  status?: number
  hang?: boolean
  answerAfterMs?: number
}

interface ProbeMock {
  base: string
  script: Map<string, BucketScript>
  requests: string[]
  models: string[]
  close(): Promise<void>
}

// CC§7
async function startProbeMock(): Promise<ProbeMock> {
  const script = new Map<string, BucketScript>()
  const requests: string[] = []
  const models: string[] = []
  const nowSec = Math.floor(Date.now() / 1000)
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', async () => {
      const auth = String(req.headers['authorization'] ?? req.headers['x-api-key'] ?? '')
      const token = auth.replace(/^Bearer /, '')
      requests.push(token)
      models.push(String((JSON.parse(raw || '{}') as { model?: unknown }).model ?? ''))
      const s = script.get(token) ?? {}
      if (s.hang) return
      if (s.answerAfterMs) await new Promise((ok) => setTimeout(ok, s.answerAfterMs))
      if (s.status && s.status !== 200) {
        res.writeHead(s.status, { 'content-type': 'application/json' })
        res.end('{}')
        return
      }
      res.writeHead(200, {
        'content-type': 'application/json',
        'anthropic-ratelimit-unified-5h-utilization': String(s.u5 ?? 0.1),
        'anthropic-ratelimit-unified-7d-utilization': String(s.u7 ?? 0.2),
        'anthropic-ratelimit-unified-7d_oi-utilization': String(s.uoi ?? 0.3),
        'anthropic-ratelimit-unified-5h-status': s.s5 ?? 'allowed',
        'anthropic-ratelimit-unified-7d-status': 'allowed',
        'anthropic-ratelimit-unified-7d_oi-status': 'allowed',
        'anthropic-ratelimit-unified-5h-reset': String(nowSec + 7200),
        'anthropic-ratelimit-unified-7d-reset': String(nowSec + 200000),
        'anthropic-ratelimit-unified-7d_oi-reset': String(nowSec + 200000)
      })
      res.end('{}')
    })
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    script,
    requests,
    models,
    close: () => new Promise((ok) => server.close(() => ok()))
  }
}

interface CallRecord {
  pid: number
  argv: string[]
  sessionId: string
  oauthToken: string | null
  apiKey: string | null
}

function readCalls(env: E2EEnv): CallRecord[] {
  if (!fs.existsSync(env.claudeCalls)) return []
  return fs
    .readFileSync(env.claudeCalls, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as CallRecord)
}

async function waitForCalls(env: E2EEnv, n: number, timeoutMs = 30_000): Promise<CallRecord[]> {
  const t0 = Date.now()
  for (;;) {
    const calls = readCalls(env)
    if (calls.length >= n) return calls
    if (Date.now() - t0 > timeoutMs) throw new Error(`waited ${timeoutMs}ms for ${n} claude calls`)
    await new Promise((ok) => setTimeout(ok, 200))
  }
}

async function visibleTerminalText(page: Page): Promise<string> {
  return centerTerm(page).innerText()
}

async function launchConfigured(env: E2EEnv): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launchApp(env)
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

async function openSettings(page: Page): Promise<void> {
  await page.locator('.tb-ico[title="Settings"]').click()
  await page.locator('.modal').waitFor({ state: 'visible' })
}

function scanForTokens(root: string, skip: (p: string) => boolean): string[] {
  const hits: string[] = []
  const tokens = Object.values(TOKENS)
  const walk = (dir: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (skip(full)) continue
      if (e.isDirectory()) walk(full)
      else if (e.isFile()) {
        let data = ''
        try {
          data = fs.readFileSync(full, 'latin1')
        } catch {
          continue
        }
        for (const t of tokens) if (data.includes(t)) hits.push(`${full} ← ${t}`)
      }
    }
  }
  walk(root)
  return hits
}

function claudeAccounts(page: Page): Locator {
  return page.locator('.acct-section').first()
}

test('E1: settings CRUD — no launch-command field, only the verifiable add entries (Sign in, Paste token), an inline delete that also removes the Keychain secret, persistence, stale key ignored', async ({
  env
}) => {
  test.setTimeout(120_000)
  const mock = await startProbeMock()
  env.launchEnv.KOLOFT_PROBE_BASE_URL = mock.base
  seedSettings(env, { claudeCommand: 'stale-wrapper', multiAccount: true })
  seedKeychain(env)

  let app = await launchApp(env)
  try {
    let page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await openSettings(page)

    await expect(page.locator('.modal')).not.toContainText('Claude launch command')
    await expect(
      claudeAccounts(page).locator('.acct-foot button', { hasText: 'Sign in' })
    ).toBeVisible()
    await expect(
      claudeAccounts(page).locator('.acct-foot button', { hasText: 'Paste token' })
    ).toBeVisible()
    await expect(
      claudeAccounts(page).locator('.acct-foot button', { hasText: 'API key' })
    ).toHaveCount(0)
    await expect(
      claudeAccounts(page).locator('.acct-foot button', { hasText: 'Custom endpoint' })
    ).toHaveCount(0)
    await expect(claudeAccounts(page).locator('.acct-foot button')).toHaveCount(3)

    await expect(claudeAccounts(page).locator('.acct-empty')).toBeVisible()

    await claudeAccounts(page).locator('.acct-foot button', { hasText: 'Paste token' }).click()
    await page.locator('.acct-add input[type="text"]').fill('bravo')
    await page.locator('.acct-add input[type="password"]').fill(TOKENS.bravo)
    await page.locator('.acct-add-actions button', { hasText: 'Verify and save' }).click()
    await expect(page.locator('.acct-row')).toHaveCount(1, { timeout: 15_000 })
    await expect(page.locator('.acct-name')).toHaveText('bravo')
    await expect(page.locator('.acct-badge.fable')).toBeVisible()

    await page.locator('.acct-row input[type="checkbox"]').first().uncheck()
    await expect(page.locator('.acct-row.off')).toHaveCount(1)

    const kc = JSON.parse(fs.readFileSync(env.keychainFile, 'utf8'))
    expect(kc[UNPACKAGED_BUILD_OAUTH_SVC_SPELLED_OUT_NOT_IMPORTED].bravo).toBe(TOKENS.bravo)

    await app.close()
    app = await launchApp(env)
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await openSettings(page)
    await expect(page.locator('.acct-row.off')).toHaveCount(1)

    await claudeAccounts(page).locator('.acct-foot button', { hasText: 'Refresh usage' }).click()
    await expect(
      claudeAccounts(page).locator('.acct-foot button', { hasText: 'Updated' })
    ).toBeVisible({
      timeout: 15_000
    })
    await expect(
      claudeAccounts(page).locator('.acct-foot button', { hasText: 'Refresh usage' })
    ).toBeVisible({
      timeout: 15_000
    })

    await page.locator('.acct-x').click()
    await page.locator('.acct-confirm button', { hasText: 'Delete' }).click()
    await expect(page.locator('.acct-row')).toHaveCount(0)
    const kc2 = JSON.parse(fs.readFileSync(env.keychainFile, 'utf8'))
    expect(kc2[UNPACKAGED_BUILD_OAUTH_SVC_SPELLED_OUT_NOT_IMPORTED].bravo).toBeUndefined()

    expect(scanForTokens(env.userData, () => false)).toEqual([])
  } finally {
    await app.close().catch(() => {})
    await mock.close()
  }
})

test('E2: mode off → no injection, no banner, no chip; a runtime toggle reaches the next launch', async ({
  env,
  page
}) => {
  test.setTimeout(120_000)
  seedPool(env, { multiAccount: false })
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')
  const [first] = await waitForCalls(env, 1)
  expect(first.oauthToken).toBeNull()
  expect(first.apiKey).toBeNull()
  const text = await visibleTerminalText(page)
  expect(text).not.toContain('koloft: →')
  await expect(page.locator('.ws-acct-chip')).toHaveCount(0)
  await expect(page.locator('.island .acct-meter')).toHaveCount(0)

  await page.evaluate(() => window.api.settings.set({ multiAccount: true }))
  await runIn(page, centerTerm(page), '/exit')
  await page.waitForTimeout(LET_THE_FIRST_SESSION_EXIT_MS)
  await startSessionIn(page, 'ws-a')
  const calls = await waitForCalls(env, 2)
  expect(calls[1].oauthToken).not.toBeNull()
})

test('E3: picks the least-loaded account; the shim banner says so', async ({ env }) => {
  test.setTimeout(120_000)
  const mock = await startProbeMock()
  mock.script.set(TOKENS.alpha, { u5: 0.9, u7: 0.5, uoi: 0.4 })
  mock.script.set(TOKENS.bravo, { u5: 0.33, u7: 0.52, uoi: 0.34 })
  mock.script.set(TOKENS['charlie'], { u5: 0.96, u7: 0.58, uoi: 0.2 })
  env.launchEnv.KOLOFT_PROBE_BASE_URL = mock.base
  seedPool(env)
  const { app, page } = await launchConfigured(env)
  try {
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    const [call] = await waitForCalls(env, 1)
    expect(call.oauthToken).toBe(TOKENS.bravo)
    expect(call.apiKey).toBeNull()
    await expect(page.locator('.term-wrap:visible .xterm')).toContainText('koloft: → bravo', {
      timeout: 10_000
    })
    await expect(page.locator('.ws-acct-chip')).toHaveCount(0)
  } finally {
    await app.close().catch(() => {})
    await mock.close()
  }
})

test('E12: the picked account reaches the embedded statusline’s account segment — the shim re-exports it, since ptyManager strips the old wrapper tag', async ({
  env
}) => {
  test.setTimeout(120_000)
  const mock = await startProbeMock()
  mock.script.set(TOKENS.alpha, { u5: 0.9 })
  mock.script.set(TOKENS.bravo, { u5: 0.1 })
  mock.script.set(TOKENS.charlie, { u5: 0.8 })
  env.launchEnv.KOLOFT_PROBE_BASE_URL = mock.base
  seedPool(env)
  const { app, page } = await launchConfigured(env)
  try {
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    const [call] = await waitForCalls(env, 1)
    expect(call.oauthToken).toBe(TOKENS.bravo)

    const out = path.join(env.home, 'fake-claude-statusline.out')
    await expect
      .poll(
        () => {
          try {
            return fs.readFileSync(out, 'utf8')
          } catch {
            return ''
          }
        },
        { timeout: COLD_STATUSLINE_RENDER_MS }
      )
      .toContain('bravo')
  } finally {
    await app.close().catch(() => {})
    await mock.close()
  }
})

test('E4: API-key fallback only past grace; fable badge from a 404 probe', async ({ env }) => {
  test.setTimeout(150_000)
  const mock = await startProbeMock()
  for (const t of [TOKENS.alpha, TOKENS.bravo, TOKENS['charlie']]) {
    mock.script.set(t, { u5: 1, s5: 'rejected' })
  }
  env.launchEnv.KOLOFT_PROBE_BASE_URL = mock.base
  seedPool(env)
  const { app, page } = await launchConfigured(env)
  try {
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    const [call] = await waitForCalls(env, 1)
    expect(call.apiKey).toBe(TOKENS['api-main'])
    expect(call.oauthToken).toBeNull()
    await expect(page.locator('.term-wrap:visible .xterm')).toContainText('metered', {
      timeout: 10_000
    })
  } finally {
    await app.close().catch(() => {})
    await mock.close()
  }
})

test('E4b: rejected but resetting inside grace → stays on subscriptions (no spending)', async ({
  env
}) => {
  test.setTimeout(120_000)
  const mock = await startProbeMock()
  const nowSec = Math.floor(Date.now() / 1000)
  mock.script.set(TOKENS.alpha, { u5: 1, s5: 'rejected' })
  mock.script.set(TOKENS['charlie'], { u5: 1, s5: 'rejected' })
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const auth = String(req.headers['authorization'] ?? '')
      const token = auth.replace(/^Bearer /, '')
      if (token !== TOKENS.bravo) {
        res.writeHead(200, {
          'anthropic-ratelimit-unified-5h-utilization': '1',
          'anthropic-ratelimit-unified-5h-status': 'rejected',
          'anthropic-ratelimit-unified-5h-reset': String(nowSec + 7200),
          'anthropic-ratelimit-unified-7d-utilization': '0.5',
          'anthropic-ratelimit-unified-7d-status': 'allowed',
          'anthropic-ratelimit-unified-7d-reset': String(nowSec + 200000)
        })
      } else {
        res.writeHead(200, {
          'anthropic-ratelimit-unified-5h-utilization': '1',
          'anthropic-ratelimit-unified-5h-status': 'rejected',
          'anthropic-ratelimit-unified-5h-reset': String(nowSec + 300),
          'anthropic-ratelimit-unified-7d-utilization': '0.5',
          'anthropic-ratelimit-unified-7d-status': 'allowed',
          'anthropic-ratelimit-unified-7d-reset': String(nowSec + 200000)
        })
      }
      res.end('{}')
    })
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  env.launchEnv.KOLOFT_PROBE_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  seedPool(env)
  const { app, page } = await launchConfigured(env)
  try {
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    const [call] = await waitForCalls(env, 1)
    expect(call.apiKey).toBeNull()
    expect(call.oauthToken).toBe(TOKENS.bravo)
  } finally {
    await app.close().catch(() => {})
    await new Promise((ok) => server.close(ok))
    await mock.close()
  }
})

test.describe('usage capsule: a startup round unasked, hover to open, refetch only what is missing or stale', () => {
  const HOVER_REOPEN_GUARD_MS = 600
  test('capsule: a startup round fills it unasked, hover opens it upward inside the window, hovering fresh numbers costs nothing, and a click-dismiss does not spring back', async ({
    env
  }) => {
    test.setTimeout(120_000)
    const mock = await startProbeMock()
    env.launchEnv.KOLOFT_PROBE_BASE_URL = mock.base
    seedPool(env)
    const { app, page } = await launchConfigured(env)
    try {
      const capsule = page.locator('.tbu')
      const pop = page.locator('.tbu-pop')
      await capsule.waitFor({ state: 'visible' })
      await expect.poll(() => mock.requests.length, { timeout: 20_000 }).toBe(4)
      await expect(capsule.locator('.tbu-bar:not(.total) .tbu-fill')).toHaveCount(3)

      await expect(pop).toBeHidden()
      await capsule.hover()
      await expect(pop).toBeVisible()
      await expect(pop.locator('.tbu-grid').first()).toBeVisible()
      const cap = (await capsule.boundingBox())!
      const card = (await pop.boundingBox())!
      const viewH = await page.evaluate(() => window.innerHeight)
      expect(card.y + card.height).toBeLessThanOrEqual(cap.y)
      expect(card.y).toBeGreaterThanOrEqual(0)
      expect(card.y + card.height).toBeLessThanOrEqual(viewH)

      await page.mouse.move(4, 400)
      await expect(pop).toBeHidden()
      await capsule.hover()
      await expect(pop).toBeVisible()
      await page.waitForTimeout(ROOM_FOR_A_WRONG_REFETCH_MS)
      expect(mock.requests.length).toBe(4)

      await capsule.click()
      await expect(pop).toBeHidden()
      await page.waitForTimeout(HOVER_REOPEN_GUARD_MS)
      await expect(pop).toBeHidden()
      await capsule.click()
      await expect(pop).toBeVisible()
    } finally {
      await app.close().catch(() => {})
      await mock.close()
    }
  })

  test('capsule: one account failing does not make the pool look fresh — hovering refetches the account with no number', async ({
    env
  }) => {
    test.setTimeout(120_000)
    const mock = await startProbeMock()
    mock.script.set(TOKENS.charlie, { status: 500 })
    env.launchEnv.KOLOFT_PROBE_BASE_URL = mock.base
    seedPool(env)
    const { app, page } = await launchConfigured(env)
    try {
      const capsule = page.locator('.tbu')
      await capsule.waitFor({ state: 'visible' })
      await expect.poll(() => mock.requests.length, { timeout: 20_000 }).toBe(4)
      await expect(capsule.locator('.tbu-bar:not(.total) .tbu-fill')).toHaveCount(2)

      mock.script.set(TOKENS.charlie, {})
      await capsule.hover()
      await expect(page.locator('.tbu-pop')).toBeVisible()
      await expect(capsule.locator('.tbu-bar:not(.total) .tbu-fill')).toHaveCount(3, {
        timeout: 20_000
      })
      expect(mock.requests.length).toBe(8)
    } finally {
      await app.close().catch(() => {})
      await mock.close()
    }
  })

  test('capsule: what the startup round failed to fetch, opening the panel refetches', async ({
    env
  }) => {
    test.setTimeout(120_000)
    const mock = await startProbeMock()
    for (const t of Object.values(TOKENS)) mock.script.set(t, { status: 500 })
    env.launchEnv.KOLOFT_PROBE_BASE_URL = mock.base
    seedPool(env)
    const { app, page } = await launchConfigured(env)
    try {
      const capsule = page.locator('.tbu')
      await capsule.waitFor({ state: 'visible' })
      await expect.poll(() => mock.requests.length, { timeout: 20_000 }).toBe(4)
      await expect(capsule.locator('.tbu-fill')).toHaveCount(0)

      for (const t of Object.values(TOKENS)) mock.script.set(t, {})
      await capsule.hover()
      const pop = page.locator('.tbu-pop')
      await expect(pop).toBeVisible()
      await expect(pop.locator('.tbu-rows .tbu-grid').first()).toBeVisible({ timeout: 20_000 })
      await expect.poll(() => mock.requests.length, { timeout: 20_000 }).toBe(8)
    } finally {
      await app.close().catch(() => {})
      await mock.close()
    }
  })
})

test.describe('pool surfaces: the aggregate is the mean of exactly the measured members, and walls at the same instant a member does', () => {
  test('pool: three measured accounts draw a wider, leading total bar at their mean (not a copy of one member), and lead the panel with a POOL row', async ({
    env
  }) => {
    test.setTimeout(120_000)
    const mock = await startProbeMock()
    mock.script.set(TOKENS.alpha, { u5: 0.2, u7: 0.2 })
    mock.script.set(TOKENS.bravo, { u5: 0.4, u7: 0.2 })
    mock.script.set(TOKENS.charlie, { u5: 0.6, u7: 0.2 })
    env.launchEnv.KOLOFT_PROBE_BASE_URL = mock.base
    seedPool(env)
    const { app, page } = await launchConfigured(env)
    try {
      const capsule = page.locator('.tbu')
      await capsule.waitFor({ state: 'visible' })
      await expect.poll(() => mock.requests.length, { timeout: 20_000 }).toBe(4)
      await expect(capsule.locator('.tbu-bar:not(.total) .tbu-fill')).toHaveCount(3)
      await expect(capsule.locator('.tbu-bar.total')).toHaveCount(1)
      await expect(capsule.locator('.tbu-bar:not(.total)')).toHaveCount(3)

      const total = capsule.locator('.tbu-bar.total')
      const member = capsule.locator('.tbu-bar:not(.total)').first()
      const totalBox = (await total.boundingBox())!
      const memberBox = (await member.boundingBox())!
      expect(totalBox.width).toBeGreaterThan(memberBox.width)
      expect(totalBox.x).toBeLessThan(memberBox.x)

      const fillBox = (await total.locator('.tbu-fill').boundingBox())!
      const frac = fillBox.height / totalBox.height
      expect(frac).toBeGreaterThan(0.3)
      expect(frac).toBeLessThan(0.5)

      await capsule.hover()
      const pop = page.locator('.tbu-pop')
      await expect(pop).toBeVisible()
      const pool = pop.locator('.tbu-row.pool')
      await expect(pool).toBeVisible()
      await expect(pool).toHaveAttribute('role', 'group')
      await expect(pool.locator('.tbu-pool-meta')).toContainText('3 measured')
      await expect(pool.locator('.tbu-pool-meta')).toContainText('3 usable')
      const pct = Number.parseInt(
        await pool.locator('.acct-meter[data-win="5h"] .m-pct').innerText(),
        10
      )
      expect(pct).toBeGreaterThan(30)
      expect(pct).toBeLessThan(50)
      const firstAcct = (await pop.locator('.tbu-rows .tbu-row').first().boundingBox())!
      expect((await pool.boundingBox())!.y).toBeLessThan(firstAcct.y)
    } finally {
      await app.close().catch(() => {})
      await mock.close()
    }
  })

  test('pool: a hard-walled account (walled past grace, not merely rejected) is badged WALLED, dated “back”, and counted in the POOL row at the same instant', async ({
    env
  }) => {
    test.setTimeout(120_000)
    const mock = await startProbeMock()
    mock.script.set(TOKENS.alpha, { u5: 0.2, u7: 0.2 })
    mock.script.set(TOKENS.bravo, { u5: 0.3, u7: 0.2 })
    mock.script.set(TOKENS.charlie, { u5: 1, s5: 'rejected' })
    env.launchEnv.KOLOFT_PROBE_BASE_URL = mock.base
    seedPool(env)
    const { app, page } = await launchConfigured(env)
    try {
      const capsule = page.locator('.tbu')
      await capsule.waitFor({ state: 'visible' })
      await expect.poll(() => mock.requests.length, { timeout: 20_000 }).toBe(4)
      await expect(capsule.locator('.tbu-bar:not(.total) .tbu-fill')).toHaveCount(3)
      await expect(capsule.locator('.tbu-bar:not(.total) .tbu-fill.bad')).toHaveCount(1)

      await capsule.hover()
      const pop = page.locator('.tbu-pop')
      await expect(pop).toBeVisible()
      const pool = pop.locator('.tbu-row.pool')
      await expect(pool).toBeVisible()
      await expect(pool.locator('.tbu-pool-meta')).toContainText('3 measured')
      await expect(pool.locator('.tbu-pool-meta')).toContainText('2 usable')
      await expect(pool.locator('.tbu-cell-sub.alarm')).toHaveText('1 walled')

      const row = pop.locator('.tbu-row', { hasText: 'charlie' })
      await expect(row.locator('.acct-status.walled')).toHaveText('WALLED')
      const sub = row.locator('.tbu-cell').first().locator('.tbu-cell-sub')
      await expect(sub).toContainText('back')
      await expect(sub).toHaveClass(/alarm/)
    } finally {
      await app.close().catch(() => {})
      await mock.close()
    }
  })

  test('pool: with only one account measured (enabled is not enough) there is no total bar and no aggregate', async ({
    env
  }) => {
    test.setTimeout(120_000)
    const mock = await startProbeMock()
    mock.script.set(TOKENS.alpha, { u5: 0.5, u7: 0.2 })
    mock.script.set(TOKENS.bravo, { status: 500 })
    mock.script.set(TOKENS.charlie, { status: 500 })
    env.launchEnv.KOLOFT_PROBE_BASE_URL = mock.base
    seedPool(env)
    const { app, page } = await launchConfigured(env)
    try {
      const capsule = page.locator('.tbu')
      await capsule.waitFor({ state: 'visible' })
      await expect.poll(() => mock.requests.length, { timeout: 20_000 }).toBe(4)
      await expect(capsule.locator('.tbu-bar:not(.total) .tbu-fill')).toHaveCount(1)
      await expect(capsule.locator('.tbu-bar.total')).toHaveCount(0)

      await capsule.hover()
      const pop = page.locator('.tbu-pop')
      await expect(pop).toBeVisible()
      const pool = pop.locator('.tbu-row.pool')
      await expect(pool).toBeVisible()
      await expect(pool).toContainText('only 1 account measured')
      await expect(pool.locator('.acct-meter')).toHaveCount(0)
    } finally {
      await app.close().catch(() => {})
      await mock.close()
    }
  })
})

test('E6: probe outage degrades to round-robin fast — never a blocked launch', async ({
  env,
  app,
  page
}) => {
  test.setTimeout(120_000)
  env.launchEnv.KOLOFT_PROBE_BASE_URL = 'http://127.0.0.1:1'
  seedPool(env)
  await waitBooted(page)
  const t0 = Date.now()
  await startSessionIn(page, 'ws-a')
  const [call] = await waitForCalls(env, 1, 20_000)
  expect(Date.now() - t0).toBeLessThan(15_000)
  expect(call.oauthToken).not.toBeNull()
  await expect(centerTerm(page)).toContainText('round-robin', { timeout: 10_000 })
})

test('E6b: HUNG probe server → main answers within its 2s budget (round-robin), not a bare exec', async ({
  env,
  app,
  page
}) => {
  test.setTimeout(120_000)
  const mock = await startProbeMock()
  for (const t of Object.values(TOKENS)) mock.script.set(t, { hang: true })
  env.launchEnv.KOLOFT_PROBE_BASE_URL = mock.base
  seedPool(env)
  try {
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    const [call] = await waitForCalls(env, 1, 20_000)
    expect(call.oauthToken).not.toBeNull()
    await expect(page.locator('.term-wrap:visible .xterm')).toContainText('round-robin', {
      timeout: 10_000
    })
  } finally {
    await mock.close()
  }
})

test('E7: leak scan — no token bytes in the renderer, the scrollback or userData', async ({
  env,
  page
}) => {
  test.setTimeout(150_000)
  const mock = await startProbeMock()
  mock.script.set(TOKENS.bravo, { u5: 0.1 })
  env.launchEnv.KOLOFT_PROBE_BASE_URL = mock.base
  seedPool(env)
  try {
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    const [call] = await waitForCalls(env, 1)
    expect(call.oauthToken).not.toBeNull()

    const html = await page.evaluate(() => document.documentElement.outerHTML)
    for (const t of Object.values(TOKENS)) expect(html).not.toContain(t)
    const term = await visibleTerminalText(page)
    for (const t of Object.values(TOKENS)) expect(term).not.toContain(t)
    expect(scanForTokens(env.userData, () => false)).toEqual([])
    const picks = path.join(env.userData, 'picks')
    if (fs.existsSync(picks)) expect(fs.readdirSync(picks)).toEqual([])
  } finally {
    await mock.close()
  }
})

test('E8: a token exported by the user’s shell rc (downstream of main’s env scrub) is used verbatim, with a warning', async ({
  env
}) => {
  test.setTimeout(150_000)
  const mock = await startProbeMock()
  mock.script.set(TOKENS.bravo, { u5: 0.1 })
  env.launchEnv.KOLOFT_PROBE_BASE_URL = mock.base
  fs.appendFileSync(
    path.join(env.home, '.zshrc'),
    "\nexport CLAUDE_CODE_OAUTH_TOKEN='zzz-wrapper-token'\n"
  )
  seedPool(env)
  const { app, page } = await launchConfigured(env)
  try {
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    const [call] = await waitForCalls(env, 1)
    expect(call.oauthToken).toBe('zzz-wrapper-token')
    await expect(centerTerm(page)).toContainText('skipping balancing', { timeout: 10_000 })
  } finally {
    await app.close().catch(() => {})
    await mock.close()
  }
})

test('E9: a restarted (resumed) session re-balances to the now-lighter account — every launch picks afresh, and a manual refresh changes the next pick', async ({
  env
}) => {
  test.setTimeout(150_000)
  const mock = await startProbeMock()
  mock.script.set(TOKENS.alpha, { u5: 0.9 })
  mock.script.set(TOKENS.bravo, { u5: 0.1 })
  mock.script.set(TOKENS['charlie'], { u5: 0.95 })
  env.launchEnv.KOLOFT_PROBE_BASE_URL = mock.base
  seedPool(env)
  const { app, page } = await launchConfigured(env)
  try {
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    const [first] = await waitForCalls(env, 1)
    expect(first.oauthToken).toBe(TOKENS.bravo)
    await expect(
      page.locator('.ws-tab-title', { hasText: 'Fake session: project notes' })
    ).toBeVisible({ timeout: 40_000 })

    mock.script.set(TOKENS.bravo, { u5: 0.97 })
    mock.script.set(TOKENS.alpha, { u5: 0.05 })
    await page.evaluate(() => window.api.accounts.probe())

    await app.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById('restart-session')
      if (!item) throw new Error('no application-menu item with id "restart-session"')
      item.click()
    })
    const calls = await waitForCalls(env, 2, 45_000)
    expect(calls[1].argv).toContain('--resume')
    expect(calls[1].oauthToken).toBe(TOKENS.alpha)
  } finally {
    await app.close().catch(() => {})
    await mock.close()
  }
})

test('E11: an expired account recovers in place via “Sign in again”, keeping its position and the user’s disable', async ({
  env
}) => {
  test.setTimeout(120_000)
  const TOKEN = 'sk-ant-oat01-relogin-fixture-abcdef0123456789'
  const mock = await startProbeMock()
  mock.script.set(TOKEN, { u5: 0.15, u7: 0.25, uoi: 0.35 })
  env.launchEnv.KOLOFT_PROBE_BASE_URL = mock.base
  env.launchEnv.KOLOFT_FAKE_SETUP_TOKEN = TOKEN
  fs.writeFileSync(
    env.keychainFile,
    JSON.stringify({ [UNPACKAGED_BUILD_OAUTH_SVC_SPELLED_OUT_NOT_IMPORTED]: { bravo: 'stale' } })
  )
  seedSettings(env, {
    multiAccount: true,
    accounts: [
      { ...acct('alpha'), enabled: true },
      {
        name: 'bravo',
        kind: 'oauth',
        enabled: false,
        fable: 'unknown',
        status: 'expired',
        addedAt: 1
      }
    ]
  })

  const { app, page } = await launchConfigured(env)
  try {
    await openSettings(page)
    const bravoRow = page.locator('.acct-row', { hasText: 'bravo' })
    await expect(bravoRow.locator('.acct-status.expired')).toBeVisible()

    await bravoRow.locator('.acct-relogin').click()
    await page.locator('.acct-add-actions button', { hasText: 'Sign in' }).click()

    await expect
      .poll(
        async () => {
          const list = await page.evaluate(() => window.api.accounts.list())
          return list.find((a) => a.name === 'bravo')?.status
        },
        { timeout: 45_000 }
      )
      .toBe('ok')

    const list = await page.evaluate(() => window.api.accounts.list())
    expect(list.map((a) => a.name)).toEqual(['alpha', 'bravo'])
    expect(list.find((a) => a.name === 'bravo')?.enabled).toBe(false)
    const kc = JSON.parse(fs.readFileSync(env.keychainFile, 'utf8'))
    expect(kc[UNPACKAGED_BUILD_OAUTH_SVC_SPELLED_OUT_NOT_IMPORTED].bravo).toBe(TOKEN)
  } finally {
    await app.close().catch(() => {})
    await mock.close()
  }
})

test('E10: guided login captures the printed token (even wrapped at 80 columns) from a hidden pty into the Keychain and the pool, sending the auth page to the user’s own browser', async ({
  env
}) => {
  test.setTimeout(120_000)
  const TOKEN_LONG_ENOUGH_TO_WRAP_AT_80_COLUMNS =
    'sk-ant-oat01-guided0login0fixture0aaaaaaaaaaaaaaaaaaaabbbbbbbbbbbbbbbbbbbbccccccccccccccccccccdddddddddd'
  const mock = await startProbeMock()
  mock.script.set(TOKEN_LONG_ENOUGH_TO_WRAP_AT_80_COLUMNS, { u5: 0.2, u7: 0.3, uoi: 0.4 })
  env.launchEnv.KOLOFT_PROBE_BASE_URL = mock.base
  env.launchEnv.KOLOFT_FAKE_SETUP_TOKEN = TOKEN_LONG_ENOUGH_TO_WRAP_AT_80_COLUMNS
  const AUTH_URL = 'https://example.invalid/oauth/authorize?state=e10'
  env.launchEnv.KOLOFT_FAKE_SETUP_URL = AUTH_URL
  fs.writeFileSync(env.keychainFile, JSON.stringify({}))
  seedSettings(env, { multiAccount: true, accounts: [] })

  const { app, page } = await launchConfigured(env)
  try {
    await openSettings(page)
    await expect(claudeAccounts(page).locator('.acct-empty')).toBeVisible()

    const tabsBefore = await page.locator('.ws-tab').count()
    await claudeAccounts(page).locator('.acct-foot button', { hasText: 'Sign in' }).click()
    await page.locator('.acct-add input[type="text"]').fill('bravo')
    await page.locator('.acct-add-actions button', { hasText: 'Sign in' }).click()

    await expect(page.locator('.acct-section')).toBeVisible()

    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.api.accounts.list())).map((a) => a.name).join(','),
        { timeout: 45_000 }
      )
      .toBe('bravo')

    const kc = JSON.parse(fs.readFileSync(env.keychainFile, 'utf8'))
    expect(kc[UNPACKAGED_BUILD_OAUTH_SVC_SPELLED_OUT_NOT_IMPORTED].bravo).toBe(
      TOKEN_LONG_ENOUGH_TO_WRAP_AT_80_COLUMNS
    )
    const [acct] = await page.evaluate(() => window.api.accounts.list())
    expect(acct.status).toBe('ok')
    expect(acct.fable).toBe('yes')

    await expect(page.locator('.acct-login-state.ok')).toContainText('Saved bravo')
    expect(await page.locator('.ws-tab').count()).toBe(tabsBefore)

    await expect
      .poll(() =>
        fs.existsSync(env.externalOpens) ? fs.readFileSync(env.externalOpens, 'utf8') : ''
      )
      .toContain(AUTH_URL)
    await expect(page.locator('.tb-ico[aria-label="Opened page"]')).toHaveCount(0)
  } finally {
    await app.close().catch(() => {})
    await mock.close()
  }
})

test('guided login: a captured token the probe rejects as expired reports failure and is written to neither the Keychain nor the pool', async ({
  env
}) => {
  test.setTimeout(120_000)
  const REJECTED_TOKEN = 'sk-ant-oat01-rejected-login-fixture-abcdef0123456789'
  const mock = await startProbeMock()
  mock.script.set(REJECTED_TOKEN, { status: 401 })
  env.launchEnv.KOLOFT_PROBE_BASE_URL = mock.base
  env.launchEnv.KOLOFT_FAKE_SETUP_TOKEN = REJECTED_TOKEN
  fs.writeFileSync(env.keychainFile, JSON.stringify({}))
  seedSettings(env, { multiAccount: true, accounts: [] })

  const { app, page } = await launchConfigured(env)
  try {
    await openSettings(page)
    await claudeAccounts(page).locator('.acct-foot button', { hasText: 'Sign in' }).click()
    await page.locator('.acct-add input[type="text"]').fill('bravo')
    await page.locator('.acct-add-actions button', { hasText: 'Sign in' }).click()

    await expect(page.locator('.acct-login-state.bad')).toContainText('rejected', {
      timeout: 45_000
    })
    expect(mock.requests).toContain(REJECTED_TOKEN)
    expect(await page.evaluate(() => window.api.accounts.list())).toEqual([])
    expect(fs.readFileSync(env.keychainFile, 'utf8')).not.toContain(REJECTED_TOKEN)
  } finally {
    await app.close().catch(() => {})
    await mock.close()
  }
})

test('panel probe: overlapping rounds share one, and once it settles the next call starts a fresh round — the single-flight latch never sticks', async ({
  env
}) => {
  test.setTimeout(120_000)
  const SLOW_ENOUGH_FOR_THE_CALLS_TO_OVERLAP_MS = 1_500
  const mock = await startProbeMock()
  env.launchEnv.KOLOFT_PROBE_BASE_URL = mock.base
  seedPool(env)
  const { app, page } = await launchConfigured(env)
  try {
    const capsule = page.locator('.tbu')
    await capsule.waitFor({ state: 'visible' })
    await expect.poll(() => mock.requests.length, { timeout: 20_000 }).toBe(4)
    await expect(capsule.locator('.tbu-bar:not(.total) .tbu-fill')).toHaveCount(3)

    for (const t of Object.values(TOKENS)) {
      mock.script.set(t, { answerAfterMs: SLOW_ENOUGH_FOR_THE_CALLS_TO_OVERLAP_MS })
    }
    await page.evaluate(() =>
      Promise.all([
        window.api.accounts.probe(),
        window.api.accounts.probe(),
        window.api.accounts.probe()
      ])
    )
    expect(mock.requests.length).toBe(8)

    await page.evaluate(() => window.api.accounts.probe())
    expect(mock.requests.length).toBe(12)
  } finally {
    await app.close().catch(() => {})
    await mock.close()
  }
})

test('panel probe: a custom-endpoint account is probed with its own model, not the Anthropic fallback', async ({
  env
}) => {
  test.setTimeout(120_000)
  const CUSTOM_TOKEN = 'custom-endpoint-fixture-token'
  const mock = await startProbeMock()
  env.launchEnv.KOLOFT_PROBE_BASE_URL = mock.base
  fs.writeFileSync(
    env.keychainFile,
    JSON.stringify({
      [UNPACKAGED_BUILD_CUSTOM_SVC_SPELLED_OUT_NOT_IMPORTED]: { glm: CUSTOM_TOKEN }
    })
  )
  seedSettings(env, {
    multiAccount: true,
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
  const { app, page } = await launchConfigured(env)
  try {
    await page.evaluate(() => window.api.accounts.probe())
    expect(mock.requests).toEqual([CUSTOM_TOKEN])
    expect(mock.models).toEqual(['glm-5.2'])
  } finally {
    await app.close().catch(() => {})
    await mock.close()
  }
})
