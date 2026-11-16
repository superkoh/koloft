import fs from 'fs'
import path from 'path'
import type { ElectronApplication, Page } from '@playwright/test'
import { expect } from './app'
import { E2E_AGY_ACCOUNT, E2E_CODEX_ACCOUNT, E2E_MUSE_ACCOUNT, type E2EEnv } from './env'
import { sendShortcut } from './p1'
import { SIGN_IN_FOLDER_OF, type BackendId, type SignInBackend } from '../../../src/shared/types'

export const ONLY_ACCOUNT: Record<SignInBackend, string> = {
  codex: E2E_CODEX_ACCOUNT,
  muse: E2E_MUSE_ACCOUNT,
  agy: E2E_AGY_ACCOUNT
}

export const NO_ACCOUNT_CAN_BE_USED: Record<BackendId, string> = {
  claude: 'No Claude account can be used — check Settings ▸ Accounts.',
  codex: 'No Codex account can be used — check Settings ▸ Accounts.',
  muse: 'No Muse account can be used — check Settings ▸ Accounts.',
  agy: 'No Antigravity account can be used — check Settings ▸ Accounts.'
}

export async function untilTheActiveTabsTranscriptIsWritten(
  page: Page,
  timeout = 60_000
): Promise<string> {
  const tabId = await page.locator('.ws .ws-tab.active').getAttribute('data-tab-id')
  let sessionId = ''
  await expect
    .poll(
      async () => {
        const live = await page.evaluate(() => window.api.sessions.list())
        const s = live.find((x) => x.tabId === tabId && x.sessionId)
        if (!s) return false
        sessionId = s.sessionId
        return page.evaluate((id) => window.api.sessions.transcriptExists(id), s.sessionId)
      },
      { timeout }
    )
    .toBe(true)
  return sessionId
}

export function openTabsFile(env: E2EEnv): string {
  return path.join(env.userData, 'open-tabs.json')
}

export async function theOpenTabAsKoloftSavedIt(env: E2EEnv, sessionId: string): Promise<string> {
  let saved = ''
  await expect
    .poll(
      () => {
        try {
          saved = fs.readFileSync(openTabsFile(env), 'utf8')
          const tabs = (JSON.parse(saved) as { tabs: { sessionId: string; asleep?: boolean }[] })
            .tabs
          return tabs.length === 1 && tabs[0].sessionId === sessionId && !tabs[0].asleep
        } catch {
          return false
        }
      },
      { timeout: 30_000 }
    )
    .toBe(true)
  return saved
}

export async function turnOffItsOnlyAccountRestartAndSeeWhy(
  app: ElectronApplication,
  page: Page,
  backend: SignInBackend
): Promise<void> {
  await untilTheActiveTabsTranscriptIsWritten(page)
  await page.evaluate(([name, kind]) => window.api.accounts.toggle(name, kind, false), [
    ONLY_ACCOUNT[backend],
    SIGN_IN_FOLDER_OF[backend]
  ] as const)
  await sendShortcut(app, 'shortcut:restart-session')
  await expect(page.locator('.toast-msg')).toHaveText(NO_ACCOUNT_CAN_BE_USED[backend], {
    timeout: 30_000
  })
}
