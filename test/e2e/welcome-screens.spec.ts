import fs from 'fs'
import path from 'path'
import type { Locator, Page } from '@playwright/test'
import { test, expect, quitAndClose } from './helpers/app'
import { installAgyWithNoAccount, type E2EEnv } from './helpers/env'
import { seedJsonl } from './helpers/p1'
import { expectScreen } from './helpers/screenCompare'
import {
  agyGoogle,
  codexChatGpt,
  codexSignIn,
  DAY_S,
  FIXED_NOW,
  FIXED_S,
  HIDDEN_TERMINAL_STAND_IN,
  HOUR_S,
  installCodexAtFixedTime,
  launchAtFixedTime,
  SCREENS_TAKE_LONGER_THAN_THE_DEFAULT_MS,
  seedAccounts,
  startClaudeProbe,
  type Seeded
} from './helpers/screenSeeds'
import { answerFileDialog } from './helpers/workbench'

test.describe.configure({ timeout: SCREENS_TAKE_LONGER_THAN_THE_DEFAULT_MS })

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

async function expectWelcome(page: Page, name: string): Promise<void> {
  await expectScreen(page, { name, parts: [welcome(page)], room: 0 })
}

async function pickAgentTab(page: Page, product: string): Promise<void> {
  await welcome(page).locator('.wl-seg button', { hasText: product }).click()
  await expect(welcome(page).locator('.wl-seg button.on')).toContainText(product)
}

test.describe('welcome: every step, for each agent installed or not and signed in or not', () => {
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
      await expectWelcome(page, 'welcome-1-nothing-installed')
      await nextStep(page, 2)
      await expect(welcome(page).locator('.wl-chip')).toHaveText('No sessions on this Mac yet')
      await expectWelcome(page, 'welcome-2-empty-mac')
      answerFileDialog(env, env.workspaces.a)
      await welcomeGo(page).click()
      await expect(welcome(page).locator('.wl-chip')).toHaveText('ws-a is pinned', {
        timeout: 20_000
      })
      await expectWelcome(page, 'welcome-2-folder-picked')
      await nextStep(page, 3)
      for (const [product, id] of [
        ['Claude Code', 'claude'],
        ['Codex', 'codex'],
        ['Antigravity CLI', 'agy']
      ] as const) {
        await pickAgentTab(page, product)
        await expect(welcome(page).locator('.wl-sign-text')).toContainText('first.')
        await expectWelcome(page, `welcome-3-${id}-not-installed`)
      }
      await welcome(page).getByRole('button', { name: 'I’ll sign in later' }).click()
      await expectStep(page, 4)
      await expectWelcome(page, 'welcome-4-first-session')
    } finally {
      await quitAndClose(app)
    }
  })

  test('every agent installed, past sessions found, no account: steps 1 and 2, step 3 for each agent, and Claude Code’s browser sign-in waiting then failing', async ({
    env
  }) => {
    const LOGIN_TIMEOUT_LONG_ENOUGH_TO_SHOOT_THE_WAIT_MS = 15_000
    installCodexAtFixedTime(env)
    installAgyWithNoAccount(env)
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
      await expectWelcome(page, 'welcome-1-all-installed')
      await nextStep(page, 2)
      await expect(welcome(page).locator('.wl-chip')).toHaveText(/^Found 3 sessions in 2 folders/, {
        timeout: 20_000
      })
      await expectWelcome(page, 'welcome-2-sessions-found')
      await nextStep(page, 3)
      for (const [product, id] of [
        ['Codex', 'codex'],
        ['Antigravity CLI', 'agy'],
        ['Claude Code', 'claude']
      ] as const) {
        await pickAgentTab(page, product)
        await expectWelcome(page, `welcome-3-${id}-not-signed-in`)
      }
      await welcomeGo(page).click()
      await expect(welcomeGo(page)).toHaveText(/Waiting for your browser/, { timeout: 20_000 })
      await expect(welcome(page).getByRole('button', { name: 'Open the page again' })).toBeVisible({
        timeout: 20_000
      })
      await expectWelcome(page, 'welcome-3-claude-waiting-for-browser')
      const tail = welcome(page).locator('.wl-sign-text.bad pre')
      await expect(tail).toContainText('Sign-in timed out', { timeout: 45_000 })
      await tail.evaluate((el, text) => {
        el.textContent = text
      }, HIDDEN_TERMINAL_STAND_IN)
      await expectWelcome(page, 'welcome-3-claude-sign-in-failed')
    } finally {
      await quitAndClose(app)
    }
  })

  test('every agent installed and signed in: step 3 for each agent, then the last step resuming the newest session, asking or not', async ({
    env
  }) => {
    installCodexAtFixedTime(env)
    installAgyWithNoAccount(env)
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
        await expectWelcome(page, `welcome-3-${id}-signed-in`)
      }
      await nextStep(page, 4)
      await expect(welcomeGo(page)).toContainText('Resume “Tidy the release notes”')
      await expectWelcome(page, 'welcome-4-resume-without-asking')
      await welcome(page).locator('.wl-perm button').click()
      await expect(welcome(page).locator('.wl-perm')).toContainText('Claude Code asks only')
      const ask = welcome(page).locator('.wl-ask input')
      for (const [id, label] of [
        ['claude', 'Claude'],
        ['codex', 'Codex'],
        ['agy', 'Antigravity']
      ] as const) {
        await expect(welcome(page).locator('.wl-agtag')).toHaveText(new RegExp(`^${label}tab$`))
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
    installCodexAtFixedTime(env)
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
      await expectWelcome(page, 'welcome-3-codex-sign-in-again')
      await welcomeGo(page).click()
      const aside = page.locator('.wl-aside')
      await expect(aside).toBeVisible({ timeout: 20_000 })
      await expectScreen(page, { name: 'welcome-stepped-aside', parts: [aside] })
      const bar = page.locator('.term-island > .wb-bar')
      await bar.getByRole('button', { name: 'Cancel' }).click()
      await expect(welcome(page).locator('.acct-login-state.bad')).toBeVisible({ timeout: 20_000 })
      await expectWelcome(page, 'welcome-3-codex-sign-in-failed')
    } finally {
      await quitAndClose(app)
    }
  })
})
