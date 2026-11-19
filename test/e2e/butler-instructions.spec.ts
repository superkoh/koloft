import fs from 'fs'
import path from 'path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { installAgy, installCodex, installMuse, seedSettings, type E2EEnv } from './helpers/env'
import {
  butlerRow,
  centerTerm,
  readAllCalls,
  runIn,
  settingsOnDisk,
  waitBooted,
  waitForAllCalls
} from './helpers/p1'
import { INSTRUCTIONS_MAX_BYTES } from '../../src/plugins/butler/shared/instructions'
import { instructionsBytes } from '../../src/core/ownerInstructions'
import type { ButlerSetting } from '../../src/plugins/butler/shared/types'

test.setTimeout(120_000)

const A_KEY_IS_HANDLED_MS = 300
const TEXT = 'Answer me in Chinese, short.\n合并前先问我。'
const OWNER_PART = `Written by the owner\n${TEXT}`
const LAST_IN_THE_ROLE = `\n\n${OWNER_PART}`

const left = (text: string): string =>
  `${(INSTRUCTIONS_MAX_BYTES - instructionsBytes(text)).toLocaleString('en-US')} left`

function butlerFolder(env: E2EEnv): string {
  return path.join(env.userData, 'conductors', 'global')
}

function jsonLines(file: string): Record<string, unknown>[] {
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

async function launched(
  env: E2EEnv,
  seed: Record<string, unknown> = {}
): Promise<{ app: ElectronApplication; page: Page }> {
  seedSettings(env, { hintsOff: true, ...seed })
  const app = await launchApp(env)
  const page = await app.firstWindow()
  await waitBooted(page)
  return { app, page }
}

const WRITTEN = {
  butler: { name: 'Alfred', formerNames: [], instructions: [{ text: TEXT, at: 1, by: 'owner' }] }
}

const strip = (page: Page) => page.locator('.term-island .butler-strip')

test.describe('The butler’s Instructions: written by the owner, placed last in the butler’s prompt, on each of the four agents', () => {
  test('Claude Code: the strip under the butler opens the editor, which counts what is left, keeps an input method’s Esc for the input method, refuses too much and saves; a fresh conversation is asked for first, then gets the text beside its role, and a helper it starts gets it last in its role', async ({
    env
  }) => {
    const { app, page } = await launched(env)
    try {
      await butlerRow(page).click()
      await expect(butlerRow(page)).toHaveClass(/st-waiting/, { timeout: 60_000 })
      await expect(strip(page).locator('.wb-title')).toHaveText(/^Alfred\s· Butler$/)
      const [first] = await waitForAllCalls(env, 1)
      expect(first.argv).not.toContain('--append-system-prompt')

      await strip(page).getByRole('button', { name: 'Instructions' }).click()
      const editor = page.getByRole('dialog', { name: 'Instructions' })
      const field = editor.getByRole('textbox', { name: 'Instructions' })
      await expect(field).toBeFocused()
      await expect(editor.locator('.pal-tips')).toHaveText(left(''))
      await field.dispatchEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true })
      await page.waitForTimeout(A_KEY_IS_HANDLED_MS)
      await expect(editor).toBeVisible()
      await field.dispatchEvent('keydown', { key: 'Escape', bubbles: true })
      await expect(editor).toHaveCount(0)
      await strip(page).getByRole('button', { name: 'Instructions' }).click()
      await expect(field).toBeFocused()
      await field.fill('a'.repeat(INSTRUCTIONS_MAX_BYTES + 12))
      await expect(editor.locator('.pal-tips')).toHaveText('12 over the limit')
      await expect(editor.getByRole('button', { name: /^Save/ })).toBeDisabled()
      await field.fill(TEXT)
      await expect(editor.locator('.pal-tips')).toHaveText(left(TEXT))
      await page.keyboard.press('Meta+Enter')
      await expect(editor).toHaveCount(0)
      await expect(page.locator('.toast-msg')).toContainText(
        'Alfred uses it from the next fresh conversation (on Muse, from the next start).'
      )
      await expect
        .poll(() => (settingsOnDisk(env).butler as ButlerSetting).instructions?.at(-1)?.text)
        .toBe(TEXT)

      const fresh = strip(page).getByRole('button', { name: 'Start a fresh conversation' })
      const ask = page.locator('.modal', { hasText: 'Start a fresh conversation?' })
      await fresh.click()
      await ask.getByRole('button', { name: 'Cancel' }).click()
      await expect(ask).toHaveCount(0)
      const oldTab = await butlerRow(page).getAttribute('data-tab-id')
      await fresh.click()
      await ask.getByRole('button', { name: 'Start fresh' }).click()
      const [, second] = await waitForAllCalls(env, 2, 60_000)
      expect(readAllCalls(env)).toHaveLength(2)
      expect(second.cwd).toBe(butlerFolder(env))
      expect(second.argv[second.argv.indexOf('--append-system-prompt') + 1]).toBe(OWNER_PART)

      await expect(butlerRow(page)).not.toHaveAttribute('data-tab-id', oldTab ?? '')
      await expect(butlerRow(page)).toHaveClass(/st-waiting/, { timeout: 60_000 })
      const tabId = (await butlerRow(page).getAttribute('data-tab-id'))!
      await page.evaluate(
        (id) =>
          window.api.terminal.write(
            id,
            '/koloft session new --model sonnet --effort low -- look into the logs\r'
          ),
        tabId
      )
      const [, , helper] = await waitForAllCalls(env, 3, 60_000)
      expect(helper.cwd).toBe(butlerFolder(env))
      expect(helper.firstPrompt).toContain(`report back to Alfred.${LAST_IN_THE_ROLE}`)
    } finally {
      await quitAndClose(app)
    }
  })

  test('Codex: the butler’s developer instructions end with the owner’s text', async ({ env }) => {
    installCodex(env)
    const { app, page } = await launched(env, { ...WRITTEN, assist: { backend: 'codex' } })
    try {
      await butlerRow(page).click()
      await expect(butlerRow(page)).toHaveClass(/st-waiting/, { timeout: 60_000 })
      await expect(strip(page)).toBeVisible()
      const told = jsonLines(path.join(env.home, 'fake-codex-server-calls.jsonl')).flatMap((s) =>
        (s.argv as string[])
          .filter((a) => a.startsWith('developer_instructions='))
          .map((a) => JSON.parse(a.slice('developer_instructions='.length)) as string)
      )
      expect(told.length).toBeGreaterThan(0)
      for (const instructions of told) expect(instructions.endsWith(LAST_IN_THE_ROLE)).toBe(true)
    } finally {
      await quitAndClose(app)
    }
  })

  // MUSE§12
  test('Muse: the butler’s start hook text ends with the owner’s text', async ({ env }) => {
    installMuse(env)
    const { app, page } = await launched(env, { ...WRITTEN, assist: { backend: 'muse' } })
    try {
      await butlerRow(page).click()
      await expect(butlerRow(page)).toHaveClass(/st-waiting/, { timeout: 60_000 })
      await expect(strip(page)).toBeVisible()
      await runIn(page, centerTerm(page), 'hello')
      const toldFile = path.join(env.home, 'fake-muse-told.jsonl')
      await expect.poll(() => jsonLines(toldFile).length, { timeout: 30_000 }).toBeGreaterThan(0)
      const [{ out }] = jsonLines(toldFile)
      const context = JSON.parse(out as string).hookSpecificOutput.additionalContext as string
      expect(context.endsWith(LAST_IN_THE_ROLE)).toBe(true)
    } finally {
      await quitAndClose(app)
    }
  })

  // AGY§8
  test('Antigravity: the butler’s start message ends with the owner’s text', async ({ env }) => {
    installAgy(env)
    const { app, page } = await launched(env, { ...WRITTEN, assist: { backend: 'agy' } })
    try {
      await butlerRow(page).click()
      await expect(butlerRow(page)).toHaveClass(/\bactive\b/, { timeout: 60_000 })
      await expect(strip(page)).toBeVisible()
      await runIn(page, centerTerm(page), 'hello')
      const injectedFile = path.join(env.home, 'fake-agy-injected.jsonl')
      const starts = (): Record<string, unknown>[] =>
        jsonLines(injectedFile).filter((r) => r.event === 'SessionStart')
      await expect.poll(() => starts().length, { timeout: 30_000 }).toBe(1)
      expect(String(starts()[0].systemMessage).endsWith(LAST_IN_THE_ROLE)).toBe(true)
    } finally {
      await quitAndClose(app)
    }
  })
})
