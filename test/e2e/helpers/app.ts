import { test as base, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import fs from 'fs'
import path from 'path'
import { setupE2EEnv, type E2EEnv } from './env'
import type { AttentionEvent } from '../../../src/shared/types'

const REPO_ROOT = path.join(__dirname, '..', '..', '..')
const MAIN_ENTRY = path.join(REPO_ROOT, 'out', 'main', 'index.js')

interface Fixtures {
  env: E2EEnv
  app: ElectronApplication
  page: Page
}

export const test = base.extend<Fixtures>({
  env: async ({}, use, testInfo) => {
    const env = setupE2EEnv()
    await use(env)
    const sshLog = path.join(env.home, 'fake-ssh', 'log')
    if (testInfo.status !== testInfo.expectedStatus && fs.existsSync(sshLog)) {
      fs.copyFileSync(sshLog, testInfo.outputPath('fake-ssh-log.jsonl'))
    }
    env.cleanup()
  },
  app: async ({ env }, use) => {
    const app = await launchApp(env)
    await use(app)
    await quitAndClose(app)
  },
  page: async ({ app }, use) => {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await use(page)
  }
})

export { expect }

export async function quitAndClose(app: ElectronApplication): Promise<void> {
  const win = app.windows()[0]
  if (win) {
    const exitedArmedBeforeApprovalSinceMainQuitsInsideIt = app
      .waitForEvent('close', { timeout: 15_000 })
      .catch(() => {})
    const approved = await win
      .evaluate(() => window.api.app.approveQuit())
      .then(() => true)
      .catch(() => false)
    // ADR-0021
    if (approved) await exitedArmedBeforeApprovalSinceMainQuitsInsideIt
  }
  await app.close().catch(() => {})
}

export async function launchApp(env: E2EEnv): Promise<ElectronApplication> {
  if (!fs.existsSync(MAIN_ENTRY)) {
    throw new Error(`${MAIN_ENTRY} not found — run \`npm run build\` before test:e2e`)
  }
  return electron.launch({
    // PLATFORM§4
    args: [MAIN_ENTRY, `--user-data-dir=${env.userData}`, ...(env.extraArgs ?? [])],
    cwd: REPO_ROOT,
    env: env.launchEnv as Record<string, string>
  })
}

export async function pendingAttention(page: Page): Promise<AttentionEvent[]> {
  return page.evaluate(() => window.api.attention.list())
}

export async function runInTerminal(page: Page, cmd: string): Promise<void> {
  const term = page.locator('.term-wrap:visible .xterm').first()
  await term.click()
  await page.keyboard.type(cmd)
  await page.keyboard.press('Enter')
}

// PLATFORM§2
export function withOpenPath(env: E2EEnv, cmd: string): string {
  return `export PATH="${env.shimDir}:${env.fakeBin}:$PATH"; hash -r; ${cmd}`
}
