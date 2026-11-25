import fs from 'fs'
import http from 'http'
import path from 'path'
import type { AddressInfo } from 'net'
import { DatabaseSync } from 'node:sqlite'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { addKeychainEntry, seedSettings, type E2EEnv } from './helpers/env'
import { seedJsonl, waitBooted } from './helpers/p1'
import { answerFileDialog } from './helpers/workbench'
import { expectScreen } from './helpers/screenCompare'

const FIXED_NOW = Date.UTC(2031, 2, 4, 9, 30, 0)
const FIXED_S = FIXED_NOW / 1000
const HOUR_S = 3600
const DAY_S = 24 * HOUR_S
const SHIFTED_CLOCK = path.join(__dirname, 'fixtures', 'shifted-clock.cjs')
const WINDOW = { width: 1440, height: 920 }
const HIDDEN_TERMINAL_STAND_IN =
  'Sign-in timed out\n(stand-in: the hidden terminal’s own lines name this machine’s user and a throwaway folder)'
const EVERY_ANIMATION_AT_ITS_END =
  '*, *::before, *::after { animation-duration: 0s !important; animation-iteration-count: 1 !important; animation-delay: 0s !important; transition-duration: 0s !important; transition-delay: 0s !important; }'
const PINNED_RENDERING = ['--lang=en-US', '--disable-gpu', '--force-device-scale-factor=1']

const UNPACKAGED_BUILD_SERVICE = {
  oauth: 'koloft-dev-claude-oauth',
  apikey: 'koloft-dev-anthropic-api',
  custom: 'koloft-dev-custom-endpoint',
  'agy-home': 'koloft-dev-agy-home'
} as const

type Kind = 'oauth' | 'apikey' | 'custom' | 'codex-home' | 'agy-home'

interface Seeded {
  name: string
  kind: Kind
  enabled?: boolean
  fable?: 'yes' | 'no' | 'unknown'
  status?: 'ok' | 'expired' | 'unverified'
  baseUrl?: string
  model?: string
}

interface ClaudeAnswer {
  status?: number
  u5?: number
  s5?: string
  u7?: number
  uoi?: number
  soi?: string
  r5?: number
  r7?: number
}

interface CodexWindow {
  mins: number
  usedPercent: number
  resetsInMins: number
}

interface AgyBucket {
  name: string
  window: string
  remaining: number
  resetsAt: number
}

function claudeSecret(name: string): string {
  return `sk-ant-fixture-${name}`
}

function seedAccounts(env: E2EEnv, accounts: Seeded[], extra: Record<string, unknown> = {}): void {
  fs.writeFileSync(env.keychainFile, '{}')
  for (const a of accounts) {
    if (a.kind === 'oauth' || a.kind === 'apikey' || a.kind === 'custom')
      addKeychainEntry(env, UNPACKAGED_BUILD_SERVICE[a.kind], a.name, claudeSecret(a.name))
  }
  seedSettings(env, {
    hintsOff: true,
    accounts: accounts.map((a) => ({
      name: a.name,
      kind: a.kind,
      enabled: a.enabled ?? true,
      fable: a.fable ?? 'unknown',
      status: a.status ?? 'ok',
      addedAt: FIXED_NOW - DAY_S * 1000,
      fableCheckedAt: FIXED_NOW - HOUR_S * 1000,
      ...(a.baseUrl ? { baseUrl: a.baseUrl, model: a.model } : {})
    })),
    ...extra
  })
}

function installFakeCodex(env: E2EEnv): void {
  const binary = path.join(env.fakeBin, 'codex')
  fs.symlinkSync(path.join(__dirname, 'fixtures', 'fake-codex.js'), binary)
  env.launchEnv.KOLOFT_CODEX_CMD = binary
  env.launchEnv.CODEX_HOME = path.join(env.home, '.codex')
  fs.writeFileSync(path.join(env.home, '.zprofile'), `export PATH="${env.fakeBin}:$PATH"\n`)
  fs.writeFileSync(path.join(env.home, 'fake-codex-now'), String(FIXED_S))
}

function installFakeAgy(env: E2EEnv): void {
  const binary = path.join(env.fakeBin, 'agy')
  fs.symlinkSync(path.join(__dirname, 'fixtures', 'fake-agy.js'), binary)
  env.launchEnv.KOLOFT_AGY_CMD = binary
}

function codexSignIn(env: E2EEnv, name: string, auth: Record<string, unknown> | null): void {
  const home = path.join(env.userData, 'codex-homes', name)
  fs.mkdirSync(home, { recursive: true })
  if (auth) fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify(auth), { mode: 0o600 })
}

function codexChatGpt(
  windows: CodexWindow[],
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return { windows, ...extra }
}

function agyAppDir(env: E2EEnv, name: string): string {
  return path.join(env.userData, 'agy-homes', name, 'antigravity-cli')
}

function agyGoogle(env: E2EEnv, name: string, buckets: AgyBucket[] | null): void {
  const app = agyAppDir(env, name)
  fs.mkdirSync(path.join(app, 'cache'), { recursive: true })
  fs.writeFileSync(
    path.join(app, 'cache', 'onboarding.json'),
    JSON.stringify({ onboardingComplete: true })
  )
  fs.writeFileSync(path.join(app, 'antigravity-oauth-token'), '{}')
  if (buckets)
    fs.writeFileSync(
      path.join(app, 'fake-agy-usage.json'),
      JSON.stringify({
        groups: [
          {
            name: 'Gemini Models',
            buckets: buckets.map((b, i) => ({
              id: `bucket-${i}`,
              name: b.name,
              window: b.window,
              remaining_fraction: b.remaining,
              reset_time: new Date(b.resetsAt * 1000).toISOString()
            }))
          }
        ]
      })
    )
}

function agyKey(env: E2EEnv, name: string): void {
  const app = agyAppDir(env, name)
  fs.mkdirSync(path.join(app, 'cache'), { recursive: true })
  fs.writeFileSync(
    path.join(app, 'cache', 'onboarding.json'),
    JSON.stringify({ onboardingComplete: true })
  )
  addKeychainEntry(env, UNPACKAGED_BUILD_SERVICE['agy-home'], name, `gemini-fixture-${name}`)
}

function agySignedOut(env: E2EEnv, name: string): void {
  fs.mkdirSync(agyAppDir(env, name), { recursive: true })
}

// CC§7
async function startClaudeProbe(
  answers: Record<string, ClaudeAnswer>
): Promise<{ base: string; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      const auth = String(req.headers['authorization'] ?? req.headers['x-api-key'] ?? '')
      const name = auth.replace(/^Bearer /, '').replace(/^sk-ant-fixture-/, '')
      const a = answers[name] ?? {}
      if (a.status && a.status !== 200) {
        res.writeHead(a.status, { 'content-type': 'application/json' }).end('{}')
        return
      }
      res
        .writeHead(200, {
          'content-type': 'application/json',
          ...(a.u5 === undefined
            ? {}
            : {
                'anthropic-ratelimit-unified-5h-utilization': String(a.u5),
                'anthropic-ratelimit-unified-5h-status': a.s5 ?? 'allowed',
                'anthropic-ratelimit-unified-5h-reset': String(a.r5 ?? FIXED_S + 2 * HOUR_S)
              }),
          'anthropic-ratelimit-unified-7d-utilization': String(a.u7 ?? 0.2),
          'anthropic-ratelimit-unified-7d-status': 'allowed',
          'anthropic-ratelimit-unified-7d-reset': String(a.r7 ?? FIXED_S + 3 * DAY_S),
          ...(a.uoi === undefined
            ? {}
            : {
                'anthropic-ratelimit-unified-7d_oi-utilization': String(a.uoi),
                'anthropic-ratelimit-unified-7d_oi-status': a.soi ?? 'allowed',
                'anthropic-ratelimit-unified-7d_oi-reset': String(FIXED_S + 3 * DAY_S)
              })
        })
        .end('{}')
    })
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((ok) => server.close(() => ok()))
  }
}

async function launchAtFixedTime(env: E2EEnv): Promise<{ app: ElectronApplication; page: Page }> {
  env.launchEnv.TZ = 'UTC'
  env.launchEnv.KOLOFT_E2E_CLOCK_SHIFT_MS = String(FIXED_NOW - Date.now())
  env.extraArgs.push(...PINNED_RENDERING)
  const app = await launchApp(env, { preloadInMain: SHIFTED_CLOCK })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await app.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height)
  }, WINDOW)
  await page.clock.setFixedTime(FIXED_NOW)
  await page.context().addInitScript((css) => {
    const put = (): void => {
      const style = document.createElement('style')
      style.textContent = css
      document.documentElement.appendChild(style)
    }
    if (document.documentElement) put()
    else
      new MutationObserver((_, watch) => {
        if (!document.documentElement) return
        watch.disconnect()
        put()
      }).observe(document, { childList: true })
  }, EVERY_ANIMATION_AT_ITS_END)
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  expect(
    await page.evaluate(() =>
      document
        .getAnimations()
        .filter((a) => Number(a.effect?.getComputedTiming().duration ?? 0) > 0)
        .map(
          (a) =>
            `${(a as CSSAnimation).animationName ?? a.constructor.name} ${a.effect?.getComputedTiming().duration} on ${((a.effect as KeyframeEffect)?.target as Element | null)?.className}`
        )
    )
  ).toEqual([])
  return { app, page }
}

async function openAccounts(page: Page): Promise<void> {
  await waitBooted(page)
  await page.locator('.tb-ico[title="Settings"]').click()
  await page.getByRole('tab', { name: 'Accounts', exact: true }).click()
  await expect(page.locator('.set-ph h3', { hasText: /^Accounts$/ })).toBeVisible()
}

function group(page: Page, title: string): Locator {
  return page.locator('.set-grp', { hasText: new RegExp(`^${title}$`) })
}

function agentParts(page: Page, agent: 'Claude' | 'Codex' | 'Antigravity'): Locator[] {
  const head = group(page, agent)
  const section = head.locator('xpath=following-sibling::div[contains(@class,"acct-section")][1]')
  return agent === 'Claude'
    ? [head, head.locator('xpath=following-sibling::div[1]'), section]
    : [head, section]
}

async function expectAgentSections(page: Page, env: E2EEnv, prefix: string): Promise<void> {
  for (const [agent, id] of [
    ['Claude', 'claude'],
    ['Codex', 'codex'],
    ['Antigravity', 'agy']
  ] as const) {
    const parts = agentParts(page, agent)
    await expectScreen(page, { name: `${prefix}-${id}`, parts, hideHomeIn: env.home })
  }
}

async function accountsSettled(page: Page, rows: number): Promise<void> {
  await expect(page.locator('.acct-section .acct-row')).toHaveCount(rows, { timeout: 20_000 })
  await expect(page.locator('.acct-note', { hasText: /^Not probed yet$/ })).toHaveCount(0, {
    timeout: 20_000
  })
  await expect(page.locator('button.mini', { hasText: 'Refresh usage' })).toBeEnabled()
}

test.describe('C5-T0 accounts page: one set of screenshots, structure and screen-reader text per agent', () => {
  test('accounts page with no account at all, every agent installed', async ({ env }) => {
    installFakeCodex(env)
    installFakeAgy(env)
    seedAccounts(env, [])
    const { app, page } = await launchAtFixedTime(env)
    try {
      await openAccounts(page)
      await expect(
        page.locator('.acct-empty', { hasText: /^No (Codex |Antigravity )?accounts yet/ })
      ).toHaveCount(3)
      await expectScreen(page, {
        name: 'accounts-top',
        parts: [
          page.locator('.set-ph'),
          page.locator('.set-row').nth(0),
          page.locator('.set-row').nth(1)
        ],
        hideHomeIn: env.home
      })
      await expectAgentSections(page, env, 'accounts-empty')
    } finally {
      await quitAndClose(app)
    }
  })

  test('accounts page with one row of every kind of account, each measured', async ({ env }) => {
    installFakeCodex(env)
    installFakeAgy(env)
    seedAccounts(env, [
      { name: 'studio', kind: 'oauth', fable: 'yes' },
      { name: 'garden', kind: 'oauth', fable: 'no' },
      { name: 'metered', kind: 'apikey' },
      {
        name: 'gateway',
        kind: 'custom',
        baseUrl: 'https://llm.example.invalid/anthropic',
        model: 'house-model'
      },
      { name: 'plus', kind: 'codex-home' },
      { name: 'byok', kind: 'codex-home' },
      { name: 'google', kind: 'agy-home' },
      { name: 'gemini-key', kind: 'agy-home' }
    ])
    codexSignIn(
      env,
      'plus',
      codexChatGpt(
        [
          { mins: 300, usedPercent: 25, resetsInMins: 270 },
          { mins: 10080, usedPercent: 61, resetsInMins: 4 * 1440 + 60 }
        ],
        { balance: 1250, resets: 2 }
      )
    )
    codexSignIn(env, 'byok', { auth_mode: 'apikey', OPENAI_API_KEY: 'sk-proj-fixture-byok' })
    agyGoogle(env, 'google', [
      {
        name: 'Weekly Limit Remaining',
        window: 'weekly',
        remaining: 0.58,
        resetsAt: FIXED_S + 5 * DAY_S
      },
      {
        name: 'Five Hour Limit Remaining',
        window: '5h',
        remaining: 0.9,
        resetsAt: FIXED_S + 3 * HOUR_S
      }
    ])
    agyKey(env, 'gemini-key')
    const probe = await startClaudeProbe({
      studio: { u5: 0.42, u7: 0.63, uoi: 0.18 },
      garden: { u5: 0.07, u7: 0.31 },
      metered: {},
      gateway: {}
    })
    env.launchEnv.KOLOFT_PROBE_BASE_URL = probe.base
    const { app, page } = await launchAtFixedTime(env)
    try {
      await openAccounts(page)
      await accountsSettled(page, 8)
      await expectAgentSections(page, env, 'accounts-every-kind')
    } finally {
      await quitAndClose(app)
      await probe.close()
    }
  })

  test('accounts page where things went wrong: expired, unverified, a failed probe, used up, signed out, switched off; then a delete asked and a sign-in again opened', async ({
    env
  }) => {
    installFakeCodex(env)
    installFakeAgy(env)
    seedAccounts(env, [
      { name: 'lapsed', kind: 'oauth', fable: 'yes', status: 'expired' },
      { name: 'walled', kind: 'oauth', fable: 'yes' },
      { name: 'offline', kind: 'oauth', fable: 'no' },
      { name: 'resting', kind: 'oauth', enabled: false },
      { name: 'unchecked', kind: 'apikey', status: 'unverified' },
      { name: 'signed-out', kind: 'codex-home' },
      { name: 'capped', kind: 'codex-home' },
      { name: 'paused', kind: 'codex-home', enabled: false },
      { name: 'logged-off', kind: 'agy-home' },
      { name: 'drained', kind: 'agy-home' }
    ])
    codexSignIn(env, 'signed-out', null)
    codexSignIn(
      env,
      'capped',
      codexChatGpt(
        [
          { mins: 300, usedPercent: 100, resetsInMins: 40 },
          { mins: 10080, usedPercent: 92, resetsInMins: 2 * 1440 }
        ],
        { resets: 1 }
      )
    )
    codexSignIn(env, 'paused', codexChatGpt([{ mins: 10080, usedPercent: 12, resetsInMins: 1440 }]))
    agySignedOut(env, 'logged-off')
    agyGoogle(env, 'drained', [
      {
        name: 'Weekly Limit Remaining',
        window: 'weekly',
        remaining: 0,
        resetsAt: FIXED_S + 2 * DAY_S
      },
      {
        name: 'Five Hour Limit Remaining',
        window: '5h',
        remaining: 0.35,
        resetsAt: FIXED_S + HOUR_S
      }
    ])
    const probe = await startClaudeProbe({
      lapsed: { status: 401 },
      walled: { u5: 1, s5: 'rejected', r5: FIXED_S + 40 * 60, u7: 0.7, uoi: 0.97, soi: 'rejected' },
      offline: { status: 503 },
      unchecked: { status: 503 }
    })
    env.launchEnv.KOLOFT_PROBE_BASE_URL = probe.base
    const { app, page } = await launchAtFixedTime(env)
    try {
      await openAccounts(page)
      await expect(page.locator('.acct-section .acct-row')).toHaveCount(10, { timeout: 20_000 })
      await expect(page.locator('.acct-note', { hasText: 'Probe failed: network' })).toBeVisible({
        timeout: 20_000
      })
      await expect(
        page.locator('.acct-note', { hasText: /^Gemini Models · 7d resets / })
      ).toBeVisible({
        timeout: 20_000
      })
      await expect(page.locator('.acct-note', { hasText: /^5h resets / })).toHaveCount(2, {
        timeout: 20_000
      })
      await expectAgentSections(page, env, 'accounts-trouble')

      const row = (name: string): Locator =>
        page.locator('.acct-row', {
          has: page.locator('.acct-name', { hasText: new RegExp(`^${name}$`) })
        })
      await row('walled').getByRole('button', { name: 'Delete account' }).click()
      await expect(row('walled').locator('.acct-confirm')).toBeVisible()
      await expectScreen(page, { name: 'accounts-delete-asked-claude', parts: [row('walled')] })
      await page.keyboard.press('Escape')
      await expect(row('walled').locator('.acct-confirm')).toHaveCount(0)
      await row('capped').getByRole('button', { name: 'Delete account' }).click()
      await expect(row('capped').locator('.acct-confirm')).toBeVisible()
      await expectScreen(page, { name: 'accounts-delete-asked-codex', parts: [row('capped')] })
      await page.keyboard.press('Escape')
      await row('drained').getByRole('button', { name: 'Delete account' }).click()
      await expect(row('drained').locator('.acct-confirm')).toBeVisible()
      await expectScreen(page, { name: 'accounts-delete-asked-agy', parts: [row('drained')] })
      await page.keyboard.press('Escape')

      for (const [name, agent, id] of [
        ['lapsed', 'Claude', 'claude'],
        ['signed-out', 'Codex', 'codex'],
        ['logged-off', 'Antigravity', 'agy']
      ] as const) {
        await row(name).getByRole('button', { name: 'Sign in again' }).click()
        const form = agentParts(page, agent)[agent === 'Claude' ? 2 : 1].locator('.acct-add')
        await expect(form.locator('.acct-add-title')).toHaveText(`Sign in again ${name}`)
        await expectScreen(page, { name: `accounts-sign-in-again-${id}`, parts: [form] })
      }
    } finally {
      await quitAndClose(app)
      await probe.close()
    }
  })

  test('accounts page add forms: the one form each agent offers to paste a secret into', async ({
    env
  }) => {
    installFakeCodex(env)
    installFakeAgy(env)
    seedAccounts(env, [])
    const { app, page } = await launchAtFixedTime(env)
    try {
      await openAccounts(page)
      for (const [button, title, id] of [
        ['Paste token', 'Paste token', 'claude'],
        ['Paste API key', 'Add OpenAI API key', 'codex'],
        ['Paste Gemini API key', 'Add Gemini API key', 'agy']
      ] as const) {
        await page.getByRole('button', { name: button, exact: true }).click()
        const form = page.locator('.acct-add')
        await expect(form.locator('.acct-add-title')).toHaveText(title)
        await expect(form).toHaveCount(1)
        await expectScreen(page, { name: `accounts-add-form-${id}`, parts: [form] })
      }
    } finally {
      await quitAndClose(app)
    }
  })

  test('Claude Code signs in in the background and the account is saved', async ({ env }) => {
    env.launchEnv.KOLOFT_FAKE_SETUP_TOKEN = 'sk-ant-oat01-fixture-saved-0123456789abcdef'
    seedAccounts(env, [])
    const probe = await startClaudeProbe({})
    env.launchEnv.KOLOFT_PROBE_BASE_URL = probe.base
    const { app, page } = await launchAtFixedTime(env)
    try {
      await openAccounts(page)
      const section = agentParts(page, 'Claude')[2]
      await section
        .locator('.acct-foot')
        .getByRole('button', { name: 'Sign in', exact: true })
        .click()
      const form = section.locator('.acct-add')
      await form.locator('input[type="text"]').fill('night')
      await form.getByRole('button', { name: 'Sign in', exact: true }).click()
      await expect(form.locator('.acct-login-state.ok')).toBeVisible({ timeout: 20_000 })
      await expectScreen(page, { name: 'accounts-sign-in-claude-saved', parts: [form] })
    } finally {
      await quitAndClose(app)
      await probe.close()
    }
  })

  test('Claude Code signs in in the background: the form, the browser step, and a sign-in that did not complete', async ({
    env
  }) => {
    const LOGIN_TIMEOUT_LONG_ENOUGH_TO_SHOOT_THE_BROWSER_STEP_MS = 15_000
    env.launchEnv.KOLOFT_FAKE_SETUP_URL = 'https://example.invalid/oauth/authorize?state=fixture'
    env.launchEnv.KOLOFT_FAKE_SETUP_TOKEN = 'none'
    env.launchEnv.KOLOFT_LOGIN_TIMEOUT_MS = String(
      LOGIN_TIMEOUT_LONG_ENOUGH_TO_SHOOT_THE_BROWSER_STEP_MS
    )
    seedAccounts(env, [])
    const { app, page } = await launchAtFixedTime(env)
    try {
      await openAccounts(page)
      const section = agentParts(page, 'Claude')[2]
      await section
        .locator('.acct-foot')
        .getByRole('button', { name: 'Sign in', exact: true })
        .click()
      const form = section.locator('.acct-add')
      await form.locator('input[type="text"]').fill('night')
      await expectScreen(page, { name: 'accounts-sign-in-claude-form', parts: [form] })
      await form.getByRole('button', { name: 'Sign in', exact: true }).click()
      await expect(form.getByRole('button', { name: 'Open authorization page' })).toBeVisible({
        timeout: 20_000
      })
      await expectScreen(page, { name: 'accounts-sign-in-claude-browser', parts: [form] })
      const tail = form.locator('.acct-login-tail')
      await expect(tail).toContainText('Sign-in timed out', { timeout: 45_000 })
      await tail.evaluate((el, text) => {
        el.textContent = text
      }, HIDDEN_TERMINAL_STAND_IN)
      await expectScreen(page, { name: 'accounts-sign-in-claude-failed', parts: [form] })
    } finally {
      await quitAndClose(app)
    }
  })

  for (const agent of [
    {
      id: 'codex',
      label: 'Codex',
      button: 'Sign in to Codex',
      install: (env: E2EEnv) => {
        installFakeCodex(env)
        fs.writeFileSync(path.join(env.home, 'fake-codex-login-waits'), '')
      }
    },
    { id: 'agy', label: 'Antigravity', button: 'Sign in with Google', install: installFakeAgy }
  ] as const) {
    test(`${agent.label} signs in in a terminal tab: the form, the tab's bar, and the banner when it did not complete`, async ({
      env
    }) => {
      agent.install(env)
      seedAccounts(env, [])
      const { app, page } = await launchAtFixedTime(env)
      try {
        await openAccounts(page)
        await page.getByRole('button', { name: agent.button }).click()
        const form = page.locator('.acct-add')
        await form.locator('input[type="text"]').fill('fresh')
        await expectScreen(page, { name: `accounts-sign-in-${agent.id}-form`, parts: [form] })
        await form.getByRole('button', { name: 'Sign in', exact: true }).click()
        const bar = page.locator('.term-island > .wb-bar')
        await expect(bar.locator('.wb-title')).toHaveText(`${agent.label} sign in: fresh`, {
          timeout: 20_000
        })
        await expectScreen(page, {
          name: `accounts-sign-in-${agent.id}-tab-bar`,
          parts: [bar],
          room: 0
        })
        await bar.getByRole('button', { name: 'Cancel' }).click()
        const failed = page.locator('.acct-add')
        await expect(failed.locator('.acct-login-state.bad')).toBeVisible({ timeout: 20_000 })
        await expectScreen(page, {
          name: `accounts-sign-in-${agent.id}-failed`,
          parts: [failed],
          hideHomeIn: env.home
        })
      } finally {
        await quitAndClose(app)
      }
    })
  }
})

function firstRun(env: E2EEnv, accounts: Seeded[], extra: Record<string, unknown> = {}): void {
  fs.writeFileSync(
    path.join(env.userData, 'layout.json'),
    JSON.stringify({
      version: 6,
      workspaces: [],
      workbench: { defaultOpen: true },
      members: [],
      panels: {}
    })
  )
  seedAccounts(env, accounts, { onboardingSeen: false, ...extra })
}

function claudeHistory(env: E2EEnv, folder: string, title: string, agoMs: number): void {
  seedJsonl(env, folder, {
    summary: title,
    mtime: FIXED_NOW - agoMs,
    timestamp: FIXED_NOW - agoMs,
    owned: false
  })
}

function codexHistory(env: E2EEnv, folder: string, title: string, agoS: number): void {
  const id = `0199a1b2-c3d4-7e5f-8a6b-${String(agoS).padStart(12, '0')}`
  const saved = path.join(env.home, '.codex', 'sessions')
  fs.mkdirSync(saved, { recursive: true })
  fs.writeFileSync(
    path.join(saved, id + '.json'),
    JSON.stringify({
      id,
      cwd: folder,
      name: title,
      preview: title,
      createdAt: FIXED_S - agoS,
      updatedAt: FIXED_S - agoS,
      turns: []
    })
  )
}

function welcome(page: Page): Locator {
  return page.locator('.wl')
}

async function expectStep(page: Page, n: number): Promise<void> {
  await expect(welcome(page)).toHaveAttribute('data-step', String(n), { timeout: 20_000 })
}

function welcomeGo(page: Page): Locator {
  return welcome(page).locator('[data-welcome-go]').first()
}

async function nextStep(page: Page, n: number): Promise<void> {
  await expect(welcomeGo(page)).toBeEnabled({ timeout: 20_000 })
  await welcomeGo(page).click()
  await expectStep(page, n)
}

async function expectWelcome(page: Page, env: E2EEnv, name: string): Promise<void> {
  await expectScreen(page, { name, parts: [welcome(page)], room: 0, hideHomeIn: env.home })
}

async function pickAgentTab(page: Page, product: string): Promise<void> {
  await welcome(page).locator('.wl-seg button', { hasText: product }).click()
  await expect(welcome(page).locator('.wl-seg button.on')).toContainText(product)
}

test.describe('C5-T0 welcome: every step, for each agent installed or not and signed in or not', () => {
  test('nothing installed on an empty Mac: step 1, the folder pick, each agent offered to install, and the last step', async ({
    env
  }) => {
    firstRun(env, [])
    env.launchEnv.KOLOFT_TEST_CLAUDE_PROBE = 'missing'
    const { app, page } = await launchAtFixedTime(env)
    try {
      await expectStep(page, 1)
      await expect(welcome(page).locator('.wl-chip')).toHaveText(/0 of 3 ready/, {
        timeout: 20_000
      })
      await expectWelcome(page, env, 'welcome-1-nothing-installed')
      await nextStep(page, 2)
      await expect(welcome(page).locator('.wl-chip')).toHaveText('No sessions on this Mac yet')
      await expectWelcome(page, env, 'welcome-2-empty-mac')
      answerFileDialog(env, env.workspaces.a)
      await welcomeGo(page).click()
      await expect(welcome(page).locator('.wl-chip')).toHaveText('ws-a is pinned', {
        timeout: 20_000
      })
      await expectWelcome(page, env, 'welcome-2-folder-picked')
      await nextStep(page, 3)
      for (const [product, id] of [
        ['Claude Code', 'claude'],
        ['Codex', 'codex'],
        ['Antigravity CLI', 'agy']
      ] as const) {
        await pickAgentTab(page, product)
        await expect(welcome(page).locator('.wl-sign-text')).toContainText('first.')
        await expectWelcome(page, env, `welcome-3-${id}-not-installed`)
      }
      await welcome(page).getByRole('button', { name: 'I’ll sign in later' }).click()
      await expectStep(page, 4)
      await expectWelcome(page, env, 'welcome-4-first-session')
    } finally {
      await quitAndClose(app)
    }
  })

  test('every agent installed, past sessions found, no account: steps 1 and 2, step 3 for each agent, and Claude Code’s browser sign-in waiting then failing', async ({
    env
  }) => {
    const LOGIN_TIMEOUT_LONG_ENOUGH_TO_SHOOT_THE_WAIT_MS = 15_000
    installFakeCodex(env)
    installFakeAgy(env)
    firstRun(env, [])
    env.launchEnv.KOLOFT_FAKE_SETUP_URL = 'https://example.invalid/oauth/authorize?state=fixture'
    env.launchEnv.KOLOFT_FAKE_SETUP_TOKEN = 'none'
    env.launchEnv.KOLOFT_LOGIN_TIMEOUT_MS = String(LOGIN_TIMEOUT_LONG_ENOUGH_TO_SHOOT_THE_WAIT_MS)
    claudeHistory(env, env.workspaces.a, 'Tidy the release notes', 2 * HOUR_S * 1000)
    claudeHistory(env, env.workspaces.a, 'Draft the onboarding copy', 3 * DAY_S * 1000)
    codexHistory(env, env.workspaces.b, 'Port the parser', 5 * DAY_S)
    const { app, page } = await launchAtFixedTime(env)
    try {
      await expectStep(page, 1)
      await expect(welcome(page).locator('.wl-chip')).toHaveText('3 of 3 ready on this Mac', {
        timeout: 20_000
      })
      await expect(welcome(page).locator('.wl-agent-state small').first()).toHaveText(
        /2 sessions · 1 folder/
      )
      await expectWelcome(page, env, 'welcome-1-all-installed')
      await nextStep(page, 2)
      await expect(welcome(page).locator('.wl-chip')).toHaveText(/^Found 3 sessions in 2 folders/, {
        timeout: 20_000
      })
      await expectWelcome(page, env, 'welcome-2-sessions-found')
      await nextStep(page, 3)
      for (const [product, id] of [
        ['Codex', 'codex'],
        ['Antigravity CLI', 'agy'],
        ['Claude Code', 'claude']
      ] as const) {
        await pickAgentTab(page, product)
        await expectWelcome(page, env, `welcome-3-${id}-not-signed-in`)
      }
      await welcomeGo(page).click()
      await expect(welcomeGo(page)).toHaveText(/Waiting for your browser/, { timeout: 20_000 })
      await expect(welcome(page).getByRole('button', { name: 'Open the page again' })).toBeVisible({
        timeout: 20_000
      })
      await expectWelcome(page, env, 'welcome-3-claude-waiting-for-browser')
      const tail = welcome(page).locator('.wl-sign-text.bad pre')
      await expect(tail).toContainText('Sign-in timed out', { timeout: 45_000 })
      await tail.evaluate((el, text) => {
        el.textContent = text
      }, HIDDEN_TERMINAL_STAND_IN)
      await expectWelcome(page, env, 'welcome-3-claude-sign-in-failed')
    } finally {
      await quitAndClose(app)
    }
  })

  test('every agent installed and signed in: step 3 for each agent, then the last step resuming the newest session, asking or not', async ({
    env
  }) => {
    installFakeCodex(env)
    installFakeAgy(env)
    firstRun(
      env,
      [
        { name: 'Claude', kind: 'oauth' },
        { name: 'Codex', kind: 'codex-home' },
        { name: 'Antigravity', kind: 'agy-home' }
      ],
      { skipPermissions: true }
    )
    codexSignIn(env, 'Codex', codexChatGpt([{ mins: 10080, usedPercent: 20, resetsInMins: 1440 }]))
    agyGoogle(env, 'Antigravity', null)
    const probe = await startClaudeProbe({ Claude: { u5: 0.1, u7: 0.2 } })
    env.launchEnv.KOLOFT_PROBE_BASE_URL = probe.base
    claudeHistory(env, env.workspaces.a, 'Tidy the release notes', 2 * HOUR_S * 1000)
    const { app, page } = await launchAtFixedTime(env)
    try {
      await expectStep(page, 1)
      await nextStep(page, 2)
      await nextStep(page, 3)
      for (const [product, id, label] of [
        ['Codex', 'codex', 'Codex'],
        ['Antigravity CLI', 'agy', 'Antigravity'],
        ['Claude Code', 'claude', 'Claude']
      ] as const) {
        await pickAgentTab(page, product)
        await expect(welcome(page).locator('.wl-sign-done')).toHaveText(`Signed in to ${label}`)
        await expectWelcome(page, env, `welcome-3-${id}-signed-in`)
      }
      await nextStep(page, 4)
      await expect(welcomeGo(page)).toContainText('Resume “Tidy the release notes”')
      await expectWelcome(page, env, 'welcome-4-resume-without-asking')
      await welcome(page).locator('.wl-perm button').click()
      await expect(welcome(page).locator('.wl-perm')).toContainText('Claude Code asks only')
      const ask = welcome(page).locator('.wl-ask input')
      for (const id of ['claude', 'codex', 'agy']) {
        await expectScreen(page, {
          name: `welcome-4-asking-${id}`,
          parts: [welcome(page).locator('.wl-foot')],
          room: 0
        })
        await ask.press('Tab')
      }
    } finally {
      await quitAndClose(app)
      await probe.close()
    }
  })

  test('a Codex account to sign in again: step 3 says so, steps aside for the sign-in tab, and shows the banner when it did not complete', async ({
    env
  }) => {
    installFakeCodex(env)
    fs.writeFileSync(path.join(env.home, 'fake-codex-login-waits'), '')
    firstRun(env, [{ name: 'work', kind: 'codex-home', status: 'expired' }])
    codexSignIn(env, 'work', null)
    codexHistory(env, env.workspaces.b, 'Port the parser', 600)
    const { app, page } = await launchAtFixedTime(env)
    try {
      await expectStep(page, 1)
      await nextStep(page, 2)
      await nextStep(page, 3)
      await expect(welcome(page).locator('.wl-seg button.on')).toContainText('Codex')
      await expect(welcome(page).locator('.wl-sign-note')).toContainText(
        'This signs “work” in again.'
      )
      await expectWelcome(page, env, 'welcome-3-codex-sign-in-again')
      await welcomeGo(page).click()
      const aside = page.locator('.wl-aside')
      await expect(aside).toBeVisible({ timeout: 20_000 })
      await expectScreen(page, { name: 'welcome-stepped-aside', parts: [aside] })
      const bar = page.locator('.term-island > .wb-bar')
      await bar.getByRole('button', { name: 'Cancel' }).click()
      await expect(welcome(page).locator('.acct-login-state.bad')).toBeVisible({ timeout: 20_000 })
      await expectWelcome(page, env, 'welcome-3-codex-sign-in-failed')
    } finally {
      await quitAndClose(app)
    }
  })
})

function assistSetUp(page: Page): Locator {
  return page.locator('.assist-modal')
}

async function openAssistSetUp(page: Page): Promise<void> {
  await waitBooted(page)
  await page
    .locator('.isl-butler .ws-tab', { hasText: 'Not set up — click to start' })
    .click({ timeout: 20_000 })
  await expect(assistSetUp(page)).toBeVisible({ timeout: 20_000 })
}

test.describe('C5-T0 Assist settings: what Assist runs on, and the set-up question for each agent signed in or not', () => {
  test('Settings ▸ Assist with Claude Code signed in and the other two with no account, and its agent list open', async ({
    env
  }) => {
    installFakeCodex(env)
    installFakeAgy(env)
    seedAccounts(env, [{ name: 'studio', kind: 'oauth' }], { assist: { backend: 'claude' } })
    const probe = await startClaudeProbe({ studio: { u5: 0.1, u7: 0.2 } })
    env.launchEnv.KOLOFT_PROBE_BASE_URL = probe.base
    const { app, page } = await launchAtFixedTime(env)
    try {
      await waitBooted(page)
      await page.locator('.tb-ico[title="Settings"]').click()
      await page.getByRole('tab', { name: 'Assist', exact: true }).click()
      const runsOn = page.getByRole('button', { name: 'Koloft Assist runs on' })
      await expect(runsOn).toContainText('Claude')
      const row = page.locator('.set-row', { has: runsOn })
      await expect(row.locator('.ob-warn')).toHaveCount(2)
      await expectScreen(page, {
        name: 'assist-runs-on',
        parts: [page.locator('.set-grp', { hasText: /^Assist$/ }), row]
      })
      await runsOn.click()
      const list = page.getByRole('listbox', { name: 'Agents' })
      await expect(list.getByRole('option')).toHaveCount(3)
      await expectScreen(page, { name: 'assist-agent-list', parts: [list] })
    } finally {
      await quitAndClose(app)
      await probe.close()
    }
  })

  test('the Assist set-up question with no account at all, every agent installed', async ({
    env
  }) => {
    installFakeCodex(env)
    installFakeAgy(env)
    seedAccounts(env, [], { assist: null, skipPermissionsAgreed: true })
    const { app, page } = await launchAtFixedTime(env)
    try {
      await openAssistSetUp(page)
      await expect(assistSetUp(page).locator('.choice-t')).toHaveText([
        'Claude',
        'Codex',
        'Antigravity'
      ])
      await expectScreen(page, { name: 'assist-set-up-no-account', parts: [assistSetUp(page)] })
    } finally {
      await quitAndClose(app)
    }
  })

  test('the Assist set-up question with Claude Code signed in, a Codex account to sign in again, and the question about asking before each step', async ({
    env
  }) => {
    installFakeCodex(env)
    installFakeAgy(env)
    seedAccounts(
      env,
      [
        { name: 'studio', kind: 'oauth' },
        { name: 'work', kind: 'codex-home', status: 'expired' }
      ],
      { assist: null, skipPermissions: true, skipPermissionsAgreed: false }
    )
    codexSignIn(env, 'work', null)
    const probe = await startClaudeProbe({ studio: { u5: 0.1, u7: 0.2 } })
    env.launchEnv.KOLOFT_PROBE_BASE_URL = probe.base
    const { app, page } = await launchAtFixedTime(env)
    try {
      await openAssistSetUp(page)
      await expect(assistSetUp(page).locator('.choice-d').nth(1)).toContainText(
        '"work" is not signed in'
      )
      await expect(assistSetUp(page).locator('.choice-d').first()).toHaveText(/^Signed in/)
      await expectScreen(page, { name: 'assist-set-up-mixed', parts: [assistSetUp(page)] })
    } finally {
      await quitAndClose(app)
      await probe.close()
    }
  })

  test('the Assist set-up question with no agent on this Mac', async ({ env }) => {
    env.launchEnv.KOLOFT_TEST_CLAUDE_PROBE = 'missing'
    seedAccounts(env, [], { assist: null, skipPermissionsAgreed: true })
    const { app, page } = await launchAtFixedTime(env)
    try {
      await openAssistSetUp(page)
      await expect(assistSetUp(page).locator('.choice-d').first()).toHaveText(
        'Not on this Mac. Click to install.',
        { timeout: 20_000 }
      )
      await expectScreen(page, { name: 'assist-set-up-no-agent', parts: [assistSetUp(page)] })
    } finally {
      await quitAndClose(app)
    }
  })
})

function usageCapsule(page: Page): Locator {
  return page.locator('button.tbu')
}

function usagePopover(page: Page): Locator {
  return page.locator('.tbu-pop')
}

async function openUsagePopover(page: Page): Promise<void> {
  await usageCapsule(page).click()
  await expect(usagePopover(page)).toBeVisible()
  await expect(usagePopover(page).locator('.tbu-act').first()).toHaveText(/Probe now/, {
    timeout: 20_000
  })
  await usagePopover(page).locator('.tbu-pop-head').first().hover()
}

test.describe('C5-T0 top-bar usage: the capsule and its panel for every agent', () => {
  test('many accounts: Claude Code’s 5-hour, 7-day and fable bars with a total row, Codex’s windows with a total row and a reset to use, Antigravity’s quota buckets and an API key', async ({
    env
  }) => {
    installFakeCodex(env)
    installFakeAgy(env)
    seedAccounts(env, [
      { name: 'studio', kind: 'oauth', fable: 'yes' },
      { name: 'garden', kind: 'oauth', fable: 'no' },
      { name: 'walled', kind: 'oauth', fable: 'yes' },
      { name: 'metered', kind: 'apikey' },
      { name: 'plus', kind: 'codex-home' },
      { name: 'capped', kind: 'codex-home' },
      { name: 'signed-out', kind: 'codex-home' },
      { name: 'google', kind: 'agy-home' },
      { name: 'gemini-key', kind: 'agy-home' }
    ])
    codexSignIn(
      env,
      'plus',
      codexChatGpt(
        [
          { mins: 300, usedPercent: 25, resetsInMins: 270 },
          { mins: 10080, usedPercent: 61, resetsInMins: 4 * 1440 + 60 }
        ],
        { balance: 1250 }
      )
    )
    codexSignIn(
      env,
      'capped',
      codexChatGpt(
        [
          { mins: 300, usedPercent: 100, resetsInMins: 40 },
          { mins: 10080, usedPercent: 92, resetsInMins: 2 * 1440 }
        ],
        { resets: 2 }
      )
    )
    codexSignIn(env, 'signed-out', null)
    agyGoogle(env, 'google', [
      {
        name: 'Weekly Limit Remaining',
        window: 'weekly',
        remaining: 0.58,
        resetsAt: FIXED_S + 5 * DAY_S
      },
      {
        name: 'Five Hour Limit Remaining',
        window: '5h',
        remaining: 0.9,
        resetsAt: FIXED_S + 3 * HOUR_S
      }
    ])
    agyKey(env, 'gemini-key')
    const probe = await startClaudeProbe({
      studio: { u5: 0.42, u7: 0.63, uoi: 0.18 },
      garden: { u5: 0.07, u7: 0.31 },
      walled: { u5: 1, s5: 'rejected', r5: FIXED_S + 40 * 60, u7: 0.7, uoi: 0.97, soi: 'rejected' },
      metered: {}
    })
    env.launchEnv.KOLOFT_PROBE_BASE_URL = probe.base
    const { app, page } = await launchAtFixedTime(env)
    try {
      await waitBooted(page)
      await expect(usageCapsule(page).locator('.tbu-group')).toHaveCount(2, { timeout: 20_000 })
      await expect(usageCapsule(page)).toHaveAttribute('aria-label', /Antigravity/, {
        timeout: 20_000
      })
      await expect(usageCapsule(page)).toHaveAttribute('aria-label', /walled/i, { timeout: 20_000 })
      await expectScreen(page, { name: 'topbar-usage-capsule-many', parts: [usageCapsule(page)] })
      await openUsagePopover(page)
      await expectScreen(page, {
        name: 'topbar-usage-panel-many',
        parts: [usagePopover(page)],
        mouseStays: true
      })
      await usagePopover(page)
        .locator('.tbu-rows')
        .evaluate((rows) => rows.scrollTo({ top: rows.scrollHeight, behavior: 'instant' }))
      await expect(
        usagePopover(page).locator('.tbu-row', { hasText: 'gemini-key' })
      ).toBeInViewport()
      await expectScreen(page, {
        name: 'topbar-usage-panel-many-scrolled-down',
        parts: [usagePopover(page)],
        mouseStays: true
      })
      await usagePopover(page).getByRole('button', { name: 'Use a reset' }).click()
      const confirm = usagePopover(page).locator('.acct-confirm')
      await expect(confirm).toBeVisible()
      await expectScreen(page, {
        name: 'topbar-usage-codex-reset-asked',
        parts: [usagePopover(page).locator('.tbu-row', { has: page.locator('.acct-confirm') })],
        mouseStays: true
      })
    } finally {
      await quitAndClose(app)
      await probe.close()
    }
  })

  test('one Claude Code subscription walled with an API key standing by: no total row, and the metered fallback bar', async ({
    env
  }) => {
    seedAccounts(env, [
      { name: 'walled', kind: 'oauth', fable: 'no' },
      { name: 'metered', kind: 'apikey' }
    ])
    const probe = await startClaudeProbe({
      walled: {
        u5: 1,
        s5: 'rejected',
        r5: FIXED_S + 3 * HOUR_S,
        u7: 0.97,
        r7: FIXED_S + 2 * DAY_S
      },
      metered: {}
    })
    env.launchEnv.KOLOFT_PROBE_BASE_URL = probe.base
    const { app, page } = await launchAtFixedTime(env)
    try {
      await waitBooted(page)
      await expect(usageCapsule(page).locator('.tbu-fill.acc')).toBeVisible({ timeout: 20_000 })
      await expectScreen(page, {
        name: 'topbar-usage-capsule-fallback',
        parts: [usageCapsule(page)]
      })
      await openUsagePopover(page)
      await expectScreen(page, {
        name: 'topbar-usage-panel-fallback',
        parts: [usagePopover(page)],
        mouseStays: true
      })
    } finally {
      await quitAndClose(app)
      await probe.close()
    }
  })
})

function appendJsonLines(file: string, lines: unknown[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
}

function claudeUsage(
  env: E2EEnv,
  folder: string,
  title: string,
  atMs: number,
  input: number
): void {
  const id = seedJsonl(env, folder, { summary: title, mtime: atMs, timestamp: atMs, owned: false })
  const projects = path.join(env.home, '.claude', 'projects')
  const file = fs
    .readdirSync(projects)
    .map((d) => path.join(projects, d, `${id}.jsonl`))
    .find((f) => fs.existsSync(f))!
  appendJsonLines(file, [
    {
      type: 'assistant',
      sessionId: id,
      requestId: `req-${id}`,
      timestamp: new Date(atMs).toISOString(),
      message: {
        id: `msg-${id}`,
        model: 'claude-opus-5-5',
        usage: { input_tokens: input, output_tokens: input / 10 }
      }
    }
  ])
  fs.utimesSync(file, new Date(atMs), new Date(atMs))
}

function codexUsage(env: E2EEnv, folder: string, atMs: number, input: number): void {
  const at = new Date(atMs)
  const p2 = (n: number): string => String(n).padStart(2, '0')
  const thread = `0199a1b2-c3d4-7e5f-8a6b-${String(atMs).slice(-12)}`
  const file = path.join(
    env.home,
    '.codex',
    'sessions',
    String(at.getUTCFullYear()),
    p2(at.getUTCMonth() + 1),
    p2(at.getUTCDate()),
    `rollout-${at.toISOString().slice(0, 19).replace(/:/g, '-')}-${thread}.jsonl`
  )
  const ts = at.toISOString()
  appendJsonLines(file, [
    { timestamp: ts, type: 'session_meta', payload: { id: thread, cwd: folder } },
    { timestamp: ts, type: 'turn_context', payload: { turn_id: 't1', model: 'gpt-5.5' } },
    {
      timestamp: ts,
      type: 'token_usage_record',
      payload: {
        turn_id: 't1',
        response_id: 'r1',
        usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: 0 }
      }
    }
  ])
}

function agyUsage(env: E2EEnv, atMs: number, input: number): void {
  const id = `7d1f0c2a-0b3e-4c5d-9e6f-${String(atMs).slice(-12)}`
  const app = path.join(env.home, '.gemini', 'antigravity-cli')
  const at = new Date(atMs).toISOString()
  appendJsonLines(path.join(app, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl'), [
    { type: 'USER_INPUT', created_at: at, content: 'hi' },
    {
      type: 'PLANNER_RESPONSE',
      created_at: at,
      content: 'hello',
      input_tokens: input,
      output_tokens: 0,
      cache_read_tokens: 0
    }
  ])
  fs.mkdirSync(path.join(app, 'conversations'), { recursive: true })
  const db = new DatabaseSync(path.join(app, 'conversations', `${id}.db`))
  db.exec('create table gen_metadata (idx integer primary key, data blob)')
  db.exec('create table executor_metadata (idx integer primary key, data blob)')
  db.prepare('insert into gen_metadata (idx, data) values (?, ?)').run(
    0,
    protobufString(1, protobufString(19, Buffer.from('gemini-3.1-pro')))
  )
  db.close()
}

function protobufString(field: number, inner: Buffer): Buffer {
  return Buffer.concat([varint((field << 3) | 2), varint(inner.length), inner])
}

function varint(n: number): Buffer {
  const out: number[] = []
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80)
    n >>>= 7
  }
  out.push(n)
  return Buffer.from(out)
}

test.describe('C5-T0 Settings ▸ Usage: the chart and every grouping, with sessions of all three agents', () => {
  test('usage page by day, session, workspace and model', async ({ env }) => {
    installFakeCodex(env)
    installFakeAgy(env)
    seedAccounts(env, [])
    const day = DAY_S * 1000
    claudeUsage(
      env,
      env.workspaces.a,
      'Tidy the release notes',
      FIXED_NOW - HOUR_S * 1000,
      1_000_000
    )
    claudeUsage(env, env.workspaces.b, 'Draft the onboarding copy', FIXED_NOW - 3 * day, 400_000)
    codexUsage(env, env.workspaces.a, FIXED_NOW - day, 400_000)
    agyUsage(env, FIXED_NOW - 2 * HOUR_S * 1000, 500_000)
    const { app, page } = await launchAtFixedTime(env)
    try {
      await waitBooted(page)
      await page.locator('.tb-ico[title="Settings"]').click()
      await page.getByRole('tab', { name: 'Usage', exact: true }).click()
      await expect(page.locator('.costs-sum .n').nth(1)).toHaveText('4', { timeout: 30_000 })
      await expectScreen(page, {
        name: 'usage-page-chart',
        parts: [
          page.locator('.set-ph'),
          page.locator('.costs-head'),
          page.locator('.costs-sum'),
          page.locator('.costs-chart'),
          page.locator('.costs-x')
        ],
        hideHomeIn: env.home
      })
      for (const [label, id] of [
        ['Day', 'day'],
        ['Session', 'session'],
        ['Workspace', 'workspace'],
        ['Model', 'model']
      ] as const) {
        await page.locator('.costs-head button', { hasText: new RegExp(`^${label}$`) }).click()
        const list = page.locator('.costs-list')
        await expect(
          page.locator('.costs-head button.on', { hasText: new RegExp(`^${label}$`) })
        ).toBeVisible()
        await expectScreen(page, {
          name: `usage-page-by-${id}`,
          parts: [
            list.locator('xpath=preceding-sibling::div[contains(@class,"set-grp")][1]'),
            list
          ],
          hideHomeIn: env.home
        })
      }
    } finally {
      await quitAndClose(app)
    }
  })
})
