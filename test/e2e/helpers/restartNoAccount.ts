import type { ElectronApplication, Page } from '@playwright/test'
import { expect } from './app'
import { E2E_AGY_ACCOUNT, E2E_CODEX_ACCOUNT, E2E_MUSE_ACCOUNT } from './env'
import { sendShortcut } from './p1'
import type { AccountKind } from '../../../src/shared/types'

type SignInBackend = 'codex' | 'muse' | 'agy'

const ONLY_ACCOUNT: Record<SignInBackend, { name: string; kind: AccountKind }> = {
  codex: { name: E2E_CODEX_ACCOUNT, kind: 'codex-home' },
  muse: { name: E2E_MUSE_ACCOUNT, kind: 'muse-home' },
  agy: { name: E2E_AGY_ACCOUNT, kind: 'agy-home' }
}

export const NO_ACCOUNT_TO_RESTART_ON: Record<SignInBackend, string> = {
  codex: 'No Codex account can be used — check Settings ▸ Accounts.',
  muse: 'No Muse account can be used — check Settings ▸ Accounts.',
  agy: 'No Antigravity account can be used — check Settings ▸ Accounts.'
}

export async function turnOffItsOnlyAccountAndRestart(
  app: ElectronApplication,
  page: Page,
  backend: SignInBackend
): Promise<void> {
  await expect
    .poll(
      async () => {
        const live = await page.evaluate(() => window.api.sessions.list())
        const s = live.find((x) => x.backendId === backend && x.alive && x.sessionId)
        if (!s) return false
        return page.evaluate((id) => window.api.sessions.transcriptExists(id), s.sessionId)
      },
      { timeout: 60_000 }
    )
    .toBe(true)
  const { name, kind } = ONLY_ACCOUNT[backend]
  await page.evaluate(([n, k]) => window.api.accounts.toggle(n, k, false), [name, kind] as const)
  await sendShortcut(app, 'shortcut:restart-session')
  await expect(page.locator('.toast-msg')).toHaveText(NO_ACCOUNT_TO_RESTART_ON[backend], {
    timeout: 30_000
  })
}
