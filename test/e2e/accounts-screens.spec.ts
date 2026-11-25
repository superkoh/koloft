import fs from 'fs'
import path from 'path'
import type { Locator, Page } from '@playwright/test'
import { test, expect, quitAndClose } from './helpers/app'
import { installAgyWithNoAccount, type E2EEnv } from './helpers/env'
import { waitBooted } from './helpers/p1'
import { expectScreen } from './helpers/screenCompare'
import {
  agyGoogle,
  agyKey,
  agySignedOut,
  codexChatGpt,
  codexSignIn,
  DAY_S,
  FIXED_S,
  HIDDEN_TERMINAL_STAND_IN,
  HOUR_S,
  installCodexAtFixedTime,
  launchAtFixedTime,
  SCREENS_TAKE_LONGER_THAN_THE_DEFAULT_MS,
  seedAccounts,
  startClaudeProbe
} from './helpers/screenSeeds'

test.describe.configure({ timeout: SCREENS_TAKE_LONGER_THAN_THE_DEFAULT_MS })

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

async function expectAgentSections(page: Page, prefix: string): Promise<void> {
  for (const [agent, id] of [
    ['Claude', 'claude'],
    ['Codex', 'codex'],
    ['Antigravity', 'agy']
  ] as const) {
    const parts = agentParts(page, agent)
    await expectScreen(page, { name: `${prefix}-${id}`, parts })
  }
}

async function accountsSettled(page: Page, rows: number): Promise<void> {
  await expect(page.locator('.acct-section .acct-row')).toHaveCount(rows, { timeout: 20_000 })
  await expect(page.locator('.acct-note', { hasText: /^Not probed yet$/ })).toHaveCount(0, {
    timeout: 20_000
  })
  await expect(page.locator('button.mini', { hasText: 'Refresh usage' })).toBeEnabled()
}

test.describe('accounts page: one set of screenshots, structure and screen-reader text per agent', () => {
  test('accounts page with no account at all, every agent installed', async ({ env }) => {
    installCodexAtFixedTime(env)
    installAgyWithNoAccount(env)
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
        ]
      })
      await expectAgentSections(page, 'accounts-empty')
    } finally {
      await quitAndClose(app)
    }
  })

  test('accounts page with one row of every kind of account, each measured', async ({ env }) => {
    installCodexAtFixedTime(env)
    installAgyWithNoAccount(env)
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
      await expect(
        page.locator('.acct-note', { hasText: /^Gemini Models · 7d resets / })
      ).toBeVisible({ timeout: 20_000 })
      await expectAgentSections(page, 'accounts-every-kind')
    } finally {
      await quitAndClose(app)
      await probe.close()
    }
  })

  test('accounts page where things went wrong: expired, unverified, a failed probe, used up, signed out, switched off; then a delete asked and a sign-in again opened', async ({
    env
  }) => {
    installCodexAtFixedTime(env)
    installAgyWithNoAccount(env)
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
      await expectAgentSections(page, 'accounts-trouble')

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
      await expect(row('capped').locator('.acct-confirm')).toHaveCount(0)
      await row('drained').getByRole('button', { name: 'Delete account' }).click()
      await expect(row('drained').locator('.acct-confirm')).toBeVisible()
      await expectScreen(page, { name: 'accounts-delete-asked-agy', parts: [row('drained')] })
      await page.keyboard.press('Escape')
      await expect(row('drained').locator('.acct-confirm')).toHaveCount(0)

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
    installCodexAtFixedTime(env)
    installAgyWithNoAccount(env)
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
        installCodexAtFixedTime(env)
        fs.writeFileSync(path.join(env.home, 'fake-codex-login-waits'), '')
      }
    },
    {
      id: 'agy',
      label: 'Antigravity',
      button: 'Sign in with Google',
      install: installAgyWithNoAccount
    }
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
          parts: [failed]
        })
      } finally {
        await quitAndClose(app)
      }
    })
  }
})
