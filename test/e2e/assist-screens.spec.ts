import type { Locator, Page } from '@playwright/test'
import { test, expect, quitAndClose } from './helpers/app'
import { installAgyWithNoAccount } from './helpers/env'
import { waitBooted } from './helpers/p1'
import { expectScreen } from './helpers/screenCompare'
import {
  codexSignIn,
  installCodexAtFixedTime,
  launchAtFixedTime,
  SCREENS_TAKE_LONGER_THAN_THE_DEFAULT_MS,
  seedAccounts,
  startClaudeProbe
} from './helpers/screenSeeds'

test.describe.configure({ timeout: SCREENS_TAKE_LONGER_THAN_THE_DEFAULT_MS })

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

test.describe('Assist settings: what Assist runs on, and the set-up question for each agent signed in or not', () => {
  test('Settings ▸ Assist with Claude Code signed in and the other two with no account, and its agent list open', async ({
    env
  }) => {
    installCodexAtFixedTime(env)
    installAgyWithNoAccount(env)
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
    installCodexAtFixedTime(env)
    installAgyWithNoAccount(env)
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
    installCodexAtFixedTime(env)
    installAgyWithNoAccount(env)
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
