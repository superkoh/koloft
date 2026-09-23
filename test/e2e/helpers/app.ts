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

/**
 * Per-test fixtures: a fresh isolated $HOME, a launched Electron app pointed at it,
 * and its first window. `env` is also usable on its own (the persistence spec relaunches
 * the app against the SAME home to verify restore).
 */
export const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern
  env: async ({}, use, testInfo) => {
    const env = setupE2EEnv()
    await use(env)
    // a red remote spec used to leave no trace of what reached the fake machine —
    // the cleanup below takes the fake ssh's log (helpers/remote.ts `stateDir`) with it.
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

/**
 * Shut an app down the way a user quits it — the teardown every launch must go through.
 *
 * `close()` on its own stopped being enough once the unsaved-changes guard landed
 * (file-edit B-26). Playwright's close IS the quit, and a renderer holding a dirty editor
 * answers it by putting its question on screen and telling main to stand down — which also
 * cancels main's own five-second fallback. Nothing then presses a button, so a test that
 * FAILED mid-edit does not fail fast: the worker sits there until its teardown timeout.
 *
 * Sending the approval first is exactly what the renderer sends after Discard, so this is
 * the product's own channel and not a test branch. With nothing dirty the guard sees an
 * approval and lets the quit straight through, which is what makes it safe for every spec
 * rather than only the editing ones.
 *
 * The close listener is armed BEFORE the approval because main quits inside the handler for
 * it: arm it afterwards and the app can already be gone, leaving the wait to time out. It is
 * awaited only when the approval really got through — a crashed renderer (reload-recovery)
 * cannot send anything, and waiting for a quit nobody asked for would add the full timeout
 * to that spec's teardown.
 */
export async function quitAndClose(app: ElectronApplication): Promise<void> {
  const win = app.windows()[0]
  if (win) {
    const exited = app.waitForEvent('close', { timeout: 15_000 }).catch(() => {})
    const approved = await win
      .evaluate(() => window.api.app.approveQuit())
      .then(() => true)
      .catch(() => false)
    if (approved) await exited
  }
  await app.close().catch(() => {})
}

/** Launch the built app against an isolated env. Exposed so a spec can relaunch. */
export async function launchApp(env: E2EEnv): Promise<ElectronApplication> {
  // A missing build makes Electron itself pop a native "Unable to find Electron app"
  // dialog — a GUI a background test run must never show, and one KOLOFT_TEST_BACKGROUND
  // cannot suppress because the app never loads. Fail fast in-process instead.
  if (!fs.existsSync(MAIN_ENTRY)) {
    throw new Error(`${MAIN_ENTRY} not found — run \`npm run build\` before test:e2e`)
  }
  return electron.launch({
    // --user-data-dir isolates userData (shim/hooks/settings/layout); $HOME isolates
    // the tracker's ~/.claude/projects + the shell profile. Both are required on macOS.
    // env.extraArgs carries per-spec Chromium switches (e.g. --host-resolver-rules for
    // the self-signed https fixture's aliases), which have no env-var equivalent.
    args: [MAIN_ENTRY, `--user-data-dir=${env.userData}`, ...(env.extraArgs ?? [])],
    cwd: REPO_ROOT,
    env: env.launchEnv as Record<string, string>
  })
}

/**
 * Main's pending "needs you" set (src/main/attention.ts), read through the same IPC the
 * renderer has.
 *
 * This is the ONLY observable an e2e run has for the attention pipeline: nothing in the
 * UI renders the set (the sidebar's status dot is derived from SessionStatus, not from
 * markers), and D8 bars a background test launch from the two real outlets — no OS
 * Notification is ever constructed, and the Dock is never touched. Poll it:
 *
 *   await expect.poll(=> pendingAttention(page)).toHaveLength(1)
 */
export async function pendingAttention(page: Page): Promise<AttentionEvent[]> {
  return page.evaluate(() => window.api.attention.list())
}

/** Type a command into the visible terminal and submit it (real xterm keystrokes). */
export async function runInTerminal(page: Page, cmd: string): Promise<void> {
  const term = page.locator('.term-wrap:visible .xterm').first()
  await term.click()
  await page.keyboard.type(cmd)
  await page.keyboard.press('Enter')
}

/**
 * Run `cmd` with the `open` shim first on PATH and the recording fake `open` second
 * (macOS path_helper reorders PATH in login shells), so a buggy shim can only ever hit
 * the recording fake — never a real app on the machine running the suite.
 */
export function withOpenPath(env: E2EEnv, cmd: string): string {
  return `export PATH="${env.shimDir}:${env.fakeBin}:$PATH"; hash -r; ${cmd}`
}
