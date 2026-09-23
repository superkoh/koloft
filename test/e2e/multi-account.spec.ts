import fs from 'fs'
import path from 'path'
import http from 'http'
import type { AddressInfo } from 'net'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, launchApp } from './helpers/app'
import { seedSettings, type E2EEnv } from './helpers/env'
import { centerTerm, runIn, startSessionIn, waitBooted } from './helpers/p1'

/**
 * Multi-account load balancing — e2e E1–E9 (locked contract: the original design notes
 * §4 and the design doc's §06, both retired after the feature merged;
 * the probe/header facts live on in docs/claude-code-contract.md §7).
 *
 * Hard rules honored throughout: the probe module refuses the real network in test
 * mode (KOLOFT_PROBE_BASE_URL points at the in-test mock server or is absent), Keychain
 * reads go through the KOLOFT_KEYCHAIN_FILE fixture / fake `security`, and everything
 * runs under KOLOFT_TEST_BACKGROUND=1 (no focus steal).
 */

// ---- fixtures --------------------------------------------------------------------

const TOKENS: Record<string, string> = {
  alpha: 'sk-ant-oat01-fixture-alpha',
  bravo: 'sk-ant-oat01-fixture-bravo',
  charlie: 'sk-ant-oat01-fixture-charlie',
  'api-main': 'sk-ant-api03-fixture-api'
}

// Keychain services are namespaced per build; an e2e run is an unpackaged build, so
// it addresses the 'koloft-dev' store — never the installed app's. Spelling the namespace
// out (rather than importing the helper) is deliberate: these keys are the contract
// the app under test must resolve to, so a bug in the helper cannot make the fixture
// agree with it by construction.
const OAUTH_SVC = 'koloft-dev-claude-oauth'
const APIKEY_SVC = 'koloft-dev-anthropic-api'

function seedKeychain(env: E2EEnv): void {
  fs.writeFileSync(
    env.keychainFile,
    JSON.stringify({
      [OAUTH_SVC]: {
        alpha: TOKENS.alpha,
        bravo: TOKENS.bravo,
        charlie: TOKENS.charlie
      },
      [APIKEY_SVC]: { 'api-main': TOKENS['api-main'] }
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

/** per-token bucket script for the probe mock */
interface BucketScript {
  u5?: number
  u7?: number
  uoi?: number
  s5?: string
  status?: number
  /** never respond (hung-server case) */
  hang?: boolean
}

interface ProbeMock {
  base: string
  script: Map<string, BucketScript>
  requests: string[]
  close(): Promise<void>
}

async function startProbeMock(): Promise<ProbeMock> {
  const script = new Map<string, BucketScript>()
  const requests: string[] = []
  const nowSec = Math.floor(Date.now() / 1000)
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const auth = String(req.headers['authorization'] ?? req.headers['x-api-key'] ?? '')
      const token = auth.replace(/^Bearer /, '')
      requests.push(token)
      const s = script.get(token) ?? {}
      if (s.hang) return // accept and never answer
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

/** Manual launch for specs that must configure env.launchEnv FIRST — the `app`
 *  fixture launches before the test body runs, so a body-time launchEnv mutation
 *  (e.g. KOLOFT_PROBE_BASE_URL) would never reach the process env. */
async function launchConfigured(env: E2EEnv): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launchApp(env)
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

async function openSettings(page: Page): Promise<void> {
  // C1 titlebar: settings is the Lucide icon button (the old .settings-btn retired)
  await page.locator('.tb-ico[title="Settings"]').click()
  await page.locator('.modal').waitFor({ state: 'visible' })
}

/** recursive byte-scan of a dir for any fixture token (E7 leak assertion) */
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

// ---- specs -----------------------------------------------------------------------

test('E1: settings CRUD — no launch-command field, only the shipped add entries, persistence, stale key ignored', async ({
  env
}) => {
  test.setTimeout(120_000)
  const mock = await startProbeMock()
  env.launchEnv.KOLOFT_PROBE_BASE_URL = mock.base
  // stale claudeCommand key from an old install must be ignored, not fatal
  seedSettings(env, { claudeCommand: 'stale-wrapper', multiAccount: true })
  seedKeychain(env)

  let app = await launchApp(env)
  try {
    let page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await openSettings(page)

    // D4 absence assertion + the add paths actually shipped: guided login (primary)
    // and manual token. The apikey / custom kinds exist in the backend but their add
    // entries stay hidden until they can be verified against a real credential — an
    // unverifiable path must not be reachable, so their absence is asserted too (a
    // button quietly coming back is exactly the regression this guards).
    await expect(page.locator('.modal')).not.toContainText('Claude launch command')
    await expect(page.locator('.acct-foot button', { hasText: 'Sign in' })).toBeVisible()
    await expect(page.locator('.acct-foot button', { hasText: 'Paste token' })).toBeVisible()
    await expect(page.locator('.acct-foot button', { hasText: 'API key' })).toHaveCount(0)
    await expect(page.locator('.acct-foot button', { hasText: 'Custom endpoint' })).toHaveCount(0)
    // (the 3rd foot button is the usage refresh, not an add path)
    await expect(page.locator('.acct-foot button')).toHaveCount(3)

    // empty state first
    await expect(page.locator('.acct-empty')).toBeVisible()

    // paste-add an oauth account; the mock verifies it (fable bucket present → badge)
    await page.locator('.acct-foot button', { hasText: 'Paste token' }).click()
    await page.locator('.acct-add input[type="text"]').fill('bravo')
    await page.locator('.acct-add input[type="password"]').fill(TOKENS.bravo)
    await page.locator('.acct-add-actions button', { hasText: 'Verify and save' }).click()
    await expect(page.locator('.acct-row')).toHaveCount(1, { timeout: 15_000 })
    await expect(page.locator('.acct-name')).toHaveText('bravo')
    await expect(page.locator('.acct-badge.fable')).toBeVisible()

    // toggle off → .off
    await page.locator('.acct-row input[type="checkbox"]').first().uncheck()
    await expect(page.locator('.acct-row.off')).toHaveCount(1)

    // keychain fixture actually holds the secret (write path went through)
    const kc = JSON.parse(fs.readFileSync(env.keychainFile, 'utf8'))
    expect(kc[OAUTH_SVC].bravo).toBe(TOKENS.bravo)

    // relaunch → the account persists
    await app.close()
    app = await launchApp(env)
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await openSettings(page)
    await expect(page.locator('.acct-row.off')).toHaveCount(1)

    // the refresh button must REPORT — a round whose numbers happen not to move is
    // otherwise indistinguishable from a click that did nothing
    await page.locator('.acct-foot button', { hasText: 'Refresh usage' }).click()
    await expect(page.locator('.acct-foot button', { hasText: 'Updated' })).toBeVisible({
      timeout: 15_000
    })
    // …and it returns to the neutral label, so the next click is legible too
    await expect(page.locator('.acct-foot button', { hasText: 'Refresh usage' })).toBeVisible({
      timeout: 15_000
    })

    // delete via the INLINE confirm (FR-07 — window.confirm retired; a native dialog
    // appearing here would hang the test, which is exactly the regression guard) →
    // row gone AND the credential actually removed: a leftover Keychain entry would
    // be an orphaned secret nothing references
    await page.locator('.acct-x').click()
    await page.locator('.acct-confirm button', { hasText: 'Delete' }).click()
    await expect(page.locator('.acct-row')).toHaveCount(0)
    const kc2 = JSON.parse(fs.readFileSync(env.keychainFile, 'utf8'))
    expect(kc2[OAUTH_SVC].bravo).toBeUndefined()

    // paste-add leak scan: no token bytes anywhere in userData (E7-style, after E1)
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
  // no probe mock on purpose: mode-off must not probe at all
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')
  const [first] = await waitForCalls(env, 1)
  expect(first.oauthToken).toBeNull()
  expect(first.apiKey).toBeNull()
  const text = await visibleTerminalText(page)
  expect(text).not.toContain('koloft: →')
  await expect(page.locator('.ws-acct-chip')).toHaveCount(0)
  // D8: no usage figures anywhere in the sidebar
  await expect(page.locator('.island .acct-meter')).toHaveCount(0)

  // runtime toggle ON — no app restart: the very next launch has to inject. The first
  // session is ended first so the assertion below reads one unambiguous new launch.
  await page.evaluate(() => window.api.settings.set({ multiAccount: true }))
  await runIn(page, centerTerm(page), '/exit')
  await page.waitForTimeout(800)
  await startSessionIn(page, 'ws-a')
  const calls = await waitForCalls(env, 2)
  // probes refuse the network (no KOLOFT_PROBE_BASE_URL) → round-robin still injects
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
    // the @chip is retired (agent-centric C2): the account's only UI surfaces are the
    // ccstatusline segment (E12) and Settings — the sidebar must stay chipless
    await expect(page.locator('.ws-acct-chip')).toHaveCount(0)
  } finally {
    await app.close().catch(() => {})
    await mock.close()
  }
})

// The two features meet here and nowhere else. The built-in statusline's first segment
// is `echo $ANT_ACCOUNT` — a tag that used to come from an external auth wrapper, and
// that ptyManager now strips from every tab's env. Unless the shim re-exports the
// account it picked, that segment renders blank in every Koloft tab: a merge of two
// individually-correct features producing a broken product. Nothing in either feature's
// own suite can see it.
test('E12: the picked account reaches the embedded statusline’s account segment', async ({
  env
}) => {
  test.setTimeout(120_000)
  const mock = await startProbeMock()
  mock.script.set(TOKENS.alpha, { u5: 0.9 })
  mock.script.set(TOKENS.bravo, { u5: 0.1 }) // least loaded → picked
  mock.script.set(TOKENS.charlie, { u5: 0.8 })
  env.launchEnv.KOLOFT_PROBE_BASE_URL = mock.base
  seedPool(env) // statuslineBuiltin defaults on — not overridden here on purpose
  const { app, page } = await launchConfigured(env)
  try {
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    const [call] = await waitForCalls(env, 1)
    expect(call.oauthToken).toBe(TOKENS.bravo)

    // the fake claude runs the injected statusLine command exactly as the real one
    // does; a cold render parses a 3MB bundle through the electron binary in node mode
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
        { timeout: 40_000 }
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
  // all subscriptions hard-limited: rejected with reset far beyond grace (the mock's
  // default 5h reset is now+7200 ≥ grace)
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
  // hand-built headers: bravo rejected but unblocking in 5 minutes → NOT hard-limited
  mock.script.set(TOKENS.alpha, { u5: 1, s5: 'rejected' })
  mock.script.set(TOKENS['charlie'], { u5: 1, s5: 'rejected' })
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const auth = String(req.headers['authorization'] ?? '')
      const token = auth.replace(/^Bearer /, '')
      if (token !== TOKENS.bravo) {
        // route others to the shared script shape: rejected far out
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
    expect(call.apiKey).toBeNull() // NOT the metered key
    expect(call.oauthToken).toBe(TOKENS.bravo) // the soon-unblocking account wins
  } finally {
    await app.close().catch(() => {})
    await new Promise((ok) => server.close(ok))
    await mock.close()
  }
})

// The capsule's own interaction contract (D4 hover / D8 open-refresh / D9 startup
// round). Not part of the former E-numbered set — these three rules were decided
//, after the feature shipped.

/** comfortably past the 150ms hover-open delay: long enough that a panel which was
 *  going to spring back open under a resting pointer would have done so */
const HOVER_REOPEN_GUARD_MS = 600
test('capsule: a startup round fills it, and hovering fresh numbers costs nothing', async ({
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
    // D9: one request per enabled account, with nobody having asked for it — so the
    // three subscription bars are drawn before the panel is ever opened
    await expect.poll(() => mock.requests.length, { timeout: 20_000 }).toBe(4)
    // member bars only: the design's pool bar draws the same fill and would otherwise inflate
    // every count in this file (topbar-usage §06)
    await expect(capsule.locator('.tbu-bar:not(.total) .tbu-fill')).toHaveCount(3)

    // D4: hover alone opens it
    await expect(pop).toBeHidden()
    await capsule.hover()
    await expect(pop).toBeVisible()
    await expect(pop.locator('.tbu-grid').first()).toBeVisible()
    // the capsule lives in the sidebar's footer, so the card opens UPWARD:
    // its whole box above the capsule and inside the window, never off the lower edge
    const cap = (await capsule.boundingBox())!
    const card = (await pop.boundingBox())!
    const viewH = await page.evaluate(() => window.innerHeight)
    expect(card.y + card.height).toBeLessThanOrEqual(cap.y)
    expect(card.y).toBeGreaterThanOrEqual(0)
    expect(card.y + card.height).toBeLessThanOrEqual(viewH)

    // D8: numbers this fresh are not worth a second round, however often it is opened
    await page.mouse.move(4, 400)
    await expect(pop).toBeHidden()
    await capsule.hover()
    await expect(pop).toBeVisible()
    await page.waitForTimeout(1_000)
    expect(mock.requests.length).toBe(4)

    // D4: still a toggle for click/Enter — and a click-dismissal must not spring back
    // open under the very pointer that dismissed it
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

// The half-failed round is the case a naive "oldest snapshot" staleness check gets
// wrong: the survivors are fresh, so the pool reads as fresh and the accounts with no
// number at all are never retried — while the header claims "updated just now".
test('capsule: one account failing does not make the pool look fresh', async ({ env }) => {
  test.setTimeout(120_000)
  const mock = await startProbeMock()
  mock.script.set(TOKENS.charlie, { status: 500 })
  env.launchEnv.KOLOFT_PROBE_BASE_URL = mock.base
  seedPool(env)
  const { app, page } = await launchConfigured(env)
  try {
    const capsule = page.locator('.tbu')
    await capsule.waitFor({ state: 'visible' })
    // startup round: alpha + bravo answered, charlie did not
    await expect.poll(() => mock.requests.length, { timeout: 20_000 }).toBe(4)
    await expect(capsule.locator('.tbu-bar:not(.total) .tbu-fill')).toHaveCount(2)

    // charlie recovers; hovering must notice it is still empty and refetch, even
    // though its two neighbours were probed seconds ago
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
    // the startup round ran and came back empty-handed — nothing to draw. Left
    // deliberately UNnarrowed: with |M| = 0 there must be no pool bar either, so the
    // broad selector is the stronger assertion here.
    await expect.poll(() => mock.requests.length, { timeout: 20_000 }).toBe(4)
    await expect(capsule.locator('.tbu-fill')).toHaveCount(0)

    // the server recovers; opening the panel is what notices (D8: no snapshot at all
    // is as due for a refresh as a stale one)
    for (const t of Object.values(TOKENS)) mock.script.set(t, {})
    await capsule.hover()
    const pop = page.locator('.tbu-pop')
    await expect(pop).toBeVisible()
    // an account row only grows a grid once its snapshot lands — the POOL row's
    // placeholder grid is painted with the popover itself and would race the round
    await expect(pop.locator('.tbu-rows .tbu-grid').first()).toBeVisible({ timeout: 20_000 })
    await expect.poll(() => mock.requests.length, { timeout: 20_000 }).toBe(8)
  } finally {
    await app.close().catch(() => {})
    await mock.close()
  }
})

// The pool surfaces (topbar-usage D10–D15). Both are aggregates
// of the SAME rows the capsule already draws one by one, so what these three specs are
// really for is the seam between the two readings: the aggregate must be a mean of the
// members (not a copy of one of them), must count exactly the accounts that carry a
// number, and must say "walled" at the same instant the member does.

test('pool: three measured accounts draw a total bar and lead the panel with a POOL row', async ({
  env
}) => {
  test.setTimeout(120_000)
  const mock = await startProbeMock()
  // 5h at 20 / 40 / 60 (7d flat below them, so 5h is the binding window everywhere):
  // the mean, 40%, is far from both the lowest and the highest member, so a total bar
  // that copied either one — the failure mode D10 exists to prevent — is visible.
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
    // |M| = 3 → exactly one pool bar, and the members are untouched by its arrival
    await expect(capsule.locator('.tbu-bar:not(.total) .tbu-fill')).toHaveCount(3)
    await expect(capsule.locator('.tbu-bar.total')).toHaveCount(1)
    await expect(capsule.locator('.tbu-bar:not(.total)')).toHaveCount(3)

    // D11: width and position are the non-color identity channels — wider than a
    // member bar, and leading the group rather than sitting inside it
    const total = capsule.locator('.tbu-bar.total')
    const member = capsule.locator('.tbu-bar:not(.total)').first()
    const totalBox = (await total.boundingBox())!
    const memberBox = (await member.boundingBox())!
    expect(totalBox.width).toBeGreaterThan(memberBox.width)
    expect(totalBox.x).toBeLessThan(memberBox.x)

    // D10: the height is the MEAN tension. Asserted as a band, not a pixel — the exact
    // fold is the unit suite's business; what this layer owes is "between the members,
    // near the middle" rather than min/max.
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
    // D12: measured is the mean's denominator (how many accounts the number is made
    // of), usable is the schedulable count — two different questions, both spelled out
    await expect(pool.locator('.tbu-pool-meta')).toContainText('3 measured')
    await expect(pool.locator('.tbu-pool-meta')).toContainText('3 usable')
    // the aggregate 5h meter reads the mean too, and by the same band
    const pct = Number.parseInt(
      await pool.locator('.acct-meter[data-win="5h"] .m-pct').innerText(),
      10
    )
    expect(pct).toBeGreaterThan(30)
    expect(pct).toBeLessThan(50)
    // and it is the panel's FIRST row: the aggregate reads before the members
    const firstAcct = (await pop.locator('.tbu-rows .tbu-row').first().boundingBox())!
    expect((await pool.boundingBox())!.y).toBeLessThan(firstAcct.y)
  } finally {
    await app.close().catch(() => {})
    await mock.close()
  }
})

// D15: "walled" is the picker's hardLimited, not a bare `rejected` — and the badge, the
// capsule's top rail and the pool's count have to agree at that one instant, or the
// three loudest signals in the product disagree about the same account.
test('pool: a hard-walled account is badged WALLED, dated “back”, and counted in the POOL row', async ({
  env
}) => {
  test.setTimeout(120_000)
  const mock = await startProbeMock()
  mock.script.set(TOKENS.alpha, { u5: 0.2, u7: 0.2 })
  mock.script.set(TOKENS.bravo, { u5: 0.3, u7: 0.2 })
  // rejected with the mock's default 5h reset (now + 7200s) — an hour past GRACE, so
  // this is a wall the scheduler honours too, not a five-minute blip
  mock.script.set(TOKENS.charlie, { u5: 1, s5: 'rejected' })
  env.launchEnv.KOLOFT_PROBE_BASE_URL = mock.base
  seedPool(env)
  const { app, page } = await launchConfigured(env)
  try {
    const capsule = page.locator('.tbu')
    await capsule.waitFor({ state: 'visible' })
    await expect.poll(() => mock.requests.length, { timeout: 20_000 }).toBe(4)
    await expect(capsule.locator('.tbu-bar:not(.total) .tbu-fill')).toHaveCount(3)
    // exactly one member bar reads walled (alpha/bravo sit at 20–30%, nowhere near the
    // 90% that would color a healthy bar red) — the capsule half of the same instant
    await expect(capsule.locator('.tbu-bar:not(.total) .tbu-fill.bad')).toHaveCount(1)

    await capsule.hover()
    const pop = page.locator('.tbu-pop')
    await expect(pop).toBeVisible()
    const pool = pop.locator('.tbu-row.pool')
    await expect(pool).toBeVisible()
    // still measured (it carries a number), no longer usable (nothing can be scheduled
    // onto it) — the two counts are what keeps that distinction legible
    await expect(pool.locator('.tbu-pool-meta')).toContainText('3 measured')
    await expect(pool.locator('.tbu-pool-meta')).toContainText('2 usable')
    await expect(pool.locator('.tbu-cell-sub.alarm')).toHaveText('1 walled')

    const row = pop.locator('.tbu-row', { hasText: 'charlie' })
    await expect(row.locator('.acct-status.walled')).toHaveText('WALLED')
    // "when does it come back" now lives in the 5h cell (first column, fixed order),
    // and that subline is never allowed to be empty on a walled window
    const sub = row.locator('.tbu-cell').first().locator('.tbu-cell-sub')
    await expect(sub).toContainText('back')
    await expect(sub).toHaveClass(/alarm/)
  } finally {
    await app.close().catch(() => {})
    await mock.close()
  }
})

// D11.1: the threshold is |M| ≥ 2 — accounts that actually carry a number, not
// accounts that are enabled. Three enabled with two probes failing must NOT draw the
// last survivor's water line and call it the pool.
test('pool: with only one account measured there is no total bar and no aggregate', async ({
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
    // the row itself stays (three enabled OAuth accounts: the pool concept holds), but
    // a one-account "average" is the single-account noise the bar was dropped to avoid
    const pool = pop.locator('.tbu-row.pool')
    await expect(pool).toBeVisible()
    await expect(pool).toContainText('only 1 account measured')
    await expect(pool.locator('.acct-meter')).toHaveCount(0)
  } finally {
    await app.close().catch(() => {})
    await mock.close()
  }
})

test('E6: probe outage degrades to round-robin fast — never a blocked launch', async ({
  env,
  app,
  page
}) => {
  test.setTimeout(120_000)
  // (a) connection refused: point at a dead port
  env.launchEnv.KOLOFT_PROBE_BASE_URL = 'http://127.0.0.1:1'
  seedPool(env)
  await waitBooted(page)
  const t0 = Date.now()
  await startSessionIn(page, 'ws-a')
  const [call] = await waitForCalls(env, 1, 20_000)
  expect(Date.now() - t0).toBeLessThan(15_000)
  expect(call.oauthToken).not.toBeNull() // round-robin still injected a token
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
    expect(call.oauthToken).not.toBeNull() // token injected — NOT the shim's bare-exec timeout
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

    // no fixture token bytes in the renderer DOM, the visible scrollback, or
    // anywhere under userData (pick req/res clean up after themselves; the keychain
    // fixture lives OUTSIDE userData deliberately)
    const html = await page.evaluate(() => document.documentElement.outerHTML)
    for (const t of Object.values(TOKENS)) expect(html).not.toContain(t)
    const term = await visibleTerminalText(page)
    for (const t of Object.values(TOKENS)) expect(term).not.toContain(t)
    expect(scanForTokens(env.userData, () => false)).toEqual([])
    // and the pick channel left no residue at all
    const picks = path.join(env.userData, 'picks')
    if (fs.existsSync(picks)) expect(fs.readdirSync(picks)).toEqual([])
  } finally {
    await mock.close()
  }
})

// E8 — a wrapper-style pre-set token is respected verbatim, and warned about. The rc
// file is the one place such a token can still come from: main scrubs every
// CLAUDE_CODE_* key out of the env it spawns a pty with (ptyManager), but the pty runs
// the user's own login shell, and what that shell exports lands downstream of the scrub.
test('E8: a token exported by the user’s shell rc is used verbatim, with a warning', async ({
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

// E9 — D3: every launch picks afresh, so a ⇧⌘R restart can land on a different
// account than the original session did. The fake `security` has to live in shimDir
// for the same reason every launch here does: Koloft spawns the pty itself, and only
// shimDir is guaranteed ahead of /usr/bin in it — see the comment in helpers/env.ts.
test('E9: a restarted (resumed) session re-balances to the now-lighter account', async ({
  env
}) => {
  test.setTimeout(150_000)
  const mock = await startProbeMock()
  // round 1: bravo is the light one
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
    // the restart resumes a session BY ID, so wait for the real bind (the row title
    // arrives from the transcript): the menu item is a no-op until there is a session
    // id to resume
    await expect(
      page.locator('.ws-tab-title', { hasText: 'Fake session: project notes' })
    ).toBeVisible({ timeout: 40_000 })

    // usage flips, then a settings-panel refresh republishes it. Going through the
    // panel (rather than sleeping out the 30s cache) also pins the coherence rule:
    // a manual ↻ must change what the NEXT launch picks, not just the bars.
    mock.script.set(TOKENS.bravo, { u5: 0.97 })
    mock.script.set(TOKENS.alpha, { u5: 0.05 })
    await page.evaluate(() => window.api.accounts.probe())

    // restart the session in place via the File-menu item — the same code path ⇧⌘R
    // drives (restart-session.spec's contract trigger). The respawned
    // `claude --resume` goes through the shim and picks afresh (D3).
    await app.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById('restart-session')
      if (!item) throw new Error('no application-menu item with id "restart-session"')
      item.click()
    })
    const calls = await waitForCalls(env, 2, 45_000)
    expect(calls[1].argv).toContain('--resume')
    expect(calls[1].oauthToken).toBe(TOKENS.alpha) // re-balanced, not sticky
  } finally {
    await app.close().catch(() => {})
    await mock.close()
  }
})

// E11 — an expired credential must have a way back that is not "delete and start
// over": the row carries its own recovery, and taking it keeps the row's position and
// the user's enabled choice while replacing only the credential.
test('E11: an expired account recovers in place via “Sign in again”', async ({ env }) => {
  test.setTimeout(120_000)
  const TOKEN = 'sk-ant-oat01-relogin-fixture-abcdef0123456789'
  const mock = await startProbeMock()
  mock.script.set(TOKEN, { u5: 0.15, u7: 0.25, uoi: 0.35 })
  env.launchEnv.KOLOFT_PROBE_BASE_URL = mock.base
  env.launchEnv.KOLOFT_FAKE_SETUP_TOKEN = TOKEN
  fs.writeFileSync(env.keychainFile, JSON.stringify({ [OAUTH_SVC]: { bravo: 'stale' } }))
  // an expired row that the user had also DISABLED — recovery must not quietly re-enable
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
    // position preserved (probes rewrite rows constantly — recovery must not reshuffle)
    expect(list.map((a) => a.name)).toEqual(['alpha', 'bravo'])
    // and the user's own disable stays put: recovery restores health, not intent
    expect(list.find((a) => a.name === 'bravo')?.enabled).toBe(false)
    const kc = JSON.parse(fs.readFileSync(env.keychainFile, 'utf8'))
    expect(kc[OAUTH_SVC].bravo).toBe(TOKEN) // stale credential replaced
  } finally {
    await app.close().catch(() => {})
    await mock.close()
  }
})

// E10 — guided login (D9's primary entry). Koloft opens a real tab, runs the official
// `claude setup-token`, and lifts the printed token off that tab's output into the
// Keychain + the pool, with no copy-paste. The fake claude stands in for the browser
// round trip; everything else (tab, shim passthrough, capture, keychain, probe) is real.
test('E10: guided login captures the printed token into the Keychain and the pool', async ({
  env
}) => {
  test.setTimeout(120_000)
  // full-length (108 chars) on purpose: at the pty's default 80 columns a real token
  // WRAPS, and a capture that stops at the line break stores a silently truncated
  // credential that only fails later, at verification
  const TOKEN =
    'sk-ant-oat01-guided0login0fixture0aaaaaaaaaaaaaaaaaaaabbbbbbbbbbbbbbbbbbbbccccccccccccccccccccdddddddddd'
  const mock = await startProbeMock()
  mock.script.set(TOKEN, { u5: 0.2, u7: 0.3, uoi: 0.4 })
  env.launchEnv.KOLOFT_PROBE_BASE_URL = mock.base
  env.launchEnv.KOLOFT_FAKE_SETUP_TOKEN = TOKEN
  const AUTH_URL = 'https://example.invalid/oauth/authorize?state=e10'
  env.launchEnv.KOLOFT_FAKE_SETUP_URL = AUTH_URL
  fs.writeFileSync(env.keychainFile, JSON.stringify({}))
  seedSettings(env, { multiAccount: true, accounts: [] })

  const { app, page } = await launchConfigured(env)
  try {
    await openSettings(page)
    await expect(page.locator('.acct-empty')).toBeVisible()

    const tabsBefore = await page.locator('.ws-tab').count()
    await page.locator('.acct-foot button', { hasText: 'Sign in' }).click()
    await page.locator('.acct-add input[type="text"]').fill('bravo')
    await page.locator('.acct-add-actions button', { hasText: 'Sign in' }).click()

    // the flow runs in a HIDDEN pty: the user keeps the settings panel they were in,
    // and no terminal tab shows up for a command they never asked to see
    await expect(page.locator('.acct-section')).toBeVisible()

    // main lifts the token off the hidden pty's output: the account lands in the pool…
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.api.accounts.list())).map((a) => a.name).join(','),
        { timeout: 45_000 }
      )
      .toBe('bravo')

    // …with the secret in the Keychain, verified (a probe succeeded), fable detected
    const kc = JSON.parse(fs.readFileSync(env.keychainFile, 'utf8'))
    expect(kc[OAUTH_SVC].bravo).toBe(TOKEN)
    const [acct] = await page.evaluate(() => window.api.accounts.list())
    expect(acct.status).toBe('ok')
    expect(acct.fable).toBe('yes')

    // the panel says so in place, and STILL no tab was created — the printed token
    // never had a visible surface to linger on
    await expect(page.locator('.acct-login-state.ok')).toContainText('Saved bravo')
    expect(await page.locator('.ws-tab').count()).toBe(tabsBefore)

    // the authorization page went to the user's own browser — the OAuth callback has to
    // come back from where their login lives — and never parked in Koloft's overlay
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
