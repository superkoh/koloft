import fs from 'fs'
import path from 'path'
import type { ElectronApplication, Page } from '@playwright/test'
import { expect, launchApp } from './app'
import type { E2EEnv } from './env'

export async function launch(env: E2EEnv): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launchApp(env)
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
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
