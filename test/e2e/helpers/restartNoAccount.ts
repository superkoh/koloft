import type { ElectronApplication, Page } from '@playwright/test'
import { expect } from './app'
import { E2E_AGY_ACCOUNT, E2E_CODEX_ACCOUNT, E2E_MUSE_ACCOUNT } from './env'
import { sendShortcut } from './p1'
import { SIGN_IN_FOLDER_OF, type SignInBackend } from '../../../src/shared/types'

const ONLY_ACCOUNT: Record<SignInBackend, string> = {
  codex: E2E_CODEX_ACCOUNT,
  muse: E2E_MUSE_ACCOUNT,
  agy: E2E_AGY_ACCOUNT
}

const NO_ACCOUNT_TO_RESTART_ON: Record<SignInBackend, string> = {
  codex: 'No Codex account can be used — check Settings ▸ Accounts.',
  muse: 'No Muse account can be used — check Settings ▸ Accounts.',
  agy: 'No Antigravity account can be used — check Settings ▸ Accounts.'
}

export async function turnOffItsOnlyAccountRestartAndSeeWhy(
  app: ElectronApplication,
  page: Page,
  backend: SignInBackend
): Promise<void> {
  const tabId = await page.locator('.ws .ws-tab.active').getAttribute('data-tab-id')
  await expect
    .poll(
      async () => {
        const live = await page.evaluate(() => window.api.sessions.list())
        const s = live.find((x) => x.tabId === tabId && x.sessionId)
        if (!s) return false
        return page.evaluate((id) => window.api.sessions.transcriptExists(id), s.sessionId)
      },
      { timeout: 60_000 }
    )
    .toBe(true)
  await page.evaluate(([name, kind]) => window.api.accounts.toggle(name, kind, false), [
    ONLY_ACCOUNT[backend],
    SIGN_IN_FOLDER_OF[backend]
  ] as const)
  await sendShortcut(app, 'shortcut:restart-session')
  await expect(page.locator('.toast-msg')).toHaveText(NO_ACCOUNT_TO_RESTART_ON[backend], {
    timeout: 30_000
  })
}
